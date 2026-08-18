#!/usr/bin/env python3
"""
Schema-drift guard: every SQL statement in the backend must COMPILE against the
real schema.

Three production bugs in a row came from hand-written SQL naming a column that
does not exist, on a code path no test ever executed:

  * music_search.py said `p.shared`; the playlists column is `is_public`.
    Every `in:`/`playlist:` search 500'd.
  * admin.py said `ai_analysis_jobs.errors`; that table's column is
    `error_message` (the similarly shaped scan_tasks table is the one with
    `errors`). The AI-analysis failure handler itself raised, leaving the job
    wedged at status='running' forever and discarding the original error.
  * radio.py interpolated unmapped field abbreviations straight into SQL, so
    the `l:` (album) and `p:` (path) filters that browse-page.js sends became
    `no such column: l` / `no such column: p`.

Unit tests do not catch these, because the defect is in a string that is only
built and executed under a specific branch. sqlite3's `prepare` does full name
resolution without running anything, so we can check EVERY statement cheaply.

Method: AST-walk the backend for string constants that look like SQL (including
f-strings, whose interpolated holes are filled with neutral placeholders), then
prepare each against a database built by the real migrations. A statement that
names a missing table or column fails here instead of in production.

Anything that cannot be resolved to a preparable statement is REPORTED, not
silently skipped -- see test_unresolved_statements_are_accounted_for.

Run: python3 backend/test_sql_schema.py   (from the mrepo-web repo root)
"""

import ast
import itertools
import re
import sqlite3
import sys
import unittest
from pathlib import Path

_repo_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_repo_root))

from backend import db as db_mod  # noqa: E402

BACKEND = _repo_root / 'backend'

SKIP_FILES = {'test_sql_schema.py', 'test_sync_contract.py',
              'test_search_scoping.py', 'test_music_search.py'}

# backend/ai_service/ talks to METADATA_DB (analyzer.py:177, 211), a SEPARATE
# database from the app's MUSIC_DB. Its tables (`embeddings`, ...) are not in
# these migrations by design, so checking them here would be checking the wrong
# schema. Excluded deliberately -- not because it failed.
SKIP_DIRS = {'ai_service'}

# Tables the code itself treats as OPTIONAL: it probes sqlite_master and takes a
# fallback path when they are absent (browse.py's browse_genres_normalized).
# Nothing creates them in this schema today, so a reference is expected, not
# drift. Keep this list short -- each entry is a hole in the guard.
OPTIONAL_TABLES = {'genres', 'song_genres'}

# Must look like a whole statement, not merely start with a SQL-ish verb --
# docstrings such as "Update a user (admin only)." and "Delete a playlist."
# start with one and are not SQL.
SQL_SHAPE = re.compile(
    r'^\s*(?:'
    r'SELECT\b[\s\S]*?\bFROM\b'
    r'|SELECT\b[\s\S]*?\)'          # SELECT COUNT(*) with no FROM
    r'|INSERT\s+(?:OR\s+\w+\s+)?INTO\b'
    r'|UPDATE\b[\s\S]*?\bSET\b'
    r'|DELETE\s+FROM\b'
    r'|REPLACE\s+INTO\b'
    r'|WITH\b[\s\S]*?\bAS\b'
    r')', re.IGNORECASE)

# An interpolation hole can sit in a WHERE fragment, an ORDER BY, a column
# list, a HAVING clause... so try several neutral fillers and accept the first
# that compiles. Every candidate is a literal or a truth value -- none of them
# introduce an identifier, so a substitution can never manufacture a false
# "no such column". Statements no candidate reconstructs land in `unresolved`.
PLACEHOLDERS = ['1=1', '1', "''", '', 'uuid']

# Ceiling on filler combinations per statement (see _fstring_candidates).
MAX_COMBOS = 400


def _looks_like_sql(text):
    return bool(SQL_SHAPE.match(text))


def _render_fstring(node, fillers):
    """Render an f-string, substituting `fillers[i]` into the i-th hole."""
    parts = []
    hole = 0
    for piece in node.values:
        if isinstance(piece, ast.Constant) and isinstance(piece.value, str):
            parts.append(piece.value)
        else:
            parts.append(fillers[hole])
            hole += 1
    return ''.join(parts)


def _fstring_candidates(node):
    """Every combination of fillers across the f-string's holes.

    Holes are independent -- one may be a WHERE fragment while the next is an
    optional HAVING that must render EMPTY -- so filling them all the same way
    reconstructs only the single-hole cases. Combinations are capped so a
    statement with many holes cannot blow up the run.
    """
    holes = sum(1 for v in node.values
                if not (isinstance(v, ast.Constant) and isinstance(v.value, str)))
    if holes == 0:
        return [_render_fstring(node, [])]
    if len(PLACEHOLDERS) ** holes > MAX_COMBOS:
        # Too many holes to enumerate: fall back to uniform fills.
        return [_render_fstring(node, [f] * holes) for f in PLACEHOLDERS]
    return [_render_fstring(node, combo)
            for combo in itertools.product(PLACEHOLDERS, repeat=holes)]


def _collect_statements():
    """Yield (path, lineno, [candidate sql, ...]) for each SQL-looking literal.

    A plain string yields one candidate; an f-string yields one per filler.
    """
    for path in sorted(BACKEND.rglob('*.py')):
        if path.name in SKIP_FILES or '__pycache__' in path.parts:
            continue
        if SKIP_DIRS & set(path.parts):
            continue
        tree = ast.parse(path.read_text(), filename=str(path))

        # ast.walk descends INTO f-strings, so the literal chunks around each
        # hole ("SELECT ... WHERE ") also surface as bare Constants. Checking
        # those would report a truncated fragment as broken SQL. Exclude them.
        inner = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                for piece in node.values:
                    inner.add(id(piece))

        for node in ast.walk(tree):
            if id(node) in inner:
                continue
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if not _looks_like_sql(node.value):
                    continue
                candidates = [node.value]
            elif isinstance(node, ast.JoinedStr):
                rendered = _fstring_candidates(node)
                if not any(_looks_like_sql(r) for r in rendered):
                    continue
                candidates = [r for r in rendered if _looks_like_sql(r)]
            else:
                continue
            yield path.relative_to(_repo_root), node.lineno, candidates


def _build_schema_conn():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    db_mod._run_migrations(conn)
    return conn


class SqlSchemaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = _build_schema_conn()
        cls.failures = []
        cls.unresolved = []
        cls.checked = 0

        for path, lineno, candidates in _collect_statements():
            drift = None
            compiled = False
            last_err = None

            for candidate in candidates:
                stmt = candidate.strip().rstrip(';')
                try:
                    cls._prepare(stmt)
                    compiled = True
                    break
                except sqlite3.OperationalError as exc:
                    msg = str(exc)
                    if 'no such column' in msg or 'no such table' in msg:
                        # A missing name is real drift regardless of which
                        # filler produced it -- fillers never add identifiers.
                        if not cls._is_optional(msg):
                            drift = (msg, stmt)
                            break
                        compiled = True
                        break
                    last_err = msg
                except (sqlite3.Warning, sqlite3.ProgrammingError, ValueError) as exc:
                    last_err = str(exc)

            if drift:
                cls.failures.append((path, lineno, drift[0], drift[1]))
            elif compiled:
                cls.checked += 1
            else:
                # No filler reconstructed a valid statement -- our limitation,
                # not the code's. Tracked, not silently dropped.
                cls.unresolved.append((path, lineno, last_err or 'unknown'))

    @classmethod
    def _is_optional(cls, msg):
        """True for tables the code guards on at runtime (see OPTIONAL_TABLES)."""
        m = re.search(r'no such table: (\w+)', msg)
        return bool(m) and m.group(1) in OPTIONAL_TABLES

    @classmethod
    def _prepare(cls, stmt):
        """Name-resolve a statement without running it.

        EXPLAIN compiles the statement (so unknown tables/columns raise) but
        executes nothing. sqlite3 still insists the bind count matches, so
        supply Nones -- the count comes from the driver's own complaint rather
        than from counting '?' by hand, which would miscount markers that
        appear inside string literals.
        """
        try:
            cls.conn.execute(f'EXPLAIN {stmt}')
            return
        except sqlite3.ProgrammingError as exc:
            m = re.search(r'uses (\d+)', str(exc))
            if not m:
                raise
            cls.conn.execute(f'EXPLAIN {stmt}', (None,) * int(m.group(1)))

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_every_statement_resolves_against_the_schema(self):
        if self.failures:
            lines = [
                f'{p}:{n}  {msg}\n    {sql[:160].strip()}'
                for p, n, msg, sql in self.failures
            ]
            self.fail(
                f'{len(self.failures)} SQL statement(s) name a table or column '
                f'that does not exist in the migrated schema:\n\n'
                + '\n\n'.join(lines))

    def test_a_meaningful_number_of_statements_were_checked(self):
        # Guards the guard: if the collector silently stops matching (a refactor
        # moves SQL into a helper, say), this test would "pass" while checking
        # nothing. Pin a floor well under the current count.
        self.assertGreater(
            self.checked, 300,
            f'only {self.checked} statements were compiled — the SQL collector '
            'has probably stopped finding them')

    def test_unresolved_statements_are_accounted_for(self):
        # No silent caps: report what this guard could NOT check, so the gap is
        # visible rather than mistaken for coverage.
        if self.unresolved:
            print(f'\n[sql-schema] {len(self.unresolved)} statement(s) could not '
                  f'be prepared (dynamic SQL our placeholder substitution cannot '
                  f'reconstruct); these are NOT schema-checked:')
            for p, n, msg in self.unresolved:
                print(f'  {p}:{n}  {msg}')
        # Only genuinely runtime-assembled statements should land here (an
        # UPDATE whose SET list is joined from a variable-length list, say).
        # A jump in this number means the guard quietly stopped covering things.
        self.assertLess(
            len(self.unresolved), 10,
            f'{len(self.unresolved)} statements are unreconstructable (was 4); '
            'the guard has lost coverage — see the list printed above')


if __name__ == '__main__':
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""
Contract test for per-user scoping in the advanced search language.

The query language exposes two fields that are meaningless without knowing WHO
is asking: `in:`/`playlist:` (playlist membership) and `tag:`. music_search's
build_sql(ast, user_id=None) takes that identity as an OPTIONAL argument, and
when it is missing the builder does not fail -- it quietly switches to a
different, wrong query:

    playlist  ->  matches only public playlists (p.is_public = 1)
    tag       ->  compiles to the literal "1=0", matching nothing

Every call site in backend/api/songs.py used to omit it, so `in:Favorites`
returned zero rows with no error anywhere. The sibling monolith (swapi-apps)
had the same omission plus a worse variant of the same class of bug: its copy
of the playlist subquery referenced a `p.shared` column that does not exist,
producing a 500 on every `in:` query in production.

This test pins both halves against the REAL migrated schema, so a regression
fails here instead of silently returning an empty result set to a user:

  * the owner sees their own private playlist / tag  (guards the wiring)
  * another user does not                            (guards the scoping)
  * the SQL executes at all                          (guards column drift)

Run: python3 backend/test_search_scoping.py   (from the mrepo-web repo root)
     or via: node tests/run-e2e.js --contract
"""

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

_repo_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_repo_root))

from backend import db as db_mod  # noqa: E402
from backend import music_search  # noqa: E402
from backend.api import songs as songs_mod  # noqa: E402
from backend.api import playlists as playlists_mod  # noqa: E402
from backend.api import tags as tags_mod  # noqa: E402

OWNER = 'scoping-owner'
OTHER = 'scoping-other'
OWNER_DETAILS = {'user_id': OWNER}
OTHER_DETAILS = {'user_id': OTHER}

_PATCH_MODULES = [songs_mod, playlists_mod, tags_mod]


def _make_conn(db_path):
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False,
                           isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


class SearchScopingTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self._tmp.close()
        self.db_path = self._tmp.name

        self.conn = _make_conn(self.db_path)
        db_mod._run_migrations(self.conn)

        # 4 songs; the first 3 go in the owner's private playlist.
        self.songs = [f'song-{i}' for i in range(4)]
        self.conn.executemany(
            "INSERT INTO songs (uuid, file, title, artist) VALUES (?, ?, ?, ?)",
            [(u, f'/music/{u}.flac', u, 'Scoping Artist') for u in self.songs])

        for m in _PATCH_MODULES:
            m.get_db = lambda c=self.conn: c

        self.private_id = playlists_mod.playlists_create(
            'ScopingPrivate', is_public=False, details=OWNER_DETAILS)['id']
        playlists_mod.playlists_add_songs(
            self.private_id, self.songs[:3], details=OWNER_DETAILS)

        self.public_id = playlists_mod.playlists_create(
            'ScopingPublic', is_public=True, details=OWNER_DETAILS)['id']
        playlists_mod.playlists_add_songs(
            self.public_id, [self.songs[3]], details=OWNER_DETAILS)

        self.tag_id = tags_mod.tags_create('ScopingTag', details=OWNER_DETAILS)['id']
        tags_mod.tags_add_to_song(self.tag_id, self.songs[0], details=OWNER_DETAILS)

    def tearDown(self):
        self.conn.close()
        Path(self.db_path).unlink(missing_ok=True)

    # ---- helpers -----------------------------------------------------------

    def _search(self, query, details=OWNER_DETAILS, limit=50):
        return songs_mod.songs_search(query, limit=limit, details=details)

    def _uuids(self, result):
        return sorted(s['uuid'] for s in result['items'])

    # ---- build_sql: the degradation itself ---------------------------------

    def test_build_sql_playlist_sql_runs_against_the_real_schema(self):
        # Guards column drift (the `p.shared` crash): the generated SQL must be
        # executable, not merely well-formed text.
        for query in ('in:ScopingPrivate', 'in:eq:ScopingPrivate', 'playlist:ScopingPrivate'):
            for user_id in (None, OWNER):
                where, params = music_search.build_sql(
                    music_search.parse_query(query), user_id)
                self.conn.execute(
                    f"SELECT uuid FROM songs WHERE {where}", params).fetchall()

    def test_build_sql_tag_sql_runs_against_the_real_schema(self):
        for user_id in (None, OWNER):
            where, params = music_search.build_sql(
                music_search.parse_query('tag:ScopingTag'), user_id)
            self.conn.execute(
                f"SELECT uuid FROM songs WHERE {where}", params).fetchall()

    def test_build_sql_without_user_id_is_the_degraded_arm(self):
        # Documents WHY the plumbing matters: this is the behaviour every caller
        # silently got. If this assertion ever fails because the no-user arm was
        # made permissive, that is a data leak, not a fix.
        where, params = music_search.build_sql(
            music_search.parse_query('in:ScopingPrivate'), None)
        rows = self.conn.execute(f"SELECT uuid FROM songs WHERE {where}", params).fetchall()
        self.assertEqual([], [r['uuid'] for r in rows],
                         'no-user build_sql must not expose private playlists')

    # ---- songs_search: the wiring ------------------------------------------

    def test_in_returns_owners_private_playlist(self):
        res = self._search('in:ScopingPrivate')
        self.assertEqual(sorted(self.songs[:3]), self._uuids(res),
                         'owner must see their own private playlist')
        self.assertEqual(3, res['totalCount'],
                         'totalCount must be scoped identically to items')

    def test_in_exact_match_form_is_scoped(self):
        self.assertEqual(sorted(self.songs[:3]),
                         self._uuids(self._search('in:eq:ScopingPrivate')))

    def test_playlist_alias_is_scoped(self):
        self.assertEqual(sorted(self.songs[:3]),
                         self._uuids(self._search('playlist:ScopingPrivate')))

    def test_tag_returns_owners_tagged_song(self):
        # Without a user_id this compiles to `1=0` and returns [].
        self.assertEqual([self.songs[0]], self._uuids(self._search('tag:ScopingTag')))

    def test_user_id_survives_boolean_recursion(self):
        # AndNode/OrNode/NotNode recurse through build_sql; the identity has to
        # be threaded down every branch, not just the top-level call.
        self.assertEqual(sorted(self.songs[:3]),
                         self._uuids(self._search('in:ScopingPrivate AND a:"Scoping Artist"')))
        self.assertEqual(sorted(self.songs[:3]),
                         self._uuids(self._search('in:ScopingPrivate OR in:ScopingPrivate')))
        self.assertEqual(sorted([self.songs[3]]),
                         self._uuids(self._search('NOT in:ScopingPrivate')))

    def test_songs_random_honours_in_scoping(self):
        # songs_random walks its own build_sql path and had the same omission.
        for _ in range(8):
            picked = songs_mod.songs_random(
                filter_query='in:ScopingPrivate', count=1, details=OWNER_DETAILS)
            self.assertIn(picked['uuid'], self.songs[:3],
                          'songs_random ignored the in: filter')

    # ---- the other side: scoping must still exclude ------------------------

    def test_other_user_cannot_see_private_playlist(self):
        res = self._search('in:ScopingPrivate', details=OTHER_DETAILS)
        self.assertEqual([], self._uuids(res))
        self.assertEqual(0, res['totalCount'])

    def test_other_user_can_see_public_playlist(self):
        # Scoping must not collapse into owner-only: public playlists stay shared.
        self.assertEqual([self.songs[3]],
                         self._uuids(self._search('in:ScopingPublic', details=OTHER_DETAILS)))

    def test_other_user_cannot_see_owners_tag(self):
        self.assertEqual([], self._uuids(self._search('tag:ScopingTag', details=OTHER_DETAILS)))

    def test_every_query_language_field_compiles(self):
        """
        Every field in FIELD_MAP must produce EXECUTABLE SQL, for both operator
        families and with and without a user.

        This is the assertion that catches `p.shared`. music_search builds WHERE
        *fragments*, not whole statements, so backend/test_sql_schema.py (which
        prepares complete statements) cannot see them -- a fragment referencing a
        nonexistent column is invisible until a user happens to type that field.
        Enumerating FIELD_MAP means a newly added field is covered the moment it
        is added, rather than whenever someone remembers to write a test.
        """
        import backend.music_search as ms

        failures = []
        for field in sorted(set(ms.FIELD_MAP)):
            # Numeric fields legitimately reject a text value; probe them with
            # a number so a real compile failure is not masked by that refusal.
            probe = '1988' if ms.FIELD_MAP[field] in ms.NUMERIC_FIELDS else 'probevalue'
            for op in ('eq', 'mt'):
                query = f'{field}:{op}:{probe}'
                for user_id in (None, OWNER):
                    try:
                        where, params = ms.build_sql(ms.parse_query(query), user_id)
                    except Exception as exc:            # parse/build refusal
                        failures.append(f'{query} (user={user_id}) build: {exc}')
                        continue
                    try:
                        self.conn.execute(
                            f"SELECT uuid FROM songs WHERE {where}", params).fetchall()
                    except Exception as exc:            # the p.shared class
                        failures.append(f'{query} (user={user_id}) execute: {exc}')

        self.assertEqual([], failures,
                         'query-language fields producing unusable SQL:\n  '
                         + '\n  '.join(failures))


    def test_missing_details_does_not_leak(self):
        # An unauthenticated/misrouted call must degrade closed, never open.
        res = self._search('in:ScopingPrivate', details=None)
        self.assertEqual([], self._uuids(res))
        self.assertEqual([], self._uuids(self._search('tag:ScopingTag', details=None)))


if __name__ == '__main__':
    unittest.main(verbosity=2)

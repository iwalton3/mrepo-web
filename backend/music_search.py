"""
Advanced Search Query Parser for Music Player

Supports:
- Boolean operators: AND, OR, NOT
- Grouping with parentheses: (a OR b) AND c
- Field-specific queries: g:eq:Rock, a:mt:Beatles, a:Beatles (shorthand)
- Numeric comparisons: year:gte:1980, bpm:lt:120
- AI-powered search: ai:prompt, ai(subquery)
- All text comparisons are case-insensitive

Syntax:
    QUERY      := EXPR | EXPR 'OR' QUERY
    EXPR       := TERM | TERM 'AND' EXPR | TERM EXPR
    TERM       := 'NOT' ATOM | ATOM
    ATOM       := '(' QUERY ')' | AI_FUNC | FIELD ':' OP ':' VALUE | FIELD ':' VALUE | VALUE

Fields:
    c = category
    g = genre
    a = artist
    aa = album_artist
    l = album (aLbum)
    n = title (Name)
    t = tag (requires user context)
    in = playlist membership (e.g., in:Favorites)
    ai = AI text search (CLAP-based semantic search)
    p = path (file path)
    f = filename
    u = uuid
    year = release year (numeric)
    bpm = beats per minute (numeric)
    dur = duration in seconds (numeric)
    track = track number (numeric)
    disc = disc number (numeric)

Operators:
    eq = equals (exact match, case-insensitive)
    ne = not equals (case-insensitive)
    mt = matches (contains, case-insensitive) - DEFAULT when operator omitted
    nm = not matches
    gt, lt, gte, lte = numeric comparisons

AI Search:
    ai:prompt                         -> Semantic search using CLAP text embeddings
    ai(subquery)                      -> Find songs similar to subquery results

Examples:
    Beatles                           -> All fields contain "Beatles"
    a:Beatles                         -> Artist contains "Beatles" (shorthand for a:mt:Beatles)
    a:mt:Beatles                      -> Artist contains "Beatles"
    g:eq:Rock AND a:mt:Beatles        -> Rock genre AND artist contains Beatles
    g:eq:Jazz OR g:eq:Blues           -> Jazz OR Blues genre
    (g:eq:Rock OR g:eq:Metal) a:Iron  -> (Rock OR Metal) AND Iron in artist
    NOT c:eq:Classical                -> Not Classical category
    year:gte:1980 AND year:lte:1989   -> 1980s music
    a:eq:KOTOKO                       -> Artist equals "KOTOKO" (case-insensitive)
    in:Favorites                      -> Songs in playlists containing "Favorites"
    in:eq:Rock Anthems                -> Songs in "Rock Anthems" playlist (exact match)
    ai:upbeat electronic music        -> Semantic search for upbeat electronic
    c:j-pop AND ai:happy anime song   -> J-pop category with semantic filter
    ai(a:Beatles)                     -> Songs similar to Beatles tracks
"""

import re
from typing import List, Tuple, Dict, Any, Optional
from dataclasses import dataclass
from enum import Enum


class TokenType(Enum):
    AND = 'AND'
    OR = 'OR'
    NOT = 'NOT'
    LPAREN = '('
    RPAREN = ')'
    FIELD_OP_VALUE = 'FIELD_OP_VALUE'
    VALUE = 'VALUE'
    AI_FUNC = 'AI_FUNC'  # ai(subquery)
    EOF = 'EOF'


@dataclass
class Token:
    type: TokenType
    value: Any


class ASTNode:
    """Base class for AST nodes."""
    pass


@dataclass
class AndNode(ASTNode):
    left: ASTNode
    right: ASTNode


@dataclass
class OrNode(ASTNode):
    left: ASTNode
    right: ASTNode


@dataclass
class NotNode(ASTNode):
    child: ASTNode


@dataclass
class FieldCondition(ASTNode):
    field: str
    operator: str
    value: str


@dataclass
class TextSearch(ASTNode):
    value: str


@dataclass
class AITextSearch(ASTNode):
    """AI semantic search using text prompt (ai:prompt syntax)."""
    prompt: str


@dataclass
class AISubquerySearch(ASTNode):
    """AI similarity search based on subquery results (ai(subquery) syntax)."""
    subquery: ASTNode


# Field mapping
FIELD_MAP = {
    'c': 'category',
    'category': 'category',
    'g': 'genre',
    'genre': 'genre',
    'a': 'artist',
    'artist': 'artist',
    'l': 'album',
    'album': 'album',
    'n': 'title',
    'title': 'title',
    't': 'tag',
    'tag': 'tag',
    'in': 'playlist',
    'playlist': 'playlist',
    'p': 'file',
    'path': 'file',
    'file': 'file',
    'f': 'filename',
    'filename': 'filename',
    'u': 'uuid',
    'uuid': 'uuid',
    'year': 'year',
    'bpm': 'bpm',
    'duration': 'duration_seconds',
    'dur': 'duration_seconds',
    # New fields
    'aa': 'album_artist',
    'albumartist': 'album_artist',
    'album_artist': 'album_artist',
    'track': 'track_number',
    'track_number': 'track_number',
    'disc': 'disc_number',
    'disc_number': 'disc_number',
}

# Operator mapping
OPERATOR_MAP = {
    'eq': '=',
    'ne': '!=',
    'mt': 'LIKE',
    'nm': 'NOT LIKE',
    'gt': '>',
    'lt': '<',
    'gte': '>=',
    'lte': '<=',
}

# Numeric fields
NUMERIC_FIELDS = {'year', 'bpm', 'duration_seconds', 'track_number', 'disc_number'}


class Lexer:
    """Tokenizer for search queries."""

    # Pattern for field:op:value OR field:value (op defaults to 'mt')
    FIELD_PATTERN = re.compile(
        r'([a-zA-Z_]+):(?:([a-zA-Z]+):)?("(?:[^"\\]|\\.)*"|[^\s()]+)'
    )

    # Pattern for ai:prompt - captures multi-word prompts until AND/OR/)/end
    # Must be checked BEFORE general FIELD_PATTERN
    AI_TEXT_PATTERN = re.compile(
        r'ai:("(?:[^"\\]|\\.)*"|.+?)(?=\s+(?:AND|OR)\s|\)|$)',
        re.IGNORECASE
    )

    def __init__(self, text: str):
        self.text = text
        self.pos = 0
        self.length = len(text)

    def _skip_whitespace(self):
        while self.pos < self.length and self.text[self.pos].isspace():
            self.pos += 1

    def _read_quoted_string(self) -> str:
        """Read a quoted string, handling escapes."""
        assert self.text[self.pos] == '"'
        self.pos += 1
        result = []
        while self.pos < self.length:
            ch = self.text[self.pos]
            if ch == '\\' and self.pos + 1 < self.length:
                self.pos += 1
                result.append(self.text[self.pos])
            elif ch == '"':
                self.pos += 1
                return ''.join(result)
            else:
                result.append(ch)
            self.pos += 1
        return ''.join(result)

    def _read_word(self) -> str:
        """Read an unquoted word."""
        start = self.pos
        while self.pos < self.length:
            ch = self.text[self.pos]
            if ch.isspace() or ch in '()':
                break
            self.pos += 1
        return self.text[start:self.pos]

    def _read_balanced_parens(self) -> str:
        """Read content inside balanced parentheses, handling nesting."""
        assert self.text[self.pos] == '('
        self.pos += 1  # Skip opening paren
        depth = 1
        result = []
        while self.pos < self.length and depth > 0:
            ch = self.text[self.pos]
            if ch == '(':
                depth += 1
                result.append(ch)
            elif ch == ')':
                depth -= 1
                if depth > 0:
                    result.append(ch)
            elif ch == '"':
                # Read quoted string to avoid counting parens inside quotes
                result.append(ch)
                self.pos += 1
                while self.pos < self.length:
                    qch = self.text[self.pos]
                    result.append(qch)
                    if qch == '\\' and self.pos + 1 < self.length:
                        self.pos += 1
                        result.append(self.text[self.pos])
                    elif qch == '"':
                        break
                    self.pos += 1
            else:
                result.append(ch)
            self.pos += 1
        return ''.join(result)

    def next_token(self) -> Token:
        self._skip_whitespace()

        if self.pos >= self.length:
            return Token(TokenType.EOF, None)

        ch = self.text[self.pos]

        # Parentheses
        if ch == '(':
            self.pos += 1
            return Token(TokenType.LPAREN, '(')
        if ch == ')':
            self.pos += 1
            return Token(TokenType.RPAREN, ')')

        # Check for keywords
        remaining = self.text[self.pos:]

        if remaining.upper().startswith('AND ') or remaining.upper().startswith('AND)'):
            self.pos += 3
            return Token(TokenType.AND, 'AND')

        if remaining.upper().startswith('OR ') or remaining.upper().startswith('OR)'):
            self.pos += 2
            return Token(TokenType.OR, 'OR')

        if remaining.upper().startswith('NOT ') or remaining.upper().startswith('NOT('):
            self.pos += 3
            return Token(TokenType.NOT, 'NOT')

        # Check for ai(subquery) function syntax
        if remaining.lower().startswith('ai('):
            self.pos += 2  # Skip 'ai'
            subquery = self._read_balanced_parens()
            return Token(TokenType.AI_FUNC, subquery)

        # Check for ai:prompt - captures multi-word prompts until AND/OR/)/end
        ai_text_match = self.AI_TEXT_PATTERN.match(remaining)
        if ai_text_match:
            value = ai_text_match.group(1).strip()
            # Remove quotes if present
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1].replace('\\"', '"')
            self.pos += ai_text_match.end()
            return Token(TokenType.FIELD_OP_VALUE, ('ai', 'mt', value))

        # Check for field:op:value or field:value pattern
        match = self.FIELD_PATTERN.match(remaining)
        if match:
            field, op, value = match.groups()
            # Default operator to 'mt' (matches/contains) if not specified
            if op is None:
                op = 'mt'
            # Remove quotes if present
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1].replace('\\"', '"')
            self.pos += match.end()
            return Token(TokenType.FIELD_OP_VALUE, (field.lower(), op.lower(), value))

        # Quoted string as value
        if ch == '"':
            value = self._read_quoted_string()
            return Token(TokenType.VALUE, value)

        # Regular word as value
        word = self._read_word()
        if word:
            return Token(TokenType.VALUE, word)

        return Token(TokenType.EOF, None)


class Parser:
    """
    Recursive descent parser for search queries.

    Grammar:
        query   := or_expr
        or_expr := and_expr ('OR' and_expr)*
        and_expr := term (('AND' | implicit) term)*
        term    := 'NOT' atom | atom
        atom    := '(' query ')' | ai_func | ai_field | field_cond | text_search
        ai_func := 'ai(' subquery ')'
        ai_field := 'ai:' prompt
    """

    def __init__(self, lexer: Lexer):
        self.lexer = lexer
        self.current = self.lexer.next_token()

    def _advance(self):
        self.current = self.lexer.next_token()

    def _expect(self, token_type: TokenType):
        if self.current.type != token_type:
            raise ValueError(f"Expected {token_type}, got {self.current.type}")
        self._advance()

    def parse(self) -> ASTNode:
        if self.current.type == TokenType.EOF:
            return TextSearch('')
        return self._or_expr()

    def _or_expr(self) -> ASTNode:
        left = self._and_expr()

        while self.current.type == TokenType.OR:
            self._advance()
            right = self._and_expr()
            left = OrNode(left, right)

        return left

    def _and_expr(self) -> ASTNode:
        left = self._term()

        while self.current.type in (TokenType.AND, TokenType.NOT,
                                    TokenType.LPAREN, TokenType.FIELD_OP_VALUE,
                                    TokenType.VALUE, TokenType.AI_FUNC):
            if self.current.type == TokenType.AND:
                self._advance()

            if self.current.type in (TokenType.NOT, TokenType.LPAREN,
                                     TokenType.FIELD_OP_VALUE, TokenType.VALUE,
                                     TokenType.AI_FUNC):
                right = self._term()
                left = AndNode(left, right)
            else:
                break

        return left

    def _term(self) -> ASTNode:
        if self.current.type == TokenType.NOT:
            self._advance()
            child = self._atom()
            return NotNode(child)

        return self._atom()

    def _atom(self) -> ASTNode:
        if self.current.type == TokenType.LPAREN:
            self._advance()
            node = self._or_expr()
            self._expect(TokenType.RPAREN)
            return node

        if self.current.type == TokenType.AI_FUNC:
            # ai(subquery) - parse subquery and return AISubquerySearch
            subquery_str = self.current.value
            self._advance()
            subquery_ast = parse_query(subquery_str)
            return AISubquerySearch(subquery_ast)

        if self.current.type == TokenType.FIELD_OP_VALUE:
            field, op, value = self.current.value
            self._advance()
            # Handle ai:prompt as AITextSearch
            if field == 'ai':
                return AITextSearch(value)
            return FieldCondition(field, op, value)

        if self.current.type == TokenType.VALUE:
            value = self.current.value
            self._advance()
            return TextSearch(value)

        raise ValueError(f"Unexpected token: {self.current}")


def parse_query(query: str) -> ASTNode:
    """Parse a search query string into an AST."""
    query = query.strip()
    if not query:
        return TextSearch('')

    lexer = Lexer(query)
    parser = Parser(lexer)
    return parser.parse()


def build_sql(ast: ASTNode, user_id: Optional[str] = None) -> Tuple[str, List]:
    """
    Convert AST to SQL WHERE clause and parameters.

    Args:
        ast: The AST node to convert
        user_id: Optional user ID for tag queries

    Returns:
        Tuple of (where_clause, params)
    """
    if isinstance(ast, AndNode):
        left_sql, left_params = build_sql(ast.left, user_id)
        right_sql, right_params = build_sql(ast.right, user_id)
        return f"({left_sql} AND {right_sql})", left_params + right_params

    if isinstance(ast, OrNode):
        left_sql, left_params = build_sql(ast.left, user_id)
        right_sql, right_params = build_sql(ast.right, user_id)
        return f"({left_sql} OR {right_sql})", left_params + right_params

    if isinstance(ast, NotNode):
        child_sql, child_params = build_sql(ast.child, user_id)
        return f"NOT ({child_sql})", child_params

    if isinstance(ast, FieldCondition):
        return _build_field_condition(ast, user_id)

    if isinstance(ast, TextSearch):
        return _build_text_search(ast)

    if isinstance(ast, AITextSearch):
        # AI text search can't be converted to SQL directly
        # Return a marker that always matches - AI filtering happens post-query
        return "1=1", []

    if isinstance(ast, AISubquerySearch):
        # AI subquery search - the subquery is used to find similar songs
        # Return a marker that always matches - AI filtering happens post-query
        return "1=1", []

    raise ValueError(f"Unknown AST node type: {type(ast)}")


def _build_field_condition(cond: FieldCondition,
                           user_id: Optional[str] = None) -> Tuple[str, List]:
    """Build SQL for a field condition."""
    # Map field name
    db_field = FIELD_MAP.get(cond.field)
    if not db_field:
        raise ValueError(f"Unknown field: {cond.field}")

    # Map operator
    sql_op = OPERATOR_MAP.get(cond.operator)
    if not sql_op:
        raise ValueError(f"Unknown operator: {cond.operator}")

    # Handle special cases
    if db_field == 'tag':
        # Tag requires a subquery
        if not user_id:
            return "1=0", []  # Tags require user context
        return (
            "uuid IN (SELECT song_uuid FROM song_tags st "
            "JOIN tags t ON st.tag_id = t.id "
            "WHERE t.name = ? AND st.user_id = ?)",
            [cond.value, user_id]
        )

    if db_field == 'playlist':
        # Playlist membership - search songs in playlists by name
        # Matches playlists owned by user OR public playlists
        if sql_op in ('LIKE', 'NOT LIKE'):
            name_condition = "p.name LIKE ?"
            name_value = f'%{cond.value}%'
        else:
            name_condition = "p.name = ? COLLATE NOCASE"
            name_value = cond.value

        if user_id:
            # User can see their own playlists and public playlists
            return (
                f"uuid IN (SELECT ps.song_uuid FROM playlist_songs ps "
                f"JOIN playlists p ON ps.playlist_id = p.id "
                f"WHERE {name_condition} AND (p.user_id = ? OR p.is_public = 1))",
                [name_value, user_id]
            )
        else:
            # No user context - only public playlists
            return (
                f"uuid IN (SELECT ps.song_uuid FROM playlist_songs ps "
                f"JOIN playlists p ON ps.playlist_id = p.id "
                f"WHERE {name_condition} AND p.is_public = 1)",
                [name_value]
            )

    if db_field == 'filename':
        # Extract filename from path
        if sql_op in ('LIKE', 'NOT LIKE'):
            value = f'%{cond.value}%'
        else:
            value = cond.value
        # Use SUBSTR to get filename
        return f"SUBSTR(file, LENGTH(file) - LENGTH(REPLACE(file, '/', '')) + 1) {sql_op} ?", [value]

    # Handle LIKE operators - add wildcards
    if sql_op == 'LIKE':
        return f"{db_field} LIKE ?", [f'%{cond.value}%']
    if sql_op == 'NOT LIKE':
        return f"{db_field} NOT LIKE ?", [f'%{cond.value}%']

    # Handle numeric fields
    if db_field in NUMERIC_FIELDS:
        try:
            value = int(cond.value)
        except ValueError:
            try:
                value = float(cond.value)
            except ValueError:
                raise ValueError(f"Expected numeric value for {cond.field}, got: {cond.value}")
        return f"{db_field} {sql_op} ?", [value]
    else:
        value = cond.value

    # For string fields, use COLLATE NOCASE for case-insensitive equality/inequality
    if sql_op in ('=', '!='):
        return f"{db_field} {sql_op} ? COLLATE NOCASE", [value]

    return f"{db_field} {sql_op} ?", [value]


def _build_text_search(search: TextSearch) -> Tuple[str, List]:
    """Build SQL for a text search across all fields."""
    if not search.value:
        return "1=1", []

    # Search across multiple text fields
    fields = ['title', 'artist', 'album', 'category', 'genre']
    conditions = [f"{f} LIKE ?" for f in fields]
    params = [f'%{search.value}%'] * len(fields)

    return f"({' OR '.join(conditions)})", params


# Convenience function for direct use
def search_to_sql(query: str, user_id: Optional[str] = None) -> Tuple[str, List]:
    """
    Convert a search query string directly to SQL.

    Args:
        query: Search query string
        user_id: Optional user ID for tag queries

    Returns:
        Tuple of (where_clause, params)

    Examples:
        >>> search_to_sql("Beatles")
        ("(title LIKE ? OR artist LIKE ? OR album LIKE ? OR category LIKE ? OR genre LIKE ?)",
         ['%Beatles%', '%Beatles%', '%Beatles%', '%Beatles%', '%Beatles%'])

        >>> search_to_sql("g:eq:Rock AND a:mt:Beatles")
        ("(genre = ? AND artist LIKE ?)", ['Rock', '%Beatles%'])
    """
    try:
        ast = parse_query(query)
        return build_sql(ast, user_id)
    except Exception as e:
        # Fallback: treat entire query as text search
        return _build_text_search(TextSearch(query))


# AI search analysis functions

@dataclass
class AISearchInfo:
    """Information about AI search components in a query."""
    has_ai: bool
    text_prompts: List[str]  # List of ai:prompt values
    subqueries: List[ASTNode]  # List of ai(subquery) AST nodes
    context_ast: Optional[ASTNode]  # Non-AI portion of the AST for context


def extract_ai_info(ast: ASTNode) -> AISearchInfo:
    """
    Extract AI search information from an AST.

    Returns an AISearchInfo object containing:
    - has_ai: Whether any AI search nodes are present
    - text_prompts: List of text prompts from ai:prompt syntax
    - subqueries: List of subquery ASTs from ai(subquery) syntax
    - context_ast: The non-AI portion of the AST (for filtering context)
    """
    text_prompts = []
    subqueries = []

    def collect_ai_nodes(node: ASTNode):
        """Recursively collect AI nodes."""
        if isinstance(node, AITextSearch):
            text_prompts.append(node.prompt)
        elif isinstance(node, AISubquerySearch):
            subqueries.append(node.subquery)
        elif isinstance(node, AndNode):
            collect_ai_nodes(node.left)
            collect_ai_nodes(node.right)
        elif isinstance(node, OrNode):
            collect_ai_nodes(node.left)
            collect_ai_nodes(node.right)
        elif isinstance(node, NotNode):
            collect_ai_nodes(node.child)

    def remove_ai_nodes(node: ASTNode) -> Optional[ASTNode]:
        """Remove AI nodes from AST, returning the non-AI portion."""
        if isinstance(node, (AITextSearch, AISubquerySearch)):
            return None
        elif isinstance(node, AndNode):
            left = remove_ai_nodes(node.left)
            right = remove_ai_nodes(node.right)
            if left is None and right is None:
                return None
            elif left is None:
                return right
            elif right is None:
                return left
            else:
                return AndNode(left, right)
        elif isinstance(node, OrNode):
            left = remove_ai_nodes(node.left)
            right = remove_ai_nodes(node.right)
            if left is None and right is None:
                return None
            elif left is None:
                return right
            elif right is None:
                return left
            else:
                return OrNode(left, right)
        elif isinstance(node, NotNode):
            child = remove_ai_nodes(node.child)
            if child is None:
                return None
            return NotNode(child)
        else:
            # FieldCondition, TextSearch - keep as is
            return node

    collect_ai_nodes(ast)
    context_ast = remove_ai_nodes(ast)

    return AISearchInfo(
        has_ai=bool(text_prompts or subqueries),
        text_prompts=text_prompts,
        subqueries=subqueries,
        context_ast=context_ast
    )


def get_stable_seed(query: str) -> int:
    """Generate a stable random seed from query string for deterministic sampling."""
    import hashlib
    return int(hashlib.md5(query.encode()).hexdigest()[:8], 16)


def sample_uuids(uuids: List[str], count: int, seed: int) -> List[str]:
    """Sample UUIDs with a stable random seed for deterministic results."""
    import random
    if len(uuids) <= count:
        return uuids
    rng = random.Random(seed)
    return rng.sample(uuids, count)


def build_uuid_constraint(uuids: List[str]) -> Tuple[str, List]:
    """Build SQL constraint for a list of UUIDs."""
    if not uuids:
        return "1=0", []  # No results
    placeholders = ','.join(['?'] * len(uuids))
    return f"uuid IN ({placeholders})", list(uuids)

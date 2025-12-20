"""
Advanced Search Query Parser for Music Player

Supports:
- Boolean operators: AND, OR, NOT
- Grouping with parentheses: (a OR b) AND c
- Field-specific queries: g:eq:Rock, a:mt:Beatles, a:Beatles (shorthand)
- Numeric comparisons: year:gte:1980, bpm:lt:120
- All text comparisons are case-insensitive

Syntax:
    QUERY      := EXPR | EXPR 'OR' QUERY
    EXPR       := TERM | TERM 'AND' EXPR | TERM EXPR
    TERM       := 'NOT' ATOM | ATOM
    ATOM       := '(' QUERY ')' | FIELD ':' OP ':' VALUE | FIELD ':' VALUE | VALUE

Fields:
    c = category
    g = genre
    a = artist
    aa = album_artist
    l = album (aLbum)
    n = title (Name)
    t = tag (requires user context)
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
        atom    := '(' query ')' | field_cond | text_search
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
                                    TokenType.VALUE):
            if self.current.type == TokenType.AND:
                self._advance()

            if self.current.type in (TokenType.NOT, TokenType.LPAREN,
                                     TokenType.FIELD_OP_VALUE, TokenType.VALUE):
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

        if self.current.type == TokenType.FIELD_OP_VALUE:
            field, op, value = self.current.value
            self._advance()
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

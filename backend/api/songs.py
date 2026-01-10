"""
Songs API module for mrepo.

Provides song listing, searching, and retrieval endpoints.
"""

import re

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


@api_method('songs_list', require='user')
def songs_list(cursor=None, limit=50, sort='title', order='asc',
               category=None, genre=None, artist=None, album=None):
    """
    List songs with cursor-based pagination.

    Args:
        cursor: Pagination cursor (UUID to start after)
        limit: Max results (default 50, max 200)
        sort: Sort field (title, artist, album, category, genre, year)
        order: Sort order (asc, desc)
        category, genre, artist, album: Optional filters

    Returns:
        {items: [...], nextCursor: str|null, hasMore: bool, totalCount: int}
    """
    limit = min(int(limit), 200)
    sort = sort if sort in ('title', 'artist', 'album', 'category', 'genre', 'year') else 'title'
    order = 'DESC' if order.lower() == 'desc' else 'ASC'

    conn = get_db()
    cur = conn.cursor()

    # Build WHERE clause
    conditions = []
    params = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if genre:
        conditions.append("genre = ?")
        params.append(genre)
    if artist:
        conditions.append("artist = ?")
        params.append(artist)
    if album:
        conditions.append("album = ?")
        params.append(album)

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    # Get total count
    cur.execute(f"SELECT COUNT(*) FROM songs WHERE {where_clause}", params)
    total_count = cur.fetchone()[0]

    # Add cursor condition
    if cursor:
        if order == 'ASC':
            conditions.append(f"({sort}, uuid) > ((SELECT {sort} FROM songs WHERE uuid = ?), ?)")
        else:
            conditions.append(f"({sort}, uuid) < ((SELECT {sort} FROM songs WHERE uuid = ?), ?)")
        params.extend([cursor, cursor])
        where_clause = " AND ".join(conditions)

    # Query with limit + 1 to check if more exist
    query = f"""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs
        WHERE {where_clause}
        ORDER BY {sort} {order}, uuid {order}
        LIMIT ?
    """
    params.append(limit + 1)

    cur.execute(query, params)
    rows = cur.fetchall()

    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = items[-1]['uuid'] if has_more and items else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count
    }


@api_method('songs_get', require='user')
def songs_get(uuid, details=None):
    """Get a single song by UUID."""
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs WHERE uuid = ?
    """, (uuid,))

    row = cur.fetchone()

    if row is None:
        return {'error': 'Song not found'}
    return row_to_dict(row)


@api_method('songs_get_bulk', require='user')
def songs_get_bulk(uuids, details=None):
    """Get multiple songs by UUID."""
    if not uuids:
        return []

    conn = get_db()
    cur = conn.cursor()

    placeholders = ','.join('?' * len(uuids))

    cur.execute(f"""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs WHERE uuid IN ({placeholders})
    """, uuids)

    rows = cur.fetchall()
    return [row_to_dict(row) for row in rows]


@api_method('songs_search', require='user')
def songs_search(query, cursor=None, offset=None, limit=50, details=None):
    """
    Search songs using full-text search or advanced query syntax.

    Supports AI search syntax:
    - ai:prompt - Semantic search using text embeddings
    - ai(subquery) - Find songs similar to subquery results

    Returns:
        {items: [...], nextCursor: str|null, hasMore: bool, totalCount: int, aiUsed: bool}
    """
    from ..music_search import parse_query, build_sql, extract_ai_info
    from ..config import get_config

    limit = min(int(limit), 200)
    offset = int(offset) if offset is not None else None
    conn = get_db()
    cur = conn.cursor()

    ai_used = False

    try:
        ast = parse_query(query)
        ai_info = extract_ai_info(ast)

        # Check if AI search is requested and service URL is configured
        if ai_info.has_ai and get_config('ai', 'service_url'):
            return _handle_ai_search(ast, ai_info, cursor, offset, limit, details, original_query=query)

        where_clause, params = build_sql(ast)
    except Exception:
        # Fall back to FTS for simple queries
        where_clause = "uuid IN (SELECT uuid FROM songs_fts WHERE songs_fts MATCH ?)"
        safe_query = re.sub(r'[^\w\s]', ' ', query)
        params = [safe_query + '*']

    # Get total count
    count_sql = f"SELECT COUNT(*) as cnt FROM songs WHERE {where_clause}"
    cur.execute(count_sql, params)
    total_count = cur.fetchone()['cnt']

    # Use offset-based pagination if offset provided
    if offset is not None:
        query_sql = f"""
            SELECT uuid, key, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   bpm, seekable, replay_gain_track, replay_gain_album
            FROM songs
            WHERE {where_clause}
            ORDER BY uuid
            LIMIT ? OFFSET ?
        """
        cur.execute(query_sql, params + [limit + 1, offset])
    else:
        cursor_params = list(params)
        cursor_where = where_clause
        if cursor:
            cursor_where = f"({where_clause}) AND uuid > ?"
            cursor_params.append(cursor)

        query_sql = f"""
            SELECT uuid, key, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   bpm, seekable, replay_gain_track, replay_gain_album
            FROM songs
            WHERE {cursor_where}
            ORDER BY uuid
            LIMIT ?
        """
        cursor_params.append(limit + 1)
        cur.execute(query_sql, cursor_params)

    rows = cur.fetchall()

    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = items[-1]['uuid'] if has_more and items else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count,
        'offset': offset if offset is not None else 0,
        'aiUsed': ai_used
    }


def _handle_ai_search(ast, ai_info, cursor, offset, limit, details, original_query=None):
    """Handle search queries containing AI components."""
    import requests
    from ..music_search import build_sql, get_stable_seed, sample_uuids
    from ..config import get_config

    conn = get_db()
    cur = conn.cursor()

    ai_service_url = get_config('ai', 'service_url')
    ai_timeout = get_config('ai', 'search_timeout') or 5.0

    if not ai_service_url:
        # AI not configured, fall back to non-AI search
        where_clause, params = build_sql(ast)
        return _execute_standard_search(where_clause, params, cursor, offset, limit, False)

    # Get user's AI preferences
    user_id = details.get('user_id') if details else None
    ai_search_max = 2000
    ai_search_diversity = 0.3

    if user_id:
        cur.execute("""
            SELECT ai_search_max, ai_search_diversity
            FROM user_preferences WHERE user_id = ?
        """, (user_id,))
        prefs = cur.fetchone()
        if prefs:
            ai_search_max = prefs['ai_search_max'] or 2000
            ai_search_diversity = prefs['ai_search_diversity'] if prefs['ai_search_diversity'] is not None else 0.3

    # Build context query from non-AI portion
    context_uuids = None
    if ai_info.context_ast:
        context_where, context_params = build_sql(ai_info.context_ast)
        cur.execute(f"SELECT uuid FROM songs WHERE {context_where}", context_params)
        context_uuids = [row['uuid'] for row in cur.fetchall()]

        # If context filter returns no results, return empty
        if not context_uuids:
            return {
                'items': [],
                'nextCursor': None,
                'hasMore': False,
                'totalCount': 0,
                'offset': offset if offset is not None else 0,
                'aiUsed': True
            }

    # Handle AI text search (ai:prompt) - supports multiple prompts with AND semantics
    if ai_info.text_prompts:
        all_ai_uuids = None

        for prompt in ai_info.text_prompts:
            try:
                response = requests.post(
                    f"{ai_service_url}/search/text",
                    json={
                        'query': prompt,
                        'limit': ai_search_max,  # Use user preference
                        'diversity': ai_search_diversity,  # Use user preference
                        'filter_uuids': context_uuids
                    },
                    timeout=ai_timeout
                )

                if response.status_code == 200:
                    result = response.json()
                    uuids = set(r['uuid'] for r in result.get('results', []))
                    if all_ai_uuids is None:
                        all_ai_uuids = uuids
                    else:
                        # Intersection for AND semantics
                        all_ai_uuids &= uuids
            except requests.RequestException:
                pass

        if all_ai_uuids:
            return _fetch_songs_by_uuids(list(all_ai_uuids), cursor, offset, limit, True)

    # Handle AI subquery search (ai(subquery))
    if ai_info.subqueries:
        subquery_ast = ai_info.subqueries[0]
        subquery_where, subquery_params = build_sql(subquery_ast)

        # Get songs matching the subquery (up to 1000 for sampling)
        cur.execute(f"SELECT uuid FROM songs WHERE {subquery_where} LIMIT 1000", subquery_params)
        subquery_uuids = [row['uuid'] for row in cur.fetchall()]

        if subquery_uuids:
            # Use deterministic sampling for stable results
            # Generate seed from the original query for deterministic behavior
            seed = get_stable_seed(original_query or str(subquery_ast))
            # Sample up to 10 seeds (like swapi-apps)
            seed_uuids = sample_uuids(subquery_uuids, 10, seed)

            try:
                response = requests.post(
                    f"{ai_service_url}/search/batch_similar",
                    json={
                        'uuids': seed_uuids,
                        'limit': limit * 2,
                        'filter_uuids': context_uuids
                    },
                    timeout=ai_timeout
                )

                if response.status_code == 200:
                    result = response.json()
                    matched_uuids = [r['uuid'] for r in result.get('results', [])]
                    # Exclude seed songs from results
                    seed_set = set(subquery_uuids)  # Exclude all subquery songs
                    matched_uuids = [u for u in matched_uuids if u not in seed_set]
                    return _fetch_songs_by_uuids(matched_uuids, cursor, offset, limit, True)
            except requests.RequestException:
                pass  # Fall through to standard search

    # Fallback: execute standard search ignoring AI nodes
    where_clause, params = build_sql(ast)
    return _execute_standard_search(where_clause, params, cursor, offset, limit, False)


def _execute_standard_search(where_clause, params, cursor, offset, limit, ai_used):
    """Execute a standard SQL-based search."""
    conn = get_db()
    cur = conn.cursor()

    # Get total count
    count_sql = f"SELECT COUNT(*) as cnt FROM songs WHERE {where_clause}"
    cur.execute(count_sql, params)
    total_count = cur.fetchone()['cnt']

    # Use offset-based pagination if offset provided
    if offset is not None:
        query_sql = f"""
            SELECT uuid, key, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   bpm, seekable, replay_gain_track, replay_gain_album
            FROM songs
            WHERE {where_clause}
            ORDER BY uuid
            LIMIT ? OFFSET ?
        """
        cur.execute(query_sql, params + [limit + 1, offset])
    else:
        cursor_params = list(params)
        cursor_where = where_clause
        if cursor:
            cursor_where = f"({where_clause}) AND uuid > ?"
            cursor_params.append(cursor)

        query_sql = f"""
            SELECT uuid, key, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   bpm, seekable, replay_gain_track, replay_gain_album
            FROM songs
            WHERE {cursor_where}
            ORDER BY uuid
            LIMIT ?
        """
        cursor_params.append(limit + 1)
        cur.execute(query_sql, cursor_params)

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = items[-1]['uuid'] if has_more and items else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count,
        'offset': offset if offset is not None else 0,
        'aiUsed': ai_used
    }


def _fetch_songs_by_uuids(uuids, cursor, offset, limit, ai_used):
    """Fetch songs by a list of UUIDs, preserving order."""
    if not uuids:
        return {
            'items': [],
            'nextCursor': None,
            'hasMore': False,
            'totalCount': 0,
            'offset': offset if offset is not None else 0,
            'aiUsed': ai_used
        }

    conn = get_db()
    cur = conn.cursor()

    # Apply pagination
    start_idx = offset if offset is not None else 0
    if cursor:
        try:
            start_idx = uuids.index(cursor) + 1
        except ValueError:
            start_idx = 0

    paginated_uuids = uuids[start_idx:start_idx + limit + 1]

    if not paginated_uuids:
        return {
            'items': [],
            'nextCursor': None,
            'hasMore': False,
            'totalCount': len(uuids),
            'offset': start_idx,
            'aiUsed': ai_used
        }

    # Fetch songs
    placeholders = ','.join('?' * len(paginated_uuids[:limit]))
    cur.execute(f"""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs
        WHERE uuid IN ({placeholders})
    """, paginated_uuids[:limit])

    rows = cur.fetchall()

    # Preserve original order from AI results
    uuid_to_row = {row['uuid']: row_to_dict(row) for row in rows}
    items = [uuid_to_row[u] for u in paginated_uuids[:limit] if u in uuid_to_row]

    has_more = len(paginated_uuids) > limit
    next_cursor = items[-1]['uuid'] if has_more and items else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': len(uuids),
        'offset': start_idx,
        'aiUsed': ai_used
    }


@api_method('songs_quick_search', require='user')
def songs_quick_search(query, limit=10, details=None):
    """
    Quick search returning sectioned results (artists, albums, songs, folders).
    """
    if not query or not query.strip():
        return {
            'artists': [], 'albums': [], 'songs': [], 'folders': [],
            'artistsHasMore': False, 'albumsHasMore': False,
            'songsHasMore': False, 'foldersHasMore': False
        }

    query = query.strip()
    query_lower = query.lower()
    limit = min(int(limit), 50)
    conn = get_db()
    cur = conn.cursor()

    safe_query = re.sub(r'[^\w\s]', ' ', query).strip()
    if not safe_query:
        safe_query = query

    fts_prefix = f'"{safe_query}"*'
    like_pattern = f'%{query_lower}%'

    # Find matching artists
    artists = []
    artists_has_more = False
    try:
        cur.execute("""
            SELECT s.artist, COUNT(*) as song_count
            FROM songs s
            JOIN songs_fts f ON s.uuid = f.uuid
            WHERE songs_fts MATCH ?
              AND s.artist IS NOT NULL AND s.artist != ''
            GROUP BY s.artist
            ORDER BY song_count DESC
            LIMIT ?
        """, (f'artist:{fts_prefix}', limit + 1))
        rows = cur.fetchall()
        artists_has_more = len(rows) > limit
        for row in rows[:limit]:
            name = row['artist']
            relevance = 1.0 if name.lower() == query_lower else (0.8 if name.lower().startswith(query_lower) else 0.6)
            artists.append({'name': name, 'song_count': row['song_count'], 'relevance': relevance})
    except Exception:
        cur.execute("""
            SELECT artist, COUNT(*) as song_count
            FROM songs
            WHERE artist IS NOT NULL AND artist != '' AND LOWER(artist) LIKE ?
            GROUP BY artist ORDER BY song_count DESC LIMIT ?
        """, (like_pattern, limit + 1))
        rows = cur.fetchall()
        artists_has_more = len(rows) > limit
        for row in rows[:limit]:
            artists.append({'name': row['artist'], 'song_count': row['song_count'], 'relevance': 0.6})

    # Find matching albums
    albums = []
    albums_has_more = False
    try:
        cur.execute("""
            SELECT s.album, s.artist, COUNT(*) as song_count
            FROM songs s
            JOIN songs_fts f ON s.uuid = f.uuid
            WHERE songs_fts MATCH ?
              AND s.album IS NOT NULL AND s.album != ''
            GROUP BY s.album, s.artist
            ORDER BY song_count DESC
            LIMIT ?
        """, (f'album:{fts_prefix}', limit + 1))
        rows = cur.fetchall()
        albums_has_more = len(rows) > limit
        for row in rows[:limit]:
            name = row['album']
            relevance = 0.95 if name.lower() == query_lower else (0.75 if name.lower().startswith(query_lower) else 0.55)
            albums.append({'name': name, 'artist': row['artist'], 'song_count': row['song_count'], 'relevance': relevance})
    except Exception:
        cur.execute("""
            SELECT album, artist, COUNT(*) as song_count
            FROM songs
            WHERE album IS NOT NULL AND album != '' AND LOWER(album) LIKE ?
            GROUP BY album, artist ORDER BY song_count DESC LIMIT ?
        """, (like_pattern, limit + 1))
        rows = cur.fetchall()
        albums_has_more = len(rows) > limit
        for row in rows[:limit]:
            albums.append({'name': row['album'], 'artist': row['artist'], 'song_count': row['song_count'], 'relevance': 0.55})

    # Find matching songs
    songs = []
    songs_has_more = False
    try:
        cur.execute("""
            SELECT s.uuid, s.title, s.artist, s.album, s.category, s.genre, s.file,
                   s.duration_seconds, s.seekable
            FROM songs s
            JOIN songs_fts f ON s.rowid = f.rowid
            WHERE songs_fts MATCH ?
            ORDER BY s.title
            LIMIT ?
        """, (f'title:{fts_prefix}', limit + 1))
        rows = cur.fetchall()
        songs_has_more = len(rows) > limit
        for row in rows[:limit]:
            title = row['title']
            relevance = 0.9 if title.lower() == query_lower else (0.7 if title.lower().startswith(query_lower) else 0.5)
            songs.append({
                'uuid': row['uuid'], 'title': title, 'artist': row['artist'],
                'album': row['album'], 'category': row['category'], 'genre': row['genre'],
                'file': row['file'], 'duration_seconds': row['duration_seconds'],
                'seekable': row['seekable'], 'relevance': relevance
            })
    except Exception:
        cur.execute("""
            SELECT uuid, title, artist, album, category, genre, file,
                   duration_seconds, seekable
            FROM songs WHERE LOWER(title) LIKE ? LIMIT ?
        """, (like_pattern, limit + 1))
        rows = cur.fetchall()
        songs_has_more = len(rows) > limit
        for row in rows[:limit]:
            songs.append({
                'uuid': row['uuid'], 'title': row['title'], 'artist': row['artist'],
                'album': row['album'], 'category': row['category'], 'genre': row['genre'],
                'file': row['file'], 'duration_seconds': row['duration_seconds'],
                'seekable': row['seekable'], 'relevance': 0.5
            })

    # Folders search - find directories containing matching files
    folders = []
    folders_has_more = False
    # Get matching files and extract directories in Python
    cur.execute("""
        SELECT file FROM songs WHERE LOWER(file) LIKE ? LIMIT 1000
    """, (like_pattern,))
    matched_files = cur.fetchall()

    # Extract directories and count
    dir_counts = {}
    for row in matched_files:
        file_path = row['file']
        if '/' in file_path:
            # Get parent directory
            dir_path = '/'.join(file_path.split('/')[:-1])
            if dir_path:
                dir_counts[dir_path] = dir_counts.get(dir_path, 0) + 1

    # Sort by count descending
    sorted_dirs = sorted(dir_counts.items(), key=lambda x: x[1], reverse=True)
    folders_has_more = len(sorted_dirs) > limit

    for path, count in sorted_dirs[:limit]:
        name = path.rstrip('/').split('/')[-1] if path else ''
        folders.append({'path': path, 'name': name, 'song_count': count, 'relevance': 0.5})

    return {
        'artists': artists,
        'albums': albums,
        'songs': songs,
        'folders': folders,
        'artistsHasMore': artists_has_more,
        'albumsHasMore': albums_has_more,
        'songsHasMore': songs_has_more,
        'foldersHasMore': folders_has_more
    }


@api_method('songs_random', require='user')
def songs_random(filter_query=None, count=1):
    """Get random song(s), optionally filtered. Returns single song dict if count=1."""
    conn = get_db()
    cur = conn.cursor()

    count = min(int(count), 50)

    if filter_query:
        from ..music_search import parse_query, build_sql
        try:
            ast = parse_query(filter_query)
            where_clause, params = build_sql(ast)
        except Exception:
            where_clause = "1=1"
            params = []
    else:
        where_clause = "1=1"
        params = []

    cur.execute(f"""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs
        WHERE {where_clause}
        ORDER BY RANDOM()
        LIMIT ?
    """, params + [count])

    rows = cur.fetchall()
    items = rows_to_list(rows)
    # Return single item when count=1, otherwise return list
    return items[0] if count == 1 and items else items


@api_method('songs_count', require='user')
def songs_count(category=None, genre=None, artist=None, album=None):
    """Count songs with optional filters."""
    conn = get_db()
    cur = conn.cursor()

    conditions = []
    params = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if genre:
        conditions.append("genre = ?")
        params.append(genre)
    if artist:
        conditions.append("artist = ?")
        params.append(artist)
    if album:
        conditions.append("album = ?")
        params.append(album)

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    cur.execute(f"SELECT COUNT(*) FROM songs WHERE {where_clause}", params)
    return {'count': cur.fetchone()[0]}


@api_method('songs_by_path', require='user')
def songs_by_path(path, cursor=None, limit=100, details=None):
    """Get songs by file path prefix with pagination."""
    conn = get_db()
    cur = conn.cursor()

    limit = min(int(limit), 1000)
    offset = int(cursor) if cursor else 0

    # Get total count
    cur.execute("""
        SELECT COUNT(*) FROM songs WHERE file LIKE ?
    """, (path + '%',))
    total_count = cur.fetchone()[0]

    cur.execute("""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs
        WHERE file LIKE ?
        ORDER BY file
        LIMIT ? OFFSET ?
    """, (path + '%', limit + 1, offset))

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = str(offset + limit) if has_more else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count
    }


@api_method('songs_by_filter', require='user')
def songs_by_filter(category=None, genre=None, artist=None, album=None,
                    cursor=None, limit=100):
    """Get songs matching filters with pagination."""
    conn = get_db()
    cur = conn.cursor()

    limit = min(int(limit), 1000)
    offset = int(cursor) if cursor else 0

    conditions = []
    params = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if genre:
        conditions.append("genre = ?")
        params.append(genre)
    if artist:
        conditions.append("artist = ?")
        params.append(artist)
    if album:
        conditions.append("album = ?")
        params.append(album)

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    # Get total count
    cur.execute(f"SELECT COUNT(*) FROM songs WHERE {where_clause}", params)
    total_count = cur.fetchone()[0]

    # Fixed sort order matching original
    order_by = 'artist, album, track_number, title, uuid'

    cur.execute(f"""
        SELECT uuid, key, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               bpm, seekable, replay_gain_track, replay_gain_album
        FROM songs
        WHERE {where_clause}
        ORDER BY {order_by}
        LIMIT ? OFFSET ?
    """, params + [limit + 1, offset])

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = str(offset + limit) if has_more else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count
    }


@api_method('songs_fts_ranked', require='user')
def songs_fts_ranked(query, limit=50):
    """
    Ranked full-text search using FTS5 BM25 scoring.

    Returns songs ranked by relevance with weighted field scoring:
    - Title matches weighted highest
    - Artist matches weighted high
    - Album matches weighted medium
    - Genre/category matches weighted lower

    Args:
        query: Search query string
        limit: Max results (default 50, max 200)

    Returns:
        {items: [...], totalCount: int}
    """
    limit = min(int(limit), 200)
    conn = get_db()
    cur = conn.cursor()

    if not query or not query.strip():
        return {'items': [], 'totalCount': 0}

    # Sanitize query for FTS
    safe_query = re.sub(r'[^\w\s]', ' ', query.strip())
    if not safe_query:
        return {'items': [], 'totalCount': 0}

    fts_query = safe_query + '*'

    try:
        # Use BM25 ranking with field weights:
        # title (10), artist (5), album (3), genre (1), category (1)
        cur.execute("""
            SELECT s.uuid, s.key, s.type, s.category, s.genre, s.artist, s.album,
                   s.title, s.file, s.album_artist, s.track_number, s.disc_number,
                   s.year, s.duration_seconds, s.bpm, s.seekable,
                   s.replay_gain_track, s.replay_gain_album,
                   bm25(songs_fts, 10.0, 5.0, 3.0, 1.0, 1.0) as rank
            FROM songs s
            JOIN songs_fts f ON s.uuid = f.uuid
            WHERE songs_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (fts_query, limit))

        rows = cur.fetchall()
        items = rows_to_list(rows)

        # Get total count
        cur.execute("""
            SELECT COUNT(*) FROM songs_fts WHERE songs_fts MATCH ?
        """, (fts_query,))
        total_count = cur.fetchone()[0]

    except Exception:
        # Fallback to simple LIKE search if FTS fails
        like_pattern = f'%{safe_query}%'
        cur.execute("""
            SELECT uuid, key, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   bpm, seekable, replay_gain_track, replay_gain_album
            FROM songs
            WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
            ORDER BY
                CASE WHEN LOWER(title) LIKE ? THEN 0 ELSE 1 END,
                CASE WHEN LOWER(artist) LIKE ? THEN 0 ELSE 1 END,
                title
            LIMIT ?
        """, (like_pattern, like_pattern, like_pattern,
              f'{safe_query.lower()}%', f'{safe_query.lower()}%', limit))

        rows = cur.fetchall()
        items = rows_to_list(rows)
        total_count = len(items)

    return {
        'items': items,
        'totalCount': total_count
    }

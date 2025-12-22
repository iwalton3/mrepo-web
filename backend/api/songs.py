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
def songs_search(query, cursor=None, offset=None, limit=50):
    """
    Search songs using full-text search or advanced query syntax.

    Returns:
        {items: [...], nextCursor: str|null, hasMore: bool, totalCount: int}
    """
    from ..music_search import parse_query, build_sql

    limit = min(int(limit), 200)
    offset = int(offset) if offset is not None else None
    conn = get_db()
    cur = conn.cursor()

    try:
        ast = parse_query(query)
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
        'offset': offset if offset is not None else 0
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

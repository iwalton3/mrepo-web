"""
Browse API module for mrepo.

Provides hierarchical browsing by category, genre, artist, album.
Uses offset-based pagination (cursor is offset as string).
"""

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


@api_method('browse_categories', require='user')
def browse_categories(sort=None):
    """List all categories with song counts.

    Args:
        sort: 'name' (default) or 'song_count' for descending by count
    """
    conn = get_db()
    cur = conn.cursor()

    order_clause = "ORDER BY song_count DESC, category" if sort == 'song_count' else "ORDER BY category"

    cur.execute(f"""
        SELECT category as name, COUNT(*) as song_count
        FROM songs
        WHERE category IS NOT NULL AND category != ''
        GROUP BY category
        {order_clause}
    """)

    rows = cur.fetchall()
    items = rows_to_list(rows)

    return {
        'items': items,
        'totalCount': len(items),
        'hasMore': False
    }


@api_method('browse_genres', require='user')
def browse_genres(category=None, min_songs=None, sort=None):
    """List genres with song counts, optionally filtered by category.

    Args:
        category: Optional category filter
        min_songs: Minimum song count to include (default None = no filter)
        sort: 'name' (default) or 'song_count' for descending by count
    """
    conn = get_db()
    cur = conn.cursor()

    # Use parameterized HAVING clause for safety
    min_songs_val = int(min_songs) if min_songs is not None and int(min_songs) > 0 else None
    having_clause = "HAVING COUNT(*) >= ?" if min_songs_val else ""

    order_clause = "ORDER BY song_count DESC, genre" if sort == 'song_count' else "ORDER BY genre"

    if category:
        params = [category]
        if min_songs_val:
            params.append(min_songs_val)
        cur.execute(f"""
            SELECT genre as name, COUNT(*) as song_count
            FROM songs
            WHERE genre IS NOT NULL AND genre != '' AND category = ?
            GROUP BY genre
            {having_clause}
            {order_clause}
        """, params)
    else:
        params = [min_songs_val] if min_songs_val else []
        cur.execute(f"""
            SELECT genre as name, COUNT(*) as song_count
            FROM songs
            WHERE genre IS NOT NULL AND genre != ''
            GROUP BY genre
            {having_clause}
            {order_clause}
        """, params)

    rows = cur.fetchall()
    items = rows_to_list(rows)

    # Calculate total songs for [All Genres] entry
    if category:
        cur.execute("SELECT COUNT(*) FROM songs WHERE category = ?", (category,))
    else:
        cur.execute("SELECT COUNT(*) FROM songs")
    total_songs = cur.fetchone()[0]

    # Prepend [All Genres] entry to skip genre selection
    all_genres_entry = {
        'name': '[All Genres]',
        'song_count': total_songs
    }
    items.insert(0, all_genres_entry)

    return {
        'items': items,
        'totalCount': len(items),
        'hasMore': False
    }


@api_method('browse_artists', require='user')
def browse_artists(category=None, genre=None, cursor=None, limit=100, min_songs=None, sort=None):
    """List artists with song counts, paginated.

    Args:
        category: Optional category filter
        genre: Optional genre filter
        cursor: Pagination cursor (offset as string)
        limit: Max items to return
        min_songs: Minimum song count to include
        sort: 'name' (default) or 'song_count' for descending by count
    """
    limit = min(int(limit), 1000)
    conn = get_db()
    cur = conn.cursor()

    conditions = ["artist IS NOT NULL AND artist != ''"]
    params = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if genre:
        conditions.append("genre = ?")
        params.append(genre)

    where_clause = " AND ".join(conditions)

    # Use parameterized HAVING clause for safety
    min_songs_val = int(min_songs) if min_songs is not None and int(min_songs) > 0 else None
    having_clause = "HAVING COUNT(*) >= ?" if min_songs_val else ""

    # Get total artist count (with min_songs filter but without cursor)
    count_params = params + ([min_songs_val] if min_songs_val else [])
    cur.execute(f"""
        SELECT COUNT(*) FROM (
            SELECT artist FROM songs WHERE {where_clause}
            GROUP BY artist {having_clause}
        )
    """, count_params)
    total_artist_count = cur.fetchone()[0]

    # Get total song count for [All Artists] entry
    cur.execute(f"""
        SELECT COUNT(*) FROM songs WHERE {where_clause}
    """, params)
    total_song_count = cur.fetchone()[0]

    # Count songs without artist (for [Unknown Artist] entry)
    unknown_conditions = ["(artist IS NULL OR artist = '')"]
    unknown_params = []
    if category:
        unknown_conditions.append("category = ?")
        unknown_params.append(category)
    if genre:
        unknown_conditions.append("genre = ?")
        unknown_params.append(genre)
    unknown_where = " AND ".join(unknown_conditions)

    cur.execute(f"""
        SELECT COUNT(*) FROM songs WHERE {unknown_where}
    """, unknown_params)
    unknown_count = cur.fetchone()[0]

    # Use offset-based pagination (cursor is offset as string)
    offset = int(cursor) if cursor else 0

    order_clause = "ORDER BY song_count DESC, artist" if sort == 'song_count' else "ORDER BY artist"

    main_params = params + ([min_songs_val] if min_songs_val else []) + [limit + 1, offset]
    cur.execute(f"""
        SELECT artist as name, COUNT(*) as song_count
        FROM songs
        WHERE {where_clause}
        GROUP BY artist
        {having_clause}
        {order_clause}
        LIMIT ?
        OFFSET ?
    """, main_params)

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = str(offset + limit) if has_more else None

    # Prepend special entries on first page
    if not cursor:
        # [Unknown Artist] for songs without artist info
        if unknown_count > 0:
            unknown_entry = {
                'name': '[Unknown Artist]',
                'song_count': unknown_count
            }
            items.insert(0, unknown_entry)

        # [All Artists] to skip artist selection
        all_artists_entry = {
            'name': '[All Artists]',
            'song_count': total_song_count + unknown_count
        }
        items.insert(0, all_artists_entry)

    # totalCount includes special entries: +1 for [All Artists], +1 for [Unknown Artist] if present
    special_entries = 1 + (1 if unknown_count > 0 else 0)

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_artist_count + special_entries
    }


@api_method('browse_albums', require='user')
def browse_albums(artist=None, category=None, genre=None, cursor=None, limit=100, sort=None, details=None):
    """List albums with song counts, paginated.

    Args:
        artist: Optional artist filter (use '[Unknown Artist]' for songs without artist)
        category: Optional category filter
        genre: Optional genre filter
        cursor: Pagination cursor (offset as string)
        limit: Max items to return
        sort: 'name' (default) or 'song_count' for descending by count
    """
    limit = min(int(limit), 1000)
    conn = get_db()
    cur = conn.cursor()

    conditions = ["album IS NOT NULL AND album != ''"]
    params = []

    # Handle special artist values
    if artist == '[Unknown Artist]':
        conditions.append("(artist IS NULL OR artist = '')")
    elif artist:
        conditions.append("artist = ?")
        params.append(artist)
    if category:
        conditions.append("category = ?")
        params.append(category)
    if genre:
        conditions.append("genre = ?")
        params.append(genre)

    where_clause = " AND ".join(conditions)

    # Get total album count
    cur.execute(f"""
        SELECT COUNT(*) FROM (
            SELECT album FROM songs WHERE {where_clause}
            GROUP BY album, COALESCE(album_artist, artist)
        )
    """, params)
    total_album_count = cur.fetchone()[0]

    # Get total song count for [All Albums]
    cur.execute(f"""
        SELECT COUNT(*) FROM songs WHERE {where_clause}
    """, params)
    total_song_count = cur.fetchone()[0]

    # Check for songs without albums (unknown album)
    unknown_conditions = ["(album IS NULL OR album = '')"]
    unknown_params = []
    if artist == '[Unknown Artist]':
        unknown_conditions.append("(artist IS NULL OR artist = '')")
    elif artist:
        unknown_conditions.append("artist = ?")
        unknown_params.append(artist)
    if category:
        unknown_conditions.append("category = ?")
        unknown_params.append(category)
    if genre:
        unknown_conditions.append("genre = ?")
        unknown_params.append(genre)
    unknown_where = " AND ".join(unknown_conditions)

    cur.execute(f"""
        SELECT COUNT(*) FROM songs WHERE {unknown_where}
    """, unknown_params)
    unknown_count = cur.fetchone()[0]

    # If there are songs without albums, add to total album count
    if unknown_count > 0:
        total_album_count += 1

    # Use offset-based pagination
    offset = int(cursor) if cursor else 0

    if sort == 'song_count':
        order_clause = "ORDER BY song_count DESC, album, display_artist"
    else:
        order_clause = "ORDER BY album, display_artist"

    cur.execute(f"""
        SELECT
            album as name,
            COALESCE(album_artist, artist) as display_artist,
            COUNT(*) as song_count,
            MIN(year) as year
        FROM songs
        WHERE {where_clause}
        GROUP BY album, COALESCE(album_artist, artist)
        {order_clause}
        LIMIT ?
        OFFSET ?
    """, params + [limit + 1, offset])

    rows = cur.fetchall()

    # Convert to list with 'artist' key for compatibility
    items = []
    for row in rows[:limit]:
        items.append({
            'name': row['name'],
            'artist': row['display_artist'],
            'song_count': row['song_count'],
            'year': row['year']
        })

    has_more = len(rows) > limit
    next_cursor = str(offset + limit) if has_more else None

    # Prepend special entries on first page
    if not cursor:
        # [Unknown Album] for songs without album info
        if unknown_count > 0:
            unknown_entry = {
                'name': '[Unknown Album]',
                'artist': artist,
                'song_count': unknown_count,
                'year': None
            }
            items.insert(0, unknown_entry)

        # [All Albums] to skip album selection
        all_albums_entry = {
            'name': '[All Albums]',
            'artist': artist,
            'song_count': total_song_count + unknown_count,
            'year': None
        }
        items.insert(0, all_albums_entry)

    # totalCount includes special entries
    special_entries = 1 + (1 if unknown_count > 0 else 0)

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_album_count + special_entries
    }


@api_method('browse_album_songs', require='user')
def browse_album_songs(album, artist=None, category=None, genre=None, cursor=None, limit=100):
    """Get all songs in an album with smart ordering.

    Special cases:
    - album='[Unknown Album]' returns songs without album metadata
    - album='[All Albums]' or album=None returns all songs (filtered by other params)

    Args:
        album: Album name, '[Unknown Album]', '[All Albums]', or None
        artist: Optional artist filter
        category: Optional category filter
        genre: Optional genre filter
        cursor: Pagination cursor (offset as string)
        limit: Max items to return
    """
    limit = min(int(limit), 1000)
    conn = get_db()
    cur = conn.cursor()

    # Handle special album values
    if album == '[Unknown Album]':
        base_conditions = ["(album IS NULL OR album = '')"]
        base_params = []
    elif album == '[All Albums]' or album is None:
        base_conditions = []
        base_params = []
    else:
        base_conditions = ["album = ?"]
        base_params = [album]

    # Handle special artist values
    if artist == '[Unknown Artist]':
        base_conditions.append("(artist IS NULL OR artist = '')")
    elif artist:
        base_conditions.append("artist = ?")
        base_params.append(artist)
    if category:
        base_conditions.append("category = ?")
        base_params.append(category)
    if genre:
        base_conditions.append("genre = ?")
        base_params.append(genre)

    base_where = " AND ".join(base_conditions) if base_conditions else "1=1"

    # Check album completeness for smart sorting
    cur.execute(f"""
        SELECT COUNT(*) as total,
               COUNT(track_number) as with_tracks,
               MAX(track_number) as max_track,
               COUNT(DISTINCT disc_number) as disc_count,
               COUNT(DISTINCT album) as album_count
        FROM songs
        WHERE {base_where}
    """, base_params)

    stats = cur.fetchone()
    total_songs = stats['total']
    with_tracks = stats['with_tracks']
    max_track = stats['max_track'] or 0
    disc_count = stats['disc_count'] or 1
    album_count = stats['album_count'] or 0

    # Album is "complete" if:
    # 1. Most songs have track numbers (>80%)
    # 2. We have roughly the expected number of tracks (>90% of max_track)
    # 3. All songs are from a single album
    is_sorted_by_track = False
    if with_tracks > 0 and total_songs > 0:
        has_track_numbers = (with_tracks / total_songs) >= 0.8
        is_complete = max_track > 0 and (total_songs >= max_track * 0.9)
        is_single_album = album_count <= 1 or album is not None
        is_sorted_by_track = has_track_numbers and is_complete and is_single_album

    # Choose sort order based on completeness
    if is_sorted_by_track:
        order_clause = "disc_number ASC NULLS FIRST, track_number ASC NULLS LAST, title ASC, uuid ASC"
    else:
        order_clause = "title ASC, uuid ASC"

    # Use offset-based pagination
    offset = int(cursor) if cursor else 0

    cur.execute(f"""
        SELECT uuid, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               seekable, replay_gain_track, replay_gain_album, key, bpm
        FROM songs
        WHERE {base_where}
        ORDER BY {order_clause}
        LIMIT ?
        OFFSET ?
    """, base_params + [limit + 1, offset])

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = str(offset + limit) if has_more else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_songs,
        'isSortedByTrack': is_sorted_by_track,
        'discCount': disc_count
    }


@api_method('browse_album_artists', require='user')
def browse_album_artists(category=None, genre=None, cursor=None, limit=100, min_songs=None):
    """List album artists (from album_artist field)."""
    limit = min(int(limit), 1000)
    conn = get_db()
    cur = conn.cursor()

    conditions = ["album_artist IS NOT NULL AND album_artist != ''"]
    params = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if genre:
        conditions.append("genre = ?")
        params.append(genre)

    where_clause = " AND ".join(conditions)

    # Use parameterized HAVING clause for safety
    min_songs_val = int(min_songs) if min_songs is not None and int(min_songs) > 0 else None
    having_clause = "HAVING COUNT(*) >= ?" if min_songs_val else ""

    # Get total count
    count_params = params + ([min_songs_val] if min_songs_val else [])
    cur.execute(f"""
        SELECT COUNT(*) FROM (
            SELECT album_artist FROM songs WHERE {where_clause}
            GROUP BY album_artist {having_clause}
        )
    """, count_params)
    total_count = cur.fetchone()[0]

    # Use offset-based pagination
    offset = int(cursor) if cursor else 0

    main_params = params + ([min_songs_val] if min_songs_val else []) + [limit + 1, offset]
    cur.execute(f"""
        SELECT album_artist as name, COUNT(DISTINCT album) as album_count, COUNT(*) as song_count
        FROM songs
        WHERE {where_clause}
        GROUP BY album_artist
        {having_clause}
        ORDER BY album_artist
        LIMIT ?
        OFFSET ?
    """, main_params)

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


@api_method('browse_artist_songs', require='user')
def browse_artist_songs(artist_id, role=None, cursor=None, limit=100):
    """Get all songs by an artist.

    Args:
        artist_id: Artist name (required)
        role: Filter by role - 'artist' or 'album_artist' (default: both)
        cursor: Pagination cursor (offset as string)
        limit: Maximum songs to return
    """
    limit = min(int(limit), 1000)
    conn = get_db()
    cur = conn.cursor()

    artist_name = artist_id
    if not artist_name:
        raise ValueError('artist_id is required')

    # Default order: album, disc, track, title
    order_by = 'album, disc_number, track_number, title'

    # Build condition based on role filter
    if role == 'artist':
        condition = "artist = ?"
        params = [artist_name]
    elif role == 'album_artist':
        condition = "album_artist = ?"
        params = [artist_name]
    else:
        condition = "(artist = ? OR album_artist = ?)"
        params = [artist_name, artist_name]

    # Get total count
    cur.execute(f"""
        SELECT COUNT(*) FROM songs WHERE {condition}
    """, params)
    total_count = cur.fetchone()[0]

    # Use offset-based pagination
    offset = int(cursor) if cursor else 0

    cur.execute(f"""
        SELECT uuid, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               seekable, replay_gain_track, replay_gain_album, key, bpm
        FROM songs
        WHERE {condition}
        ORDER BY {order_by}
        LIMIT ?
        OFFSET ?
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


@api_method('browse_path', require='user')
def browse_path(path='/', cursor=None, limit=100, sort=None, details=None):
    """Browse by file path (directory listing style).

    Returns directories and files at the given path level.
    Uses offset-based pagination.

    For absolute paths (starting with /), the first directory level shows
    top-level folders like 'home', 'media', etc.

    Args:
        path: Directory path to browse (e.g., '/', '/home/user/music')
        cursor: Pagination cursor (offset as string)
        limit: Max items to return
        sort: 'name' (default) or 'song_count' for descending by count
    """
    limit = min(int(limit), 1000)
    offset = int(cursor) if cursor else 0
    conn = get_db()
    cur = conn.cursor()

    # Normalize path - keep leading slash for absolute paths
    path = path.rstrip('/')
    if not path:
        path = '/'

    # Order clause
    if sort == 'song_count':
        dir_order = "song_count DESC, name COLLATE NOCASE ASC"
    else:
        dir_order = "name COLLATE NOCASE ASC"

    if path == '/':
        # Root level for absolute paths
        # Extract first directory component after leading /
        # e.g., /home/user/music/song.mp3 -> 'home'
        cur.execute(f"""
            SELECT
                CASE
                    WHEN file LIKE '/%' AND INSTR(SUBSTR(file, 2), '/') > 0
                    THEN SUBSTR(file, 2, INSTR(SUBSTR(file, 2), '/') - 1)
                    WHEN file LIKE '/%'
                    THEN SUBSTR(file, 2)
                    WHEN INSTR(file, '/') > 0
                    THEN SUBSTR(file, 1, INSTR(file, '/') - 1)
                    ELSE file
                END as name,
                COUNT(*) as song_count
            FROM songs
            GROUP BY name
            HAVING name IS NOT NULL AND name != ''
            ORDER BY {dir_order}
        """)

        dir_rows = cur.fetchall()
        directories = [{'type': 'directory', 'name': row['name'], 'song_count': row['song_count']} for row in dir_rows]
        files = []

    else:
        # Non-root: get subdirectories and files in this path
        # Ensure path has leading / for absolute paths
        prefix = path + '/'
        prefix_len = len(prefix) + 1

        # Get subdirectories with song counts
        cur.execute(f"""
            SELECT
                CASE
                    WHEN INSTR(SUBSTR(file, ?), '/') > 0
                    THEN SUBSTR(file, ?, INSTR(SUBSTR(file, ?), '/') - 1)
                    ELSE NULL
                END as name,
                COUNT(*) as song_count
            FROM songs
            WHERE file LIKE ?
              AND LENGTH(file) > ?
            GROUP BY name
            HAVING name IS NOT NULL AND name != ''
            ORDER BY {dir_order}
        """, (prefix_len, prefix_len, prefix_len, prefix + '%', len(prefix)))

        dir_rows = cur.fetchall()
        directories = [{'type': 'directory', 'name': row['name'], 'song_count': row['song_count']} for row in dir_rows]

        # Get files directly in this folder (files that start with prefix but have no more slashes)
        cur.execute("""
            SELECT uuid, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   seekable, replay_gain_track, replay_gain_album, key, bpm
            FROM songs
            WHERE file LIKE ? AND file NOT LIKE ?
            ORDER BY title COLLATE NOCASE
        """, (prefix + '%', prefix + '%/%'))

        file_rows = cur.fetchall()
        files = [dict(row) | {'type': 'file', 'name': row['title'] or row['file'].rsplit('/', 1)[-1]} for row in file_rows]

    # Combine directories and files
    all_items = directories + files
    total_count = len(all_items)

    # Apply pagination
    paginated_items = all_items[offset:offset + limit]
    has_more = (offset + limit) < total_count
    next_cursor = str(offset + limit) if has_more else None

    return {
        'path': path,
        'items': paginated_items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count
    }


@api_method('browse_genres_normalized', require='user')
def browse_genres_normalized(category=None, cursor=None, limit=100, min_songs=None):
    """List genres from normalized genre table if available."""
    conn = get_db()
    cur = conn.cursor()

    # Check if normalized genres table exists
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='genres'")
    if not cur.fetchone():
        # Fall back to non-normalized
        return browse_genres(category=category, cursor=cursor, limit=limit, min_songs=min_songs)

    limit = min(int(limit), 200)
    offset = int(cursor) if cursor else 0

    # Use parameterized HAVING clause for safety
    min_songs_val = int(min_songs) if min_songs is not None and int(min_songs) > 0 else None
    having_clause = "HAVING COUNT(DISTINCT sg.song_uuid) >= ?" if min_songs_val else ""

    # Build query with optional category filter
    if category:
        # Get total count with category filter
        cur.execute(f"""
            SELECT COUNT(DISTINCT g.id) FROM genres g
            JOIN song_genres sg ON g.id = sg.genre_id
            JOIN songs s ON sg.song_uuid = s.uuid
            WHERE s.category = ?
        """, (category,))
        total_count = cur.fetchone()[0]

        main_params = [category] + ([min_songs_val] if min_songs_val else []) + [limit + 1, offset]
        cur.execute(f"""
            SELECT g.id as genre_id, g.display_name as name, COUNT(DISTINCT sg.song_uuid) as song_count
            FROM genres g
            JOIN song_genres sg ON g.id = sg.genre_id
            JOIN songs s ON sg.song_uuid = s.uuid
            WHERE s.category = ?
            GROUP BY g.id
            {having_clause}
            ORDER BY g.display_name
            LIMIT ?
            OFFSET ?
        """, main_params)
    else:
        # Get total count without filter
        cur.execute("SELECT COUNT(*) FROM genres")
        total_count = cur.fetchone()[0]

        main_params = ([min_songs_val] if min_songs_val else []) + [limit + 1, offset]
        cur.execute(f"""
            SELECT g.id as genre_id, g.display_name as name, COUNT(DISTINCT sg.song_uuid) as song_count
            FROM genres g
            LEFT JOIN song_genres sg ON g.id = sg.genre_id
            GROUP BY g.id
            {having_clause}
            ORDER BY g.display_name
            LIMIT ?
            OFFSET ?
        """, main_params)

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

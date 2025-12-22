"""
Radio API module for mrepo.

Provides radio mode using filter-based song selection.
API-compatible with the original swapi-apps music.py radio methods.
"""

import secrets
import re
from datetime import datetime

from ..app import api_method
from ..db import get_db, rows_to_list, row_to_dict


def _parse_filter_query(filter_query):
    """
    Parse a filter query string into SQL conditions.

    Supports:
    - c:eq:Value - category equals
    - g:eq:Value - genre equals
    - a:eq:Value - artist equals
    - a:mt:Value - artist matches (contains)
    - year:gte:Value - year >= value
    - year:lte:Value - year <= value
    - AND/OR connectors

    Returns (where_clause, params)
    """
    if not filter_query:
        return "1=1", []

    conditions = []
    params = []

    # Split by AND/OR (simple parsing)
    parts = re.split(r'\s+AND\s+', filter_query, flags=re.IGNORECASE)

    for part in parts:
        part = part.strip()
        if not part:
            continue

        # Parse field:op:value format
        match = re.match(r'^(\w+):(\w+):(.+)$', part)
        if not match:
            continue

        field, op, value = match.groups()

        # Map field abbreviations to column names
        field_map = {
            'c': 'category',
            'g': 'genre',
            'a': 'artist',
            'aa': 'album_artist',
            'al': 'album',
            't': 'title',
            'year': 'year',
        }

        column = field_map.get(field.lower(), field.lower())

        if op == 'eq':
            conditions.append(f"{column} = ?")
            params.append(value)
        elif op == 'mt':
            conditions.append(f"{column} LIKE ?")
            params.append(f"%{value}%")
        elif op == 'gte':
            conditions.append(f"{column} >= ?")
            params.append(value)
        elif op == 'lte':
            conditions.append(f"{column} <= ?")
            params.append(value)

    if not conditions:
        return "1=1", []

    return " AND ".join(conditions), params


def _get_song_by_uuid(cur, uuid):
    """Get full song details by UUID."""
    cur.execute("""
        SELECT uuid, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               seekable, replay_gain_track, replay_gain_album, key, bpm
        FROM songs WHERE uuid = ?
    """, (uuid,))
    return cur.fetchone()


def _get_random_song(cur, filter_query=None):
    """Get a random song, optionally filtered."""
    where_clause, params = _parse_filter_query(filter_query)
    cur.execute(f"""
        SELECT uuid, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               seekable, replay_gain_track, replay_gain_album, key, bpm
        FROM songs WHERE {where_clause}
        ORDER BY RANDOM() LIMIT 1
    """, params)
    return cur.fetchone()


def _populate_queue(cur, session_id, seed_song, count=10, filter_query=None):
    """
    Populate the radio queue with songs similar to the seed.

    Simple algorithm: find songs in the same category/genre as seed,
    excluding already-queued songs.
    """
    where_clause, params = _parse_filter_query(filter_query)

    # Get existing queue UUIDs to exclude
    cur.execute("""
        SELECT song_uuid FROM radio_queue WHERE session_id = ?
    """, (session_id,))
    existing = {row['song_uuid'] for row in cur.fetchall()}

    # Start with filter conditions
    conditions = [where_clause] if where_clause != "1=1" else []
    query_params = list(params)

    # If no filter, try to match seed's category/genre
    if not filter_query and seed_song:
        if seed_song['category']:
            conditions.append("category = ?")
            query_params.append(seed_song['category'])
        if seed_song['genre']:
            conditions.append("genre = ?")
            query_params.append(seed_song['genre'])

    final_where = " AND ".join(conditions) if conditions else "1=1"

    # Get candidate songs
    cur.execute(f"""
        SELECT uuid, type, category, genre, artist, album, title, file,
               album_artist, track_number, disc_number, year, duration_seconds,
               seekable, replay_gain_track, replay_gain_album, key, bpm
        FROM songs
        WHERE {final_where}
        ORDER BY RANDOM()
        LIMIT ?
    """, query_params + [count * 3])  # Get extra to filter out existing

    candidates = [row for row in cur.fetchall() if row['uuid'] not in existing]

    # If not enough songs, try without category/genre filter
    if len(candidates) < count and filter_query is None:
        cur.execute("""
            SELECT uuid, type, category, genre, artist, album, title, file,
                   album_artist, track_number, disc_number, year, duration_seconds,
                   seekable, replay_gain_track, replay_gain_album, key, bpm
            FROM songs
            ORDER BY RANDOM()
            LIMIT ?
        """, (count * 3,))
        more = [row for row in cur.fetchall()
                if row['uuid'] not in existing and row['uuid'] not in {c['uuid'] for c in candidates}]
        candidates.extend(more)

    # Take only what we need
    selected = candidates[:count]

    # Get max position
    cur.execute("""
        SELECT MAX(position) FROM radio_queue WHERE session_id = ?
    """, (session_id,))
    result = cur.fetchone()
    next_pos = (result[0] or -1) + 1

    # Insert into queue
    for song in selected:
        cur.execute("""
            INSERT INTO radio_queue (session_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (session_id, song['uuid'], next_pos))
        next_pos += 1

    return [row_to_dict(s) for s in selected]


@api_method('radio_start', require='user')
def radio_start(seed_uuid=None, filter_query=None, details=None):
    """
    Start a new radio session.

    Args:
        seed_uuid: Optional seed song UUID (random if not provided)
        filter_query: Optional search filter to constrain radio

    Returns:
        {session_id, seed: {...}, queue: [...]}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    session_id = secrets.token_urlsafe(16)

    # Get or select seed song
    if seed_uuid:
        seed = _get_song_by_uuid(cur, seed_uuid)
    else:
        seed = _get_random_song(cur, filter_query)

    if not seed:
        return {'error': 'No songs found matching filter'}

    # Create session
    cur.execute("""
        INSERT INTO radio_sessions (session_id, user_id, filter_query, seed_uuid)
        VALUES (?, ?, ?, ?)
    """, (session_id, user_id, filter_query, seed['uuid']))

    # Populate initial queue
    queue = _populate_queue(cur, session_id, seed, count=10, filter_query=filter_query)

    # Sync radio queue to user_queue table so it persists across refreshes
    # Clear existing queue
    cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

    # Add seed song first, then queue songs
    all_songs = [row_to_dict(seed)] + queue
    for i, song in enumerate(all_songs):
        cur.execute("""
            INSERT INTO user_queue (user_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (user_id, song['uuid'], i))

    # Populate sca_song_pool with songs matching the filter
    # This allows sca_populate_queue to add more songs during playback
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))

    where_clause, params = _parse_filter_query(filter_query)
    cur.execute(f"""
        INSERT INTO sca_song_pool (user_id, song_uuid)
        SELECT ?, uuid FROM songs WHERE {where_clause}
    """, [user_id] + params)

    # Enable SCA mode in playback state so it persists across refreshes
    cur.execute("""
        INSERT INTO user_playback_state (user_id, sca_enabled, queue_index, updated_at)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET sca_enabled = 1, queue_index = 0, updated_at = ?
    """, (user_id, datetime.utcnow(), datetime.utcnow()))

    return {
        'session_id': session_id,
        'seed': row_to_dict(seed),
        'queue': queue
    }


@api_method('radio_next', require='user')
def radio_next(session_id, details=None):
    """
    Get the next song from the radio queue.

    If queue is low, automatically populates more songs.
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Get session
    cur.execute("""
        SELECT session_id, filter_query, seed_uuid FROM radio_sessions
        WHERE session_id = ? AND user_id = ?
    """, (session_id, user_id))
    session = cur.fetchone()

    if not session:
        return {'error': 'Session not found'}

    # Get next from queue
    cur.execute("""
        SELECT rq.position, s.uuid, s.type, s.category, s.genre, s.artist, s.album,
               s.title, s.file, s.album_artist, s.track_number, s.disc_number,
               s.year, s.duration_seconds, s.seekable,
               s.replay_gain_track, s.replay_gain_album, s.key, s.bpm
        FROM radio_queue rq
        JOIN songs s ON rq.song_uuid = s.uuid
        WHERE rq.session_id = ?
        ORDER BY rq.position
        LIMIT 1
    """, (session_id,))
    next_item = cur.fetchone()

    if not next_item:
        # Queue empty, try to populate more
        seed = _get_song_by_uuid(cur, session['seed_uuid'])
        _populate_queue(cur, session_id, seed, count=10, filter_query=session['filter_query'])

        # Try again
        cur.execute("""
            SELECT rq.position, s.uuid, s.type, s.category, s.genre, s.artist, s.album,
                   s.title, s.file, s.album_artist, s.track_number, s.disc_number,
                   s.year, s.duration_seconds, s.seekable,
                   s.replay_gain_track, s.replay_gain_album, s.key, s.bpm
            FROM radio_queue rq
            JOIN songs s ON rq.song_uuid = s.uuid
            WHERE rq.session_id = ?
            ORDER BY rq.position
            LIMIT 1
        """, (session_id,))
        next_item = cur.fetchone()

    if not next_item:
        return {'error': 'No more songs available'}

    # Remove from queue
    cur.execute("""
        DELETE FROM radio_queue WHERE session_id = ? AND position = ?
    """, (session_id, next_item['position']))

    # Update session activity and seed
    cur.execute("""
        UPDATE radio_sessions SET last_activity = ?, seed_uuid = ?
        WHERE session_id = ?
    """, (datetime.utcnow(), next_item['uuid'], session_id))

    # Check if queue is running low, repopulate if needed
    cur.execute("""
        SELECT COUNT(*) FROM radio_queue WHERE session_id = ?
    """, (session_id,))
    remaining = cur.fetchone()[0]

    if remaining < 5:
        _populate_queue(cur, session_id, next_item, count=10 - remaining,
                       filter_query=session['filter_query'])

    result = row_to_dict(next_item)
    del result['position']
    return result


@api_method('radio_skip', require='user')
def radio_skip(session_id, song_uuid, position_seconds=0, details=None):
    """Record a skip event for learning."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Record in history as skipped (if we have the record)
    cur.execute("""
        UPDATE play_history
        SET skipped = 1, play_duration_seconds = ?
        WHERE user_id = ? AND song_uuid = ?
        ORDER BY played_at DESC
        LIMIT 1
    """, (position_seconds, user_id, song_uuid))

    return {'success': True}


@api_method('radio_queue', require='user')
def radio_queue(session_id, limit=10, details=None):
    """Get upcoming songs in the radio queue."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify session ownership
    cur.execute("""
        SELECT session_id FROM radio_sessions WHERE session_id = ? AND user_id = ?
    """, (session_id, user_id))

    if not cur.fetchone():
        return {'items': [], 'session_id': None}

    cur.execute("""
        SELECT s.uuid, s.type, s.category, s.genre, s.artist, s.album, s.title,
               s.file, s.album_artist, s.duration_seconds, s.seekable,
               s.track_number, s.disc_number, s.year,
               s.replay_gain_track, s.replay_gain_album, s.key, s.bpm
        FROM radio_queue rq
        JOIN songs s ON rq.song_uuid = s.uuid
        WHERE rq.session_id = ?
        ORDER BY rq.position
        LIMIT ?
    """, (session_id, limit))

    return {
        'items': rows_to_list(cur.fetchall()),
        'session_id': session_id
    }


# SCA (Song Continuity Algorithm) Methods - these use the user's queue

@api_method('sca_start_from_queue', require='user')
def sca_start_from_queue(details=None):
    """Initialize SCA with songs from the current queue."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Clear existing pool
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))

    # Copy queue to pool
    cur.execute("""
        INSERT INTO sca_song_pool (user_id, song_uuid)
        SELECT user_id, song_uuid FROM user_queue WHERE user_id = ?
    """, (user_id,))

    # Enable SCA mode
    cur.execute("""
        INSERT INTO user_playback_state (user_id, sca_enabled, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(user_id) DO UPDATE SET sca_enabled = 1, updated_at = ?
    """, (user_id, datetime.utcnow(), datetime.utcnow()))

    cur.execute("SELECT COUNT(*) FROM sca_song_pool WHERE user_id = ?", (user_id,))
    count = cur.fetchone()[0]

    return {'success': True, 'poolSize': count}


@api_method('sca_start_from_playlist', require='user')
def sca_start_from_playlist(playlist_id, details=None):
    """Initialize SCA with songs from a playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Check access
    cur.execute("""
        SELECT user_id, is_public FROM playlists WHERE id = ?
    """, (playlist_id,))
    playlist = cur.fetchone()

    if not playlist:
        raise ValueError('Playlist not found')
    # Compare as strings since user_id column is TEXT
    if str(playlist['user_id']) != str(user_id) and not playlist['is_public']:
        raise ValueError('Access denied')

    # Clear existing pool
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))

    # Copy playlist to pool
    cur.execute("""
        INSERT INTO sca_song_pool (user_id, song_uuid)
        SELECT ?, song_uuid FROM playlist_songs WHERE playlist_id = ?
    """, (user_id, playlist_id))

    # Enable SCA mode
    cur.execute("""
        INSERT INTO user_playback_state (user_id, sca_enabled, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(user_id) DO UPDATE SET sca_enabled = 1, updated_at = ?
    """, (user_id, datetime.utcnow(), datetime.utcnow()))

    cur.execute("SELECT COUNT(*) FROM sca_song_pool WHERE user_id = ?", (user_id,))
    count = cur.fetchone()[0]

    return {'success': True, 'poolSize': count}


@api_method('sca_populate_queue', require='user')
def sca_populate_queue(count=5, details=None):
    """Add songs from the SCA pool to the queue."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    count = min(int(count), 20)

    # Get random songs from pool that aren't already in queue, with full metadata
    cur.execute("""
        SELECT s.uuid, s.type, s.category, s.genre, s.artist, s.album, s.title,
               s.file, s.album_artist, s.track_number, s.disc_number, s.year,
               s.duration_seconds, s.seekable, s.replay_gain_track, s.replay_gain_album,
               s.key, s.bpm
        FROM songs s
        JOIN sca_song_pool p ON s.uuid = p.song_uuid
        WHERE p.user_id = ?
          AND s.uuid NOT IN (SELECT song_uuid FROM user_queue WHERE user_id = ?)
        ORDER BY RANDOM()
        LIMIT ?
    """, (user_id, user_id, count))

    songs = rows_to_list(cur.fetchall())

    if not songs:
        return {'added': 0, 'songs': [], 'message': 'Pool exhausted'}

    # Get max position
    cur.execute("SELECT MAX(position) FROM user_queue WHERE user_id = ?", (user_id,))
    result = cur.fetchone()
    next_pos = (result[0] or -1) + 1

    for song in songs:
        cur.execute("""
            INSERT INTO user_queue (user_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (user_id, song['uuid'], next_pos))
        next_pos += 1

    return {'added': len(songs), 'songs': songs}


@api_method('sca_stop', require='user')
def sca_stop(details=None):
    """Stop SCA mode. Queue remains, pool is cleared."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Disable SCA
    cur.execute("""
        UPDATE user_playback_state SET sca_enabled = 0, updated_at = ?
        WHERE user_id = ?
    """, (datetime.utcnow(), user_id))

    # Clear pool
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))

    return {'success': True}


@api_method('sca_get_pool', require='user')
def sca_get_pool(details=None):
    """Get the current SCA pool."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT s.uuid, s.title, s.artist, s.album, s.duration_seconds,
               s.type, s.seekable, s.key, s.bpm
        FROM sca_song_pool p
        JOIN songs s ON p.song_uuid = s.uuid
        WHERE p.user_id = ?
        ORDER BY s.artist, s.album, s.title
    """, (user_id,))

    rows = cur.fetchall()
    return {'items': rows_to_list(rows)}

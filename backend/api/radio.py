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

ROLLING_SEED_THRESHOLD = 200  # Playlists/queues below this use rolling seed mode


def _setup_rolling_seed_mode(cur, user_id, song_uuids, pool_size):
    """Set up rolling seed mode for small pools."""
    # Clear and set up original seeds
    cur.execute("DELETE FROM sca_original_seeds WHERE user_id = ?", (user_id,))
    for uuid in song_uuids:
        cur.execute("""
            INSERT OR IGNORE INTO sca_original_seeds (user_id, song_uuid)
            VALUES (?, ?)
        """, (user_id, uuid))

    # Enable rolling seed mode
    cur.execute("""
        INSERT INTO sca_rolling_seed_state (user_id, rolling_seed_enabled, original_pool_size)
        VALUES (?, 1, ?)
        ON CONFLICT(user_id) DO UPDATE SET rolling_seed_enabled = 1, original_pool_size = ?
    """, (user_id, pool_size, pool_size))


def _clear_rolling_seed_mode(cur, user_id):
    """Clear rolling seed mode."""
    cur.execute("DELETE FROM sca_original_seeds WHERE user_id = ?", (user_id,))
    cur.execute("""
        INSERT INTO sca_rolling_seed_state (user_id, rolling_seed_enabled, original_pool_size)
        VALUES (?, 0, 0)
        ON CONFLICT(user_id) DO UPDATE SET rolling_seed_enabled = 0, original_pool_size = 0
    """, (user_id,))


def _regenerate_rolling_seed_pool(cur, user_id):
    """
    Regenerate the pool using rolling seed logic.

    Takes half from recent queue history and half from original seeds.
    This allows continuous playback even with small playlists.
    """
    # Get original seeds
    cur.execute("""
        SELECT song_uuid FROM sca_original_seeds WHERE user_id = ?
    """, (user_id,))
    original_seeds = [row['song_uuid'] for row in cur.fetchall()]

    if not original_seeds:
        return 0

    # Get recent songs from queue (last N songs played)
    cur.execute("""
        SELECT song_uuid FROM user_queue
        WHERE user_id = ?
        ORDER BY position DESC
        LIMIT ?
    """, (user_id, len(original_seeds)))
    recent_songs = [row['song_uuid'] for row in cur.fetchall()]

    # Calculate how many from each source
    # Half from recent songs, half from original seeds
    half_size = max(len(original_seeds) // 2, 10)

    # Sample from recent songs (if we have any)
    import random
    recent_sample = random.sample(recent_songs, min(half_size, len(recent_songs))) if recent_songs else []

    # Sample from original seeds
    original_sample = random.sample(original_seeds, min(half_size, len(original_seeds)))

    # Combine and deduplicate
    new_pool = list(set(recent_sample + original_sample))

    # Clear current pool and repopulate
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))
    for uuid in new_pool:
        cur.execute("""
            INSERT OR IGNORE INTO sca_song_pool (user_id, song_uuid)
            VALUES (?, ?)
        """, (user_id, uuid))

    return len(new_pool)


@api_method('sca_start_from_queue', require='user')
def sca_start_from_queue(details=None):
    """Initialize SCA with songs from the current queue.

    Copies queue songs into SCA pool, clears queue, enables SCA mode,
    and populates initial queue from similar songs.

    For small queues (< ROLLING_SEED_THRESHOLD), uses rolling seed mode
    which searches the entire library for similar songs.
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Get queue songs first (before clearing)
    cur.execute("SELECT song_uuid FROM user_queue WHERE user_id = ? ORDER BY position", (user_id,))
    queue_uuids = [row['song_uuid'] for row in cur.fetchall()]
    queue_size = len(queue_uuids)

    if not queue_uuids:
        return {'error': 'Queue is empty'}

    # Clear existing pool and original seeds
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))
    cur.execute("DELETE FROM sca_original_seeds WHERE user_id = ?", (user_id,))

    # Copy queue to pool
    for uuid in queue_uuids:
        cur.execute("INSERT INTO sca_song_pool (user_id, song_uuid) VALUES (?, ?)", (user_id, uuid))

    # For rolling seed mode: also store as original seeds
    if queue_size < ROLLING_SEED_THRESHOLD:
        for uuid in queue_uuids:
            cur.execute("INSERT INTO sca_original_seeds (user_id, song_uuid) VALUES (?, ?)", (user_id, uuid))
        # Enable rolling seed mode
        cur.execute("""
            INSERT INTO sca_rolling_seed_state (user_id, rolling_seed_enabled, original_pool_size)
            VALUES (?, 1, ?)
            ON CONFLICT(user_id) DO UPDATE SET rolling_seed_enabled = 1, original_pool_size = ?
        """, (user_id, queue_size, queue_size))
    else:
        _clear_rolling_seed_mode(cur, user_id)

    # Clear the queue (will be repopulated with similar songs)
    cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

    # Enable SCA mode
    cur.execute("""
        INSERT INTO user_playback_state (user_id, sca_enabled, queue_index, updated_at)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET sca_enabled = 1, queue_index = 0, updated_at = ?
    """, (user_id, datetime.utcnow(), datetime.utcnow()))

    # Commit before populating (so sca_populate_queue sees the changes)
    conn.commit()

    # Check if CLAP mode is enabled and warn if seeds aren't analyzed
    from ..config import get_config
    ai_warning = None
    ai_service_url = get_config('ai', 'service_url')
    if ai_service_url and queue_size < ROLLING_SEED_THRESHOLD:
        try:
            import requests
            result = requests.post(
                f"{ai_service_url}/check/analyzed",
                json={'uuids': queue_uuids},
                timeout=5.0
            )
            if result.status_code == 200:
                data = result.json()
                analyzed_count = data.get('analyzed_count', 0)
                if analyzed_count == 0:
                    ai_warning = f"None of your {len(queue_uuids)} seed song(s) have been analyzed. AI radio will fall back to random selection. Run AI analysis from Admin page."
                elif analyzed_count < len(queue_uuids):
                    ai_warning = f"Only {analyzed_count}/{len(queue_uuids)} seed songs are analyzed. AI may have limited effectiveness."
        except:
            pass  # Non-critical check

    # Populate initial queue with similar songs
    populate_result = sca_populate_queue(count=20, details=details)

    return {
        'success': True,
        'poolSize': queue_size,
        'rollingSeedException': queue_size < ROLLING_SEED_THRESHOLD,
        'aiWarning': ai_warning,
        'added': populate_result.get('added', 0),
        'ai_used': populate_result.get('ai_used', False),
        'queue': populate_result.get('songs', [])
    }


@api_method('sca_start_from_playlist', require='user')
def sca_start_from_playlist(playlist_id, details=None):
    """Initialize SCA with songs from a playlist.

    Copies playlist songs into SCA pool, clears queue, enables SCA mode,
    and populates initial queue from similar songs.

    For small playlists (< ROLLING_SEED_THRESHOLD), uses rolling seed mode
    which searches the entire library for similar songs.
    """
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

    # Get playlist songs
    cur.execute("SELECT song_uuid FROM playlist_songs WHERE playlist_id = ? ORDER BY position", (playlist_id,))
    playlist_uuids = [row['song_uuid'] for row in cur.fetchall()]
    playlist_size = len(playlist_uuids)

    if not playlist_uuids:
        return {'error': 'Playlist is empty'}

    # Clear existing pool and original seeds
    cur.execute("DELETE FROM sca_song_pool WHERE user_id = ?", (user_id,))
    cur.execute("DELETE FROM sca_original_seeds WHERE user_id = ?", (user_id,))

    # Copy playlist to pool
    for uuid in playlist_uuids:
        cur.execute("INSERT INTO sca_song_pool (user_id, song_uuid) VALUES (?, ?)", (user_id, uuid))

    # For rolling seed mode: also store as original seeds
    if playlist_size < ROLLING_SEED_THRESHOLD:
        for uuid in playlist_uuids:
            cur.execute("INSERT INTO sca_original_seeds (user_id, song_uuid) VALUES (?, ?)", (user_id, uuid))
        # Enable rolling seed mode
        cur.execute("""
            INSERT INTO sca_rolling_seed_state (user_id, rolling_seed_enabled, original_pool_size)
            VALUES (?, 1, ?)
            ON CONFLICT(user_id) DO UPDATE SET rolling_seed_enabled = 1, original_pool_size = ?
        """, (user_id, playlist_size, playlist_size))
    else:
        _clear_rolling_seed_mode(cur, user_id)

    # Clear the queue (will be repopulated with similar songs)
    cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

    # Enable SCA mode
    cur.execute("""
        INSERT INTO user_playback_state (user_id, sca_enabled, queue_index, updated_at)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET sca_enabled = 1, queue_index = 0, updated_at = ?
    """, (user_id, datetime.utcnow(), datetime.utcnow()))

    # Commit before populating (so sca_populate_queue sees the changes)
    conn.commit()

    # Check if CLAP mode is enabled and warn if seeds aren't analyzed
    from ..config import get_config
    ai_warning = None
    ai_service_url = get_config('ai', 'service_url')
    if ai_service_url and playlist_size < ROLLING_SEED_THRESHOLD:
        try:
            import requests
            result = requests.post(
                f"{ai_service_url}/check/analyzed",
                json={'uuids': playlist_uuids},
                timeout=5.0
            )
            if result.status_code == 200:
                data = result.json()
                analyzed_count = data.get('analyzed_count', 0)
                if analyzed_count == 0:
                    ai_warning = f"None of your {len(playlist_uuids)} seed song(s) have been analyzed. AI radio will fall back to random selection. Run AI analysis from Admin page."
                elif analyzed_count < len(playlist_uuids):
                    ai_warning = f"Only {analyzed_count}/{len(playlist_uuids)} seed songs are analyzed. AI may have limited effectiveness."
        except:
            pass  # Non-critical check

    # Populate initial queue with similar songs
    populate_result = sca_populate_queue(count=20, details=details)

    return {
        'success': True,
        'poolSize': playlist_size,
        'rollingSeedException': playlist_size < ROLLING_SEED_THRESHOLD,
        'aiWarning': ai_warning,
        'added': populate_result.get('added', 0),
        'ai_used': populate_result.get('ai_used', False),
        'queue': populate_result.get('songs', [])
    }


def _clap_find_similar(seed_uuids, exclude_uuids, count, diversity=0.3):
    """
    Find similar songs from entire library using CLAP.
    Used for playlist/queue-based radio (searches whole library, not just pool).
    """
    import requests
    from ..config import get_config

    ai_service_url = get_config('ai', 'service_url')
    if not ai_service_url:
        return None

    # Use last 5 seeds plus some random earlier ones if available
    if len(seed_uuids) > 10:
        import random
        seeds = seed_uuids[-5:] + random.sample(seed_uuids[:-5], min(5, len(seed_uuids) - 5))
    else:
        seeds = seed_uuids

    try:
        result = requests.post(
            f"{ai_service_url}/playlist/generate",
            json={
                'seed_uuids': seeds,
                'size': count,
                'diversity': diversity,
                'min_duration': 30,
                'exclude_uuids': list(exclude_uuids)
            },
            timeout=10.0
        )

        if result.status_code == 200:
            data = result.json()
            return [s['uuid'] for s in data.get('songs', [])]
        else:
            # Log error from AI service
            try:
                error_data = result.json()
                print(f"CLAP find_similar failed ({result.status_code}): {error_data.get('detail', 'Unknown error')}")
            except:
                print(f"CLAP find_similar failed ({result.status_code}): {result.text[:200]}")
    except requests.RequestException as e:
        print(f"CLAP find_similar request failed: {e}")

    return None


@api_method('sca_populate_queue', require='user')
def sca_populate_queue(count=5, details=None):
    """Add songs from the SCA pool to the queue.

    Uses the user's radio_algorithm preference:
    - 'clap': Use AI similarity to search entire library (default if AI available)
    - 'sca': Use random selection from pool
    """
    import requests
    from ..config import get_config

    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    count = min(int(count), 20)

    # Get user's radio preferences
    cur.execute("""
        SELECT radio_algorithm, ai_radio_queue_diversity FROM user_preferences WHERE user_id = ?
    """, (user_id,))
    pref = cur.fetchone()

    # Determine algorithm: use preference, or default to clap if AI available
    ai_service_url = get_config('ai', 'service_url')
    if pref and pref['radio_algorithm']:
        radio_algo = pref['radio_algorithm']
    elif ai_service_url:
        radio_algo = 'clap'  # Default to CLAP if AI is available
    else:
        radio_algo = 'sca'

    # Get user's queue diversity preference (default 0.3)
    queue_diversity = (pref['ai_radio_queue_diversity'] if pref and pref['ai_radio_queue_diversity'] is not None else 0.3)

    # Get current queue UUIDs (for exclusion and seeds)
    cur.execute("SELECT song_uuid FROM user_queue WHERE user_id = ? ORDER BY position", (user_id,))
    queue_uuids = [row['song_uuid'] for row in cur.fetchall()]
    exclude_uuids = set(queue_uuids)

    songs = []
    ai_used = False
    ai_attempted = False

    if radio_algo == 'clap' and ai_service_url:
        ai_attempted = True
        # Check for original seeds - presence indicates rolling seed mode (small playlist/queue)
        cur.execute("SELECT song_uuid FROM sca_original_seeds WHERE user_id = ?", (user_id,))
        original_seeds = [row['song_uuid'] for row in cur.fetchall()]

        if original_seeds:
            # Rolling seed mode: search entire library using mix of original + recent seeds
            import random
            recent_seeds = queue_uuids[-10:] if queue_uuids else []

            # Mix: half recent, half original (for variety)
            half = max(5, len(original_seeds) // 2)
            seed_sample = recent_seeds[-half:] + random.sample(original_seeds, min(half, len(original_seeds)))

            # Exclude the original seeds (pool songs) to get new discoveries
            cur.execute("SELECT song_uuid FROM sca_song_pool WHERE user_id = ?", (user_id,))
            pool_uuids = [row['song_uuid'] for row in cur.fetchall()]
            full_exclude = exclude_uuids | set(pool_uuids)

            selected_uuids = _clap_find_similar(
                seed_uuids=seed_sample,
                exclude_uuids=full_exclude,
                count=count,
                diversity=queue_diversity  # Use user preference
            )

            if selected_uuids:
                ai_used = True
                # Get full song metadata
                placeholders = ','.join('?' * len(selected_uuids))
                cur.execute(f"""
                    SELECT uuid, type, category, genre, artist, album, title,
                           file, album_artist, track_number, disc_number, year,
                           duration_seconds, seekable, replay_gain_track, replay_gain_album,
                           key, bpm
                    FROM songs WHERE uuid IN ({placeholders})
                """, selected_uuids)

                uuid_to_song = {row['uuid']: row_to_dict(row) for row in cur.fetchall()}
                songs = [uuid_to_song[u] for u in selected_uuids if u in uuid_to_song]

        elif queue_uuids:
            # Large pool mode (filter-based): search within pool using CLAP
            cur.execute("""
                SELECT song_uuid FROM sca_song_pool
                WHERE user_id = ? AND song_uuid NOT IN (SELECT song_uuid FROM user_queue WHERE user_id = ?)
            """, (user_id, user_id))
            pool_uuids = [row['song_uuid'] for row in cur.fetchall()]

            if pool_uuids:
                selected_uuids = _clap_find_similar(
                    seed_uuids=queue_uuids[-5:],
                    exclude_uuids=exclude_uuids,
                    count=count,
                    diversity=queue_diversity  # Use user preference
                )

                # Filter to pool only
                if selected_uuids:
                    pool_set = set(pool_uuids)
                    selected_uuids = [u for u in selected_uuids if u in pool_set][:count]

                    if selected_uuids:
                        ai_used = True
                        placeholders = ','.join('?' * len(selected_uuids))
                        cur.execute(f"""
                            SELECT uuid, type, category, genre, artist, album, title,
                                   file, album_artist, track_number, disc_number, year,
                                   duration_seconds, seekable, replay_gain_track, replay_gain_album,
                                   key, bpm
                            FROM songs WHERE uuid IN ({placeholders})
                        """, selected_uuids)

                        uuid_to_song = {row['uuid']: row_to_dict(row) for row in cur.fetchall()}
                        songs = [uuid_to_song[u] for u in selected_uuids if u in uuid_to_song]

    # Fallback to random SCA if CLAP didn't work or not enabled
    if not songs:
        # Get random songs from pool that aren't already in queue
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
            # Pool exhausted - check if rolling seed mode is enabled
            cur.execute("""
                SELECT rolling_seed_enabled FROM sca_rolling_seed_state WHERE user_id = ?
            """, (user_id,))
            state = cur.fetchone()

            if state and state['rolling_seed_enabled']:
                # Regenerate pool from rolling seeds
                new_pool_size = _regenerate_rolling_seed_pool(cur, user_id)
                if new_pool_size > 0:
                    # Retry getting songs from the regenerated pool
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
                message = 'Pool exhausted'
                if ai_attempted:
                    message = 'Pool exhausted. AI search failed - ensure songs are analyzed from Admin page.'
                return {'added': 0, 'songs': [], 'message': message, 'ai_used': False, 'ai_attempted': ai_attempted}

    # Add songs to queue
    cur.execute("SELECT MAX(position) FROM user_queue WHERE user_id = ?", (user_id,))
    result = cur.fetchone()
    next_pos = (result[0] or -1) + 1

    for song in songs:
        cur.execute("""
            INSERT INTO user_queue (user_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (user_id, song['uuid'], next_pos))
        next_pos += 1

    return {'added': len(songs), 'songs': songs, 'ai_used': ai_used}


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


@api_method('sca_populate_queue_ai', require='user')
def sca_populate_queue_ai(count=5, seed_uuid=None, diversity=0.3, details=None):
    """
    Add songs to the queue using AI similarity search.

    Uses the current song (or seed_uuid) to find similar songs from the pool.
    Falls back to random selection if AI is unavailable.

    Args:
        count: Number of songs to add
        seed_uuid: Optional seed song UUID (uses current queue position if not provided)
        diversity: MMR diversity factor (0-1, higher = more diverse)
    """
    import requests
    from ..config import get_config

    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    count = min(int(count), 20)

    # Check if AI is available (auto-enable if service URL is configured)
    ai_service_url = get_config('ai', 'service_url')
    ai_timeout = get_config('ai', 'search_timeout') or 5.0

    if not ai_service_url:
        # Fall back to regular SCA
        return sca_populate_queue(count=count, details=details)

    # Get seed song (from parameter or current queue position)
    if not seed_uuid:
        cur.execute("""
            SELECT queue_index FROM user_playback_state WHERE user_id = ?
        """, (user_id,))
        state = cur.fetchone()
        queue_index = state['queue_index'] if state else 0

        cur.execute("""
            SELECT song_uuid FROM user_queue
            WHERE user_id = ?
            ORDER BY position
            LIMIT 1 OFFSET ?
        """, (user_id, queue_index))
        current = cur.fetchone()
        seed_uuid = current['song_uuid'] if current else None

    if not seed_uuid:
        # No seed available, fall back to random
        return sca_populate_queue(count=count, details=details)

    # Get pool UUIDs that aren't already in queue
    cur.execute("""
        SELECT p.song_uuid
        FROM sca_song_pool p
        WHERE p.user_id = ?
          AND p.song_uuid NOT IN (SELECT song_uuid FROM user_queue WHERE user_id = ?)
    """, (user_id, user_id))
    pool_uuids = [row['song_uuid'] for row in cur.fetchall()]

    if not pool_uuids:
        return {'added': 0, 'songs': [], 'message': 'Pool exhausted', 'ai_used': False}

    # Call AI service to find similar songs
    try:
        response = requests.post(
            f"{ai_service_url}/search/similar",
            json={
                'uuid': seed_uuid,
                'limit': count * 2,  # Get extra for filtering
                'filter_uuids': pool_uuids
            },
            timeout=ai_timeout
        )

        if response.status_code == 200:
            result = response.json()
            similar_uuids = [r['uuid'] for r in result.get('results', [])][:count]

            if similar_uuids:
                # Get full song metadata
                placeholders = ','.join('?' * len(similar_uuids))
                cur.execute(f"""
                    SELECT uuid, type, category, genre, artist, album, title,
                           file, album_artist, track_number, disc_number, year,
                           duration_seconds, seekable, replay_gain_track, replay_gain_album,
                           key, bpm
                    FROM songs WHERE uuid IN ({placeholders})
                """, similar_uuids)

                # Preserve order from AI results
                uuid_to_song = {row['uuid']: row_to_dict(row) for row in cur.fetchall()}
                songs = [uuid_to_song[u] for u in similar_uuids if u in uuid_to_song]

                if songs:
                    # Add to queue
                    cur.execute("SELECT MAX(position) FROM user_queue WHERE user_id = ?", (user_id,))
                    result = cur.fetchone()
                    next_pos = (result[0] or -1) + 1

                    for song in songs:
                        cur.execute("""
                            INSERT INTO user_queue (user_id, song_uuid, position)
                            VALUES (?, ?, ?)
                        """, (user_id, song['uuid'], next_pos))
                        next_pos += 1

                    return {'added': len(songs), 'songs': songs, 'ai_used': True}

    except requests.RequestException as e:
        # Log error but don't fail - fall back to random
        print(f"AI radio error: {e}")

    # Fall back to regular SCA if AI fails
    result = sca_populate_queue(count=count, details=details)
    result['ai_used'] = False
    return result


@api_method('sca_status', require='user')
def sca_status(details=None):
    """Get SCA/radio status including AI availability."""
    from ..config import get_config
    import requests

    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Get SCA state
    cur.execute("""
        SELECT sca_enabled FROM user_playback_state WHERE user_id = ?
    """, (user_id,))
    state = cur.fetchone()
    sca_enabled = state['sca_enabled'] if state else False

    # Get pool size
    cur.execute("SELECT COUNT(*) FROM sca_song_pool WHERE user_id = ?", (user_id,))
    pool_size = cur.fetchone()[0]

    # Check AI availability (auto-enable if service URL is configured)
    ai_service_url = get_config('ai', 'service_url')
    ai_available = False

    if ai_service_url:
        try:
            response = requests.get(f"{ai_service_url}/health", timeout=2.0)
            ai_available = response.status_code == 200
        except requests.RequestException:
            pass

    # Get user AI preference
    cur.execute("""
        SELECT ai_radio_enabled FROM user_ai_preferences WHERE user_id = ?
    """, (user_id,))
    pref = cur.fetchone()
    ai_radio_preferred = pref['ai_radio_enabled'] if pref else True

    return {
        'scaEnabled': sca_enabled,
        'poolSize': pool_size,
        'aiAvailable': ai_available,
        'aiRadioPreferred': ai_radio_preferred
    }


@api_method('sca_set_ai_preference', require='user')
def sca_set_ai_preference(enabled=True, details=None):
    """Set user preference for AI-powered radio."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        INSERT INTO user_ai_preferences (user_id, ai_radio_enabled)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET ai_radio_enabled = ?
    """, (user_id, 1 if enabled else 0, 1 if enabled else 0))

    return {'success': True, 'aiRadioEnabled': enabled}

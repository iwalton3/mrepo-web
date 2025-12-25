"""
Queue API module for mrepo.

Provides server-side queue management for playback.
"""

from datetime import datetime

from ..app import api_method
from ..db import get_db, rows_to_list


@api_method('queue_list', require='user')
def queue_list(cursor=None, limit=None, details=None):
    """Get the current user's queue."""
    # Note: cursor/limit ignored - queue is returned in full
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT s.uuid, s.type, s.category, s.genre, s.artist, s.album, s.title,
               s.file, s.album_artist, s.track_number, s.disc_number, s.year,
               s.duration_seconds, s.seekable, s.replay_gain_track, s.replay_gain_album,
               s.key, s.bpm, q.position
        FROM user_queue q
        JOIN songs s ON q.song_uuid = s.uuid
        WHERE q.user_id = ?
        ORDER BY q.position
    """, (user_id,))

    rows = cur.fetchall()

    # Get playback state
    cur.execute("""
        SELECT queue_index, play_mode, sca_enabled, volume, active_device_id, active_device_seq
        FROM user_playback_state WHERE user_id = ?
    """, (user_id,))
    state = cur.fetchone()

    active_device_id = state['active_device_id'] if state else None
    active_device_seq = state['active_device_seq'] if state else 0

    return {
        'items': rows_to_list(rows),
        'queueIndex': state['queue_index'] if state else 0,
        'activeDeviceId': active_device_id,
        'activeDeviceSeq': active_device_seq,
        'playMode': state['play_mode'] if state else 'sequential',
        'scaEnabled': bool(state['sca_enabled']) if state else False,
        'volume': state['volume'] if state else 1.0,
        'nextCursor': None,
        'hasMore': False
    }


@api_method('queue_add', require='user')
def queue_add(song_uuids, position=None, details=None, _conn=None):
    """Add songs to the queue."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not song_uuids:
        return {'success': True, 'added': 0}

    try:
        # Use BEGIN IMMEDIATE to acquire write lock for atomic position calculation
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Get current max position
        cur.execute("SELECT MAX(position) FROM user_queue WHERE user_id = ?", (user_id,))
        result = cur.fetchone()
        max_pos = result[0] if result[0] is not None else -1

        if position is None:
            # Append to end
            insert_pos = max_pos + 1
        else:
            # Insert at position, shift existing
            cur.execute("""
                UPDATE user_queue
                SET position = position + ?
                WHERE user_id = ? AND position >= ?
            """, (len(song_uuids), user_id, position))
            insert_pos = position

        added = 0
        for uuid in song_uuids:
            cur.execute("""
                INSERT INTO user_queue (user_id, song_uuid, position)
                VALUES (?, ?, ?)
            """, (user_id, uuid, insert_pos))
            insert_pos += 1
            added += 1

        # Get final queue length
        cur.execute("SELECT COUNT(*) FROM user_queue WHERE user_id = ?", (user_id,))
        queue_length = cur.fetchone()[0]

        if own_conn:
            cur.execute("COMMIT")
        return {'added': added, 'queueLength': queue_length}
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('queue_add_by_path', require='user')
def queue_add_by_path(path, position=None, limit=1000, details=None):
    """Add songs by file path to the queue."""
    conn = get_db()
    cur = conn.cursor()

    limit = min(int(limit), 5000)

    cur.execute("""
        SELECT uuid FROM songs WHERE file LIKE ? ORDER BY file LIMIT ?
    """, (path + '%', limit))

    uuids = [row['uuid'] for row in cur.fetchall()]

    if not uuids:
        return {'added': 0, 'queueLength': 0}

    return queue_add(uuids, position=position, details=details)


@api_method('queue_add_by_filter', require='user')
def queue_add_by_filter(category=None, genre=None, artist=None, album=None,
                        position=None, limit=1000, details=None):
    """Add songs matching filters to the queue."""
    conn = get_db()
    cur = conn.cursor()

    limit = min(int(limit), 5000)

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
    order_by = "artist, album, disc_number, track_number"

    cur.execute(f"""
        SELECT uuid FROM songs WHERE {where_clause} ORDER BY {order_by} LIMIT ?
    """, params + [limit])

    uuids = [row['uuid'] for row in cur.fetchall()]

    if not uuids:
        return {'added': 0, 'queueLength': 0}

    return queue_add(uuids, position=position, details=details)


@api_method('queue_add_by_playlist', require='user')
def queue_add_by_playlist(playlist_id, position=None, shuffle=False, details=None):
    """Add songs from a playlist to the queue."""
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

    order_by = "RANDOM()" if shuffle else "ps.position"

    cur.execute(f"""
        SELECT ps.song_uuid
        FROM playlist_songs ps
        WHERE ps.playlist_id = ?
        ORDER BY {order_by}
    """, (playlist_id,))

    uuids = [row['song_uuid'] for row in cur.fetchall()]

    if not uuids:
        return {'success': True, 'added': 0}

    return queue_add(uuids, position=position, details=details)


@api_method('queue_remove', require='user')
def queue_remove(positions, details=None, _conn=None):
    """Remove songs from queue by positions."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not positions:
        cur.execute("SELECT COUNT(*) FROM user_queue WHERE user_id = ?", (user_id,))
        queue_length = cur.fetchone()[0]
        return {'removed': 0, 'queueLength': queue_length}

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Sort descending to remove from end first
        positions = sorted(positions, reverse=True)

        for pos in positions:
            cur.execute("""
                DELETE FROM user_queue WHERE user_id = ? AND position = ?
            """, (user_id, pos))

        # Reorder positions
        cur.execute("""
            SELECT song_uuid FROM user_queue WHERE user_id = ? ORDER BY position
        """, (user_id,))
        songs = cur.fetchall()

        cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

        for i, song in enumerate(songs):
            cur.execute("""
                INSERT INTO user_queue (user_id, song_uuid, position)
                VALUES (?, ?, ?)
            """, (user_id, song['song_uuid'], i))

        if own_conn:
            cur.execute("COMMIT")
        return {'removed': len(positions), 'queueLength': len(songs)}
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('queue_clear', require='user')
def queue_clear(details=None, _conn=None):
    """Clear the entire queue."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Get count before clearing
        cur.execute("SELECT COUNT(*) FROM user_queue WHERE user_id = ?", (user_id,))
        count = cur.fetchone()[0]

        cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

        # Reset playback state
        cur.execute("""
            INSERT OR REPLACE INTO user_playback_state (user_id, queue_index, updated_at)
            VALUES (?, 0, ?)
        """, (user_id, datetime.utcnow()))

        if own_conn:
            cur.execute("COMMIT")
        return {'cleared': count}
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('queue_reorder', require='user')
def queue_reorder(from_pos, to_pos, details=None, _conn=None):
    """Move a song within the queue."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Get all songs
        cur.execute("""
            SELECT song_uuid FROM user_queue WHERE user_id = ? ORDER BY position
        """, (user_id,))
        songs = [row['song_uuid'] for row in cur.fetchall()]

        if from_pos < 0 or from_pos >= len(songs):
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Invalid from_pos')
        if to_pos < 0 or to_pos >= len(songs):
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Invalid to_pos')

        # Reorder in memory
        song = songs.pop(from_pos)
        songs.insert(to_pos, song)

        # Update database
        cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

        for i, uuid in enumerate(songs):
            cur.execute("""
                INSERT INTO user_queue (user_id, song_uuid, position)
                VALUES (?, ?, ?)
            """, (user_id, uuid, i))

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True}
    except ValueError:
        raise
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('queue_reorder_batch', require='user')
def queue_reorder_batch(from_positions, to_position, details=None, _conn=None):
    """Move multiple songs to a single target position (maintains relative order)."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not from_positions:
        return {'success': True}

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Get all songs
        cur.execute("""
            SELECT song_uuid FROM user_queue WHERE user_id = ? ORDER BY position
        """, (user_id,))
        songs = [row['song_uuid'] for row in cur.fetchall()]

        # Extract the songs being moved (in their current relative order)
        from_positions_sorted = sorted(from_positions)
        moving_songs = [songs[pos] for pos in from_positions_sorted if 0 <= pos < len(songs)]

        # Remove them from the list (from end to preserve indices)
        for pos in sorted(from_positions, reverse=True):
            if 0 <= pos < len(songs):
                songs.pop(pos)

        # Insert at target position
        insert_pos = min(to_position, len(songs))
        for i, song in enumerate(moving_songs):
            songs.insert(insert_pos + i, song)

        # Update database
        cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

        for i, uuid in enumerate(songs):
            cur.execute("""
                INSERT INTO user_queue (user_id, song_uuid, position)
                VALUES (?, ?, ?)
            """, (user_id, uuid, i))

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True}
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('queue_set_index', require='user')
def queue_set_index(index, device_id=None, seq=None, details=None, _conn=None):
    """Set the current playback position in the queue.

    Args:
        index: Position in queue
        device_id: Unique device identifier (for per-device sequence tracking)
        seq: Sequence number from this device (monotonically increasing per device)
    """
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # New device+seq approach: each device has its own sequence counter
        if device_id is not None and seq is not None:
            # Get stored seq for this device
            cur.execute("""
                SELECT seq FROM device_queue_seqs WHERE user_id = ? AND device_id = ?
            """, (user_id, device_id))
            row = cur.fetchone()
            stored_seq = row['seq'] if row else 0

            # Reject if seq is not higher (stale or replay)
            if seq <= stored_seq:
                if own_conn:
                    cur.execute("ROLLBACK")
                return {'success': True, 'skipped': True, 'reason': 'stale_seq'}

            # Update this device's seq
            cur.execute("""
                INSERT INTO device_queue_seqs (user_id, device_id, seq)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, device_id) DO UPDATE SET seq = ?
            """, (user_id, device_id, seq, seq))

            # Update position and mark this device as active
            cur.execute("""
                INSERT INTO user_playback_state (user_id, queue_index, updated_at, active_device_id, active_device_seq)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET queue_index = ?, updated_at = ?, active_device_id = ?, active_device_seq = ?
            """, (user_id, index, datetime.utcnow(), device_id, seq, index, datetime.utcnow(), device_id, seq))

            if own_conn:
                cur.execute("COMMIT")
            return {'success': True, 'skipped': False}

        # Legacy path: no device tracking, just update
        cur.execute("""
            INSERT INTO user_playback_state (user_id, queue_index, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET queue_index = ?, updated_at = ?
        """, (user_id, index, datetime.utcnow(), index, datetime.utcnow()))

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True, 'skipped': False}
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('queue_sort', require='user')
def queue_sort(sort_by='artist', order='asc', details=None):
    """Sort the queue by a field."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Get current playing song UUID before sorting
    cur.execute("""
        SELECT queue_index FROM user_playback_state WHERE user_id = ?
    """, (user_id,))
    state = cur.fetchone()
    current_index = state['queue_index'] if state else 0

    cur.execute("""
        SELECT song_uuid FROM user_queue WHERE user_id = ? AND position = ?
    """, (user_id, current_index))
    current_song = cur.fetchone()
    current_uuid = current_song['song_uuid'] if current_song else None

    # Count which occurrence of this UUID we're at (1st, 2nd, 3rd, etc.)
    # This handles duplicate songs in the queue correctly
    current_occurrence = 0
    if current_uuid:
        cur.execute("""
            SELECT COUNT(*) FROM user_queue
            WHERE user_id = ? AND song_uuid = ? AND position <= ?
        """, (user_id, current_uuid, current_index))
        current_occurrence = cur.fetchone()[0]  # 1-based count

    sort_map = {
        'title': 's.title',
        'artist': 's.artist, s.album, s.disc_number, s.track_number',
        'album': 's.album, s.disc_number, s.track_number',
        'track': 's.artist, s.album, s.disc_number, s.track_number',
        'year': 's.year',
        'duration': 's.duration_seconds',
        'random': 'RANDOM()',
    }
    order_by = sort_map.get(sort_by, 's.artist, s.album, s.disc_number, s.track_number')
    order_dir = 'DESC' if order.lower() == 'desc' else 'ASC'

    cur.execute(f"""
        SELECT q.song_uuid
        FROM user_queue q
        JOIN songs s ON q.song_uuid = s.uuid
        WHERE q.user_id = ?
        ORDER BY {order_by} {order_dir if sort_by != 'random' else ''}
    """, (user_id,))

    songs = [row['song_uuid'] for row in cur.fetchall()]

    # Update positions
    cur.execute("DELETE FROM user_queue WHERE user_id = ?", (user_id,))

    for i, uuid in enumerate(songs):
        cur.execute("""
            INSERT INTO user_queue (user_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (user_id, uuid, i))

    # Find new index of current song (handling duplicates)
    new_index = 0
    if current_uuid and current_uuid in songs:
        # Find the nth occurrence of this UUID in the sorted list
        occurrence_count = 0
        for i, uuid in enumerate(songs):
            if uuid == current_uuid:
                occurrence_count += 1
                if occurrence_count == current_occurrence:
                    new_index = i
                    break
        else:
            # If exact occurrence not found, use last occurrence
            for i in range(len(songs) - 1, -1, -1):
                if songs[i] == current_uuid:
                    new_index = i
                    break

    # Update queue_index to point to the same song
    cur.execute("""
        UPDATE user_playback_state SET queue_index = ?, updated_at = ?
        WHERE user_id = ?
    """, (new_index, datetime.utcnow(), user_id))

    return {'success': True, 'queueLength': len(songs), 'newIndex': new_index}


@api_method('queue_save_as_playlist', require='user')
def queue_save_as_playlist(name, description='', is_public=False, details=None):
    """Save the current queue as a new playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not name or not name.strip():
        raise ValueError('Playlist name is required')

    final_name = name.strip()

    # Handle duplicate names by appending (2), (3), etc.
    cur.execute("""
        SELECT name FROM playlists WHERE user_id = ? AND name LIKE ?
    """, (user_id, final_name + '%'))
    existing = [row['name'] for row in cur.fetchall()]

    if final_name in existing:
        counter = 2
        while f"{final_name} ({counter})" in existing:
            counter += 1
        final_name = f"{final_name} ({counter})"

    # Create playlist
    cur.execute("""
        INSERT INTO playlists (user_id, name, description, is_public)
        VALUES (?, ?, ?, ?)
    """, (user_id, final_name, description or '', 1 if is_public else 0))
    playlist_id = cur.lastrowid

    # Get unique songs from queue (deduplicated)
    cur.execute("""
        SELECT DISTINCT song_uuid FROM user_queue WHERE user_id = ? ORDER BY position
    """, (user_id,))
    songs = cur.fetchall()

    # Add songs to playlist
    for i, song in enumerate(songs):
        cur.execute("""
            INSERT INTO playlist_songs (playlist_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (playlist_id, song['song_uuid'], i))

    return {'playlist_id': playlist_id, 'name': final_name, 'songs_added': len(songs)}

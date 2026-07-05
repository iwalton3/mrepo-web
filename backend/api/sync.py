"""
Sync API module for mrepo.

Provides offline sync support - queue operations for later commit.
"""

import json
from datetime import datetime, timedelta

from ..app import api_method
from ..db import get_db


def _ensure_committed_table(conn):
    """Defensively ensure the commit-idempotency table exists.

    Normally created by db.py migrations at startup, but keep sync robust on
    databases that predate the migration (and make the module self-contained
    for tests).
    """
    conn.execute('''
        CREATE TABLE IF NOT EXISTS sync_committed_sessions (
            session_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            result TEXT NOT NULL,
            committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')


def cleanup_expired_sync_ops(conn, ttl_hours=1):
    """Remove pending sync ops older than TTL and stale committed-session rows."""
    cur = conn.cursor()
    cutoff = datetime.utcnow() - timedelta(hours=ttl_hours)
    cur.execute("""
        DELETE FROM pending_sync_ops
        WHERE created_at < ?
    """, (cutoff,))
    deleted = cur.rowcount
    # Committed-session records only need to outlive client retries; 7 days is
    # far beyond any retry horizon.
    committed_cutoff = datetime.utcnow() - timedelta(days=7)
    try:
        cur.execute("""
            DELETE FROM sync_committed_sessions
            WHERE committed_at < ?
        """, (committed_cutoff,))
        deleted += cur.rowcount
    except Exception:
        # Table may not exist yet on a very old DB; ignore.
        pass
    return deleted


@api_method('sync_push', require='user')
def sync_push(session_id, seq, op_type, payload, details=None):
    """Queue an operation for later sync."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Cleanup expired ops periodically
    cleanup_expired_sync_ops(conn)

    # Store as JSON if payload is a dict
    if isinstance(payload, dict):
        payload_json = json.dumps(payload)
    else:
        payload_json = payload

    try:
        cur.execute("""
            INSERT INTO pending_sync_ops (user_id, session_id, seq, op_type, payload)
            VALUES (?, ?, ?, ?, ?)
        """, (user_id, session_id, seq, op_type, payload_json))
    except Exception:
        # Duplicate seq for this session - ignore
        pass

    return {'success': True}


def _is_harmless_error(error_msg):
    """Check if an error is harmless and can be skipped during sync.

    Harmless errors are those that indicate the operation is already done
    or the target no longer exists - common in retry scenarios.
    """
    error_lower = error_msg.lower()
    harmless_patterns = [
        'not found',      # Item was already deleted
        'access denied',  # Playlist was deleted or made private
        'already',        # Already exists/done
        'no change',      # State already matches
        'invalid',        # Invalid position (queue changed)
    ]
    return any(pattern in error_lower for pattern in harmless_patterns)


@api_method('sync_commit', require='user')
def sync_commit(session_id, details=None):
    """Execute all pending operations for a session atomically.

    Operations are executed in sequence. Harmless errors (not found, already
    exists, etc.) are skipped rather than failing the entire sync - this
    handles retry scenarios gracefully. Real errors cause a full rollback.
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not session_id:
        raise ValueError('session_id is required')

    _ensure_committed_table(conn)

    # Idempotency: if this session already committed (client lost the response
    # and is retrying), return the stored result instead of re-applying the
    # batch. Any ops the retry re-pushed are discarded so they can't leak into
    # a later commit.
    cur.execute("""
        SELECT result FROM sync_committed_sessions
        WHERE session_id = ? AND user_id = ?
    """, (session_id, user_id))
    committed = cur.fetchone()
    if committed:
        cur.execute("DELETE FROM pending_sync_ops WHERE session_id = ? AND user_id = ?",
                    (session_id, user_id))
        result = json.loads(committed['result'])
        result['alreadyCommitted'] = True
        return result

    # Get pending ops in order (seq is needed to report failed_seq on failure)
    cur.execute("""
        SELECT id, op_type, payload, seq FROM pending_sync_ops
        WHERE session_id = ? AND user_id = ?
        ORDER BY seq
    """, (session_id, user_id))

    ops = cur.fetchall()

    if not ops:
        return {'success': True, 'executed': 0, 'skipped': 0, 'errors': [],
                'tempIdMap': {}}

    executed = 0
    skipped = 0

    # Track temp ID -> real ID mappings for playlists created in this session
    temp_id_map = {}

    try:
        # Begin transaction for all operations
        cur.execute("BEGIN IMMEDIATE")

        for op in ops:
            op_type = op['op_type']
            op_seq = op['seq']
            payload = json.loads(op['payload']) if isinstance(op['payload'], str) else op['payload']

            # Resolve temp playlist IDs before executing
            payload = _resolve_temp_ids(payload, temp_id_map)

            try:
                result = _execute_sync_op(op_type, payload, details, _conn=conn)

                # Track playlist creation results for temp ID resolution
                if op_type == 'playlists.create' and result:
                    temp_id = payload.get('tempId')
                    real_id = result.get('id')
                    if temp_id and real_id:
                        temp_id_map[temp_id] = real_id

                executed += 1

            except Exception as op_error:
                error_msg = str(op_error)

                if _is_harmless_error(error_msg):
                    # Harmless error - skip this operation
                    skipped += 1

                    # Special case: if playlist create failed because it exists,
                    # look up the existing ID for temp ID resolution
                    if op_type == 'playlists.create':
                        temp_id = payload.get('tempId')
                        name = payload.get('name')
                        if temp_id and name:
                            cur.execute(
                                "SELECT id FROM playlists WHERE user_id = ? AND name = ?",
                                (user_id, name.strip())
                            )
                            row = cur.fetchone()
                            if row:
                                temp_id_map[temp_id] = row['id']
                else:
                    # Real error - roll back the whole batch and report which
                    # op (seq) failed so the client can drop the poison pill.
                    cur.execute("ROLLBACK")
                    return {
                        'success': False,
                        'executed': 0,
                        'skipped': 0,
                        'errors': [{'op_type': op_type, 'error': error_msg}],
                        'failed_op': op_type,
                        'failed_seq': op_seq,
                    }

        # All ops succeeded: clear them, record the result for idempotent retry,
        # and commit atomically. tempIdMap lets the client rewrite cached
        # pending-* playlist IDs to their real ids.
        result = {
            'success': True,
            'executed': executed,
            'skipped': skipped,
            'errors': [],
            'tempIdMap': temp_id_map,
        }
        cur.execute("""
            DELETE FROM pending_sync_ops WHERE session_id = ? AND user_id = ?
        """, (session_id, user_id))
        cur.execute("""
            INSERT INTO sync_committed_sessions (session_id, user_id, result)
            VALUES (?, ?, ?)
        """, (session_id, user_id, json.dumps(result)))

        cur.execute("COMMIT")

        return result
    except Exception as e:
        try:
            cur.execute("ROLLBACK")
        except:
            pass
        return {
            'success': False,
            'executed': 0,
            'skipped': 0,
            'errors': [{'op_type': 'unknown', 'error': str(e)}]
        }


def _resolve_temp_ids(payload, temp_id_map):
    """Resolve temporary playlist IDs to real IDs."""
    if not temp_id_map:
        return payload

    # Check playlistId field
    playlist_id = payload.get('playlistId') or payload.get('playlist_id')
    if playlist_id and str(playlist_id).startswith('pending-'):
        real_id = temp_id_map.get(playlist_id)
        if real_id:
            # Update the payload with resolved ID
            payload = dict(payload)
            if 'playlistId' in payload:
                payload['playlistId'] = real_id
            if 'playlist_id' in payload:
                payload['playlist_id'] = real_id

    return payload


def _get_param(payload, *keys, default=None):
    """Get a parameter by trying multiple key names (camelCase and snake_case)."""
    for key in keys:
        if key in payload:
            return payload[key]
    return default


def _resolve_verified_queue_positions(cur, user_id, items):
    """Resolve offline-recorded queue positions against the CURRENT queue.

    The offline client records {position, uuid} pairs against its snapshot of
    the queue. By the time the batch replays, the server queue may have diverged
    (another device edited it), so raw positions could hit the wrong songs. For
    each pair: if the uuid still sits at the recorded position, use it; else use
    the nearest unclaimed occurrence of that uuid; if the uuid is gone, skip the
    item. Pairs without a uuid (older clients / no cache) fall back to the raw
    position when it still exists.

    Returns (resolved_positions, skipped_count).
    """
    cur.execute("""
        SELECT position, song_uuid FROM user_queue
        WHERE user_id = ? ORDER BY position ASC
    """, (user_id,))
    rows = cur.fetchall()
    by_pos = {row['position']: row['song_uuid'] for row in rows}
    uuid_positions = {}
    for row in rows:
        uuid_positions.setdefault(row['song_uuid'], []).append(row['position'])

    claimed = set()
    resolved = []
    skipped = 0
    for item in items:
        pos = item.get('position')
        song_uuid = item.get('uuid')
        if song_uuid is None:
            if pos in by_pos and pos not in claimed:
                claimed.add(pos)
                resolved.append(pos)
            else:
                skipped += 1
            continue
        if pos is not None and by_pos.get(pos) == song_uuid and pos not in claimed:
            claimed.add(pos)
            resolved.append(pos)
            continue
        candidates = [p for p in uuid_positions.get(song_uuid, []) if p not in claimed]
        if candidates:
            anchor = pos if pos is not None else 0
            nearest = min(candidates, key=lambda p: abs(p - anchor))
            claimed.add(nearest)
            resolved.append(nearest)
        else:
            skipped += 1
    return resolved, skipped


def _sync_queue_remove(p, details, _conn):
    """queue.remove: prefer verified items=[{position,uuid}]; fall back to raw
    positions. Unresolvable items are skipped (counted), never fatal."""
    from . import queue
    user_id = details['user_id']
    items = p.get('items')
    if items:
        cur = _conn.cursor()
        positions, skipped = _resolve_verified_queue_positions(cur, user_id, items)
        if not positions:
            return {'removed': 0, 'skippedItems': skipped}
        result = queue.queue_remove(positions, details=details, _conn=_conn)
        if isinstance(result, dict):
            result['skippedItems'] = skipped
        return result
    positions = _get_param(p, 'positions', default=[])
    if not positions:
        return {'removed': 0}
    return queue.queue_remove(positions, details=details, _conn=_conn)


def _sync_queue_reorder(p, details, _conn):
    """queue.reorder: verify/relocate uuid, clamp toPos into queue bounds. A
    'not found' result is a harmless skip (the queue changed under us)."""
    from . import queue
    user_id = details['user_id']
    from_pos = _get_param(p, 'fromPos', 'from_pos')
    to_pos = _get_param(p, 'toPos', 'to_pos')
    if from_pos is None or to_pos is None:
        raise ValueError('Invalid reorder payload')

    song_uuid = p.get('uuid')
    if song_uuid is not None:
        cur = _conn.cursor()
        resolved, _skipped = _resolve_verified_queue_positions(
            cur, user_id, [{'position': from_pos, 'uuid': song_uuid}])
        if not resolved:
            raise ValueError('Song not found at position')  # harmless skip
        from_pos = resolved[0]

    # Clamp target into the current queue bounds
    cur = _conn.cursor()
    cur.execute("SELECT COUNT(*) FROM user_queue WHERE user_id = ?", (user_id,))
    queue_len = cur.fetchone()[0]
    if queue_len == 0:
        raise ValueError('Song not found at position')  # harmless skip
    to_pos = max(0, min(int(to_pos), queue_len - 1))
    return queue.queue_reorder(from_pos, to_pos, details=details, _conn=_conn)


def _sync_queue_reorder_batch(p, details, _conn):
    """queue.reorderBatch: verify each moved item against the current queue,
    then delegate to the batch reorder."""
    from . import queue
    user_id = details['user_id']
    from_positions = _get_param(p, 'fromPositions', 'from_positions', default=[])
    to_position = _get_param(p, 'toPosition', 'to_position', default=0)
    uuids = p.get('uuids')
    if uuids and len(uuids) == len(from_positions):
        cur = _conn.cursor()
        items = [{'position': pos, 'uuid': u} for pos, u in zip(from_positions, uuids)]
        from_positions, _skipped = _resolve_verified_queue_positions(cur, user_id, items)
        if not from_positions:
            return {'success': True, 'moved': 0}
    return queue.queue_reorder_batch(from_positions, to_position, details=details, _conn=_conn)


def _execute_sync_op(op_type, payload, details, _conn=None):
    """Execute a single sync operation.

    Supports both camelCase (original) and snake_case parameter names.
    Pass _conn for transactional batching of operations.
    """
    # Import the API methods
    from . import queue, playlists, preferences, history, playback

    handlers = {
        # Queue operations - support both camelCase (original) and snake_case
        'queue.add': lambda p: queue.queue_add(
            _get_param(p, 'songUuids', 'song_uuids', default=[]),
            _get_param(p, 'position'),
            details=details, _conn=_conn),
        'queue.remove': lambda p: _sync_queue_remove(p, details, _conn),
        'queue.clear': lambda p: queue.queue_clear(details=details, _conn=_conn),
        'queue.setIndex': lambda p: queue.queue_set_index(
            _get_param(p, 'index', 'queue_index', default=0),
            device_id=_get_param(p, 'deviceId', 'device_id'),
            seq=p.get('seq'),
            details=details, _conn=_conn),
        'queue.reorder': lambda p: _sync_queue_reorder(p, details, _conn),
        'queue.reorderBatch': lambda p: _sync_queue_reorder_batch(p, details, _conn),

        # Playlist operations - support both camelCase and snake_case
        'playlists.addSong': lambda p: playlists.playlists_add_song(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuid', 'song_uuid'),
            details=details, _conn=_conn),
        'playlists.removeSong': lambda p: playlists.playlists_remove_song(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuid', 'song_uuid'),
            index=_get_param(p, 'index'),
            details=details, _conn=_conn),
        'playlists.removeSongs': lambda p: playlists.playlists_remove_songs(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuids', 'song_uuids', default=[]),
            indices=_get_param(p, 'indices'),
            details=details, _conn=_conn),
        'playlists.addSongsBatch': lambda p: playlists.playlists_add_songs(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuids', 'song_uuids', default=[]),
            details=details, _conn=_conn),
        'playlists.reorder': lambda p: playlists.playlists_reorder(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'positions', default=[]),
            details=details, _conn=_conn),
        'playlists.sort': lambda p: playlists.playlists_sort(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'sortBy', 'sort_by', default='artist'),
            _get_param(p, 'order', default='asc'),
            details=details, _conn=_conn),
        'playlists.create': lambda p: playlists.playlists_create(
            _get_param(p, 'name'),
            _get_param(p, 'description', default=''),
            _get_param(p, 'isPublic', 'is_public', default=False),
            details=details, _conn=_conn),
        'playlists.delete': lambda p: playlists.playlists_delete(
            _get_param(p, 'playlistId', 'playlist_id'),
            details=details, _conn=_conn),

        # Preferences - forward ALL keys preferences_set accepts (camelCase or
        # snake_case). Offline changes to radio_algorithm / ai_* were silently
        # dropped before because the handler only forwarded a fixed subset.
        'preferences.set': lambda p: preferences.preferences_set(
            volume=_get_param(p, 'volume'),
            shuffle=_get_param(p, 'shuffle'),
            repeat_mode=_get_param(p, 'repeatMode', 'repeat_mode'),
            radio_eopp=_get_param(p, 'radioEopp', 'radio_eopp'),
            dark_mode=_get_param(p, 'darkMode', 'dark_mode'),
            replay_gain_mode=_get_param(p, 'replayGainMode', 'replay_gain_mode'),
            replay_gain_preamp=_get_param(p, 'replayGainPreamp', 'replay_gain_preamp'),
            replay_gain_fallback=_get_param(p, 'replayGainFallback', 'replay_gain_fallback'),
            radio_algorithm=_get_param(p, 'radioAlgorithm', 'radio_algorithm'),
            ai_search_max=_get_param(p, 'aiSearchMax', 'ai_search_max'),
            ai_search_diversity=_get_param(p, 'aiSearchDiversity', 'ai_search_diversity'),
            ai_radio_queue_diversity=_get_param(p, 'aiRadioQueueDiversity', 'ai_radio_queue_diversity'),
            details=details, _conn=_conn),

        # History - support both camelCase and snake_case
        'history.record': lambda p: history.history_record(
            _get_param(p, 'songUuid', 'song_uuid'),
            _get_param(p, 'durationSeconds', 'duration_seconds', 'play_duration_seconds', default=0),
            _get_param(p, 'skipped', default=False),
            _get_param(p, 'source'),
            details=details, _conn=_conn),

        # EQ Presets
        'eqPresets.save': lambda p: preferences.eq_presets_save(
            uuid=_get_param(p, 'uuid'),
            name=_get_param(p, 'name'),
            bands=_get_param(p, 'bands'),
            details=details, _conn=_conn),
        'eqPresets.delete': lambda p: preferences.eq_presets_delete(
            _get_param(p, 'uuid'),
            details=details, _conn=_conn),

        # Playback state - support both camelCase and snake_case
        'playback.setState': lambda p: playback.playback_set_state(
            queue_index=_get_param(p, 'queueIndex', 'queue_index'),
            sca_enabled=_get_param(p, 'scaEnabled', 'sca_enabled'),
            play_mode=_get_param(p, 'playMode', 'play_mode'),
            volume=_get_param(p, 'volume'),
            details=details, _conn=_conn),
    }

    handler = handlers.get(op_type)
    if handler:
        return handler(payload)
    else:
        raise ValueError(f'Unknown operation type: {op_type}')


@api_method('sync_discard', require='user')
def sync_discard(session_id, details=None):
    """Discard all pending operations for a session."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        DELETE FROM pending_sync_ops WHERE session_id = ? AND user_id = ?
    """, (session_id, user_id))

    return {'success': True, 'discarded': cur.rowcount}


@api_method('sync_status', require='user')
def sync_status(session_id=None, details=None):
    """Get pending sync operations status."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if session_id:
        cur.execute("""
            SELECT COUNT(*) as count, MAX(seq) as max_seq
            FROM pending_sync_ops WHERE session_id = ? AND user_id = ?
        """, (session_id, user_id))
    else:
        cur.execute("""
            SELECT session_id, COUNT(*) as count, MAX(seq) as max_seq, MIN(created_at) as oldest
            FROM pending_sync_ops WHERE user_id = ?
            GROUP BY session_id
        """, (user_id,))

    rows = cur.fetchall()

    if session_id:
        row = rows[0] if rows else None
        return {
            'pendingCount': row['count'] if row else 0,
            'maxSeq': row['max_seq'] if row else 0
        }
    else:
        return {
            'sessions': [{
                'sessionId': row['session_id'],
                'pendingCount': row['count'],
                'maxSeq': row['max_seq'],
                'oldest': row['oldest']
            } for row in rows]
        }

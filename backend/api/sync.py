"""
Sync API module for mrepo.

Provides offline sync support - queue operations for later commit.
"""

import json
from datetime import datetime, timedelta

from ..app import api_method
from ..db import get_db


def cleanup_expired_sync_ops(conn, ttl_hours=1):
    """Remove pending sync ops older than TTL."""
    cur = conn.cursor()
    cutoff = datetime.utcnow() - timedelta(hours=ttl_hours)
    cur.execute("""
        DELETE FROM pending_sync_ops
        WHERE created_at < ?
    """, (cutoff,))
    return cur.rowcount


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


@api_method('sync_commit', require='user')
def sync_commit(session_id, details=None):
    """Execute all pending operations for a session."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Get pending ops in order
    cur.execute("""
        SELECT id, op_type, payload FROM pending_sync_ops
        WHERE session_id = ? AND user_id = ?
        ORDER BY seq
    """, (session_id, user_id))

    ops = cur.fetchall()
    executed = 0
    errors = []

    # Track temp ID -> real ID mappings for playlists created in this session
    temp_id_map = {}

    for op in ops:
        try:
            payload = json.loads(op['payload']) if isinstance(op['payload'], str) else op['payload']

            # Resolve temp playlist IDs before executing
            payload = _resolve_temp_ids(payload, temp_id_map)

            result = _execute_sync_op(op['op_type'], payload, details)

            # Track playlist creation results for temp ID resolution
            if op['op_type'] == 'playlists.create' and result:
                temp_id = payload.get('tempId')
                real_id = result.get('id')
                if temp_id and real_id:
                    temp_id_map[temp_id] = real_id

            executed += 1
        except Exception as e:
            errors.append({'op_type': op['op_type'], 'error': str(e)})

    # Clear committed ops
    cur.execute("""
        DELETE FROM pending_sync_ops WHERE session_id = ? AND user_id = ?
    """, (session_id, user_id))

    return {
        'success': len(errors) == 0,
        'executed': executed,
        'errors': errors
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


def _execute_sync_op(op_type, payload, details):
    """Execute a single sync operation.

    Supports both camelCase (original) and snake_case parameter names.
    """
    # Import the API methods
    from . import queue, playlists, preferences, history, playback

    handlers = {
        # Queue operations - support both camelCase (original) and snake_case
        'queue.add': lambda p: queue.queue_add(
            _get_param(p, 'songUuids', 'song_uuids', default=[]),
            _get_param(p, 'position'),
            details=details),
        'queue.remove': lambda p: queue.queue_remove(
            _get_param(p, 'positions', default=[]),
            details=details),
        'queue.clear': lambda p: queue.queue_clear(details=details),
        'queue.setIndex': lambda p: queue.queue_set_index(
            _get_param(p, 'index', 'queue_index', default=0),
            details=details),
        'queue.reorder': lambda p: queue.queue_reorder(
            _get_param(p, 'fromPos', 'from_pos'),
            _get_param(p, 'toPos', 'to_pos'),
            details=details),

        # Playlist operations - support both camelCase and snake_case
        'playlists.addSong': lambda p: playlists.playlists_add_song(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuid', 'song_uuid'),
            details=details),
        'playlists.removeSong': lambda p: playlists.playlists_remove_song(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuid', 'song_uuid'),
            details=details),
        'playlists.removeSongs': lambda p: playlists.playlists_remove_songs(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuids', 'song_uuids', default=[]),
            details=details),
        'playlists.addSongsBatch': lambda p: playlists.playlists_add_songs(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'songUuids', 'song_uuids', default=[]),
            details=details),
        'playlists.reorder': lambda p: playlists.playlists_reorder(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'positions', default=[]),
            details=details),
        'playlists.sort': lambda p: playlists.playlists_sort(
            _get_param(p, 'playlistId', 'playlist_id'),
            _get_param(p, 'sortBy', 'sort_by', default='artist'),
            _get_param(p, 'order', default='asc'),
            details=details),
        'playlists.create': lambda p: playlists.playlists_create(
            _get_param(p, 'name'),
            _get_param(p, 'description', default=''),
            _get_param(p, 'isPublic', 'is_public', default=False),
            details=details),
        'playlists.delete': lambda p: playlists.playlists_delete(
            _get_param(p, 'playlistId', 'playlist_id'),
            details=details),

        # Preferences - convert camelCase to snake_case for preferences_set
        'preferences.set': lambda p: preferences.preferences_set(
            volume=_get_param(p, 'volume'),
            shuffle=_get_param(p, 'shuffle'),
            repeat_mode=_get_param(p, 'repeatMode', 'repeat_mode'),
            radio_eopp=_get_param(p, 'radioEopp', 'radio_eopp'),
            dark_mode=_get_param(p, 'darkMode', 'dark_mode'),
            replay_gain_mode=_get_param(p, 'replayGainMode', 'replay_gain_mode'),
            replay_gain_preamp=_get_param(p, 'replayGainPreamp', 'replay_gain_preamp'),
            replay_gain_fallback=_get_param(p, 'replayGainFallback', 'replay_gain_fallback'),
            details=details),

        # History - support both camelCase and snake_case
        'history.record': lambda p: history.history_record(
            _get_param(p, 'songUuid', 'song_uuid'),
            _get_param(p, 'durationSeconds', 'duration_seconds', 'play_duration_seconds', default=0),
            _get_param(p, 'skipped', default=False),
            _get_param(p, 'source'),
            details=details),

        # EQ Presets
        'eqPresets.save': lambda p: preferences.eq_presets_save(
            uuid=_get_param(p, 'uuid'),
            name=_get_param(p, 'name'),
            bands=_get_param(p, 'bands'),
            details=details),
        'eqPresets.delete': lambda p: preferences.eq_presets_delete(
            _get_param(p, 'uuid'),
            details=details),

        # Playback state - support both camelCase and snake_case
        'playback.setState': lambda p: playback.playback_set_state(
            queue_index=_get_param(p, 'queueIndex', 'queue_index'),
            sca_enabled=_get_param(p, 'scaEnabled', 'sca_enabled'),
            play_mode=_get_param(p, 'playMode', 'play_mode'),
            volume=_get_param(p, 'volume'),
            details=details),
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

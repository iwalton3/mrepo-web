"""
Playback API module for mrepo.

Provides playback state management.
"""

from datetime import datetime

from ..app import api_method
from ..db import get_db, row_to_dict


@api_method('playback_get_state', require='user')
def playback_get_state(details=None):
    """Get the current playback state."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT queue_index, sca_enabled, play_mode, volume
        FROM user_playback_state WHERE user_id = ?
    """, (user_id,))

    row = cur.fetchone()

    if row:
        return {
            'queueIndex': row['queue_index'],
            'scaEnabled': bool(row['sca_enabled']),
            'playMode': row['play_mode'],
            'volume': row['volume']
        }

    # Return defaults if no state exists
    return {
        'queueIndex': 0,
        'scaEnabled': False,
        'playMode': 'sequential',
        'volume': 1.0
    }


@api_method('playback_set_state', require='user')
def playback_set_state(queue_index=None, sca_enabled=None, play_mode=None,
                       volume=None, details=None, _conn=None):
    """Update playback state."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Get current state or defaults
        cur.execute("SELECT * FROM user_playback_state WHERE user_id = ?", (user_id,))
        current = cur.fetchone()

        if current:
            new_index = queue_index if queue_index is not None else current['queue_index']
            new_sca = (1 if sca_enabled else 0) if sca_enabled is not None else current['sca_enabled']
            new_mode = play_mode if play_mode is not None else current['play_mode']
            new_volume = volume if volume is not None else current['volume']

            cur.execute("""
                UPDATE user_playback_state
                SET queue_index = ?, sca_enabled = ?, play_mode = ?, volume = ?, updated_at = ?
                WHERE user_id = ?
            """, (new_index, new_sca, new_mode, new_volume, datetime.utcnow(), user_id))
        else:
            cur.execute("""
                INSERT INTO user_playback_state (user_id, queue_index, sca_enabled, play_mode, volume, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                user_id,
                queue_index if queue_index is not None else 0,
                1 if sca_enabled else 0,
                play_mode or 'sequential',
                volume if volume is not None else 1.0,
                datetime.utcnow()
            ))

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

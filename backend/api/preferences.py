"""
Preferences API module for mrepo.

Provides user preferences and EQ presets management.
"""

import secrets
from datetime import datetime

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


@api_method('preferences_get', require='user')
def preferences_get(details=None):
    """Get user preferences."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT volume, shuffle, repeat_mode, radio_eopp, dark_mode,
               replay_gain_mode, replay_gain_preamp, replay_gain_fallback
        FROM user_preferences WHERE user_id = ?
    """, (user_id,))

    row = cur.fetchone()

    if row:
        return row_to_dict(row)

    # Return defaults
    return {
        'volume': 1.0,
        'shuffle': False,
        'repeat_mode': 'none',
        'radio_eopp': True,
        'dark_mode': False,
        'replay_gain_mode': 'off',
        'replay_gain_preamp': 0.0,
        'replay_gain_fallback': -6.0
    }


@api_method('preferences_set', require='user')
def preferences_set(volume=None, shuffle=None, repeat_mode=None, radio_eopp=None,
                    dark_mode=None, replay_gain_mode=None, replay_gain_preamp=None,
                    replay_gain_fallback=None, details=None):
    """Update user preferences."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Check if row exists
    cur.execute("SELECT user_id FROM user_preferences WHERE user_id = ?", (user_id,))
    exists = cur.fetchone()

    if exists:
        updates = []
        params = []

        if volume is not None:
            updates.append("volume = ?")
            params.append(volume)
        if shuffle is not None:
            updates.append("shuffle = ?")
            params.append(1 if shuffle else 0)
        if repeat_mode is not None:
            updates.append("repeat_mode = ?")
            params.append(repeat_mode)
        if radio_eopp is not None:
            updates.append("radio_eopp = ?")
            params.append(1 if radio_eopp else 0)
        if dark_mode is not None:
            updates.append("dark_mode = ?")
            params.append(1 if dark_mode else 0)
        if replay_gain_mode is not None:
            updates.append("replay_gain_mode = ?")
            params.append(replay_gain_mode)
        if replay_gain_preamp is not None:
            updates.append("replay_gain_preamp = ?")
            params.append(replay_gain_preamp)
        if replay_gain_fallback is not None:
            updates.append("replay_gain_fallback = ?")
            params.append(replay_gain_fallback)

        if updates:
            params.append(user_id)
            cur.execute(f"UPDATE user_preferences SET {', '.join(updates)} WHERE user_id = ?", params)
    else:
        cur.execute("""
            INSERT INTO user_preferences (user_id, volume, shuffle, repeat_mode, radio_eopp,
                                         dark_mode, replay_gain_mode, replay_gain_preamp, replay_gain_fallback)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user_id,
            volume if volume is not None else 1.0,
            1 if shuffle else 0,
            repeat_mode or 'none',
            1 if radio_eopp else 0,
            1 if dark_mode else 0,
            replay_gain_mode or 'off',
            replay_gain_preamp if replay_gain_preamp is not None else 0.0,
            replay_gain_fallback if replay_gain_fallback is not None else -6.0
        ))

    return {'success': True}


# EQ Presets

@api_method('eq_presets_list', require='user')
def eq_presets_list(details=None):
    """List EQ presets for the current user."""
    import json as json_module

    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT uuid, name, bands, created_at, updated_at
        FROM eq_presets WHERE user_id = ?
        ORDER BY name
    """, (user_id,))

    rows = cur.fetchall()

    # Parse bands JSON for each preset
    presets = []
    for row in rows:
        preset = dict(row)
        if preset.get('bands'):
            try:
                preset['bands'] = json_module.loads(preset['bands'])
            except (json_module.JSONDecodeError, TypeError):
                preset['bands'] = []
        else:
            preset['bands'] = []
        presets.append(preset)

    return {'presets': presets}


@api_method('eq_presets_save', require='user')
def eq_presets_save(uuid=None, name=None, bands=None, details=None):
    """Create or update an EQ preset."""
    import json

    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not name or not str(name).strip():
        raise ValueError('Preset name is required')

    # Validate bands (should be JSON string, dict, or list)
    if isinstance(bands, (dict, list)):
        bands_json = json.dumps(bands)
    else:
        bands_json = bands

    now = datetime.utcnow()

    if uuid:
        # Update existing
        cur.execute("""
            UPDATE eq_presets SET name = ?, bands = ?, updated_at = ?
            WHERE uuid = ? AND user_id = ?
        """, (name.strip(), bands_json, now, uuid, user_id))

        if cur.rowcount == 0:
            raise ValueError('Preset not found or access denied')
    else:
        # Create new
        uuid = secrets.token_urlsafe(16)
        cur.execute("""
            INSERT INTO eq_presets (uuid, user_id, name, bands, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (uuid, user_id, name.strip(), bands_json, now, now))

    return {'uuid': uuid, 'name': name.strip()}


@api_method('eq_presets_delete', require='user')
def eq_presets_delete(uuid, details=None):
    """Delete an EQ preset."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        DELETE FROM eq_presets WHERE uuid = ? AND user_id = ?
    """, (uuid, user_id))

    if cur.rowcount == 0:
        raise ValueError('Preset not found or access denied')

    return {'success': True}

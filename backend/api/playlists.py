"""
Playlists API module for mrepo.

Provides playlist management with sharing support.
"""

import secrets
from datetime import datetime

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


@api_method('playlists_list', require='user')
def playlists_list(details=None):
    """List all playlists for the current user."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT p.id, p.name, p.description, p.is_public, p.share_token,
               p.created_at, p.updated_at,
               COUNT(ps.song_uuid) as song_count
        FROM playlists p
        LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
        WHERE p.user_id = ?
        GROUP BY p.id
        ORDER BY p.name
    """, (user_id,))

    rows = cur.fetchall()
    return {'items': rows_to_list(rows)}


@api_method('playlists_public', require='user')
def playlists_public(cursor=None, limit=50):
    """List public playlists with pagination."""
    conn = get_db()
    cur = conn.cursor()

    limit = min(int(limit), 100)

    # Cursor-based pagination (cursor is playlist id)
    if cursor:
        cur.execute("""
            SELECT p.id, p.name, p.description, p.user_id, p.share_token,
                   p.created_at,
                   COUNT(ps.song_uuid) as song_count
            FROM playlists p
            LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
            WHERE p.is_public = 1 AND p.id > ?
            GROUP BY p.id
            ORDER BY p.id
            LIMIT ?
        """, (int(cursor), limit + 1))
    else:
        cur.execute("""
            SELECT p.id, p.name, p.description, p.user_id, p.share_token,
                   p.created_at,
                   COUNT(ps.song_uuid) as song_count
            FROM playlists p
            LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
            WHERE p.is_public = 1
            GROUP BY p.id
            ORDER BY p.id
            LIMIT ?
        """, (limit + 1,))

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = str(items[-1]['id']) if has_more and items else None

    return {'items': items, 'nextCursor': next_cursor, 'hasMore': has_more}


@api_method('playlists_create', require='user')
def playlists_create(name, description='', is_public=False, details=None):
    """Create a new playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not name or not name.strip():
        raise ValueError('Playlist name is required')

    cur.execute("""
        INSERT INTO playlists (user_id, name, description, is_public)
        VALUES (?, ?, ?, ?)
    """, (user_id, name.strip(), description, 1 if is_public else 0))

    playlist_id = cur.lastrowid

    return {'id': playlist_id, 'name': name.strip()}


@api_method('playlists_update', require='user')
def playlists_update(playlist_id, name=None, description=None, is_public=None, details=None):
    """Update playlist name, description, or public status."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    updates = []
    params = []

    if name is not None:
        updates.append("name = ?")
        params.append(name.strip())
    if description is not None:
        updates.append("description = ?")
        params.append(description)
    if is_public is not None:
        updates.append("is_public = ?")
        params.append(1 if is_public else 0)

    if updates:
        updates.append("updated_at = ?")
        params.append(datetime.utcnow())
        params.append(playlist_id)

        cur.execute(f"UPDATE playlists SET {', '.join(updates)} WHERE id = ?", params)

    return {'success': True}


@api_method('playlists_delete', require='user')
def playlists_delete(playlist_id, details=None):
    """Delete a playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    # Delete songs first (cascade should handle this, but be explicit)
    cur.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (playlist_id,))
    cur.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))

    return {'success': True}


@api_method('playlists_get_songs', require='user')
def playlists_get_songs(playlist_id, cursor=None, offset=None, limit=100, details=None):
    """Get songs in a playlist with pagination."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    limit = min(int(limit), 500)

    # Check access (owner or public)
    cur.execute("""
        SELECT id, user_id, is_public FROM playlists WHERE id = ?
    """, (playlist_id,))
    playlist = cur.fetchone()

    if not playlist:
        raise ValueError('Playlist not found')
    # Compare as strings since user_id column is TEXT
    if str(playlist['user_id']) != str(user_id) and not playlist['is_public']:
        raise ValueError('Access denied')

    # Get total count
    cur.execute("""
        SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?
    """, (playlist_id,))
    total_count = cur.fetchone()[0]

    # Determine offset - cursor takes precedence, then offset, then 0
    if cursor:
        start_offset = int(cursor)
    elif offset:
        start_offset = int(offset)
    else:
        start_offset = 0

    cur.execute("""
        SELECT s.uuid, s.type, s.category, s.genre, s.artist, s.album, s.title,
               s.file, s.album_artist, s.track_number, s.disc_number, s.year,
               s.duration_seconds, s.seekable, s.replay_gain_track, s.replay_gain_album,
               s.key, s.bpm, ps.position
        FROM playlist_songs ps
        JOIN songs s ON ps.song_uuid = s.uuid
        WHERE ps.playlist_id = ?
        ORDER BY ps.position
        LIMIT ? OFFSET ?
    """, (playlist_id, limit + 1, start_offset))

    rows = cur.fetchall()
    items = rows_to_list(rows[:limit])
    has_more = len(rows) > limit
    next_cursor = str(start_offset + limit) if has_more else None

    return {
        'items': items,
        'nextCursor': next_cursor,
        'hasMore': has_more,
        'totalCount': total_count,
        'offset': start_offset
    }


@api_method('playlists_add_song', require='user')
def playlists_add_song(playlist_id, song_uuid, details=None):
    """Add a song to a playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    # Get next position
    cur.execute("SELECT MAX(position) FROM playlist_songs WHERE playlist_id = ?",
               (playlist_id,))
    result = cur.fetchone()
    next_pos = (result[0] or 0) + 1

    cur.execute("""
        INSERT OR IGNORE INTO playlist_songs (playlist_id, song_uuid, position)
        VALUES (?, ?, ?)
    """, (playlist_id, song_uuid, next_pos))

    # Update playlist timestamp
    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
               (datetime.utcnow(), playlist_id))

    return {'success': True, 'position': next_pos}


@api_method('playlists_add_songs', require='user')
def playlists_add_songs(playlist_id, song_uuids, details=None):
    """Add multiple songs to a playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not song_uuids:
        return {'success': True, 'added': 0, 'skipped': 0}

    if not isinstance(song_uuids, list):
        raise ValueError('song_uuids must be a list')

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    # Get existing songs to check for duplicates
    cur.execute("""
        SELECT song_uuid FROM playlist_songs WHERE playlist_id = ?
    """, (playlist_id,))
    existing = {row['song_uuid'] for row in cur.fetchall()}

    # Get next position
    cur.execute("SELECT MAX(position) FROM playlist_songs WHERE playlist_id = ?",
               (playlist_id,))
    result = cur.fetchone()
    next_pos = (result[0] or 0) + 1

    added = 0
    skipped = 0
    for uuid in song_uuids:
        if uuid in existing:
            skipped += 1
            continue
        cur.execute("""
            INSERT INTO playlist_songs (playlist_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (playlist_id, uuid, next_pos))
        existing.add(uuid)
        added += 1
        next_pos += 1

    # Update playlist timestamp
    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
               (datetime.utcnow(), playlist_id))

    return {'success': True, 'added': added, 'skipped': skipped}


@api_method('playlists_remove_song', require='user')
def playlists_remove_song(playlist_id, song_uuid, details=None):
    """Remove a song from a playlist by UUID."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    cur.execute("""
        DELETE FROM playlist_songs WHERE playlist_id = ? AND song_uuid = ?
    """, (playlist_id, song_uuid))

    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
               (datetime.utcnow(), playlist_id))

    return {'success': True}


@api_method('playlists_remove_songs', require='user')
def playlists_remove_songs(playlist_id, song_uuids, details=None):
    """Remove multiple songs from a playlist by UUIDs."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not song_uuids:
        return {'success': True, 'removed': 0}

    if not isinstance(song_uuids, list):
        raise ValueError('song_uuids must be a list')

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    removed = 0
    for uuid in song_uuids:
        cur.execute("""
            DELETE FROM playlist_songs WHERE playlist_id = ? AND song_uuid = ?
        """, (playlist_id, uuid))
        removed += cur.rowcount

    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
               (datetime.utcnow(), playlist_id))

    return {'success': True, 'removed': removed}


@api_method('playlists_reorder', require='user')
def playlists_reorder(playlist_id, positions, details=None):
    """Reorder songs in a playlist. positions is a list of {uuid, position} dicts."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

    if not positions or not isinstance(positions, list):
        return {'success': True}

    # Update each song's position
    for item in positions:
        uuid = item.get('uuid')
        position = item.get('position')
        if uuid is not None and position is not None:
            cur.execute("""
                UPDATE playlist_songs SET position = ?
                WHERE playlist_id = ? AND song_uuid = ?
            """, (position, playlist_id, uuid))

    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
               (datetime.utcnow(), playlist_id))

    return {'success': True}


@api_method('playlists_share', require='user')
def playlists_share(playlist_id, details=None):
    """Generate a share token for a playlist."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id, share_token FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    playlist = cur.fetchone()
    if not playlist:
        raise ValueError('Playlist not found or access denied')

    # Generate or reuse token
    token = playlist['share_token'] or secrets.token_urlsafe(16)

    cur.execute("""
        UPDATE playlists SET share_token = ? WHERE id = ?
    """, (token, playlist_id))

    return {'share_token': token}


@api_method('playlists_by_token', require=None, public=True)
def playlists_by_token(share_token):
    """Get a playlist by share token (public access)."""
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT p.id, p.name, p.description, p.user_id, p.is_public, p.created_at,
               COUNT(ps.song_uuid) as song_count
        FROM playlists p
        LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
        WHERE p.share_token = ?
        GROUP BY p.id
    """, (share_token,))

    playlist = cur.fetchone()
    if not playlist:
        raise ValueError('Playlist not found')

    return row_to_dict(playlist)


@api_method('playlists_clone', require='user')
def playlists_clone(playlist_id, new_name=None, details=None):
    """Clone a playlist (including public playlists)."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Get source playlist
    cur.execute("""
        SELECT id, name, user_id, is_public FROM playlists WHERE id = ?
    """, (playlist_id,))
    source = cur.fetchone()

    if not source:
        raise ValueError('Playlist not found')
    if str(source['user_id']) != str(user_id) and not source['is_public']:
        raise ValueError('Access denied')

    # Create new playlist
    final_name = new_name or f"{source['name']} (Copy)"
    cur.execute("""
        INSERT INTO playlists (user_id, name)
        VALUES (?, ?)
    """, (user_id, final_name))
    new_id = cur.lastrowid

    # Copy songs
    cur.execute("""
        INSERT INTO playlist_songs (playlist_id, song_uuid, position)
        SELECT ?, song_uuid, position FROM playlist_songs WHERE playlist_id = ?
    """, (new_id, playlist_id))

    return {'id': new_id, 'name': final_name}


@api_method('playlists_sort', require='user')
def playlists_sort(playlist_id, sort_by='artist', order='asc', details=None):
    """Sort a playlist by a field."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
               (playlist_id, user_id))
    if not cur.fetchone():
        raise ValueError('Playlist not found or access denied')

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

    # Get sorted songs
    cur.execute(f"""
        SELECT ps.song_uuid
        FROM playlist_songs ps
        JOIN songs s ON ps.song_uuid = s.uuid
        WHERE ps.playlist_id = ?
        ORDER BY {order_by} {order_dir if sort_by != 'random' else ''}
    """, (playlist_id,))

    songs = [row['song_uuid'] for row in cur.fetchall()]

    # Update positions
    cur.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (playlist_id,))

    for i, uuid in enumerate(songs):
        cur.execute("""
            INSERT INTO playlist_songs (playlist_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (playlist_id, uuid, i))

    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
               (datetime.utcnow(), playlist_id))

    return {'success': True, 'songCount': len(songs)}

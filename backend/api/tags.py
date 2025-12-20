"""
Tags API module for mrepo.

Provides user-defined song tagging functionality.
"""

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


@api_method('tags_list', require='user')
def tags_list(details=None):
    """
    List all tags for the current user.

    Returns:
        {items: [{id, name, color, song_count}, ...]}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        SELECT t.id, t.name, t.color,
               COUNT(st.song_uuid) as song_count
        FROM tags t
        LEFT JOIN song_tags st ON t.id = st.tag_id
        WHERE t.user_id = ?
        GROUP BY t.id
        ORDER BY t.name
    """, (user_id,))

    rows = cur.fetchall()
    return {'items': rows_to_list(rows)}


@api_method('tags_create', require='user')
def tags_create(name, color='#6c757d', details=None):
    """
    Create a new tag.

    Args:
        name: Tag name (must be unique per user)
        color: Hex color code (default: gray)

    Returns:
        {id, name, color}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not name or not name.strip():
        raise ValueError('Tag name is required')

    name = name.strip()

    # Check for duplicate
    cur.execute("""
        SELECT id FROM tags WHERE user_id = ? AND name = ?
    """, (user_id, name))
    if cur.fetchone():
        raise ValueError(f'Tag "{name}" already exists')

    cur.execute("""
        INSERT INTO tags (user_id, name, color)
        VALUES (?, ?, ?)
    """, (user_id, name, color))

    tag_id = cur.lastrowid

    return {
        'id': tag_id,
        'name': name,
        'color': color
    }


@api_method('tags_delete', require='user')
def tags_delete(tag_id, details=None):
    """
    Delete a tag.

    Args:
        tag_id: Tag ID to delete

    Returns:
        {success: bool}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify ownership
    cur.execute("""
        SELECT id FROM tags WHERE id = ? AND user_id = ?
    """, (tag_id, user_id))
    if not cur.fetchone():
        raise ValueError('Tag not found or access denied')

    # Delete tag (song_tags cascade automatically due to FK)
    cur.execute("DELETE FROM tags WHERE id = ?", (tag_id,))

    return {'success': True}


@api_method('tags_add_to_song', require='user')
def tags_add_to_song(tag_id, song_uuid, details=None):
    """
    Add a tag to a song.

    Args:
        tag_id: Tag ID
        song_uuid: Song UUID

    Returns:
        {success: bool}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify tag ownership
    cur.execute("""
        SELECT id FROM tags WHERE id = ? AND user_id = ?
    """, (tag_id, user_id))
    if not cur.fetchone():
        raise ValueError('Tag not found or access denied')

    # Verify song exists
    cur.execute("SELECT uuid FROM songs WHERE uuid = ?", (song_uuid,))
    if not cur.fetchone():
        raise ValueError('Song not found')

    # Add tag to song (ignore if already exists)
    cur.execute("""
        INSERT OR IGNORE INTO song_tags (song_uuid, tag_id, user_id)
        VALUES (?, ?, ?)
    """, (song_uuid, tag_id, user_id))

    return {'success': True}


@api_method('tags_remove_from_song', require='user')
def tags_remove_from_song(tag_id, song_uuid, details=None):
    """
    Remove a tag from a song.

    Args:
        tag_id: Tag ID
        song_uuid: Song UUID

    Returns:
        {success: bool}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    # Verify tag ownership
    cur.execute("""
        SELECT id FROM tags WHERE id = ? AND user_id = ?
    """, (tag_id, user_id))
    if not cur.fetchone():
        raise ValueError('Tag not found or access denied')

    cur.execute("""
        DELETE FROM song_tags
        WHERE tag_id = ? AND song_uuid = ? AND user_id = ?
    """, (tag_id, song_uuid, user_id))

    return {'success': True}


@api_method('tags_get_songs', require='user')
def tags_get_songs(tag_id, cursor=None, limit=100, details=None):
    """
    Get all songs with a specific tag.

    Args:
        tag_id: Tag ID
        cursor: Pagination cursor (offset as string)
        limit: Max results (default 100, max 500)

    Returns:
        {items: [...], nextCursor: str|null, hasMore: bool, totalCount: int}
    """
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    limit = min(int(limit), 500)
    offset = int(cursor) if cursor else 0

    # Verify tag ownership
    cur.execute("""
        SELECT id FROM tags WHERE id = ? AND user_id = ?
    """, (tag_id, user_id))
    if not cur.fetchone():
        raise ValueError('Tag not found or access denied')

    # Get total count
    cur.execute("""
        SELECT COUNT(*) FROM song_tags WHERE tag_id = ? AND user_id = ?
    """, (tag_id, user_id))
    total_count = cur.fetchone()[0]

    # Get songs
    cur.execute("""
        SELECT s.uuid, s.key, s.type, s.category, s.genre, s.artist, s.album,
               s.title, s.file, s.album_artist, s.track_number, s.disc_number,
               s.year, s.duration_seconds, s.bpm, s.seekable,
               s.replay_gain_track, s.replay_gain_album
        FROM songs s
        JOIN song_tags st ON s.uuid = st.song_uuid
        WHERE st.tag_id = ? AND st.user_id = ?
        ORDER BY s.artist, s.album, s.track_number
        LIMIT ? OFFSET ?
    """, (tag_id, user_id, limit + 1, offset))

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

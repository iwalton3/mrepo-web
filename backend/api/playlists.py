"""
Playlists API module for mrepo.

Provides playlist management with sharing support.
"""

import secrets
from datetime import datetime

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


def _renumber_playlist(cur, playlist_id):
    """Rewrite positions to a contiguous 0-based sequence, preserving order and
    duplicates. Uses rowid (stable per physical row) so duplicate song_uuids are
    handled unambiguously, and a two-pass negative range to dodge the
    (playlist_id, position) PRIMARY KEY mid-rewrite."""
    cur.execute("""
        SELECT rowid FROM playlist_songs WHERE playlist_id = ? ORDER BY position
    """, (playlist_id,))
    rowids = [r[0] for r in cur.fetchall()]
    for i, rid in enumerate(rowids):
        cur.execute("UPDATE playlist_songs SET position = ? WHERE rowid = ?",
                    (-(i + 1), rid))
    for i, rid in enumerate(rowids):
        cur.execute("UPDATE playlist_songs SET position = ? WHERE rowid = ?",
                    (i, rid))


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
def playlists_create(name, description='', is_public=False, details=None, _conn=None):
    """Create a new playlist."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not name or not name.strip():
        raise ValueError('Playlist name is required')

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        cur.execute("""
            INSERT INTO playlists (user_id, name, description, is_public)
            VALUES (?, ?, ?, ?)
        """, (user_id, name.strip(), description, 1 if is_public else 0))

        playlist_id = cur.lastrowid

        if own_conn:
            cur.execute("COMMIT")
        return {'id': playlist_id, 'name': name.strip()}
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


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
def playlists_delete(playlist_id, details=None, _conn=None):
    """Delete a playlist."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Playlist not found or access denied')

        # Delete songs first (cascade should handle this, but be explicit)
        cur.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (playlist_id,))
        cur.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))

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


def _playlist_songs_page(cur, playlist_id, cursor, offset, limit):
    """Fetch one page of a playlist's songs. Access must be checked by the caller."""
    limit = min(int(limit), 500)

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


@api_method('playlists_get_songs', require='user')
def playlists_get_songs(playlist_id, cursor=None, offset=None, limit=100, details=None):
    """Get songs in a playlist with pagination."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

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

    return _playlist_songs_page(cur, playlist_id, cursor, offset, limit)


@api_method('playlists_get_songs_by_token', require=None, public=True)
def playlists_get_songs_by_token(share_token, cursor=None, offset=None, limit=100):
    """Get songs of a shared playlist by its share token (public access).

    Least-privilege by construction: the unguessable share token is the
    capability, and it grants read access to exactly the playlist it was
    minted for - no user context, no playlist_id parameter to confuse,
    no other playlists, no writes. Playback needs no extra grant: the
    /stream/<uuid> route is already public.
    """
    if not share_token:
        raise ValueError('Playlist not found')

    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT id FROM playlists WHERE share_token = ?
    """, (share_token,))
    playlist = cur.fetchone()

    if not playlist:
        raise ValueError('Playlist not found')

    return _playlist_songs_page(cur, playlist['id'], cursor, offset, limit)


@api_method('playlists_add_song', require='user')
def playlists_add_song(playlist_id, song_uuid, details=None, _conn=None):
    """Add a song to a playlist."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        # Use BEGIN IMMEDIATE to acquire write lock for atomic position calculation
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Playlist not found or access denied')

        # Duplicates are a first-class feature: a playlist may contain the same
        # song more than once (e.g. the VVVVVV soundtrack repeats tracks
        # intentionally), so this always appends. The table's PRIMARY KEY is
        # (playlist_id, position), so a repeated add lands at a fresh position
        # rather than colliding.
        # Get next position (now protected by write lock)
        cur.execute("SELECT MAX(position) FROM playlist_songs WHERE playlist_id = ?",
                   (playlist_id,))
        result = cur.fetchone()
        next_pos = (result[0] or 0) + 1

        cur.execute("""
            INSERT INTO playlist_songs (playlist_id, song_uuid, position)
            VALUES (?, ?, ?)
        """, (playlist_id, song_uuid, next_pos))

        # Update playlist timestamp
        cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
                   (datetime.utcnow(), playlist_id))

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True, 'position': next_pos}
    except ValueError:
        raise
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('playlists_add_songs', require='user')
def playlists_add_songs(playlist_id, song_uuids, details=None, _conn=None):
    """Add multiple songs to a playlist."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not song_uuids:
        return {'success': True, 'added': 0, 'skipped': 0}

    if not isinstance(song_uuids, list):
        raise ValueError('song_uuids must be a list')

    try:
        # Use BEGIN IMMEDIATE to acquire write lock for atomic position calculation
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Playlist not found or access denied')

        # Get next position (now protected by write lock)
        cur.execute("SELECT MAX(position) FROM playlist_songs WHERE playlist_id = ?",
                   (playlist_id,))
        result = cur.fetchone()
        next_pos = (result[0] or 0) + 1

        # Duplicates are a first-class feature: append every uuid given, in
        # order, even if it already appears in the playlist. `skipped` stays in
        # the response shape (always 0 now) so callers that read it don't break.
        added = 0
        skipped = 0
        for uuid in song_uuids:
            cur.execute("""
                INSERT INTO playlist_songs (playlist_id, song_uuid, position)
                VALUES (?, ?, ?)
            """, (playlist_id, uuid, next_pos))
            added += 1
            next_pos += 1

        # Update playlist timestamp
        cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
                   (datetime.utcnow(), playlist_id))

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True, 'added': added, 'skipped': skipped}
    except ValueError:
        raise
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('playlists_remove_song', require='user')
def playlists_remove_song(playlist_id, song_uuid, index=None, details=None, _conn=None):
    """Remove a song from a playlist.

    Duplicate-safe: when `index` (the 0-based rank of the row in position order,
    i.e. the row the user clicked) is given, exactly that one copy is removed -
    critical now that a playlist may hold the same song several times. `song_uuid`
    then only verifies the rank still points at the intended song; on a mismatch
    (the client's view diverged) the lowest-position copy of song_uuid is removed
    so one intended copy still goes. When `index` is omitted (legacy offline
    writes queued before duplicates existed), every copy of song_uuid is removed.
    """
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Playlist not found or access denied')

        if index is not None:
            cur.execute("""
                SELECT position, song_uuid FROM playlist_songs
                WHERE playlist_id = ? ORDER BY position LIMIT 1 OFFSET ?
            """, (playlist_id, int(index)))
            row = cur.fetchone()
            if row is not None and row['song_uuid'] == song_uuid:
                target_pos = row['position']
            else:
                cur.execute("""
                    SELECT position FROM playlist_songs
                    WHERE playlist_id = ? AND song_uuid = ?
                    ORDER BY position LIMIT 1
                """, (playlist_id, song_uuid))
                r2 = cur.fetchone()
                target_pos = r2['position'] if r2 else None
            if target_pos is not None:
                cur.execute("""
                    DELETE FROM playlist_songs WHERE playlist_id = ? AND position = ?
                """, (playlist_id, target_pos))
                _renumber_playlist(cur, playlist_id)
        else:
            cur.execute("""
                DELETE FROM playlist_songs WHERE playlist_id = ? AND song_uuid = ?
            """, (playlist_id, song_uuid))

        cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
                   (datetime.utcnow(), playlist_id))

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


@api_method('playlists_remove_songs', require='user')
def playlists_remove_songs(playlist_id, song_uuids, indices=None, details=None, _conn=None):
    """Remove multiple songs from a playlist.

    Duplicate-safe: when `indices` (the 0-based ranks in position order of the
    selected rows) is given, exactly those rows are removed - so a multi-select
    that includes some-but-not-all copies of a repeated song removes only the
    chosen copies. When `indices` is omitted (legacy offline writes), every copy
    of each uuid in song_uuids is removed.
    """
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    if not song_uuids:
        return {'success': True, 'removed': 0}

    if not isinstance(song_uuids, list):
        raise ValueError('song_uuids must be a list')

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Playlist not found or access denied')

        removed = 0
        if indices is not None:
            cur.execute("""
                SELECT position, song_uuid FROM playlist_songs
                WHERE playlist_id = ? ORDER BY position
            """, (playlist_id,))
            rows = cur.fetchall()  # rank == list index
            target_positions = []
            for rank in indices:
                try:
                    target_positions.append(rows[int(rank)]['position'])
                except (IndexError, ValueError, TypeError):
                    continue
            for pos in target_positions:
                cur.execute("""
                    DELETE FROM playlist_songs WHERE playlist_id = ? AND position = ?
                """, (playlist_id, pos))
                removed += cur.rowcount
            if removed:
                _renumber_playlist(cur, playlist_id)
        else:
            for uuid in song_uuids:
                cur.execute("""
                    DELETE FROM playlist_songs WHERE playlist_id = ? AND song_uuid = ?
                """, (playlist_id, uuid))
                removed += cur.rowcount

        cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
                   (datetime.utcnow(), playlist_id))

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True, 'removed': removed}
    except ValueError:
        raise
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise


@api_method('playlists_reorder', require='user')
def playlists_reorder(playlist_id, positions, details=None, _conn=None):
    """Reorder songs in a playlist. positions is a list of {uuid, position} dicts."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
            raise ValueError('Playlist not found or access denied')

        if not positions or not isinstance(positions, list):
            if own_conn:
                cur.execute("ROLLBACK")
            return {'success': True}

        # Duplicate-safe path: when the same uuid appears more than once in the
        # payload, the per-uuid UPDATEs below can't tell the copies apart (they
        # would all collapse onto one position). A reorder from the frontend
        # always carries the COMPLETE new ordering, so when the payload covers
        # every row we rebuild the playlist from it wholesale - assigning each
        # copy its own position unambiguously. A payload that does NOT cover the
        # whole playlist is skipped rather than risk deleting rows it omits.
        valid = [(it.get('uuid'), it.get('position')) for it in positions
                 if it.get('uuid') is not None and it.get('position') is not None]
        uuids = [u for u, _ in valid]
        if len(uuids) != len(set(uuids)):
            cur.execute("SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?",
                       (playlist_id,))
            current_count = cur.fetchone()[0]
            if len(valid) == current_count:
                cur.execute("DELETE FROM playlist_songs WHERE playlist_id = ?",
                           (playlist_id,))
                for uuid, position in sorted(valid, key=lambda x: x[1]):
                    cur.execute("""
                        INSERT INTO playlist_songs (playlist_id, song_uuid, position)
                        VALUES (?, ?, ?)
                    """, (playlist_id, uuid, position))
            cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?",
                       (datetime.utcnow(), playlist_id))
            if own_conn:
                cur.execute("COMMIT")
            return {'success': True}

        # Use negative positions temporarily to avoid UNIQUE constraint violations
        # First pass: set all positions to negative
        for item in positions:
            uuid = item.get('uuid')
            position = item.get('position')
            if uuid is not None and position is not None:
                cur.execute("""
                    UPDATE playlist_songs SET position = ?
                    WHERE playlist_id = ? AND song_uuid = ?
                """, (-(position + 1), playlist_id, uuid))

        # Second pass: set to final positive positions
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

    # Deliberately no p.user_id: this is an unauthenticated endpoint and
    # the share view never uses the owner identity.
    cur.execute("""
        SELECT p.id, p.name, p.description, p.is_public, p.created_at,
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
def playlists_sort(playlist_id, sort_by='artist', order='asc', details=None, _conn=None):
    """Sort a playlist by a field."""
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    try:
        if own_conn:
            cur.execute("BEGIN IMMEDIATE")

        # Verify ownership
        cur.execute("SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                   (playlist_id, user_id))
        if not cur.fetchone():
            if own_conn:
                cur.execute("ROLLBACK")
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

        if own_conn:
            cur.execute("COMMIT")
        return {'success': True, 'songCount': len(songs)}
    except ValueError:
        raise
    except Exception as e:
        if own_conn:
            try:
                cur.execute("ROLLBACK")
            except:
                pass
        raise

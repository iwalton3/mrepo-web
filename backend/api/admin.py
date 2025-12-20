"""
Admin API module for mrepo.

Provides admin functions: VFS mappings, music scanning, user management.
"""

from datetime import datetime

from ..app import api_method
from ..db import get_db, row_to_dict, rows_to_list


# VFS (Virtual File System) Path Mapping Methods

@api_method('vfs_list_mappings', require='admin')
def vfs_list_mappings(details=None):
    """List all VFS path mappings."""
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, user_id, original_prefix, virtual_prefix, created_at
        FROM vfs_path_mappings
        ORDER BY virtual_prefix
    """)

    rows = cur.fetchall()
    return rows_to_list(rows)


@api_method('vfs_add_mapping', require='admin')
def vfs_add_mapping(original_prefix, virtual_prefix, user_id=None, details=None):
    """Add a VFS path mapping."""
    conn = get_db()
    cur = conn.cursor()

    if not original_prefix or not virtual_prefix:
        raise ValueError('Both original_prefix and virtual_prefix are required')

    try:
        cur.execute("""
            INSERT INTO vfs_path_mappings (user_id, original_prefix, virtual_prefix)
            VALUES (?, ?, ?)
        """, (user_id, original_prefix, virtual_prefix))
    except Exception:
        raise ValueError('Mapping already exists for this prefix')

    return {'id': cur.lastrowid}


@api_method('vfs_remove_mapping', require='admin')
def vfs_remove_mapping(mapping_id, details=None):
    """Remove a VFS path mapping."""
    conn = get_db()
    cur = conn.cursor()

    cur.execute("DELETE FROM vfs_path_mappings WHERE id = ?", (mapping_id,))

    if cur.rowcount == 0:
        raise ValueError('Mapping not found')

    return {'success': True}


@api_method('vfs_move_folder', require='admin')
def vfs_move_folder(old_prefix, new_prefix, details=None):
    """Update VFS mappings when a folder is moved."""
    conn = get_db()
    cur = conn.cursor()

    # Update all mappings that start with old_prefix
    cur.execute("""
        UPDATE vfs_path_mappings
        SET virtual_prefix = ? || SUBSTR(virtual_prefix, ?)
        WHERE virtual_prefix LIKE ?
    """, (new_prefix, len(old_prefix) + 1, old_prefix + '%'))

    return {'updated': cur.rowcount}


@api_method('vfs_rebuild_cache', require='admin')
def vfs_rebuild_cache(details=None):
    """Rebuild the VFS song paths cache."""
    count = _rebuild_vfs_cache_internal()
    return {'cached': count}


@api_method('rebuild_search_index', require='admin')
def rebuild_search_index(details=None):
    """Rebuild the full-text search index."""
    success = _rebuild_fts_index()
    return {'success': success}


# Music Scanner/Import Methods

def _rebuild_fts_index():
    """Rebuild the full-text search index."""
    from ..db import get_db

    conn = get_db()
    cur = conn.cursor()

    try:
        # For external content FTS tables, this rebuilds the entire index
        cur.execute("INSERT INTO songs_fts(songs_fts) VALUES('rebuild')")
        conn.commit()
        return True
    except Exception:
        # FTS table may not exist or be configured differently
        return False


def _rebuild_vfs_cache_internal():
    """Internal function to rebuild VFS cache (no auth check)."""
    from ..db import get_db

    conn = get_db()
    cur = conn.cursor()

    # Clear existing cache
    cur.execute("DELETE FROM vfs_song_paths")

    # Get all mappings
    cur.execute("SELECT user_id, original_prefix, virtual_prefix FROM vfs_path_mappings")
    mappings = cur.fetchall()

    if not mappings:
        return 0

    count = 0
    for mapping in mappings:
        user_id = mapping['user_id']
        original = mapping['original_prefix']
        virtual = mapping['virtual_prefix']

        # Find songs matching this mapping
        cur.execute("""
            SELECT uuid, file FROM songs WHERE file LIKE ?
        """, (original + '%',))

        for song in cur.fetchall():
            # Calculate virtual path
            relative = song['file'][len(original):]
            virtual_file = virtual + relative
            virtual_dir = '/'.join(virtual_file.split('/')[:-1]) + '/'

            cur.execute("""
                INSERT OR REPLACE INTO vfs_song_paths (song_uuid, user_id, virtual_file, virtual_dir)
                VALUES (?, ?, ?, ?)
            """, (song['uuid'], user_id, virtual_file, virtual_dir))
            count += 1

    return count


def _run_scan_in_background(paths, task_id):
    """Run the scan in a background thread."""
    from ..scanner import scan_paths
    from ..db import get_db

    try:
        result = scan_paths(paths, task_id)

        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
            UPDATE scan_tasks
            SET status = 'completed', completed_at = ?,
                total_files = ?, processed_files = ?,
                new_songs = ?, updated_songs = ?
            WHERE id = ?
        """, (datetime.utcnow(), result['total'], result['processed'],
              result['new'], result['updated'], task_id))
        conn.commit()

        # Rebuild indexes after successful scan
        _rebuild_fts_index()
        _rebuild_vfs_cache_internal()

    except Exception as e:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
            UPDATE scan_tasks
            SET status = 'failed', errors = ?, completed_at = ?
            WHERE id = ?
        """, (str(e), datetime.utcnow(), task_id))
        conn.commit()


@api_method('admin_start_scan', require='admin')
def admin_start_scan(paths=None, force=False, details=None):
    """Start a music library scan task."""
    import json
    import threading
    from flask import current_app

    conn = get_db()
    cur = conn.cursor()

    # Use configured paths if none provided
    if not paths:
        paths = current_app.config.get('MEDIA_PATHS', [])

    if not paths:
        raise ValueError('No media paths configured')

    # Check for existing running scan
    cur.execute("SELECT id FROM scan_tasks WHERE status = 'running'")
    running = cur.fetchone()
    if running:
        if force:
            # Mark stale scan as cancelled (e.g., after server restart)
            cur.execute("""
                UPDATE scan_tasks SET status = 'cancelled', completed_at = ?
                WHERE status = 'running'
            """, (datetime.utcnow(),))
        else:
            raise ValueError('A scan is already running. Use force=true to cancel it and start a new one.')

    # Create scan task
    cur.execute("""
        INSERT INTO scan_tasks (status, paths, started_at)
        VALUES ('running', ?, ?)
    """, (json.dumps(paths), datetime.utcnow()))

    task_id = cur.lastrowid

    # Start background scan in a separate thread
    thread = threading.Thread(
        target=_run_scan_in_background,
        args=(paths, task_id),
        daemon=True
    )
    thread.start()

    return {'taskId': task_id, 'status': 'running'}


@api_method('admin_scan_status', require='admin')
def admin_scan_status(task_id=None, details=None):
    """Get status of a scan task or the most recent one."""
    conn = get_db()
    cur = conn.cursor()

    if task_id:
        cur.execute("""
            SELECT * FROM scan_tasks WHERE id = ?
        """, (task_id,))
    else:
        cur.execute("""
            SELECT * FROM scan_tasks ORDER BY created_at DESC LIMIT 1
        """)

    row = cur.fetchone()

    if not row:
        return {'status': 'none'}

    return row_to_dict(row)


@api_method('admin_cancel_scan', require='admin')
def admin_cancel_scan(task_id=None, details=None):
    """Cancel a running scan task."""
    conn = get_db()
    cur = conn.cursor()

    if task_id:
        cur.execute("""
            UPDATE scan_tasks SET status = 'cancelled', completed_at = ?
            WHERE id = ? AND status = 'running'
        """, (datetime.utcnow(), task_id))
    else:
        cur.execute("""
            UPDATE scan_tasks SET status = 'cancelled', completed_at = ?
            WHERE status = 'running'
        """, (datetime.utcnow(),))

    return {'success': True, 'cancelled': cur.rowcount}


@api_method('admin_relocate_paths', require='admin')
def admin_relocate_paths(old_prefix, new_prefix, dry_run=True, details=None):
    """Update file paths when music is moved to a new location.

    Args:
        old_prefix: The old path prefix to replace (e.g., '/old/music/')
        new_prefix: The new path prefix (e.g., '/new/music/')
        dry_run: If True, only return count of affected files without updating

    Returns:
        Count of affected/updated songs
    """
    conn = get_db()
    cur = conn.cursor()

    if not old_prefix or not new_prefix:
        raise ValueError('Both old_prefix and new_prefix are required')

    # Count affected songs
    cur.execute("""
        SELECT COUNT(*) FROM songs WHERE file LIKE ?
    """, (old_prefix + '%',))
    count = cur.fetchone()[0]

    if dry_run:
        return {'affected': count, 'dry_run': True}

    # Update paths
    cur.execute("""
        UPDATE songs
        SET file = ? || SUBSTR(file, ?)
        WHERE file LIKE ?
    """, (new_prefix, len(old_prefix) + 1, old_prefix + '%'))

    return {'updated': cur.rowcount, 'dry_run': False}


@api_method('admin_find_missing', require='admin')
def admin_find_missing(limit=100, details=None):
    """Find songs whose files no longer exist on disk.

    Args:
        limit: Maximum number of missing songs to return

    Returns:
        List of missing songs with their metadata
    """
    from pathlib import Path

    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT uuid, file, title, artist, album FROM songs")
    songs = cur.fetchall()

    missing = []
    for song in songs:
        file_path = Path(song['file'])
        if not file_path.exists():
            missing.append({
                'uuid': song['uuid'],
                'file': song['file'],
                'title': song['title'],
                'artist': song['artist'],
                'album': song['album']
            })
            if len(missing) >= limit:
                break

    return {
        'missing': missing,
        'count': len(missing),
        'total_scanned': len(songs),
        'truncated': len(missing) >= limit
    }


@api_method('admin_remove_missing', require='admin')
def admin_remove_missing(details=None):
    """Remove songs from database whose files no longer exist on disk.

    Returns:
        Count of removed songs
    """
    from pathlib import Path

    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT uuid, file FROM songs")
    songs = cur.fetchall()

    removed = 0
    for song in songs:
        file_path = Path(song['file'])
        if not file_path.exists():
            cur.execute("DELETE FROM songs WHERE uuid = ?", (song['uuid'],))
            removed += 1

    return {'removed': removed, 'total_scanned': len(songs)}


@api_method('admin_get_stats', require='admin')
def admin_get_stats(details=None):
    """Get library statistics."""
    conn = get_db()
    cur = conn.cursor()

    stats = {}

    # Song counts
    cur.execute("SELECT COUNT(*) FROM songs")
    stats['totalSongs'] = cur.fetchone()[0]

    cur.execute("SELECT COUNT(DISTINCT artist) FROM songs WHERE artist IS NOT NULL")
    stats['totalArtists'] = cur.fetchone()[0]

    cur.execute("SELECT COUNT(DISTINCT album) FROM songs WHERE album IS NOT NULL")
    stats['totalAlbums'] = cur.fetchone()[0]

    cur.execute("SELECT COUNT(DISTINCT genre) FROM songs WHERE genre IS NOT NULL")
    stats['totalGenres'] = cur.fetchone()[0]

    cur.execute("SELECT COUNT(DISTINCT category) FROM songs WHERE category IS NOT NULL")
    stats['totalCategories'] = cur.fetchone()[0]

    # Total duration
    cur.execute("SELECT SUM(duration_seconds) FROM songs")
    total_seconds = cur.fetchone()[0] or 0
    stats['totalDuration'] = total_seconds
    stats['totalDurationFormatted'] = f"{int(total_seconds // 3600)}h {int((total_seconds % 3600) // 60)}m"

    # User counts
    cur.execute("SELECT COUNT(*) FROM users")
    stats['totalUsers'] = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM playlists")
    stats['totalPlaylists'] = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM play_history")
    stats['totalPlays'] = cur.fetchone()[0]

    # Recent activity
    cur.execute("""
        SELECT COUNT(*) FROM play_history
        WHERE played_at > datetime('now', '-7 days')
    """)
    stats['playsLastWeek'] = cur.fetchone()[0]

    return stats


@api_method('admin_get_config', require='admin')
def admin_get_config(details=None):
    """Get current configuration (sanitized)."""
    from flask import current_app
    from ..streaming import ffmpeg_available

    return {
        'mediaPaths': current_app.config.get('MEDIA_PATHS', []),
        'databasePath': current_app.config.get('DATABASE_PATH'),
        'ffmpegAvailable': ffmpeg_available(),
        'transcodeBitrate': current_app.config.get('TRANSCODE_BITRATE'),
        'allowRegistration': current_app.config.get('ALLOW_REGISTRATION', False),
    }

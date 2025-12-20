"""
History API module for mrepo.

Provides play history tracking and retrieval.
"""

from datetime import datetime

from ..app import api_method
from ..db import get_db, rows_to_list


@api_method('history_record', require='user')
def history_record(song_uuid, duration_seconds=0, skipped=False,
                   source='browse', details=None):
    """Record a play event."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    cur.execute("""
        INSERT INTO play_history (user_id, song_uuid, play_duration_seconds, skipped, source)
        VALUES (?, ?, ?, ?, ?)
    """, (user_id, song_uuid, duration_seconds, 1 if skipped else 0, source))

    return {'success': True}


@api_method('history_recent', require='user')
def history_recent(limit=50, details=None):
    """Get recent play history."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    limit = min(int(limit), 100)

    cur.execute("""
        SELECT s.uuid, s.title, s.artist, s.album, s.type, s.seekable,
               h.played_at, h.play_duration_seconds, h.skipped, h.source
        FROM play_history h
        JOIN songs s ON h.song_uuid = s.uuid
        WHERE h.user_id = ?
        ORDER BY h.played_at DESC
        LIMIT ?
    """, (user_id, limit))

    rows = cur.fetchall()
    return {'items': rows_to_list(rows)}


@api_method('history_list', require='user')
def history_list(start_date=None, end_date=None, exclude_skipped=False,
                 offset=0, limit=100, details=None):
    """Get play history with pagination and date filters."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    limit = min(int(limit), 200)
    offset = int(offset) if offset else 0
    conditions = ["h.user_id = ?"]
    params = [user_id]

    if start_date:
        conditions.append("h.played_at >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("h.played_at <= ?")
        # Append time to include the entire day
        if len(end_date) == 10:  # YYYY-MM-DD format
            params.append(end_date + ' 23:59:59')
        else:
            params.append(end_date)
    if exclude_skipped:
        conditions.append("h.skipped = 0")

    where_clause = " AND ".join(conditions)

    # Get total count
    cur.execute(f"SELECT COUNT(*) FROM play_history h WHERE {where_clause}", params)
    total_count = cur.fetchone()[0]

    cur.execute(f"""
        SELECT s.uuid, s.title, s.artist, s.album, s.type, s.seekable,
               h.played_at, h.play_duration_seconds, h.skipped, h.source
        FROM play_history h
        JOIN songs s ON h.song_uuid = s.uuid
        WHERE {where_clause}
        ORDER BY h.played_at DESC
        LIMIT ? OFFSET ?
    """, params + [limit, offset])

    rows = cur.fetchall()
    items = rows_to_list(rows)
    has_more = (offset + len(items)) < total_count

    return {
        'items': items,
        'totalCount': total_count,
        'hasMore': has_more
    }


@api_method('history_grouped', require='user')
def history_grouped(start_date=None, end_date=None, exclude_skipped=False,
                    offset=0, limit=100, details=None):
    """Get play history grouped by song."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    limit = min(int(limit), 200)
    offset = int(offset) if offset else 0
    conditions = ["h.user_id = ?"]
    params = [user_id]

    if start_date:
        conditions.append("h.played_at >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("h.played_at <= ?")
        # Append time to include the entire day
        if len(end_date) == 10:  # YYYY-MM-DD format
            params.append(end_date + ' 23:59:59')
        else:
            params.append(end_date)
    if exclude_skipped:
        conditions.append("h.skipped = 0")

    where_clause = " AND ".join(conditions)

    # Get total count of unique songs
    cur.execute(f"""
        SELECT COUNT(DISTINCT s.uuid)
        FROM play_history h
        JOIN songs s ON h.song_uuid = s.uuid
        WHERE {where_clause}
    """, params)
    total_count = cur.fetchone()[0]

    cur.execute(f"""
        SELECT s.uuid, s.title, s.artist, s.album, s.type, s.seekable,
               COUNT(*) as play_count,
               MAX(h.played_at) as last_played,
               SUM(h.play_duration_seconds) as total_duration
        FROM play_history h
        JOIN songs s ON h.song_uuid = s.uuid
        WHERE {where_clause}
        GROUP BY s.uuid
        ORDER BY play_count DESC, last_played DESC
        LIMIT ? OFFSET ?
    """, params + [limit, offset])

    rows = cur.fetchall()
    items = rows_to_list(rows)
    has_more = (offset + len(items)) < total_count

    return {
        'items': items,
        'totalCount': total_count,
        'hasMore': has_more
    }


@api_method('history_get_uuids', require='user')
def history_get_uuids(start_date=None, end_date=None, exclude_skipped=False,
                      grouped=False, limit=5000, details=None):
    """Get UUIDs from play history (for creating playlists from history)."""
    conn = get_db()
    cur = conn.cursor()
    user_id = details['user_id']

    limit = min(int(limit), 10000)
    conditions = ["h.user_id = ?"]
    params = [user_id]

    if start_date:
        conditions.append("h.played_at >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("h.played_at <= ?")
        # Append time to include the entire day
        if len(end_date) == 10:  # YYYY-MM-DD format
            params.append(end_date + ' 23:59:59')
        else:
            params.append(end_date)
    if exclude_skipped:
        conditions.append("h.skipped = 0")

    where_clause = " AND ".join(conditions)

    if grouped:
        # Get unique UUIDs ordered by play count
        cur.execute(f"""
            SELECT h.song_uuid, COUNT(*) as play_count
            FROM play_history h
            WHERE {where_clause}
            GROUP BY h.song_uuid
            ORDER BY play_count DESC
            LIMIT ?
        """, params + [limit])
    else:
        # Get all UUIDs ordered by played_at
        cur.execute(f"""
            SELECT h.song_uuid
            FROM play_history h
            WHERE {where_clause}
            ORDER BY h.played_at DESC
            LIMIT ?
        """, params + [limit])

    rows = cur.fetchall()

    # Get total count
    if grouped:
        cur.execute(f"""
            SELECT COUNT(DISTINCT h.song_uuid)
            FROM play_history h
            WHERE {where_clause}
        """, params)
    else:
        cur.execute(f"""
            SELECT COUNT(*)
            FROM play_history h
            WHERE {where_clause}
        """, params)
    total_count = cur.fetchone()[0]

    return {
        'uuids': [row['song_uuid'] for row in rows],
        'totalCount': total_count
    }

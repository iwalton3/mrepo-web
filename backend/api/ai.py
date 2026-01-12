"""
AI Music Similarity API endpoints.

Provides API methods for AI-powered music search and recommendations.
Communicates with the separate AI service via HTTP.
"""

import requests
from flask import current_app

from ..app import api_method
from ..db import get_db


# Timeout constants
DEFAULT_TIMEOUT = 10.0
SEARCH_TIMEOUT = 5.0


def _get_ai_config():
    """Get AI configuration from Flask app config."""
    return {
        'enabled': current_app.config.get('AI_ENABLED', False),
        'service_url': current_app.config.get('AI_SERVICE_URL'),
        'service_timeout': current_app.config.get('AI_SERVICE_TIMEOUT', DEFAULT_TIMEOUT),
        'search_timeout': current_app.config.get('AI_SEARCH_TIMEOUT', SEARCH_TIMEOUT),
    }


def _ai_request(endpoint, payload, timeout=None):
    """Make a request to the AI service.

    Args:
        endpoint: API endpoint (e.g., '/search/text')
        payload: Request payload dict
        timeout: Optional timeout override

    Returns:
        Response dict or error dict
    """
    config = _get_ai_config()

    # Auto-enable if service URL is configured (don't require AI_ENABLED=true)
    if not config['service_url']:
        return {'error': 'AI service URL not configured'}

    if timeout is None:
        timeout = config['service_timeout']

    url = f"{config['service_url'].rstrip('/')}{endpoint}"

    try:
        response = requests.post(url, json=payload, timeout=timeout)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.Timeout:
        return {'error': 'timeout', 'message': 'AI service timed out'}
    except requests.exceptions.ConnectionError:
        return {'error': 'connection', 'message': 'Cannot connect to AI service'}
    except requests.exceptions.RequestException as e:
        return {'error': 'request', 'message': str(e)}


def _check_ai_enabled():
    """Check if AI is enabled, raise error if not."""
    config = _get_ai_config()
    # Auto-enable if service URL is configured
    if not config['service_url']:
        raise ValueError('AI service not configured')


# -----------------------------------------------------------------------------
# Public API Methods
# -----------------------------------------------------------------------------

@api_method('ai_status', require='user')
def ai_status(details=None):
    """Check AI service status.

    Returns:
        dict with status, model_loaded, index_size, device
    """
    config = _get_ai_config()

    # Auto-enable if service URL is configured (don't require AI_ENABLED=true)
    if not config['service_url']:
        return {
            'enabled': False,
            'status': 'not_configured',
            'model_loaded': False,
            'index_size': 0,
            'device': 'none'
        }

    # Try to get health from service
    try:
        response = requests.get(
            f"{config['service_url'].rstrip('/')}/health",
            timeout=config['search_timeout']
        )
        response.raise_for_status()
        result = response.json()
        result['enabled'] = True
        return result
    except Exception as e:
        return {
            'enabled': True,
            'status': 'offline',
            'error': str(e),
            'model_loaded': False,
            'index_size': 0,
            'device': 'unknown'
        }


@api_method('ai_search_text', require='user')
def ai_search_text(query, k=50, min_score=0.2, filter_uuids=None, details=None):
    """Search for songs using natural language.

    Args:
        query: Text description (e.g., "upbeat electronic music")
        k: Number of results to return
        min_score: Minimum similarity score (0-1)
        filter_uuids: Optional list of UUIDs to filter within

    Returns:
        dict with 'results' list of {uuid, score}
    """
    _check_ai_enabled()

    config = _get_ai_config()
    result = _ai_request('/search/text', {
        'query': query,
        'k': k,
        'min_score': min_score,
        'filter_uuids': filter_uuids
    }, timeout=config['service_timeout'])

    if 'error' in result:
        raise ValueError(f"AI search failed: {result.get('message', result['error'])}")

    return result


@api_method('ai_search_compound', require='user')
def ai_search_compound(positive_texts=None, negative_texts=None, positive_uuids=None,
                       negative_uuids=None, k=50, min_score=0.2, neg_weight=0.5,
                       filter_uuids=None, details=None):
    """Search using compound embedding arithmetic (positive minus negative).

    Combines text and song embeddings at the embedding level:
    - Positive terms are averaged together
    - Negative terms are subtracted (weighted by neg_weight)
    - Result is normalized and searched

    Args:
        positive_texts: List of text prompts to include
        negative_texts: List of text prompts to exclude
        positive_uuids: List of song UUIDs to include
        negative_uuids: List of song UUIDs to exclude
        k: Number of results to return
        min_score: Minimum similarity score (0-1)
        neg_weight: Weight for negative terms (0-1, default 0.5)
        filter_uuids: Optional list of UUIDs to filter within

    Returns:
        dict with 'results' list of {uuid, score}
    """
    _check_ai_enabled()

    if not positive_texts and not positive_uuids:
        raise ValueError("At least one positive term (text or UUID) required")

    config = _get_ai_config()
    result = _ai_request('/search/compound', {
        'positive_texts': positive_texts or [],
        'negative_texts': negative_texts or [],
        'positive_uuids': positive_uuids or [],
        'negative_uuids': negative_uuids or [],
        'k': k,
        'min_score': min_score,
        'neg_weight': neg_weight,
        'filter_uuids': filter_uuids
    }, timeout=config['service_timeout'])

    if 'error' in result:
        raise ValueError(f"AI compound search failed: {result.get('message', result['error'])}")

    return result


@api_method('ai_search_similar', require='user')
def ai_search_similar(uuid, k=50, exclude_uuids=None, filter_uuids=None, details=None):
    """Find songs similar to a given song.

    Args:
        uuid: Song UUID to find similar songs for
        k: Number of results to return
        exclude_uuids: UUIDs to exclude from results
        filter_uuids: Optional list of UUIDs to filter within

    Returns:
        dict with 'results' list of {uuid, score}
    """
    _check_ai_enabled()

    config = _get_ai_config()
    result = _ai_request('/search/similar', {
        'uuid': uuid,
        'k': k,
        'exclude_uuids': exclude_uuids or [],
        'filter_uuids': filter_uuids
    }, timeout=config['search_timeout'])

    if 'error' in result:
        raise ValueError(f"AI similar search failed: {result.get('message', result['error'])}")

    # Enrich results with song metadata
    if result.get('results'):
        db = get_db()
        cur = db.cursor()
        uuids = [r['uuid'] for r in result['results']]
        placeholders = ','.join('?' * len(uuids))
        cur.execute(f'''
            SELECT uuid, title, artist, album, category, genre, duration_seconds,
                   file, album_artist, track_number, year
            FROM songs WHERE uuid IN ({placeholders})
        ''', uuids)

        metadata = {row['uuid']: dict(row) for row in cur.fetchall()}
        for item in result['results']:
            if item['uuid'] in metadata:
                item.update(metadata[item['uuid']])

    return result


@api_method('ai_generate_playlist', require='user')
def ai_generate_playlist(prompt=None, seed_uuids=None, size=30, diversity=0.2,
                         min_duration=30, exclude_uuids=None, details=None):
    """Generate a playlist using AI.

    Args:
        prompt: Text description of desired music
        seed_uuids: List of song UUIDs to use as seeds (alternative to prompt)
        size: Number of songs to generate
        diversity: 0-1, higher values add more variety (MMR)
        min_duration: Minimum song duration in seconds
        exclude_uuids: UUIDs to exclude from results

    Returns:
        dict with 'songs' list of {uuid, score}
    """
    _check_ai_enabled()

    if not prompt and not seed_uuids:
        raise ValueError("Either 'prompt' or 'seed_uuids' must be provided")

    config = _get_ai_config()
    result = _ai_request('/playlist/generate', {
        'prompt': prompt,
        'seed_uuids': seed_uuids,
        'size': size,
        'diversity': diversity,
        'min_duration': min_duration,
        'exclude_uuids': exclude_uuids or []
    }, timeout=config['service_timeout'])

    if 'error' in result:
        raise ValueError(f"AI playlist generation failed: {result.get('message', result['error'])}")

    return result


@api_method('ai_extend_queue', require='user')
def ai_extend_queue(count=10, diversity=0.2, details=None):
    """Extend the current queue with similar songs using AI.

    Uses the last 5 songs in the queue as seeds.

    Args:
        count: Number of songs to add
        diversity: 0-1, higher values add more variety

    Returns:
        dict with 'added' list of UUIDs added to queue
    """
    _check_ai_enabled()

    user_id = details['user_id']
    db = get_db()
    cur = db.cursor()

    # Get last 5 songs from queue as seeds
    cur.execute('''
        SELECT song_uuid FROM user_queue
        WHERE user_id = ?
        ORDER BY position DESC
        LIMIT 5
    ''', (user_id,))

    seed_uuids = [row['song_uuid'] for row in cur.fetchall()]

    if not seed_uuids:
        raise ValueError("Queue is empty - cannot extend")

    # Get all current queue UUIDs to exclude
    cur.execute('''
        SELECT song_uuid FROM user_queue WHERE user_id = ?
    ''', (user_id,))
    exclude_uuids = [row['song_uuid'] for row in cur.fetchall()]

    # Generate playlist from seeds
    config = _get_ai_config()
    result = _ai_request('/playlist/generate', {
        'seed_uuids': seed_uuids,
        'size': count,
        'diversity': diversity,
        'min_duration': 30,
        'exclude_uuids': exclude_uuids
    }, timeout=config['service_timeout'])

    if 'error' in result:
        raise ValueError(f"AI extend failed: {result.get('message', result['error'])}")

    # Add songs to queue
    songs_to_add = [s['uuid'] for s in result.get('songs', [])]

    if songs_to_add:
        # Get max position
        cur.execute('''
            SELECT COALESCE(MAX(position), -1) as max_pos
            FROM user_queue WHERE user_id = ?
        ''', (user_id,))
        max_pos = cur.fetchone()['max_pos']

        # Insert new songs
        for i, uuid in enumerate(songs_to_add):
            cur.execute('''
                INSERT INTO user_queue (user_id, song_uuid, position)
                VALUES (?, ?, ?)
            ''', (user_id, uuid, max_pos + 1 + i))

        db.commit()

    return {'added': songs_to_add}


@api_method('ai_extend_playlist', require='user')
def ai_extend_playlist(playlist_id, count=10, diversity=0.2, details=None):
    """Extend a playlist with similar songs using AI.

    Uses the last 5 songs in the playlist as seeds.

    Args:
        playlist_id: Playlist to extend
        count: Number of songs to add
        diversity: 0-1, higher values add more variety

    Returns:
        dict with 'added' list of UUIDs added to playlist
    """
    _check_ai_enabled()

    user_id = details['user_id']
    db = get_db()
    cur = db.cursor()

    # Verify playlist ownership
    cur.execute('''
        SELECT id FROM playlists WHERE id = ? AND user_id = ?
    ''', (playlist_id, user_id))

    if not cur.fetchone():
        raise ValueError("Playlist not found or access denied")

    # Get last 5 songs from playlist as seeds
    cur.execute('''
        SELECT song_uuid FROM playlist_songs
        WHERE playlist_id = ?
        ORDER BY position DESC
        LIMIT 5
    ''', (playlist_id,))

    seed_uuids = [row['song_uuid'] for row in cur.fetchall()]

    if not seed_uuids:
        raise ValueError("Playlist is empty - cannot extend")

    # Get all current playlist UUIDs to exclude
    cur.execute('''
        SELECT song_uuid FROM playlist_songs WHERE playlist_id = ?
    ''', (playlist_id,))
    exclude_uuids = [row['song_uuid'] for row in cur.fetchall()]

    # Generate playlist from seeds
    config = _get_ai_config()
    result = _ai_request('/playlist/generate', {
        'seed_uuids': seed_uuids,
        'size': count,
        'diversity': diversity,
        'min_duration': 30,
        'exclude_uuids': exclude_uuids
    }, timeout=config['service_timeout'])

    if 'error' in result:
        raise ValueError(f"AI extend failed: {result.get('message', result['error'])}")

    # Add songs to playlist
    songs_to_add = [s['uuid'] for s in result.get('songs', [])]

    if songs_to_add:
        # Get max position
        cur.execute('''
            SELECT COALESCE(MAX(position), -1) as max_pos
            FROM playlist_songs WHERE playlist_id = ?
        ''', (playlist_id,))
        max_pos = cur.fetchone()['max_pos']

        # Insert new songs
        for i, uuid in enumerate(songs_to_add):
            cur.execute('''
                INSERT INTO playlist_songs (playlist_id, song_uuid, position)
                VALUES (?, ?, ?)
            ''', (playlist_id, uuid, max_pos + 1 + i))

        # Update playlist timestamp
        cur.execute('''
            UPDATE playlists SET updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (playlist_id,))

        db.commit()

    return {'added': songs_to_add}


@api_method('ai_check_duplicates', require='user')
def ai_check_duplicates(uuids, threshold=0.95, details=None):
    """Check for duplicate songs among the given UUIDs.

    Args:
        uuids: List of song UUIDs to check
        threshold: Similarity threshold (0.5-1.0)

    Returns:
        dict with 'groups' list of duplicate groups
    """
    _check_ai_enabled()

    if not uuids or len(uuids) < 2:
        return {'groups': []}

    config = _get_ai_config()
    result = _ai_request('/duplicates/check', {
        'uuids': uuids,
        'threshold': threshold
    }, timeout=config['service_timeout'])

    if 'error' in result:
        raise ValueError(f"AI duplicate check failed: {result.get('message', result['error'])}")

    return result

/**
 * Music Player API Client
 *
 * Communicates with the backend music API. The transport endpoint and stream
 * URLs come from the per-deployment `#profile` seam so this client stays
 * byte-identical across the public and private builds; the deployment-specific
 * method groups (AI search, VFS, admin, auth extras) live behind `#profile`.
 */

import { profile } from '#profile';

/**
 * Check if work offline mode is enabled.
 * Uses localStorage directly to avoid circular imports with offline-store.
 */
function isWorkOfflineMode() {
    return localStorage.getItem('music-work-offline') === 'true';
}

/**
 * Make an API call to the backend.
 */
export async function apiCall(method, args = {}, kwargs = {}) {
    // Block all API calls in work offline mode
    if (isWorkOfflineMode()) {
        throw new Error('Network blocked: Work Offline mode is enabled');
    }

    const response = await fetch(profile.endpoints.apiBase, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
            method,
            args: Array.isArray(args) ? args : [],
            kwargs: typeof args === 'object' && !Array.isArray(args) ? args : kwargs,
            version: 2
        })
    });

    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(data.error);
    }

    return data.result;
}

/**
 * Songs API
 */
export const songs = {
    /**
     * List songs with cursor-based pagination.
     */
    async list({ cursor, limit = 50, sort = 'title', order = 'asc',
                 category, genre, artist, album } = {}) {
        return apiCall('songs_list', {
            cursor, limit, sort, order, category, genre, artist, album
        });
    },

    /**
     * Get a single song by UUID.
     * @param {string} uuid - Song UUID
     * @param {Object} options - Optional parameters
     * @param {boolean} options.include_vfs - Include VFS virtual_file path
     */
    async get(uuid, options = {}) {
        // include_vfs (and other VFS-only params) are accepted only where the
        // backend has VFS support; strip them elsewhere to avoid InvalidParameters.
        return apiCall('songs_get', { uuid, ...(profile.vfs ? options : {}) });
    },

    /**
     * Get multiple songs by UUID.
     * @param {string[]} uuids - Array of song UUIDs
     * @param {Object} options - Optional parameters
     * @param {boolean} options.include_vfs - Include VFS virtual_file paths
     * @returns {Promise<Object[]>} Array of song objects
     */
    async getBulk(uuids, options = {}) {
        // include_vfs (and other VFS-only params) are accepted only where the
        // backend has VFS support; strip them elsewhere to avoid InvalidParameters.
        return apiCall('songs_get_bulk', { uuids, ...(profile.vfs ? options : {}) });
    },

    /**
     * Search songs with advanced query syntax.
     * Supports offset-based pagination for jumping to specific positions.
     */
    async search(query, { cursor, offset, limit = 50 } = {}) {
        return apiCall('songs_search', { query, cursor, offset, limit });
    },

    /**
     * Get random song(s).
     */
    async random(filterQuery = null, count = 1) {
        return apiCall('songs_random', { filter_query: filterQuery, count });
    },

    /**
     * Quick search returning sectioned results (Spotify-style).
     * Returns artists, albums, songs, and folders matching the query.
     */
    async quickSearch(query, limit = 10) {
        return apiCall('songs_quick_search', { query, limit });
    },

    /**
     * Get song count with filters.
     */
    async count({ category, genre, artist, album } = {}) {
        return apiCall('songs_count', { category, genre, artist, album });
    },

    /**
     * Get all songs under a file path prefix.
     */
    async byPath(path, { cursor, limit = 100 } = {}) {
        return apiCall('songs_by_path', { path, cursor, limit });
    },

    /**
     * Get all songs matching hierarchy filters.
     */
    async byFilter({ category, genre, artist, album, cursor, limit = 100 } = {}) {
        return apiCall('songs_by_filter', { category, genre, artist, album, cursor, limit });
    },

    /**
     * Ranked full-text search using FTS5 BM25 scoring.
     * Returns songs ranked by relevance with field weights.
     */
    async ftsRanked(query, limit = 50) {
        return apiCall('songs_fts_ranked', { query, limit });
    }
};

/**
 * Browse API
 */
export const browse = {
    /**
     * List all categories with song counts.
     * @param {string} [sort] - 'name' (default) or 'song_count'
     */
    async categories({ sort } = {}) {
        return apiCall('browse_categories', { sort });
    },

    /**
     * List genres, optionally filtered by category.
     * @param {Object} [options]
     * @param {string} [options.category] - Category filter
     * @param {number} [options.minSongs] - Minimum song count filter (default: none)
     * @param {string} [options.sort] - 'name' (default) or 'song_count'
     */
    async genres({ category, minSongs, sort } = {}) {
        return apiCall('browse_genres', { category, min_songs: minSongs, sort });
    },

    /**
     * List artists with pagination.
     * @param {Object} [options]
     * @param {string} [options.category] - Category filter
     * @param {string} [options.genre] - Genre filter
     * @param {string} [options.cursor] - Pagination cursor
     * @param {number} [options.limit] - Results per page (default: 100)
     * @param {number} [options.minSongs] - Minimum song count filter
     * @param {string} [options.sort] - 'name' (default) or 'song_count'
     */
    async artists({ category, genre, cursor, limit = 100, minSongs, sort } = {}) {
        return apiCall('browse_artists', { category, genre, cursor, limit, min_songs: minSongs, sort });
    },

    /**
     * List albums with pagination.
     * @param {Object} [options]
     * @param {string} [options.artist] - Artist filter
     * @param {string} [options.category] - Category filter (for hierarchy navigation)
     * @param {string} [options.genre] - Genre filter (for hierarchy navigation)
     * @param {string} [options.cursor] - Pagination cursor
     * @param {number} [options.limit] - Results per page (default: 100)
     * @param {string} [options.sort] - 'name' (default) or 'song_count'
     */
    async albums({ artist, category, genre, cursor, limit = 100, sort } = {}) {
        return apiCall('browse_albums', { artist, category, genre, cursor, limit, sort });
    },

    /**
     * List songs in an album.
     * Sorting is automatic: by disc/track if track numbers exist, otherwise by title.
     * @param {string} album - Album name, '[Unknown Album]', '[All Albums]', or null
     * @param {Object} [options]
     * @param {string} [options.artist] - Artist filter
     * @param {string} [options.category] - Category filter (for hierarchy navigation)
     * @param {string} [options.genre] - Genre filter (for hierarchy navigation)
     * @param {string} [options.cursor] - Pagination cursor
     * @param {number} [options.limit] - Results per page (default: 100)
     */
    async albumSongs(album, { artist, category, genre, cursor, limit = 100 } = {}) {
        return apiCall('browse_album_songs', { album, artist, category, genre, cursor, limit });
    },

    /**
     * Browse virtual filesystem by path.
     * @param {string} path - VFS path (default: '/')
     * @param {Object} [options]
     * @param {string} [options.cursor] - Pagination cursor
     * @param {number} [options.limit] - Results per page (default: 100)
     * @param {string} [options.sort] - 'name' (default) or 'song_count'
     */
    async path(path = '/', { cursor, limit = 100, sort } = {}) {
        return apiCall('browse_path', { path, cursor, limit, sort });
    },

    /**
     * List album artists (from normalized junction table).
     * Only artists who have songs as album_artist role.
     * @param {number} [minSongs] - Minimum song count filter (default: none)
     */
    async albumArtists({ cursor, limit = 100, minSongs } = {}) {
        return apiCall('browse_album_artists', { cursor, limit, min_songs: minSongs });
    },

    /**
     * List genres from normalized junction table.
     * @param {number} [minSongs] - Minimum song count filter (default: none)
     */
    async genresNormalized({ cursor, limit = 100, minSongs } = {}) {
        return apiCall('browse_genres_normalized', { cursor, limit, min_songs: minSongs });
    },

    /**
     * Get songs by artist ID (from normalized junction table).
     * @param {number} artistId - Normalized artist ID
     * @param {string} [role] - Optional filter: 'artist', 'album_artist', 'featuring'
     */
    async artistSongs(artistId, { role, cursor, limit = 100 } = {}) {
        return apiCall('browse_artist_songs', { artist_id: artistId, role, cursor, limit });
    }
};

/**
 * Playlists API
 */
export const playlists = {
    /**
     * List current user's playlists.
     */
    async list() {
        return apiCall('playlists_list');
    },

    /**
     * List public playlists.
     */
    async public({ cursor, limit = 50 } = {}) {
        return apiCall('playlists_public', { cursor, limit });
    },

    /**
     * Create a new playlist.
     */
    async create(name, description = '', isPublic = false) {
        return apiCall('playlists_create', {
            name, description, is_public: isPublic
        });
    },

    /**
     * Update playlist metadata.
     */
    async update(playlistId, { name, description, isPublic } = {}) {
        return apiCall('playlists_update', {
            playlist_id: playlistId, name, description, is_public: isPublic
        });
    },

    /**
     * Delete a playlist.
     */
    async delete(playlistId) {
        return apiCall('playlists_delete', { playlist_id: playlistId });
    },

    /**
     * Get songs in a playlist.
     * Supports offset-based pagination for jumping to specific positions.
     */
    async getSongs(playlistId, { cursor, offset, limit = 100 } = {}) {
        return apiCall('playlists_get_songs', { playlist_id: playlistId, cursor, offset, limit });
    },

    /**
     * Add a song to a playlist.
     */
    async addSong(playlistId, songUuid) {
        return apiCall('playlists_add_song', { playlist_id: playlistId, song_uuid: songUuid });
    },

    /**
     * Add multiple songs to a playlist in batches.
     * @param {number} playlistId - Playlist ID
     * @param {string[]} songUuids - Array of song UUIDs
     * @param {number} batchSize - Number of songs per batch (default 500)
     * @param {function} onProgress - Optional callback(completed, total)
     */
    async addSongsBatch(playlistId, songUuids, batchSize = 500, onProgress = null) {
        const total = songUuids.length;
        let totalAdded = 0;
        let totalSkipped = 0;

        for (let i = 0; i < songUuids.length; i += batchSize) {
            const batch = songUuids.slice(i, i + batchSize);

            const result = await apiCall('playlists_add_songs', {
                playlist_id: playlistId,
                song_uuids: batch
            });

            if (result.error) {
                throw new Error(result.error);
            }

            totalAdded += result.added || 0;
            totalSkipped += result.skipped || 0;

            if (onProgress) {
                onProgress(i + batch.length, total);
            }
        }

        return { added: totalAdded, skipped: totalSkipped };
    },

    /**
     * Remove a song from a playlist.
     */
    async removeSong(playlistId, songUuid) {
        return apiCall('playlists_remove_song', { playlist_id: playlistId, song_uuid: songUuid });
    },

    /**
     * Remove multiple songs from a playlist (batch).
     */
    async removeSongs(playlistId, songUuids) {
        return apiCall('playlists_remove_songs', { playlist_id: playlistId, song_uuids: songUuids });
    },

    /**
     * Reorder songs in a playlist.
     */
    async reorder(playlistId, positions) {
        return apiCall('playlists_reorder', { playlist_id: playlistId, positions });
    },

    /**
     * Generate share token for a playlist.
     */
    async share(playlistId) {
        return apiCall('playlists_share', { playlist_id: playlistId });
    },

    /**
     * Get playlist by share token.
     */
    async byToken(shareToken) {
        return apiCall('playlists_by_token', { share_token: shareToken });
    },

    /**
     * Clone a playlist.
     */
    async clone(playlistId, newName = null) {
        return apiCall('playlists_clone', { playlist_id: playlistId, new_name: newName });
    },

    /**
     * Sort playlist songs.
     * @param {number} playlistId - Playlist ID
     * @param {string} sortBy - Sort field: 'artist', 'album', 'track', 'title', 'year', 'duration', 'random'
     * @param {string} order - Sort order: 'asc' or 'desc'
     */
    async sort(playlistId, sortBy, order = 'asc') {
        return apiCall('playlists_sort', { playlist_id: playlistId, sort_by: sortBy, order });
    }
};

/**
 * Tags API
 */
export const tags = {
    /**
     * List current user's tags.
     */
    async list() {
        return apiCall('tags_list');
    },

    /**
     * Create a new tag.
     */
    async create(name, color = '#6c757d') {
        return apiCall('tags_create', { name, color });
    },

    /**
     * Delete a tag.
     */
    async delete(tagId) {
        return apiCall('tags_delete', { tag_id: tagId });
    },

    /**
     * Add a tag to a song.
     */
    async addToSong(tagId, songUuid) {
        return apiCall('tags_add_to_song', { tag_id: tagId, song_uuid: songUuid });
    },

    /**
     * Remove a tag from a song.
     */
    async removeFromSong(tagId, songUuid) {
        return apiCall('tags_remove_from_song', { tag_id: tagId, song_uuid: songUuid });
    },

    /**
     * Get songs with a specific tag.
     */
    async getSongs(tagId, { cursor, limit = 100 } = {}) {
        return apiCall('tags_get_songs', { tag_id: tagId, cursor, limit });
    }
};

/**
 * Queue API (Server-side persistent queue)
 */
export const queue = {
    /**
     * Get the user's persistent queue.
     */
    async list({ cursor, limit = 100 } = {}) {
        return apiCall('queue_list', { cursor, limit });
    },

    /**
     * Add songs to the queue by UUID.
     */
    async add(songUuids, position = null) {
        return apiCall('queue_add', { song_uuids: songUuids, position });
    },

    /**
     * Add all songs from a VFS path to the queue.
     */
    async addByPath(path, position = null, limit = 5000) {
        return apiCall('queue_add_by_path', { path, position, limit });
    },

    /**
     * Add songs matching hierarchy filters to the queue.
     */
    async addByFilter({ category, genre, artist, album, position = null, limit = 5000 } = {}) {
        return apiCall('queue_add_by_filter', { category, genre, artist, album, position, limit });
    },

    /**
     * Add all songs from a playlist to the queue (server-side).
     */
    async addByPlaylist(playlistId, position = null, shuffle = false) {
        return apiCall('queue_add_by_playlist', { playlist_id: playlistId, position, shuffle });
    },

    /**
     * Remove songs at specified positions.
     */
    async remove(positions) {
        return apiCall('queue_remove', { positions });
    },

    /**
     * Clear the entire queue.
     */
    async clear() {
        return apiCall('queue_clear');
    },

    /**
     * Move a song from one position to another.
     */
    async reorder(fromPos, toPos) {
        return apiCall('queue_reorder', { from_pos: fromPos, to_pos: toPos });
    },

    /**
     * Move multiple songs to a target position (batch reorder).
     */
    async reorderBatch(fromPositions, toPosition) {
        return apiCall('queue_reorder_batch', { from_positions: fromPositions, to_position: toPosition });
    },

    /**
     * Set the current playback position.
     * @param {number} index - Position in queue
     * @param {string} [deviceId] - Unique device identifier
     * @param {number} [seq] - Sequence number for this device (monotonically increasing)
     */
    async setIndex(index, deviceId = null, seq = null) {
        const params = { index };
        if (deviceId !== null) {
            params.device_id = deviceId;
        }
        if (seq !== null) {
            params.seq = seq;
        }
        return apiCall('queue_set_index', params);
    },

    /**
     * Save the current queue as a new playlist.
     */
    async saveAsPlaylist(name, description = '', isPublic = false) {
        return apiCall('queue_save_as_playlist', {
            name,
            description,
            is_public: isPublic
        });
    },

    /**
     * Sort the queue by specified field.
     * @param {string} sortBy - Sort field: 'artist', 'album', 'track', 'title', 'year', 'duration', 'random'
     * @param {string} order - Sort order: 'asc' or 'desc'
     */
    async sort(sortBy = 'artist', order = 'asc') {
        return apiCall('queue_sort', { sort_by: sortBy, order });
    }
};

/**
 * Playback State API
 */
export const playback = {
    /**
     * Get playback state.
     */
    async getState() {
        return apiCall('playback_get_state');
    },

    /**
     * Update playback state.
     */
    async setState({ queueIndex, scaEnabled, playMode, volume } = {}) {
        return apiCall('playback_set_state', {
            queue_index: queueIndex,
            sca_enabled: scaEnabled,
            play_mode: playMode,
            volume
        });
    }
};

/**
 * SCA Pool API (Queue-based Radio)
 */
export const sca = {
    /**
     * Start SCA using current queue songs as pool.
     */
    async startFromQueue() {
        return apiCall('sca_start_from_queue');
    },

    /**
     * Start SCA using playlist songs as pool.
     */
    async startFromPlaylist(playlistId) {
        return apiCall('sca_start_from_playlist', { playlist_id: playlistId });
    },

    /**
     * Populate queue from SCA pool.
     */
    async populateQueue(count = 10) {
        return apiCall('sca_populate_queue', { count });
    },

    /**
     * Populate queue using AI (CLAP) similarity (falls back to classic SCA if
     * unavailable). Backed by the radio_algorithm='clap' path server-side.
     * @param {number} [count=10] - Number of songs to add
     * @param {string} [seedUuid] - Optional seed song UUID
     * @param {number} [diversity=0.3] - Diversity factor (0-1)
     */
    async populateQueueAi(count = 10, seedUuid = null, diversity = 0.3) {
        return apiCall('sca_populate_queue_ai', {
            count,
            seed_uuid: seedUuid,
            diversity
        });
    },

    /**
     * Stop SCA mode.
     */
    async stop() {
        return apiCall('sca_stop');
    },

    /**
     * Get songs in SCA pool.
     */
    async getPool({ cursor, limit = 100 } = {}) {
        return apiCall('sca_get_pool', { cursor, limit });
    },

    /**
     * Get SCA/radio status including AI (CLAP) availability.
     */
    async status() {
        return apiCall('sca_status');
    },

    /**
     * Set user preference for AI-powered radio (maps to radio_algorithm).
     * @param {boolean} enabled - Whether to use AI for radio
     */
    async setAiPreference(enabled) {
        return apiCall('sca_set_ai_preference', { enabled });
    }
};

/**
 * Radio API (SCA)
 */
export const radio = {
    /**
     * Start a new radio session.
     * @param {string} [seedUuid] - UUID of seed song
     * @param {string} [filterQuery] - Filter query for song selection
     */
    async start(seedUuid = null, filterQuery = null) {
        return apiCall('radio_start', { seed_uuid: seedUuid, filter_query: filterQuery });
    },

    /**
     * Get next song from radio queue.
     */
    async next(sessionId) {
        return apiCall('radio_next', { session_id: sessionId });
    },

    /**
     * Record a skip event.
     */
    async skip(sessionId, songUuid, positionSeconds = 0) {
        return apiCall('radio_skip', {
            session_id: sessionId,
            song_uuid: songUuid,
            position_seconds: positionSeconds
        });
    },

    /**
     * Get current radio queue.
     */
    async queue(sessionId) {
        return apiCall('radio_queue', { session_id: sessionId });
    }
};

/**
 * History API
 */
export const history = {
    /**
     * Record a play event. Returns { success, id } where id is used for updates.
     */
    async record(songUuid, durationSeconds = 0, skipped = false, source = 'browse') {
        return apiCall('history_record', {
            song_uuid: songUuid,
            duration_seconds: durationSeconds,
            skipped,
            source
        });
    },

    /**
     * Update a play history entry with final duration and skip status.
     */
    async update(historyId, durationSeconds, skipped = false) {
        return apiCall('history_update', {
            history_id: historyId,
            duration_seconds: durationSeconds,
            skipped
        });
    },

    /**
     * Get recent play history.
     */
    async recent(limit = 50) {
        return apiCall('history_recent', { limit });
    },

    /**
     * Get paginated play history with date filtering.
     */
    async list({ startDate, endDate, excludeSkipped = false, offset = 0, limit = 100 } = {}) {
        return apiCall('history_list', {
            start_date: startDate,
            end_date: endDate,
            exclude_skipped: excludeSkipped,
            offset,
            limit
        });
    },

    /**
     * Get unique songs with play counts, sorted by most played.
     */
    async grouped({ startDate, endDate, excludeSkipped = false, offset = 0, limit = 100 } = {}) {
        return apiCall('history_grouped', {
            start_date: startDate,
            end_date: endDate,
            exclude_skipped: excludeSkipped,
            offset,
            limit
        });
    },

    /**
     * Get song UUIDs from history for batch add operations.
     */
    async getUuids({ startDate, endDate, excludeSkipped = false, grouped = false, limit = 5000 } = {}) {
        return apiCall('history_get_uuids', {
            start_date: startDate,
            end_date: endDate,
            exclude_skipped: excludeSkipped,
            grouped,
            limit
        });
    }
};

/**
 * User Preferences API
 */
export const preferences = {
    /**
     * Get user preferences.
     */
    async get() {
        return apiCall('preferences_get');
    },

    /**
     * Update user preferences.
     */
    async set({ volume, shuffle, repeatMode, radioEopp, radioAlgorithm, darkMode,
                replayGainMode, replayGainPreamp, replayGainFallback,
                aiSearchMax, aiSearchDiversity, aiRadioQueueDiversity } = {}) {
        return apiCall('preferences_set', {
            volume,
            shuffle,
            repeat_mode: repeatMode,
            radio_eopp: radioEopp,
            radio_algorithm: radioAlgorithm,
            dark_mode: darkMode,
            replay_gain_mode: replayGainMode,
            replay_gain_preamp: replayGainPreamp,
            replay_gain_fallback: replayGainFallback,
            ai_search_max: aiSearchMax,
            ai_search_diversity: aiSearchDiversity,
            ai_radio_queue_diversity: aiRadioQueueDiversity
        });
    }
};

/**
 * EQ Presets API
 */
export const eqPresets = {
    /**
     * List all EQ presets for the current user.
     */
    async list() {
        return apiCall('eq_presets_list');
    },

    /**
     * Save an EQ preset (create or update).
     * @param {Object} preset - The preset to save
     * @param {string} [preset.uuid] - UUID if updating existing preset
     * @param {string} preset.name - Preset name
     * @param {Array} preset.bands - Array of band configurations
     */
    async save({ uuid, name, bands }) {
        return apiCall('eq_presets_save', { uuid, name, bands });
    },

    /**
     * Delete an EQ preset.
     * @param {string} uuid - The preset UUID to delete
     */
    async delete(uuid) {
        return apiCall('eq_presets_delete', { uuid });
    }
};

/**
 * Auth API (from general module).
 *
 * checkUser/login/logout are the surface common to both backends. Deployment-
 * specific auth (register, changePassword, admin) lives behind `#profile`
 * (see profile.auth) - private (site-auth) leaves those null. login/logout are
 * never called on the site-auth build (it uses profile.auth.loginUrl instead).
 */
export const auth = {
    /**
     * Check current user authentication status.
     */
    async checkUser() {
        return apiCall('check_user');
    },

    /**
     * Log in with username and password.
     */
    async login(username, password) {
        return apiCall('auth_login', { username, password });
    },

    /**
     * Log out current user.
     */
    async logout() {
        return apiCall('auth_logout');
    }
};

/**
 * Sync API - Transactional batch sync for offline operations
 */
export const sync = {
    /**
     * Push a sync operation to the pending queue.
     * @param {string} sessionId - UUID identifying this sync batch
     * @param {number} seq - Sequence number for ordering
     * @param {string} opType - Operation type (e.g., 'queue.add')
     * @param {object} payload - Operation parameters
     */
    async push(sessionId, seq, opType, payload) {
        return apiCall('sync_push', {
            session_id: sessionId,
            seq,
            op_type: opType,
            payload
        });
    },

    /**
     * Execute all pending operations for a sync session.
     * @param {string} sessionId - UUID of the sync session to commit
     */
    async commit(sessionId) {
        return apiCall('sync_commit', { session_id: sessionId });
    },

    /**
     * Discard all pending operations for a sync session.
     * @param {string} sessionId - UUID of the sync session to discard
     */
    async discard(sessionId) {
        return apiCall('sync_discard', { session_id: sessionId });
    },

    /**
     * Get status of pending sync operations.
     */
    async status() {
        return apiCall('sync_status');
    }
};

/**
 * Build stream URL for a song. The per-deployment mapping (direct repo URL vs
 * backend /stream/ endpoint, transcode handling) lives in profile.endpoints.
 *
 * @param {string} uuid - Song UUID
 * @param {string} [fileExt] - File extension (e.g., 'mp3', 'mod'). Optional.
 */
export function getStreamUrl(uuid, fileExt = null) {
    return profile.endpoints.audioUrl(uuid, fileExt);
}

export default {
    songs,
    browse,
    playlists,
    tags,
    queue,
    playback,
    sca,
    radio,
    history,
    preferences,
    eqPresets,
    auth,
    sync,
    getStreamUrl
};

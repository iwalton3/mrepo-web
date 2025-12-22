/**
 * offline-api.js - Offline-aware API wrapper
 *
 * Wraps music-api.js with offline support:
 * - Returns cached data when offline or in work-offline mode
 * - Queues writes for sync when offline
 * - Caches responses for offline use
 */

import * as api from '../api/music-api.js';
import * as offlineDb from './offline-db.js';
import offlineStore, {
    shouldUseOffline,
    addFavorite,
    removeFavorite,
    setFavorites,
    setFavoritesPlaylistId,
    refreshPendingWriteCount,
    computeOfflineFilterSets
} from './offline-store.js';
import { playerStore } from '../stores/player-store.js';

const FAVORITES_PLAYLIST_NAME = 'Favorites';

/**
 * Queue a write operation for later sync
 */
async function queueWrite(type, operation, payload) {
    await offlineDb.addPendingWrite({
        type,
        operation,
        payload
    });
    await refreshPendingWriteCount();
}

/**
 * Helper to update playlist songs cache (for non-offline playlists)
 * Uses JSON.parse/stringify to strip Proxy wrappers before IndexedDB save
 */
async function updatePlaylistSongsCache(playlistId, updateFn) {
    const stringId = String(playlistId);

    // Update regular playlist songs cache (initialize empty if not exists)
    const cacheKey = `playlist-songs:${stringId}`;
    const cachedSongs = await offlineDb.getSetting(cacheKey) || [];
    const updated = await updateFn([...cachedSongs]);
    // Strip Proxy wrappers before IndexedDB save (structured clone can't handle Proxies)
    await offlineDb.saveSetting(cacheKey, JSON.parse(JSON.stringify(updated)));

    // Also handle pending playlists
    if (stringId.startsWith('pending-')) {
        const pendingKey = `pending-playlist-songs:${stringId}`;
        const pendingSongs = await offlineDb.getSetting(pendingKey);
        if (pendingSongs) {
            // Pending playlists store UUIDs only, get metadata for updateFn
            const metadata = await offlineDb.getSongsMetadata(pendingSongs);
            const updated = await updateFn([...metadata]);
            // Store back as UUIDs (strip Proxies)
            const uuids = JSON.parse(JSON.stringify(updated.map(s => s.uuid)));
            await offlineDb.saveSetting(pendingKey, uuids);
        }
    }
}

/**
 * Helper to update playlist song count in playlists list cache
 */
async function updatePlaylistSongCount(playlistId, delta) {
    const stringId = String(playlistId);
    const cachedPlaylists = await offlineDb.getSetting('playlists') || [];
    const playlist = cachedPlaylists.find(p => String(p.id) === stringId);
    if (playlist) {
        playlist.song_count = Math.max(0, (playlist.song_count || 0) + delta);
        await offlineDb.saveSetting('playlists', cachedPlaylists);
    }
}

/**
 * Try online API call, fallback to offline on network error.
 * Handles cases where navigator.onLine is unreliable (e.g., airplane mode on mobile).
 */
async function withOfflineFallback(onlineCall, offlineCall) {
    if (shouldUseOffline()) {
        return offlineCall();
    }

    try {
        return await onlineCall();
    } catch (error) {
        // Network error (TypeError: Failed to fetch) - use offline fallback
        if (error.name === 'TypeError' || !navigator.onLine) {
            console.warn('[Offline API] Network error, using offline fallback');
            offlineStore.state.isOnline = false;
            return offlineCall();
        }
        throw error;
    }
}

// =============================================================================
// Queue API (offline-aware)
// =============================================================================

export const queue = {
    /**
     * Get queue - returns cached if offline
     */
    async list(options = {}) {
        if (shouldUseOffline()) {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                return {
                    items: cached.items,
                    queueIndex: cached.queueIndex,
                    scaEnabled: cached.scaEnabled,
                    playMode: cached.playMode
                };
            }
            // No cache available
            return { items: [], queueIndex: 0, scaEnabled: false, playMode: 'sequential' };
        }

        // Online - fetch from server and cache
        try {
            const result = await api.queue.list(options);
            await offlineDb.saveQueueCache({
                items: result.items || result,
                queueIndex: result.queueIndex || 0,
                scaEnabled: result.scaEnabled || false,
                playMode: result.playMode || 'sequential',
                lastSyncedAt: Date.now()
            });
            return result;
        } catch (error) {
            // Network error - try cache
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                return cached;
            }
            throw error;
        }
    },

    /**
     * Add songs to queue
     */
    async add(songUuids, position = null) {
        const offlineHandler = async () => {
            // Update local cache
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                // Get song metadata from cache
                const metadata = await offlineDb.getSongsMetadata(songUuids);
                const metadataMap = new Map(metadata.map(m => [m.uuid, m]));

                // Create items for ALL UUIDs - use metadata where available,
                // UUID-only objects where not (will be restored when back online)
                const newItems = songUuids.map(uuid =>
                    metadataMap.get(uuid) || { uuid }
                );

                // Ensure all items with full metadata are saved to songMetadata store
                // This enforces the invariant: if a song is in the queue, its metadata must be cached
                for (const item of newItems) {
                    if (item.uuid && item.title && !item.unavailable) {
                        await offlineDb.saveSongMetadata(item);
                    }
                }

                if (position !== null) {
                    cached.items.splice(position, 0, ...newItems);
                } else {
                    cached.items.push(...newItems);
                }
                await offlineDb.saveQueueCache(cached);
            }

            // Queue for sync (skip if in temp queue mode - temp queue is never synced)
            if (!playerStore.state.tempQueueMode) {
                await queueWrite('queue', 'add', { songUuids, position });
            }
            return { success: true, queued: !playerStore.state.tempQueueMode };
        };

        return withOfflineFallback(
            async () => {
                const result = await api.queue.add(songUuids, position);
                // Refresh cache
                await this.list();
                return result;
            },
            offlineHandler
        );
    },

    /**
     * Remove songs from queue
     */
    async remove(positions) {
        const offlineHandler = async () => {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                // Remove from highest position first to maintain indices
                const sortedPositions = [...positions].sort((a, b) => b - a);
                for (const pos of sortedPositions) {
                    cached.items.splice(pos, 1);
                }
                await offlineDb.saveQueueCache(cached);
            }
            // Skip queueWrite in temp queue mode
            if (!playerStore.state.tempQueueMode) {
                await queueWrite('queue', 'remove', { positions });
            }
            return { success: true, queued: !playerStore.state.tempQueueMode };
        };

        return withOfflineFallback(
            async () => {
                const result = await api.queue.remove(positions);
                await this.list();
                return result;
            },
            offlineHandler
        );
    },

    /**
     * Clear queue
     */
    async clear() {
        const offlineHandler = async () => {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                cached.items = [];
                cached.queueIndex = 0;
                await offlineDb.saveQueueCache(cached);
            }
            // Skip queueWrite in temp queue mode
            if (!playerStore.state.tempQueueMode) {
                await queueWrite('queue', 'clear', {});
            }
            return { success: true, queued: !playerStore.state.tempQueueMode };
        };

        return withOfflineFallback(
            async () => {
                const result = await api.queue.clear();
                await this.list();
                return result;
            },
            offlineHandler
        );
    },

    /**
     * Set queue index
     */
    async setIndex(index) {
        const offlineHandler = async () => {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                cached.queueIndex = index;
                await offlineDb.saveQueueCache(cached);
            }
            // Skip queueWrite in temp queue mode
            if (!playerStore.state.tempQueueMode) {
                await queueWrite('queue', 'setIndex', { index });
            }
            return { success: true, queued: !playerStore.state.tempQueueMode };
        };

        return withOfflineFallback(
            async () => {
                const result = await api.queue.setIndex(index);
                // Also update local cache to keep it in sync
                const cached = await offlineDb.getQueueCache();
                if (cached) {
                    cached.queueIndex = index;
                    await offlineDb.saveQueueCache(cached);
                }
                return result;
            },
            offlineHandler
        );
    },

    /**
     * Reorder queue
     */
    async reorder(fromPos, toPos) {
        const offlineHandler = async () => {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                const [item] = cached.items.splice(fromPos, 1);
                cached.items.splice(toPos, 0, item);
                await offlineDb.saveQueueCache(cached);
            }
            // Skip queueWrite in temp queue mode
            if (!playerStore.state.tempQueueMode) {
                await queueWrite('queue', 'reorder', { fromPos, toPos });
            }
            return { success: true, queued: !playerStore.state.tempQueueMode };
        };

        return withOfflineFallback(
            async () => {
                const result = await api.queue.reorder(fromPos, toPos);
                await this.list();
                return result;
            },
            offlineHandler
        );
    },

    /**
     * Batch reorder queue - move multiple items to a target position
     */
    async reorderBatch(fromPositions, toPosition) {
        const offlineHandler = async () => {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                // Sort positions ascending to maintain relative order
                const sortedPositions = [...fromPositions].sort((a, b) => a - b);
                const items = sortedPositions.map(pos => cached.items[pos]);

                // Remove from highest first to preserve indices
                for (const pos of [...sortedPositions].reverse()) {
                    cached.items.splice(pos, 1);
                }

                // Calculate adjusted target
                let adjustedTarget = toPosition;
                for (const pos of sortedPositions) {
                    if (pos < toPosition) adjustedTarget--;
                }
                adjustedTarget = Math.max(0, Math.min(adjustedTarget, cached.items.length));

                // Insert all items at target
                cached.items.splice(adjustedTarget, 0, ...items);
                await offlineDb.saveQueueCache(cached);
            }
            // Skip queueWrite in temp queue mode
            if (!playerStore.state.tempQueueMode) {
                await queueWrite('queue', 'reorderBatch', { fromPositions, toPosition });
            }
            return { success: true, queued: !playerStore.state.tempQueueMode };
        };

        return withOfflineFallback(
            async () => {
                const result = await api.queue.reorderBatch(fromPositions, toPosition);
                return result;
            },
            offlineHandler
        );
    },

    /**
     * Add songs from a playlist to queue
     * In offline mode, adds ALL song UUIDs (including unavailable ones)
     * so the full queue is available when back online
     * @param {number|string} playlistId
     * @param {number|null} position - Position to insert at (null = end)
     * @param {boolean} shuffle - Whether to shuffle the added songs
     */
    async addByPlaylist(playlistId, position = null, shuffle = false) {
        if (shouldUseOffline()) {
            const stringId = String(playlistId);

            // Handle pending playlists (they have non-numeric IDs like 'pending-123')
            if (stringId.startsWith('pending-')) {
                const key = `pending-playlist-songs:${stringId}`;
                const songUuids = await offlineDb.getSetting(key) || [];
                if (songUuids.length > 0) {
                    return this.add(songUuids, position);
                }
                return { success: false, reason: 'No songs in pending playlist' };
            }

            const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;

            // Check if this is the Favorites playlist
            const favoritesId = offlineStore.state.favoritesPlaylistId;
            if (numericId === favoritesId) {
                const favoriteUuids = await offlineDb.getFavorites();
                const uuidArray = Array.from(favoriteUuids);
                if (uuidArray.length > 0) {
                    return this.add(uuidArray, position);
                }
                return { success: false, reason: 'No favorites saved' };
            }

            // Check if this is an offline (downloaded) playlist
            const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
            if (offlinePlaylist && offlinePlaylist.songUuids?.length > 0) {
                // Add ALL UUIDs from the playlist, not just ones with cached metadata
                // This ensures the full queue is available when back online
                return this.add(offlinePlaylist.songUuids, position);
            }

            // For non-downloaded playlists, try to get whatever metadata we have cached
            const result = await playlists.getSongs(playlistId);
            if (result.items && result.items.length > 0) {
                const uuids = result.items.map(s => s.uuid);
                return this.add(uuids, position);
            }
            return { success: false, reason: 'No songs available offline' };
        }

        const result = await api.queue.addByPlaylist(playlistId, position, shuffle);
        await this.list();
        return result;
    },

    /**
     * Sort queue - handles offline mode with local sorting
     */
    async sort(sortBy = 'artist', order = 'asc') {
        if (shouldUseOffline()) {
            const cached = await offlineDb.getQueueCache();
            if (cached && cached.items && cached.items.length > 0) {
                // Sort locally
                const sorted = [...cached.items];
                const direction = order === 'desc' ? -1 : 1;

                if (sortBy === 'random') {
                    // Fisher-Yates shuffle
                    for (let i = sorted.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
                    }
                } else {
                    sorted.sort((a, b) => {
                        let aVal, bVal;
                        switch (sortBy) {
                            case 'artist':
                                aVal = (a.artist || '').toLowerCase();
                                bVal = (b.artist || '').toLowerCase();
                                break;
                            case 'album':
                                aVal = (a.album || '').toLowerCase();
                                bVal = (b.album || '').toLowerCase();
                                break;
                            case 'track':
                                // Sort by disc then track number
                                aVal = (a.disc_number || 1) * 1000 + (a.track_number || 0);
                                bVal = (b.disc_number || 1) * 1000 + (b.track_number || 0);
                                break;
                            case 'title':
                                aVal = (a.title || '').toLowerCase();
                                bVal = (b.title || '').toLowerCase();
                                break;
                            case 'year':
                                aVal = a.year || 0;
                                bVal = b.year || 0;
                                break;
                            case 'duration':
                                aVal = a.duration_seconds || 0;
                                bVal = b.duration_seconds || 0;
                                break;
                            default:
                                aVal = (a.title || '').toLowerCase();
                                bVal = (b.title || '').toLowerCase();
                        }
                        if (aVal < bVal) return -direction;
                        if (aVal > bVal) return direction;
                        return 0;
                    });
                }

                cached.items = sorted;
                cached.queueIndex = 0;  // Reset to start after sort
                await offlineDb.saveQueueCache(cached);
                return { success: true };
            }
            return { success: false, reason: 'No queue to sort' };
        }

        return api.queue.sort(sortBy, order);
    },

    // Add songs by filesystem path - offline aware
    async addByPath(path, position = null) {
        if (shouldUseOffline()) {
            // Get all cached song metadata
            const metadata = await offlineDb.getAllSongMetadata();

            // Filter to songs whose filepath starts with the given path
            const matching = metadata.filter(song => {
                const filepath = song.filepath || '';
                // Normalize paths for comparison
                const normalPath = path.endsWith('/') ? path : path + '/';
                return filepath === path || filepath.startsWith(normalPath);
            });

            if (matching.length === 0) {
                return { success: true, added: 0 };
            }

            const uuids = matching.map(s => s.uuid);
            return queue.add(uuids, position);
        }
        return api.queue.addByPath(path, position);
    },

    // Add songs by filter (hierarchy) - offline aware
    async addByFilter(filters, position = null) {
        if (shouldUseOffline()) {
            // Get all cached song metadata
            const metadata = await offlineDb.getAllSongMetadata();

            // Filter to songs matching the hierarchy filters
            const matching = metadata.filter(song => {
                if (filters.category && song.category !== filters.category) return false;
                if (filters.genre && song.genre !== filters.genre) return false;
                if (filters.artist && song.artist !== filters.artist) return false;
                if (filters.album && song.album !== filters.album) return false;
                return true;
            });

            if (matching.length === 0) {
                return { success: true, added: 0 };
            }

            const uuids = matching.map(s => s.uuid);
            return queue.add(uuids, position);
        }
        return api.queue.addByFilter({ ...filters, position });
    },

    // Save queue as playlist - offline aware
    async saveAsPlaylist(name, description = '', isPublic = false) {
        if (shouldUseOffline()) {
            const tempId = `pending-${Date.now()}`;

            // Get current queue songs - check temp queue first if in temp queue mode
            let songItems = [];
            if (playerStore.state.tempQueueMode) {
                // Get temp queue
                const { tempQueue } = await offlineDb.getTempQueueState();
                songItems = tempQueue?.items || [];
            } else {
                // Get regular queue from cache
                const cached = await offlineDb.getQueueCache();
                songItems = cached?.items || [];
            }

            // Extract UUIDs
            const songUuids = songItems.map(s => s.uuid).filter(Boolean);

            // CRITICAL: Ensure all song metadata is cached in songMetadata store
            // This enforces the invariant: if a song is in a playlist, its metadata must be cached
            for (const song of songItems) {
                if (song.uuid && song.title) {
                    await offlineDb.saveSongMetadata(song);
                }
            }

            // Queue the creation for later sync (include song UUIDs for batch add)
            await queueWrite('playlists', 'createFromQueue', {
                name, description, isPublic, tempId, songUuids
            });

            // Add to local playlists cache for optimistic UI
            const pendingPlaylist = {
                id: tempId,
                name,
                description,
                is_public: isPublic,
                song_count: songUuids.length,
                pending: true,
                created_at: new Date().toISOString()
            };

            const cachedPlaylists = await offlineDb.getSetting('playlists') || [];
            cachedPlaylists.unshift(pendingPlaylist);
            await offlineDb.saveSetting('playlists', cachedPlaylists);

            // Store song UUIDs for this pending playlist
            await offlineDb.saveSetting(`pending-playlist-songs:${tempId}`, songUuids);

            // Notify listeners that playlists changed
            notifyPlaylistsChanged();

            return { success: true, queued: true, id: tempId, name, ...pendingPlaylist };
        }
        // Online - create and notify
        const result = await api.queue.saveAsPlaylist(name, description, isPublic);
        notifyPlaylistsChanged();
        return result;
    }
};

// =============================================================================
// Preferences API (offline-aware)
// =============================================================================

export const preferences = {
    /**
     * Get preferences - returns cached if offline
     */
    async get() {
        if (shouldUseOffline()) {
            const cached = await offlineDb.getSetting('preferences');
            return cached || {};
        }

        try {
            const result = await api.preferences.get();
            await offlineDb.saveSetting('preferences', result);
            return result;
        } catch (error) {
            const cached = await offlineDb.getSetting('preferences');
            if (cached) {
                return cached;
            }
            throw error;
        }
    },

    /**
     * Set preferences
     */
    async set(prefs) {
        // Always update local cache
        const current = await offlineDb.getSetting('preferences') || {};
        const updated = { ...current, ...prefs };
        await offlineDb.saveSetting('preferences', updated);

        if (shouldUseOffline()) {
            await queueWrite('preferences', 'set', prefs);
            return { success: true, queued: true };
        }

        return api.preferences.set(prefs);
    }
};

// =============================================================================
// EQ Presets API (offline-aware)
// =============================================================================

export const eqPresets = {
    /**
     * List EQ presets - returns cached if offline
     * Always returns {presets: [...]} format to match backend
     */
    async list() {
        if (shouldUseOffline()) {
            let cached = await offlineDb.getSetting('eqPresets');
            // Handle backward compatibility: old cache might be {presets: [...]} instead of [...]
            if (cached && cached.presets && Array.isArray(cached.presets)) {
                cached = cached.presets;
            }
            // Cache stores array directly, wrap in expected format
            return { presets: cached || [] };
        }

        try {
            const result = await api.eqPresets.list();
            // Store just the array for simpler cache management
            await offlineDb.saveSetting('eqPresets', result.presets || []);
            return result;
        } catch (error) {
            let cached = await offlineDb.getSetting('eqPresets');
            // Handle backward compatibility
            if (cached && cached.presets && Array.isArray(cached.presets)) {
                cached = cached.presets;
            }
            if (cached) {
                return { presets: cached };
            }
            throw error;
        }
    },

    /**
     * Save EQ preset
     */
    async save(preset) {
        // Deep clone to strip any reactive proxies (IndexedDB can't clone them)
        preset = JSON.parse(JSON.stringify(preset));

        // Keep track of original UUID for sync (null for new presets)
        const originalUuid = preset.uuid;

        // Update local cache (stored as array)
        // Handle backward compatibility: old cache might be {presets: [...]} instead of [...]
        let cached = await offlineDb.getSetting('eqPresets') || [];
        if (cached.presets && Array.isArray(cached.presets)) {
            cached = cached.presets;
        }
        const index = preset.uuid ? cached.findIndex(p => p.uuid === preset.uuid) : -1;
        if (index >= 0) {
            cached[index] = { ...cached[index], ...preset };
        } else {
            // For new presets, generate a temporary UUID for local cache
            // The real UUID comes from the server response
            if (!preset.uuid) {
                preset = { ...preset, uuid: 'temp-' + Date.now() };
            }
            cached.push(preset);
        }
        await offlineDb.saveSetting('eqPresets', cached);

        if (shouldUseOffline()) {
            // Queue with original UUID (null for new presets) so server creates new
            await queueWrite('eqPresets', 'save', { ...preset, uuid: originalUuid });
            return { success: true, queued: true, uuid: preset.uuid };
        }

        const result = await api.eqPresets.save({ ...preset, uuid: originalUuid });

        // Update cache with real UUID from server
        if (result.uuid && preset.uuid !== result.uuid) {
            const updatedCache = await offlineDb.getSetting('eqPresets') || [];
            const tempIndex = updatedCache.findIndex(p => p.uuid === preset.uuid);
            if (tempIndex >= 0) {
                updatedCache[tempIndex].uuid = result.uuid;
                await offlineDb.saveSetting('eqPresets', updatedCache);
            }
        }

        return result;
    },

    /**
     * Delete EQ preset
     */
    async delete(uuid) {
        // Update local cache (stored as array)
        // Handle backward compatibility: old cache might be {presets: [...]} instead of [...]
        let cached = await offlineDb.getSetting('eqPresets') || [];
        if (cached.presets && Array.isArray(cached.presets)) {
            cached = cached.presets;
        }
        const filtered = cached.filter(p => p.uuid !== uuid);
        await offlineDb.saveSetting('eqPresets', filtered);

        if (shouldUseOffline()) {
            await queueWrite('eqPresets', 'delete', { uuid });
            return { success: true, queued: true };
        }

        return api.eqPresets.delete(uuid);
    }
};

// =============================================================================
// Playlists API (offline-aware for favorites)
// =============================================================================

// Memory cache for playlists list to avoid duplicate fetches
let playlistsListCache = null;
let playlistsListCacheTime = 0;
const PLAYLISTS_CACHE_TTL = 30000; // 30 seconds

/**
 * Invalidate the playlists list memory cache.
 * Call this after operations that modify playlists (e.g., deletion).
 */
export function invalidatePlaylistsCache() {
    playlistsListCache = null;
    playlistsListCacheTime = 0;
}

/**
 * Notify that playlists have changed (created, deleted, modified).
 * Dispatches a custom event that the playlists page can listen for.
 */
export function notifyPlaylistsChanged() {
    invalidatePlaylistsCache();
    window.dispatchEvent(new CustomEvent('playlists-changed'));
}

// Favorites cache state to prevent duplicate fetches
let favoritesCacheInProgress = false;
let favoritesCacheTime = 0;
const FAVORITES_CACHE_TTL = 60000; // 1 minute

export const playlists = {
    /**
     * List playlists
     */
    async list(forceRefresh = false) {
        // In work-offline mode, only return cached data (no network)
        if (shouldUseOffline()) {
            const cached = await offlineDb.getSetting('playlists');
            return { items: cached || [] };
        }

        // Return memory cache if fresh (avoids duplicate fetches)
        const now = Date.now();
        if (!forceRefresh && playlistsListCache && (now - playlistsListCacheTime) < PLAYLISTS_CACHE_TTL) {
            return { items: playlistsListCache };
        }

        // Online - fetch and cache
        try {
            const result = await api.playlists.list();

            // Handle different response formats (array or object with playlists/items)
            const playlistArray = Array.isArray(result) ? result :
                (result.playlists || result.items || []);

            // Update memory cache
            playlistsListCache = playlistArray;
            playlistsListCacheTime = now;

            // Cache playlist list for offline use (store the array)
            await offlineDb.saveSetting('playlists', playlistArray);

            // Find and cache favorites playlist
            const favorites = playlistArray.find(p => p.name === FAVORITES_PLAYLIST_NAME);
            if (favorites) {
                await setFavoritesPlaylistId(favorites.id);
                // Cache favorites songs in background (don't block list loading)
                this.cacheFavorites(favorites.id);
            }

            return { items: playlistArray };
        } catch (error) {
            // Network error - fall back to cache
            console.warn('[Offline API] Failed to fetch playlists, using cache:', error);
            const cached = await offlineDb.getSetting('playlists');
            return { items: cached || [] };
        }
    },

    /**
     * Cache favorites songs to IndexedDB
     */
    async cacheFavorites(playlistId) {
        // Skip if already in progress or recently cached
        const now = Date.now();
        if (favoritesCacheInProgress || (now - favoritesCacheTime) < FAVORITES_CACHE_TTL) {
            return;
        }

        favoritesCacheInProgress = true;
        try {
            // Fetch all favorites using batched requests
            const uuids = [];
            let cursor = null;
            const batchSize = 500;

            do {
                const result = await api.playlists.getSongs(playlistId, { cursor, limit: batchSize });
                const items = Array.isArray(result) ? result : (result.items || result.songs || []);
                uuids.push(...items.map(s => s.uuid));
                cursor = result.nextCursor;
            } while (cursor);

            await offlineDb.setFavorites(uuids);
            setFavorites(uuids);
            favoritesCacheTime = now;
        } catch (error) {
            console.error('[Offline API] Failed to cache favorites:', error);
        } finally {
            favoritesCacheInProgress = false;
        }
    },

    /**
     * Get songs in a playlist
     */
    async getSongs(playlistId, options = {}) {
        const stringId = String(playlistId);

        if (shouldUseOffline()) {
            // Check if this is a pending playlist (created offline)
            if (stringId.startsWith('pending-')) {
                const key = `pending-playlist-songs:${stringId}`;
                const songUuids = await offlineDb.getSetting(key) || [];
                const metadata = await offlineDb.getSongsMetadata(songUuids);
                return {
                    items: metadata,
                    totalCount: metadata.length,
                    hasMore: false
                };
            }

            // Convert ID to number for IndexedDB lookup (URL params are strings)
            const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;

            // Check if this is the Favorites playlist
            const favoritesId = offlineStore.state.favoritesPlaylistId;
            if (numericId === favoritesId) {
                // Get favorites UUIDs and their metadata
                const favoriteUuids = await offlineDb.getFavorites();
                const uuidArray = Array.from(favoriteUuids);
                const metadata = await offlineDb.getSongsMetadata(uuidArray);
                return {
                    items: metadata,
                    totalCount: metadata.length,
                    hasMore: false
                };
            }

            // Check if this is an offline (downloaded) playlist
            const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
            if (offlinePlaylist) {
                // Return metadata for offline songs in expected format
                const metadata = await offlineDb.getSongsMetadata(offlinePlaylist.songUuids);
                return {
                    items: metadata,
                    totalCount: metadata.length,
                    hasMore: false
                };
            }

            // Check for cached playlist songs (any playlist viewed while online)
            const cacheKey = `playlist-songs:${stringId}`;
            const cachedSongs = await offlineDb.getSetting(cacheKey);
            if (cachedSongs) {
                return {
                    items: cachedSongs,
                    totalCount: cachedSongs.length,
                    hasMore: false
                };
            }

            return { items: [], totalCount: 0, hasMore: false };
        }

        // Online - fetch and cache for offline viewing
        const result = await api.playlists.getSongs(playlistId, options);

        // Cache playlist songs for offline viewing (if no cursor - complete list)
        // Only cache if we got a full batch (no pagination)
        if (!options.cursor && result.items && result.items.length > 0) {
            const cacheKey = `playlist-songs:${stringId}`;
            await offlineDb.saveSetting(cacheKey, result.items);
        }

        return result;
    },

    /**
     * Add song to playlist (with favorites and offline playlist support)
     */
    async addSong(playlistId, songUuid) {
        const stringId = String(playlistId);
        const favoritesId = offlineStore.state.favoritesPlaylistId;

        // Helper to get song metadata, checking queue cache as fallback
        const getSongMetadataWithQueueFallback = async (uuid) => {
            const [metadata] = await offlineDb.getSongsMetadata([uuid]);
            if (metadata && !metadata.unavailable) {
                return metadata;
            }
            // Check queue cache for full metadata
            const queueCache = await offlineDb.getQueueCache();
            const queueSong = queueCache?.items?.find(s => s.uuid === uuid);
            if (queueSong && queueSong.title) {
                // Save to songMetadata store for future lookups
                await offlineDb.saveSongMetadata(queueSong);
                return queueSong;
            }
            return metadata;  // Return original (may be unavailable placeholder)
        };

        // Handle pending playlists separately (they have non-numeric IDs like 'pending-123')
        if (stringId.startsWith('pending-')) {
            const key = `pending-playlist-songs:${stringId}`;
            const existing = await offlineDb.getSetting(key) || [];
            if (!existing.includes(songUuid)) {
                existing.push(songUuid);
                await offlineDb.saveSetting(key, existing);
            }

            // Update playlist-songs cache (optimistic UI)
            await updatePlaylistSongsCache(playlistId, async songs => {
                if (!songs.find(s => s.uuid === songUuid)) {
                    const metadata = await getSongMetadataWithQueueFallback(songUuid);
                    if (metadata) {
                        songs.push(metadata);
                    }
                }
                return songs;
            });
            await updatePlaylistSongCount(playlistId, 1);

            if (shouldUseOffline()) {
                await queueWrite('playlists', 'addSong', { playlistId, songUuid });
                await computeOfflineFilterSets();
                notifyPlaylistsChanged();
                return { success: true, queued: true };
            }
            await queueWrite('playlists', 'addSong', { playlistId, songUuid });
            notifyPlaylistsChanged();
            return { success: true, queued: true };
        }

        const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;

        // Update local cache based on playlist type
        if (numericId === favoritesId) {
            await offlineDb.addFavorite(songUuid);
            addFavorite(songUuid);
        } else {
            // Update offline playlist cache if exists
            const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
            if (offlinePlaylist) {
                if (!offlinePlaylist.songUuids.includes(songUuid)) {
                    offlinePlaylist.songUuids.push(songUuid);
                    await offlineDb.saveOfflinePlaylist(offlinePlaylist);
                }
            }

            // Update playlist-songs cache (optimistic UI)
            await updatePlaylistSongsCache(playlistId, async songs => {
                if (!songs.find(s => s.uuid === songUuid)) {
                    const metadata = await getSongMetadataWithQueueFallback(songUuid);
                    if (metadata) {
                        songs.push(metadata);
                    }
                }
                return songs;
            });
            await updatePlaylistSongCount(playlistId, 1);
        }

        if (shouldUseOffline()) {
            await queueWrite('playlists', 'addSong', { playlistId, songUuid });
            await computeOfflineFilterSets();
            notifyPlaylistsChanged();
            return { success: true, queued: true };
        }

        const result = await api.playlists.addSong(playlistId, songUuid);
        notifyPlaylistsChanged();
        return result;
    },

    /**
     * Remove song from playlist (with favorites and offline playlist support)
     */
    async removeSong(playlistId, songUuid) {
        const stringId = String(playlistId);
        const favoritesId = offlineStore.state.favoritesPlaylistId;

        // Handle pending playlists separately (they have non-numeric IDs like 'pending-123')
        if (stringId.startsWith('pending-')) {
            const key = `pending-playlist-songs:${stringId}`;
            const existing = await offlineDb.getSetting(key) || [];
            const filtered = existing.filter(uuid => uuid !== songUuid);
            await offlineDb.saveSetting(key, filtered);

            // Update playlist-songs cache (optimistic UI)
            await updatePlaylistSongsCache(playlistId, songs =>
                songs.filter(s => s.uuid !== songUuid)
            );
            await updatePlaylistSongCount(playlistId, -1);

            if (shouldUseOffline()) {
                await queueWrite('playlists', 'removeSong', { playlistId, songUuid });
                await computeOfflineFilterSets();
                notifyPlaylistsChanged();
                return { success: true, queued: true };
            }
            await queueWrite('playlists', 'removeSong', { playlistId, songUuid });
            notifyPlaylistsChanged();
            return { success: true, queued: true };
        }

        const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;

        // Update local cache based on playlist type
        if (numericId === favoritesId) {
            await offlineDb.removeFavorite(songUuid);
            removeFavorite(songUuid);
        } else {
            // Update offline playlist cache if exists
            const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
            if (offlinePlaylist) {
                const idx = offlinePlaylist.songUuids.indexOf(songUuid);
                if (idx !== -1) {
                    offlinePlaylist.songUuids.splice(idx, 1);
                    await offlineDb.saveOfflinePlaylist(offlinePlaylist);
                }
            }

            // Update playlist-songs cache (optimistic UI)
            await updatePlaylistSongsCache(playlistId, songs =>
                songs.filter(s => s.uuid !== songUuid)
            );
            await updatePlaylistSongCount(playlistId, -1);
        }

        if (shouldUseOffline()) {
            await queueWrite('playlists', 'removeSong', { playlistId, songUuid });
            await computeOfflineFilterSets();
            notifyPlaylistsChanged();
            return { success: true, queued: true };
        }

        const result = await api.playlists.removeSong(playlistId, songUuid);
        notifyPlaylistsChanged();
        return result;
    },

    /**
     * Remove multiple songs from playlist (batch, with offline playlist support)
     */
    async removeSongs(playlistId, songUuids) {
        const stringId = String(playlistId);
        const favoritesId = offlineStore.state.favoritesPlaylistId;

        // Handle pending playlists separately (they have non-numeric IDs like 'pending-123')
        if (stringId.startsWith('pending-')) {
            // Update pending playlist songs cache
            const key = `pending-playlist-songs:${stringId}`;
            const existing = await offlineDb.getSetting(key) || [];
            const filtered = existing.filter(uuid => !songUuids.includes(uuid));
            await offlineDb.saveSetting(key, filtered);

            // Update playlist-songs cache (optimistic UI)
            const uuidSet = new Set(songUuids);
            await updatePlaylistSongsCache(playlistId, songs =>
                songs.filter(s => !uuidSet.has(s.uuid))
            );
            await updatePlaylistSongCount(playlistId, -songUuids.length);

            if (shouldUseOffline()) {
                await queueWrite('playlists', 'removeSongs', { playlistId, songUuids });
                await computeOfflineFilterSets();
                notifyPlaylistsChanged();
                return { success: true, queued: true, removed: songUuids.length };
            }
            // If online but pending playlist, still queue (playlist will sync first)
            await queueWrite('playlists', 'removeSongs', { playlistId, songUuids });
            notifyPlaylistsChanged();
            return { success: true, queued: true, removed: songUuids.length };
        }

        const numericId = parseInt(playlistId, 10);
        if (isNaN(numericId)) {
            console.error('[Offline API] Invalid playlist ID:', playlistId);
            return { success: false, error: 'Invalid playlist ID' };
        }

        // Update local cache based on playlist type
        if (numericId === favoritesId) {
            for (const uuid of songUuids) {
                await offlineDb.removeFavorite(uuid);
                removeFavorite(uuid);
            }
        } else {
            // Update offline playlist cache if exists
            const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
            if (offlinePlaylist) {
                offlinePlaylist.songUuids = offlinePlaylist.songUuids.filter(
                    uuid => !songUuids.includes(uuid)
                );
                await offlineDb.saveOfflinePlaylist(offlinePlaylist);
            }

            // Update playlist-songs cache (optimistic UI)
            const uuidSet = new Set(songUuids);
            await updatePlaylistSongsCache(playlistId, songs =>
                songs.filter(s => !uuidSet.has(s.uuid))
            );
            await updatePlaylistSongCount(playlistId, -songUuids.length);
        }

        if (shouldUseOffline()) {
            // Queue as batch operation for sync
            await queueWrite('playlists', 'removeSongs', { playlistId, songUuids });
            await computeOfflineFilterSets();
            notifyPlaylistsChanged();
            return { success: true, queued: true, removed: songUuids.length };
        }

        // Online - remove songs and notify
        const result = await api.playlists.removeSongs(playlistId, songUuids);
        notifyPlaylistsChanged();
        return result;
    },

    /**
     * Get public playlists - returns cached if offline
     */
    async public(options = {}) {
        if (shouldUseOffline()) {
            const cached = await offlineDb.getSetting('publicPlaylists');
            return { items: cached || [], hasMore: false };
        }

        try {
            const result = await api.playlists.public(options);
            // Cache first page of public playlists for offline
            if (!options.cursor) {
                await offlineDb.saveSetting('publicPlaylists', result.items || []);
            }
            return result;
        } catch (error) {
            console.warn('[Offline API] Failed to fetch public playlists, using cache:', error);
            const cached = await offlineDb.getSetting('publicPlaylists');
            return { items: cached || [], hasMore: false };
        }
    },

    /**
     * Sort playlist songs - handles offline mode with local sorting
     */
    async sort(playlistId, sortBy, order = 'asc') {
        const stringId = String(playlistId);

        // Helper to perform local sort
        const performLocalSort = (items) => {
            const sorted = [...items];
            const direction = order === 'desc' ? -1 : 1;

            if (sortBy === 'random') {
                // Fisher-Yates shuffle
                for (let i = sorted.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
                }
            } else {
                sorted.sort((a, b) => {
                    let aVal, bVal;
                    switch (sortBy) {
                        case 'artist':
                            aVal = (a.artist || '').toLowerCase();
                            bVal = (b.artist || '').toLowerCase();
                            break;
                        case 'album':
                            aVal = (a.album || '').toLowerCase();
                            bVal = (b.album || '').toLowerCase();
                            break;
                        case 'track':
                            aVal = (a.disc_number || 1) * 1000 + (a.track_number || 0);
                            bVal = (b.disc_number || 1) * 1000 + (b.track_number || 0);
                            break;
                        case 'title':
                            aVal = (a.title || '').toLowerCase();
                            bVal = (b.title || '').toLowerCase();
                            break;
                        case 'year':
                            aVal = a.year || 0;
                            bVal = b.year || 0;
                            break;
                        case 'duration':
                            aVal = a.duration_seconds || 0;
                            bVal = b.duration_seconds || 0;
                            break;
                        default:
                            aVal = (a.title || '').toLowerCase();
                            bVal = (b.title || '').toLowerCase();
                    }
                    if (aVal < bVal) return -direction;
                    if (aVal > bVal) return direction;
                    return 0;
                });
            }
            return sorted;
        };

        // Handle pending playlists separately (they have non-numeric IDs like 'pending-123')
        if (stringId.startsWith('pending-')) {
            const result = await this.getSongs(playlistId);
            if (!result.items || result.items.length === 0) {
                return { success: false, reason: 'No songs to sort' };
            }

            const sorted = performLocalSort(result.items);
            const sortedUuids = sorted.map(s => s.uuid);

            // Update pending playlist songs cache
            const key = `pending-playlist-songs:${stringId}`;
            await offlineDb.saveSetting(key, sortedUuids);

            // Update playlist-songs cache (optimistic UI)
            await updatePlaylistSongsCache(playlistId, () => sorted);

            // Queue for sync when back online
            await queueWrite('playlists', 'sort', { playlistId, sortBy, order });
            return { success: true, queued: true };
        }

        if (shouldUseOffline()) {
            const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;
            const favoritesId = offlineStore.state.favoritesPlaylistId;

            // Get the playlist songs to sort
            const result = await this.getSongs(playlistId);
            if (!result.items || result.items.length === 0) {
                return { success: false, reason: 'No songs to sort' };
            }

            const sorted = performLocalSort(result.items);

            // Save sorted order back to cache
            if (numericId === favoritesId) {
                // For favorites, update the favorites list order
                const sortedUuids = sorted.map(s => s.uuid);
                await offlineDb.setFavorites(sortedUuids);
                setFavorites(sortedUuids);
            } else {
                // For offline playlists, update the cached song order
                const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
                if (offlinePlaylist) {
                    offlinePlaylist.songUuids = sorted.map(s => s.uuid);
                    await offlineDb.saveOfflinePlaylist(offlinePlaylist);
                }

                // Update playlist-songs cache (optimistic UI)
                await updatePlaylistSongsCache(playlistId, () => sorted);
            }

            // Queue for sync when back online
            await queueWrite('playlists', 'sort', { playlistId, sortBy, order });
            return { success: true, queued: true };
        }

        return api.playlists.sort(playlistId, sortBy, order);
    },

    /**
     * Reorder playlist songs - handles offline mode
     */
    async reorder(playlistId, positions) {
        const stringId = String(playlistId);

        // positions is an array of {uuid, position} - extract uuids in order
        const orderedUuids = [...positions]
            .sort((a, b) => a.position - b.position)
            .map(p => p.uuid);

        // Handle pending playlists separately (they have non-numeric IDs like 'pending-123')
        if (stringId.startsWith('pending-')) {
            // Update pending playlist songs cache with new order
            const key = `pending-playlist-songs:${stringId}`;
            await offlineDb.saveSetting(key, orderedUuids);

            // Update playlist-songs cache (optimistic UI)
            const uuidOrder = new Map(orderedUuids.map((uuid, idx) => [uuid, idx]));
            await updatePlaylistSongsCache(playlistId, songs =>
                [...songs].sort((a, b) =>
                    (uuidOrder.get(a.uuid) ?? 999999) - (uuidOrder.get(b.uuid) ?? 999999)
                )
            );

            if (shouldUseOffline()) {
                await queueWrite('playlists', 'reorder', { playlistId, positions });
                return { success: true, queued: true };
            }
            // If online but pending playlist, still queue (playlist will sync first)
            await queueWrite('playlists', 'reorder', { playlistId, positions });
            return { success: true, queued: true };
        }

        if (shouldUseOffline()) {
            const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;
            const favoritesId = offlineStore.state.favoritesPlaylistId;

            // Update cache based on playlist type
            if (numericId === favoritesId) {
                await offlineDb.setFavorites(orderedUuids);
                setFavorites(orderedUuids);
            } else {
                const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
                if (offlinePlaylist) {
                    offlinePlaylist.songUuids = orderedUuids;
                    await offlineDb.saveOfflinePlaylist(offlinePlaylist);
                }

                // Update playlist-songs cache (optimistic UI)
                const uuidOrder = new Map(orderedUuids.map((uuid, idx) => [uuid, idx]));
                await updatePlaylistSongsCache(playlistId, songs =>
                    [...songs].sort((a, b) =>
                        (uuidOrder.get(a.uuid) ?? 999999) - (uuidOrder.get(b.uuid) ?? 999999)
                    )
                );
            }

            // Queue for sync when back online
            await queueWrite('playlists', 'reorder', { playlistId, positions });
            return { success: true, queued: true };
        }

        return api.playlists.reorder(playlistId, positions);
    },

    /**
     * Delete playlist - handles offline mode
     */
    async delete(playlistId) {
        const stringId = String(playlistId);
        const isPending = stringId.startsWith('pending-');
        const numericId = isPending ? null : (typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId);

        // Update local playlists list cache (handle both numeric and string IDs)
        const cached = await offlineDb.getSetting('playlists');
        if (cached) {
            const filtered = cached.filter(p =>
                String(p.id) !== stringId && (!numericId || p.id !== numericId)
            );
            await offlineDb.saveSetting('playlists', filtered);
        }

        // Remove offline playlist data if exists (only for non-pending playlists)
        if (numericId && !isNaN(numericId)) {
            await offlineDb.deleteOfflinePlaylist(numericId);
        }

        // Clear playlist-songs cache
        await offlineDb.saveSetting(`playlist-songs:${stringId}`, null);

        // Clear pending playlist songs if this was a pending playlist
        if (isPending) {
            await offlineDb.saveSetting(`pending-playlist-songs:${stringId}`, null);
        }

        if (shouldUseOffline()) {
            // Don't queue delete for pending playlists (they don't exist on server yet)
            if (!isPending) {
                await queueWrite('playlists', 'delete', { playlistId });
            }
            // Notify listeners that playlists changed
            notifyPlaylistsChanged();
            return { success: true, queued: !isPending };
        }

        // Online - delete and notify
        const result = await api.playlists.delete(playlistId);
        notifyPlaylistsChanged();
        return result;
    },

    /**
     * Add multiple songs to playlist (batch, with offline support)
     * @param {number|string} playlistId
     * @param {string[]} songUuids
     * @param {number|object|null} batchSizeOrSongObjects - Batch size for online, or song objects for metadata caching
     * @param {Function|null} onProgress - Progress callback (online only)
     */
    async addSongsBatch(playlistId, songUuids, batchSizeOrSongObjects = null, onProgress = null) {
        // Handle legacy songObjects parameter (when 3rd param is an array of objects)
        const songObjects = Array.isArray(batchSizeOrSongObjects) ? batchSizeOrSongObjects : null;
        const batchSize = typeof batchSizeOrSongObjects === 'number' ? batchSizeOrSongObjects : 500;
        // Cache metadata for provided songs upfront (before any other logic)
        // This ensures metadata is available even when adding to existing playlists while offline
        if (songObjects && songObjects.length > 0) {
            for (const song of songObjects) {
                if (song && song.uuid && song.title) {
                    await offlineDb.saveSongMetadata(song);
                }
            }
        }

        const stringId = String(playlistId);
        const numericId = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId;
        const favoritesId = offlineStore.state.favoritesPlaylistId;

        // Helper to get song metadata with queue cache fallback
        const getMetadataWithQueueFallback = async (uuids) => {
            const metadata = await offlineDb.getSongsMetadata(uuids);
            const queueCache = await offlineDb.getQueueCache();
            const queueMap = new Map((queueCache?.items || []).map(s => [s.uuid, s]));

            const results = [];
            for (const m of metadata) {
                if (m.unavailable) {
                    // Check queue cache for full metadata
                    const queueSong = queueMap.get(m.uuid);
                    if (queueSong && queueSong.title) {
                        // Save to songMetadata store for future lookups
                        await offlineDb.saveSongMetadata(queueSong);
                        results.push(queueSong);
                        continue;
                    }
                }
                results.push(m);
            }
            return results;
        };

        // Update local cache based on playlist type
        if (numericId === favoritesId) {
            for (const uuid of songUuids) {
                await offlineDb.addFavorite(uuid);
                addFavorite(uuid);
            }
        } else if (stringId.startsWith('pending-')) {
            // Pending playlist created offline - store songs in settings cache
            const key = `pending-playlist-songs:${stringId}`;
            const existing = await offlineDb.getSetting(key) || [];
            const newUuids = songUuids.filter(uuid => !existing.includes(uuid));
            await offlineDb.saveSetting(key, [...existing, ...newUuids]);

            // Ensure metadata is cached for new songs (check queue cache)
            const queueCache = await offlineDb.getQueueCache();
            const queueMap = new Map((queueCache?.items || []).map(s => [s.uuid, s]));
            for (const uuid of newUuids) {
                const queueSong = queueMap.get(uuid);
                if (queueSong && queueSong.title) {
                    await offlineDb.saveSongMetadata(queueSong);
                }
            }

            // Update song count in cached playlists list
            const cached = await offlineDb.getSetting('playlists') || [];
            const playlistIndex = cached.findIndex(p => p.id === stringId);
            if (playlistIndex >= 0) {
                cached[playlistIndex].song_count = (cached[playlistIndex].song_count || 0) + newUuids.length;
                await offlineDb.saveSetting('playlists', cached);
            }
        } else {
            // Update offline playlist cache if exists
            const offlinePlaylist = await offlineDb.getOfflinePlaylist(numericId);
            if (offlinePlaylist) {
                for (const uuid of songUuids) {
                    if (!offlinePlaylist.songUuids.includes(uuid)) {
                        offlinePlaylist.songUuids.push(uuid);
                    }
                }
                await offlineDb.saveOfflinePlaylist(offlinePlaylist);
            }

            // Update playlist-songs cache (optimistic UI)
            const existingUuids = new Set();
            await updatePlaylistSongsCache(playlistId, async songs => {
                songs.forEach(s => existingUuids.add(s.uuid));
                const newUuids = songUuids.filter(uuid => !existingUuids.has(uuid));
                if (newUuids.length > 0) {
                    const metadata = await getMetadataWithQueueFallback(newUuids);
                    songs.push(...metadata);
                }
                return songs;
            });
            const addedCount = songUuids.filter(uuid => !existingUuids.has(uuid)).length;
            if (addedCount > 0) {
                await updatePlaylistSongCount(playlistId, addedCount);
            }
        }

        if (shouldUseOffline()) {
            // Queue as batch operation for sync
            await queueWrite('playlists', 'addSongsBatch', { playlistId, songUuids });
            // Refresh filter sets so songs appear in browse
            await computeOfflineFilterSets();
            // Notify so playlist counts update
            notifyPlaylistsChanged();
            return { success: true, queued: true, added: songUuids.length };
        }

        // Online - add songs with batching and progress
        const result = await api.playlists.addSongsBatch(playlistId, songUuids, batchSize, onProgress);
        notifyPlaylistsChanged();
        return result;
    },

    // Create playlist - offline aware with optimistic UI
    async create(name, description = '', isPublic = false) {
        if (shouldUseOffline()) {
            const tempId = `pending-${Date.now()}`;
            // Queue the creation for later sync
            await queueWrite('playlists', 'create', { name, description, isPublic, tempId });

            // Add to local playlists cache for optimistic UI
            const pendingPlaylist = {
                id: tempId,
                name,
                description,
                is_public: isPublic,
                song_count: 0,
                pending: true,  // Mark as pending sync
                created_at: new Date().toISOString()
            };

            // Update cached playlists list
            const cached = await offlineDb.getSetting('playlists') || [];
            cached.unshift(pendingPlaylist);  // Add to start of list
            await offlineDb.saveSetting('playlists', cached);

            // Initialize empty songs cache for the new playlist
            await offlineDb.saveSetting(`pending-playlist-songs:${tempId}`, []);

            // Notify listeners that playlists changed
            notifyPlaylistsChanged();

            return { success: true, queued: true, id: tempId, name, ...pendingPlaylist };
        }
        // Online - create and notify
        const result = await api.playlists.create(name, description, isPublic);
        notifyPlaylistsChanged();
        return result;
    },

    // Pass through other playlist methods
    update: api.playlists.update,
    share: api.playlists.share,
    byToken: api.playlists.byToken,
    clone: api.playlists.clone
};

// =============================================================================
// Playback API (offline-aware)
// =============================================================================

export const playback = {
    /**
     * Get playback state
     */
    async getState() {
        if (shouldUseOffline()) {
            const cached = await offlineDb.getQueueCache();
            if (cached) {
                return {
                    queueIndex: cached.queueIndex,
                    scaEnabled: cached.scaEnabled,
                    playMode: cached.playMode
                };
            }
            return { queueIndex: 0, scaEnabled: false, playMode: 'sequential' };
        }

        return api.playback.getState();
    },

    /**
     * Set playback state
     */
    async setState(state) {
        // Update local cache
        const cached = await offlineDb.getQueueCache();
        if (cached) {
            if (state.queueIndex !== undefined) cached.queueIndex = state.queueIndex;
            if (state.scaEnabled !== undefined) cached.scaEnabled = state.scaEnabled;
            if (state.playMode !== undefined) cached.playMode = state.playMode;
            await offlineDb.saveQueueCache(cached);
        }

        if (shouldUseOffline()) {
            await queueWrite('playback', 'setState', state);
            return { success: true, queued: true };
        }

        return api.playback.setState(state);
    }
};

// =============================================================================
// History API (queue writes for sync)
// =============================================================================

export const history = {
    /**
     * Record play history
     * @param {string} songUuid
     * @param {number} durationSeconds
     * @param {boolean} skipped
     * @param {string} source - 'browse' or 'radio'
     */
    async record(songUuid, durationSeconds, skipped = false, source = 'browse') {
        if (shouldUseOffline()) {
            await queueWrite('history', 'record', {
                songUuid,
                durationSeconds,
                skipped,
                source,
                playedAt: Date.now()
            });
            return { success: true, queued: true };
        }

        return api.history.record(songUuid, durationSeconds, skipped, source);
    },

    // Recent history not available offline
    recent: api.history.recent,

    // History viewing methods - online only
    list: api.history.list,
    grouped: api.history.grouped,
    getUuids: api.history.getUuids
};

// =============================================================================
// Auth API (offline-aware)
// =============================================================================

export const auth = {
    /**
     * Check user authentication - returns cached if offline
     */
    async checkUser() {
        if (shouldUseOffline()) {
            const cached = await offlineDb.getSetting('authState');
            if (cached) {
                return cached;
            }
            // Return unauthenticated state if no cache
            return { authenticated: false, user: null };
        }

        try {
            const result = await api.auth.checkUser();
            // Cache auth state for offline use
            await offlineDb.saveSetting('authState', result);
            return result;
        } catch (error) {
            // Network error - try cache
            const cached = await offlineDb.getSetting('authState');
            if (cached) {
                return cached;
            }
            throw error;
        }
    },

    // These require network - not available offline
    login: api.auth.login,
    logout: api.auth.logout,
    register: api.auth.register,
    changePassword: api.auth.changePassword
};

// =============================================================================
// Browse API (offline-aware)
// =============================================================================

export const browse = {
    /**
     * List categories - from cached metadata when offline
     */
    async categories(options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            const categoryMap = new Map();

            for (const song of metadata) {
                const cat = song.category || '[Unknown Category]';
                if (!categoryMap.has(cat)) {
                    categoryMap.set(cat, { name: cat, song_count: 0 });
                }
                categoryMap.get(cat).song_count++;
            }

            let items = [...categoryMap.values()];

            // Sort by name or count
            if (options.sort === 'song_count') {
                items.sort((a, b) => b.song_count - a.song_count);
            } else {
                items.sort((a, b) => a.name.localeCompare(b.name));
            }

            return { items, hasMore: false };
        }
        return api.browse.categories(options);
    },

    /**
     * List genres - from cached metadata when offline
     */
    async genres(options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            const genreMap = new Map();

            for (const song of metadata) {
                // Filter by category if specified
                if (options.category && song.category !== options.category) continue;

                const genre = song.genre || '[Unknown Genre]';
                if (!genreMap.has(genre)) {
                    genreMap.set(genre, { name: genre, song_count: 0 });
                }
                genreMap.get(genre).song_count++;
            }

            let items = [...genreMap.values()];

            // Add [All Genres] option
            if (items.length > 0) {
                const total = items.reduce((sum, g) => sum + g.song_count, 0);
                items.unshift({ name: '[All Genres]', song_count: total });
            }

            // Sort
            if (options.sort === 'song_count') {
                items.sort((a, b) => b.song_count - a.song_count);
            } else {
                items.sort((a, b) => {
                    if (a.name.startsWith('[')) return -1;
                    if (b.name.startsWith('[')) return 1;
                    return a.name.localeCompare(b.name);
                });
            }

            return { items, hasMore: false };
        }
        return api.browse.genres(options);
    },

    /**
     * List artists - from cached metadata when offline
     */
    async artists(options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            const artistMap = new Map();

            for (const song of metadata) {
                // Filter by category/genre if specified
                if (options.category && song.category !== options.category) continue;
                if (options.genre && song.genre !== options.genre) continue;

                const artist = song.artist || '[Unknown Artist]';
                if (!artistMap.has(artist)) {
                    artistMap.set(artist, { name: artist, song_count: 0 });
                }
                artistMap.get(artist).song_count++;
            }

            let items = [...artistMap.values()];

            // Add [All Artists] option
            if (items.length > 0) {
                const total = items.reduce((sum, a) => sum + a.song_count, 0);
                items.unshift({ name: '[All Artists]', song_count: total });
            }

            // Sort
            if (options.sort === 'song_count') {
                items.sort((a, b) => b.song_count - a.song_count);
            } else {
                items.sort((a, b) => {
                    if (a.name.startsWith('[')) return -1;
                    if (b.name.startsWith('[')) return 1;
                    return a.name.localeCompare(b.name);
                });
            }

            return { items, hasMore: false };
        }
        return api.browse.artists(options);
    },

    /**
     * List albums - from cached metadata when offline
     */
    async albums(options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            const albumMap = new Map();

            for (const song of metadata) {
                // Filter by category/genre/artist if specified
                if (options.category && song.category !== options.category) continue;
                if (options.genre && song.genre !== options.genre) continue;
                if (options.artist && song.artist !== options.artist) continue;

                const album = song.album || '[Unknown Album]';
                const key = `${song.artist || ''}|${album}`;
                if (!albumMap.has(key)) {
                    albumMap.set(key, { name: album, artist: song.artist, song_count: 0 });
                }
                albumMap.get(key).song_count++;
            }

            let items = [...albumMap.values()];

            // Add [All Albums] option
            if (items.length > 0) {
                const total = items.reduce((sum, a) => sum + a.song_count, 0);
                items.unshift({ name: '[All Albums]', song_count: total });
            }

            // Sort
            if (options.sort === 'song_count') {
                items.sort((a, b) => b.song_count - a.song_count);
            } else {
                items.sort((a, b) => {
                    if (a.name.startsWith('[')) return -1;
                    if (b.name.startsWith('[')) return 1;
                    return a.name.localeCompare(b.name);
                });
            }

            return { items, hasMore: false };
        }
        return api.browse.albums(options);
    },

    /**
     * List songs in album - from cached metadata when offline
     */
    async albumSongs(album, options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            let items = [];

            for (const song of metadata) {
                // Filter by category/genre/artist if specified
                if (options.category && song.category !== options.category) continue;
                if (options.genre && song.genre !== options.genre) continue;
                if (options.artist && song.artist !== options.artist) continue;

                // Match album (handle [All Albums] and [Unknown Album])
                if (album === '[All Albums]') {
                    items.push(song);
                } else if (album === '[Unknown Album]' && !song.album) {
                    items.push(song);
                } else if (song.album === album) {
                    items.push(song);
                }
            }

            // Sort by disc/track number if available, otherwise by title
            items.sort((a, b) => {
                const discA = a.disc_number || 1;
                const discB = b.disc_number || 1;
                if (discA !== discB) return discA - discB;

                const trackA = a.track_number || 0;
                const trackB = b.track_number || 0;
                if (trackA && trackB) return trackA - trackB;

                return (a.title || '').localeCompare(b.title || '');
            });

            return { items, hasMore: false, totalCount: items.length };
        }
        return api.browse.albumSongs(album, options);
    },

    /**
     * Browse by file path - from cached metadata when offline
     */
    async path(path = '/', options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            const dirMap = new Map();
            const songItems = [];

            const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
            const pathDepth = normalizedPath === '' ? 0 : normalizedPath.split('/').filter(p => p).length;

            for (const song of metadata) {
                const filepath = song.filepath || '';
                if (!filepath) continue;

                // Check if this song is under the current path
                if (!filepath.startsWith(normalizedPath === '' ? '/' : normalizedPath + '/') &&
                    filepath !== normalizedPath) {
                    continue;
                }

                const parts = filepath.split('/').filter(p => p);

                if (parts.length === pathDepth + 1) {
                    // This is a file directly in the current directory
                    songItems.push({
                        ...song,
                        name: parts[parts.length - 1],
                        type: 'file'
                    });
                } else if (parts.length > pathDepth + 1) {
                    // This is in a subdirectory
                    const dirName = parts[pathDepth];
                    const dirPath = '/' + parts.slice(0, pathDepth + 1).join('/');

                    if (!dirMap.has(dirPath)) {
                        dirMap.set(dirPath, {
                            name: dirName,
                            path: dirPath,
                            type: 'directory',
                            song_count: 0
                        });
                    }
                    dirMap.get(dirPath).song_count++;
                }
            }

            // Combine directories and files
            let items = [...dirMap.values(), ...songItems];

            // Sort
            items.sort((a, b) => {
                // Directories first
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return (a.name || '').localeCompare(b.name || '');
            });

            return { items, hasMore: false, totalCount: items.length };
        }
        return api.browse.path(path, options);
    },

    // Pass through other browse methods (not commonly used offline)
    albumArtists: api.browse.albumArtists
};

// =============================================================================
// Re-export unchanged APIs
// =============================================================================

// Songs API (offline-aware for byPath and byFilter)
export const songs = {
    // Pass through most methods
    list: api.songs.list,
    search: api.songs.search,
    random: api.songs.random,
    quickSearch: api.songs.quickSearch,
    count: api.songs.count,
    ftsRanked: api.songs.ftsRanked,
    getBulk: api.songs.getBulk,

    // Get song by UUID
    async get(uuid) {
        return api.songs.get(uuid);
    },

    // Offline-aware byPath - returns cached songs when offline
    async byPath(path, options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();
            const normalPath = path.endsWith('/') ? path : path + '/';

            // Filter to songs whose filepath starts with the given path
            let matching = metadata.filter(song => {
                const filepath = song.filepath || '';
                return filepath === path || filepath.startsWith(normalPath);
            });

            // Sort by filepath for consistent ordering
            matching.sort((a, b) => (a.filepath || '').localeCompare(b.filepath || ''));

            // Apply pagination
            const cursor = options.cursor ? parseInt(options.cursor) : 0;
            const limit = options.limit || 100;
            const items = matching.slice(cursor, cursor + limit);
            const nextCursor = cursor + limit < matching.length ? String(cursor + limit) : null;

            return { items, nextCursor };
        }
        return api.songs.byPath(path, options);
    },

    // Offline-aware byFilter - returns cached songs when offline
    async byFilter(options = {}) {
        if (shouldUseOffline()) {
            const metadata = await offlineDb.getAllSongMetadata();

            // Filter to songs matching the hierarchy filters
            let matching = metadata.filter(song => {
                if (options.category && song.category !== options.category) return false;
                if (options.genre && song.genre !== options.genre) return false;
                if (options.artist && song.artist !== options.artist) return false;
                if (options.album && song.album !== options.album) return false;
                return true;
            });

            // Sort by artist, album, track number for consistent ordering
            matching.sort((a, b) => {
                const artistCmp = (a.artist || '').localeCompare(b.artist || '');
                if (artistCmp !== 0) return artistCmp;
                const albumCmp = (a.album || '').localeCompare(b.album || '');
                if (albumCmp !== 0) return albumCmp;
                return (a.track_number || 0) - (b.track_number || 0);
            });

            // Apply pagination
            const cursor = options.cursor ? parseInt(options.cursor) : 0;
            const limit = options.limit || 100;
            const items = matching.slice(cursor, cursor + limit);
            const nextCursor = cursor + limit < matching.length ? String(cursor + limit) : null;

            return { items, nextCursor };
        }
        return api.songs.byFilter(options);
    }
};
export const radio = api.radio;
export const sca = api.sca;
export const tags = api.tags;
export const getStreamUrl = api.getStreamUrl;

// =============================================================================
// Helper to check if favorites is cached
// =============================================================================

export function isFavorite(uuid) {
    return offlineStore.state.favoriteSongs.has(uuid);
}

export function getFavoritesPlaylistId() {
    return offlineStore.state.favoritesPlaylistId;
}

// Re-export from offline-store for convenience
export { shouldUseOffline };

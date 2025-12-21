/**
 * offline-store.js - Reactive store for offline state
 *
 * Tracks online/offline status, work offline mode, cache status,
 * offline playlists, favorites, and disk usage.
 */

import { createStore } from '../lib/framework.js';
import * as offlineDb from './offline-db.js';

// Track the version that was running when page loaded (for update detection)
let initialRunningVersion = null;

/**
 * Offline state store
 */
const offlineStore = createStore({
    // Network status
    isOnline: navigator.onLine,

    // User preference to work offline even when online
    workOfflineMode: localStorage.getItem('music-work-offline') === 'true',

    // Service worker cache status
    cacheStatus: 'checking', // 'checking' | 'caching' | 'ready' | 'error'
    cacheProgress: null, // { current: number, total: number } | null
    cacheVersion: null,

    // Pending writes
    pendingWriteCount: 0,

    // Last successful sync
    lastSyncTime: null,

    // Sync failure state
    syncFailed: false,
    syncError: null,
    syncFailedAt: null,

    // Last queue sync time (for refresh cooldown)
    lastQueueSyncTime: 0,

    // Offline playlists (array of playlist IDs)
    offlinePlaylists: [],

    // Offline folders (downloaded folder/hierarchy sets)
    offlineFolders: [],

    // All UUIDs available offline (Set for fast lookup)
    offlineSongUuids: new Set(),

    // Favorites (Set of UUIDs, always cached)
    favoriteSongs: new Set(),
    favoritesPlaylistId: null,

    // Download progress for current download
    downloadProgress: null, // { playlistId, playlistName, current, total, currentSongName } | null

    // Computed filter sets for offline browsing
    offlineArtists: new Set(),    // Artists with downloaded songs
    offlineAlbums: new Set(),     // Albums with downloaded songs
    offlineGenres: new Set(),     // Genres with downloaded songs
    offlineCategories: new Set(), // Categories with downloaded songs
    offlinePaths: new Set(),      // File paths with downloaded songs (all parent directories)
    // Flags for "Unknown" categories (songs missing metadata)
    hasUnknownArtist: false,
    hasUnknownAlbum: false,
    hasUnknownGenre: false,

    // Disk usage
    diskUsage: {
        audio: { bytes: 0, count: 0 },
        metadata: { bytes: 0, count: 0 },
        total: 0
    },

    // Storage estimate from browser
    storageEstimate: null,

    // Update availability
    updateAvailable: false,
    pendingVersion: null
});

/**
 * Initialize the offline store by loading data from IndexedDB
 */
export async function initializeOfflineStore() {
    try {
        // Open database
        await offlineDb.openDatabase();

        // Load offline playlists
        const playlists = await offlineDb.getAllOfflinePlaylists();
        offlineStore.state.offlinePlaylists = playlists.map(p => p.id);

        // Load offline folders
        const folders = await offlineDb.getAllOfflineFolders();
        offlineStore.state.offlineFolders = folders;

        // Load offline song UUIDs
        const offlineUuids = await offlineDb.getAllOfflineUuids();
        offlineStore.state.offlineSongUuids = offlineUuids;

        // Load favorites
        const favorites = await offlineDb.getFavorites();
        offlineStore.state.favoriteSongs = favorites;

        // Load favorites playlist ID
        const favPlaylistId = await offlineDb.getSetting('favoritesPlaylistId');
        if (favPlaylistId) {
            offlineStore.state.favoritesPlaylistId = favPlaylistId;
        }

        // Load pending write count
        const pendingCount = await offlineDb.getPendingWriteCount();
        offlineStore.state.pendingWriteCount = pendingCount;

        // Load last sync time
        const lastSync = await offlineDb.getSetting('lastSyncTime');
        if (lastSync) {
            offlineStore.state.lastSyncTime = lastSync;
        }

        // Load disk usage
        const usage = await offlineDb.getDiskUsage();
        offlineStore.state.diskUsage = usage;

        // Get storage estimate
        const estimate = await offlineDb.getStorageEstimate();
        offlineStore.state.storageEstimate = estimate;

        // Compute offline filter sets for browsing
        await computeOfflineFilterSets();

        // Request cache status from service worker now that we're ready
        requestCacheStatus();
    } catch (error) {
        console.error('[Offline Store] Initialization failed:', error);
    }
}

/**
 * Set up network status listeners
 */
function setupNetworkListeners() {
    window.addEventListener('online', () => {
        offlineStore.state.isOnline = true;
        // Trigger sync in sync-manager
        window.dispatchEvent(new CustomEvent('offline-store-online'));
    });

    window.addEventListener('offline', () => {
        offlineStore.state.isOnline = false;
    });

    // Listen for service worker cache status
    window.addEventListener('sw-cache-status', (event) => {
        const { status, progress, version, error, updated, previousVersion } = event.detail;
        offlineStore.state.cacheStatus = status;
        offlineStore.state.cacheProgress = progress || null;

        if (version) {
            // Track the first version we see as our "running" version
            if (initialRunningVersion === null) {
                initialRunningVersion = version;
            }

            // Detect updates: either via explicit flag or version mismatch
            if (status === 'ready' && !offlineStore.state.updateAvailable) {
                if (updated && previousVersion) {
                    // Explicit update flag from SW - use previousVersion for display
                    offlineStore.state.cacheVersion = previousVersion;
                    offlineStore.state.updateAvailable = true;
                    offlineStore.state.pendingVersion = version;
                    console.log(`[Offline Store] Update available: v${previousVersion} → v${version}`);
                } else if (initialRunningVersion && version !== initialRunningVersion) {
                    // Version changed since page load - new cache is ready
                    // cacheVersion stays as initialRunningVersion for correct display
                    offlineStore.state.updateAvailable = true;
                    offlineStore.state.pendingVersion = version;
                    console.log(`[Offline Store] Update detected: v${initialRunningVersion} → v${version}`);
                } else {
                    // No update - just set current version
                    offlineStore.state.cacheVersion = version;
                }
            } else if (!offlineStore.state.updateAvailable) {
                // Not ready yet or already have update - update version normally
                offlineStore.state.cacheVersion = version;
            }
        }
    });

    // Listen for update availability
    window.addEventListener('sw-update-available', (event) => {
        const { version, previousVersion } = event.detail;
        // Keep cacheVersion as the previous version for correct display
        if (previousVersion && !offlineStore.state.updateAvailable) {
            offlineStore.state.cacheVersion = previousVersion;
        }
        offlineStore.state.updateAvailable = true;
        offlineStore.state.pendingVersion = version;
        console.log(`[Offline Store] Update available: v${previousVersion} → v${version}`);
    });

    // Re-request cache status when SW controller changes (e.g., after SW update)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            requestCacheStatus();
        });
    }
}

/**
 * Set work offline mode
 */
export function setWorkOfflineMode(enabled) {
    offlineStore.state.workOfflineMode = enabled;
    localStorage.setItem('music-work-offline', enabled ? 'true' : 'false');
}

/**
 * Update cache status (called by service worker)
 */
export function setCacheStatus(status, progress = null, version = null) {
    offlineStore.state.cacheStatus = status;
    offlineStore.state.cacheProgress = progress;
    if (version) {
        offlineStore.state.cacheVersion = version;
    }
}

/**
 * Update pending write count
 */
export async function refreshPendingWriteCount() {
    const count = await offlineDb.getPendingWriteCount();
    offlineStore.state.pendingWriteCount = count;
}

/**
 * Update last sync time
 */
export async function setLastSyncTime(time = Date.now()) {
    offlineStore.state.lastSyncTime = time;
    await offlineDb.saveSetting('lastSyncTime', time);
}

/**
 * Set sync failure state
 */
export function setSyncFailed(error) {
    offlineStore.state.syncFailed = true;
    offlineStore.state.syncError = error;
    offlineStore.state.syncFailedAt = Date.now();
}

/**
 * Clear sync failure state
 */
export function clearSyncFailed() {
    offlineStore.state.syncFailed = false;
    offlineStore.state.syncError = null;
    offlineStore.state.syncFailedAt = null;
}

/**
 * Set last queue sync time (for refresh cooldown)
 */
export function setLastQueueSyncTime(time = Date.now()) {
    offlineStore.state.lastQueueSyncTime = time;
}

/**
 * Add a song UUID to offline set
 */
export function addOfflineSong(uuid) {
    const newSet = new Set(offlineStore.state.offlineSongUuids);
    newSet.add(uuid);
    offlineStore.state.offlineSongUuids = newSet;
}

/**
 * Remove a song UUID from offline set
 */
export function removeOfflineSong(uuid) {
    const newSet = new Set(offlineStore.state.offlineSongUuids);
    newSet.delete(uuid);
    offlineStore.state.offlineSongUuids = newSet;
}

/**
 * Add a playlist to offline playlists
 */
export function addOfflinePlaylist(playlistId) {
    if (!offlineStore.state.offlinePlaylists.includes(playlistId)) {
        offlineStore.state.offlinePlaylists = [
            ...offlineStore.state.offlinePlaylists,
            playlistId
        ];
    }
}

/**
 * Remove a playlist from offline playlists
 */
export function removeOfflinePlaylist(playlistId) {
    offlineStore.state.offlinePlaylists = offlineStore.state.offlinePlaylists.filter(
        id => id !== playlistId
    );
}

/**
 * Add or update an offline folder
 */
export function setOfflineFolder(folder) {
    const existing = offlineStore.state.offlineFolders.findIndex(f => f.id === folder.id);
    if (existing >= 0) {
        // Update existing
        const newFolders = [...offlineStore.state.offlineFolders];
        newFolders[existing] = folder;
        offlineStore.state.offlineFolders = newFolders;
    } else {
        // Add new
        offlineStore.state.offlineFolders = [...offlineStore.state.offlineFolders, folder];
    }
}

/**
 * Remove an offline folder
 */
export function removeOfflineFolder(folderId) {
    offlineStore.state.offlineFolders = offlineStore.state.offlineFolders.filter(
        f => f.id !== folderId
    );
}

/**
 * Get an offline folder by ID
 */
export function getOfflineFolderById(folderId) {
    return offlineStore.state.offlineFolders.find(f => f.id === folderId) || null;
}

/**
 * Set download progress
 */
export function setDownloadProgress(progress) {
    offlineStore.state.downloadProgress = progress;
}

/**
 * Update disk usage
 */
export async function refreshDiskUsage() {
    const usage = await offlineDb.getDiskUsage();
    offlineStore.state.diskUsage = usage;

    const estimate = await offlineDb.getStorageEstimate();
    offlineStore.state.storageEstimate = estimate;
}

/**
 * Update favorites set
 */
export function setFavorites(uuids) {
    offlineStore.state.favoriteSongs = new Set(uuids);
}

/**
 * Add a favorite
 */
export function addFavorite(uuid) {
    const newSet = new Set(offlineStore.state.favoriteSongs);
    newSet.add(uuid);
    offlineStore.state.favoriteSongs = newSet;
}

/**
 * Remove a favorite
 */
export function removeFavorite(uuid) {
    const newSet = new Set(offlineStore.state.favoriteSongs);
    newSet.delete(uuid);
    offlineStore.state.favoriteSongs = newSet;
}

/**
 * Set favorites playlist ID
 */
export async function setFavoritesPlaylistId(id) {
    offlineStore.state.favoritesPlaylistId = id;
    await offlineDb.saveSetting('favoritesPlaylistId', id);
}

/**
 * Check if we should use offline mode
 * Returns true if offline OR if work offline mode is enabled
 */
export function shouldUseOffline() {
    return !offlineStore.state.isOnline || offlineStore.state.workOfflineMode;
}

/**
 * Check if a song is available offline
 */
export function isSongAvailableOffline(uuid) {
    return offlineStore.state.offlineSongUuids.has(uuid);
}

/**
 * Check if a song is a favorite (from cache)
 */
export function isSongFavorite(uuid) {
    return offlineStore.state.favoriteSongs.has(uuid);
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Set up network listeners on module load
setupNetworkListeners();

/**
 * Request cache status and trigger update from service worker.
 * Call this after initialization to ensure cache is current.
 */
export async function requestCacheStatus() {
    if ('serviceWorker' in navigator) {
        try {
            // Wait for SW to be ready (handles race condition on initial load)
            const registration = await navigator.serviceWorker.ready;
            if (registration.active) {
                // Only send update-cache - it checks current status AND updates if needed
                // Sending both check-cache and update-cache causes duplicate cache scans
                registration.active.postMessage({ type: 'update-cache' });
            }
        } catch (e) {
            console.warn('[Offline Store] Failed to request cache status:', e);
        }
    }
}

/**
 * Check if we're actually offline (network unavailable).
 * More reliable than just checking navigator.onLine.
 */
export function isActuallyOffline() {
    return !offlineStore.state.isOnline;
}

/**
 * Check if we should show offline warnings (either work-offline mode or actually offline)
 */
export function shouldShowOfflineWarnings() {
    return offlineStore.state.workOfflineMode || !offlineStore.state.isOnline;
}

/**
 * Compute offline filter sets from cached song metadata.
 * This creates Sets for artists, albums, genres, categories, and paths
 * that have downloaded songs, enabling efficient offline browsing filtering.
 */
export async function computeOfflineFilterSets() {
    try {
        const metadata = await offlineDb.getAllSongMetadata();

        const artists = new Set();
        const albums = new Set();
        const genres = new Set();
        const categories = new Set();
        const paths = new Set();
        let hasUnknownArtist = false;
        let hasUnknownAlbum = false;
        let hasUnknownGenre = false;

        for (const song of metadata) {
            // Track artists (and detect unknown)
            if (song.artist) {
                artists.add(song.artist);
            } else {
                hasUnknownArtist = true;
            }

            // Track albums (and detect unknown)
            if (song.album) {
                albums.add(song.album);
            } else {
                hasUnknownAlbum = true;
            }

            // Track genres (and detect unknown)
            if (song.genre) {
                genres.add(song.genre);
            } else {
                hasUnknownGenre = true;
            }

            // Track categories
            if (song.category) {
                categories.add(song.category);
            }

            // Track file paths (all parent directories)
            const filepath = song.filepath || song.file || '';
            if (filepath) {
                const parts = filepath.split('/').filter(p => p);
                // Build all parent paths, e.g. '/Music/Jazz/Album' creates '/Music', '/Music/Jazz', '/Music/Jazz/Album'
                for (let i = 1; i <= parts.length; i++) {
                    paths.add('/' + parts.slice(0, i).join('/'));
                }
            }
        }

        offlineStore.state.offlineArtists = artists;
        offlineStore.state.offlineAlbums = albums;
        offlineStore.state.offlineGenres = genres;
        offlineStore.state.offlineCategories = categories;
        offlineStore.state.offlinePaths = paths;
        offlineStore.state.hasUnknownArtist = hasUnknownArtist;
        offlineStore.state.hasUnknownAlbum = hasUnknownAlbum;
        offlineStore.state.hasUnknownGenre = hasUnknownGenre;
    } catch (error) {
        console.error('[Offline Store] Failed to compute filter sets:', error);
    }
}

/**
 * Force reload the app with the new cached version.
 * This clears old caches and reloads to pick up new files.
 *
 * Important: This checks online status first to avoid breaking offline mode.
 * When the cache is cleared, we need network access to rebuild it.
 */
export async function forceReloadWithUpdate() {
    // Check if we're actually online - can't update while offline
    if (!navigator.onLine) {
        alert('Cannot update while offline. Please connect to the internet first.');
        return;
    }

    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.ready;

            if (registration.active) {
                // First, clear all cached files to force fresh fetch
                // This is necessary because update-cache only re-fetches if versions differ,
                // and Firefox's HTTP cache might be serving stale manifest
                registration.active.postMessage({ type: 'clear-cache' });

                // Give the SW time to clear the cache
                await new Promise(resolve => setTimeout(resolve, 200));

                // Now request fresh cache - SW will fetch all files from network
                registration.active.postMessage({ type: 'update-cache' });
            }

            // Clear the update flag
            offlineStore.state.updateAvailable = false;
            offlineStore.state.pendingVersion = null;

            // Reload the page - SW will re-fetch all files since cache is empty
            window.location.reload();
        } catch (e) {
            console.error('[Offline Store] Force reload failed:', e);
            // Fallback: just reload
            window.location.reload();
        }
    } else {
        window.location.reload();
    }
}

/**
 * Debug: dump cache contents to console
 */
export async function debugCache() {
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.ready;
            if (registration.active) {
                registration.active.postMessage({ type: 'debug-cache' });
            }
        } catch (e) {
            // Debug function - silent failure is ok
        }
    }
}

// Expose debug function to window for console access
if (typeof window !== 'undefined') {
    window.debugCache = debugCache;
}

// Export the store
export default offlineStore;

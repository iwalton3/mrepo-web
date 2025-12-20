/**
 * offline-audio.js - Audio blob management for offline playback
 *
 * Handles downloading, storing, and retrieving audio files from IndexedDB.
 */

import * as offlineDb from './offline-db.js';
import offlineStore, {
    addOfflineSong,
    removeOfflineSong,
    addOfflinePlaylist,
    removeOfflinePlaylist,
    setOfflineFolder,
    removeOfflineFolder,
    setDownloadProgress,
    refreshDiskUsage,
    computeOfflineFilterSets
} from './offline-store.js';
// Use raw API to avoid offline wrapper caching during downloads
import * as api from '../api/music-api.js';

/**
 * Formats that require server-side transcoding and cannot be cached offline
 */
const TRANSCODE_FORMATS = new Set([
    'mod', 'xm', 's3m', 'it', 'stm', 'med', 'mtm', 'ult', 'wow',
    '669', 'far', 'okt', 'ptm', 'dmf', 'dsm', 'amf', 'gdm', 'imf',
    'j2b', 'mdl', 'mt2', 'psm', 'umx'
]);

/**
 * MIME type mapping for audio formats
 */
const MIME_TYPES = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    webm: 'audio/webm',
    wma: 'audio/x-ms-wma'
};

/**
 * Get the stream URL for a song (same logic as music-api.js)
 */
function getStreamUrl(uuid, fileExt) {
    const config = window.MREPO_CONFIG || {};
    const STREAM_BASE = config.streamBase || '/stream/';

    if (fileExt) {
        const ext = fileExt.toLowerCase().replace(/^\./, '');
        return `${STREAM_BASE}${uuid}.${ext}`;
    }
    return `${STREAM_BASE}${uuid}`;
}

/**
 * Check if a format can be cached offline
 */
export function canCacheOffline(fileExt) {
    if (!fileExt) return false;
    const ext = fileExt.toLowerCase().replace(/^\./, '');
    return !TRANSCODE_FORMATS.has(ext);
}

/**
 * Download a single song and store it in IndexedDB
 * @param {Object} song - Song object with uuid and type
 * @param {number} [playlistId] - Associated playlist ID (for playlist downloads)
 * @param {AbortSignal} [abortSignal] - Abort signal for cancellation
 * @param {Object} [downloadSource] - Source of individual download
 *   { type: 'browse', path: '/Jazz/Miles Davis' }
 *   { type: 'partial-playlist', playlistName: 'My Playlist', playlistId: 123 }
 */
export async function downloadSong(song, playlistId = null, abortSignal = null, downloadSource = null) {
    const { uuid, type } = song;

    // Check if format can be cached
    if (!canCacheOffline(type)) {
        console.warn(`[Offline Audio] Cannot cache transcoded format: ${type}`);
        return { success: false, reason: 'transcode-required' };
    }

    // Check if already downloaded
    const exists = await offlineDb.hasAudioFile(uuid);
    if (exists) {
        // Just add the playlist reference if needed
        if (playlistId) {
            await offlineDb.addPlaylistToAudioFile(uuid, playlistId);
        }
        // Set download source for individual downloads (marks it as deliberately downloaded)
        if (downloadSource) {
            await offlineDb.setAudioFileDownloadSource(uuid, downloadSource);
            await offlineDb.setSongMetadataDownloadSource(uuid, downloadSource);
        }
        return { success: true, cached: true };
    }

    try {
        const url = getStreamUrl(uuid, type);
        const response = await fetch(url, { signal: abortSignal });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const ext = type.toLowerCase().replace(/^\./, '');
        const mimeType = MIME_TYPES[ext] || blob.type || 'audio/mpeg';

        // Save to IndexedDB
        const playlistIds = playlistId ? [playlistId] : [];
        await offlineDb.saveAudioFile(uuid, blob, mimeType, playlistIds, downloadSource);

        // Save song metadata
        await offlineDb.saveSongMetadata(song, playlistIds, downloadSource);

        // Update store
        addOfflineSong(uuid);

        return { success: true, cached: false, size: blob.size };
    } catch (error) {
        if (error.name === 'AbortError') {
            return { success: false, reason: 'aborted' };
        }
        console.error(`[Offline Audio] Failed to download ${uuid}:`, error);
        return { success: false, reason: 'error', error: error.message };
    }
}

/**
 * Delete a song from offline storage
 */
export async function deleteSong(uuid) {
    await offlineDb.deleteAudioFile(uuid);
    await offlineDb.deleteSongMetadata(uuid);
    removeOfflineSong(uuid);
    await refreshDiskUsage();
}

/**
 * Get a blob URL for offline playback
 * Returns null if song is not available offline
 */
export async function getAudioUrl(uuid) {
    const audioFile = await offlineDb.getAudioFile(uuid);
    if (!audioFile) {
        return null;
    }

    // Create blob URL
    return URL.createObjectURL(audioFile.blob);
}

/**
 * Revoke a blob URL (should be called when done with playback)
 */
export function revokeAudioUrl(blobUrl) {
    if (blobUrl && blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrl);
    }
}

/**
 * Check if a song is available offline
 */
export async function isAvailableOffline(uuid) {
    return offlineDb.hasAudioFile(uuid);
}

/**
 * Get all offline song UUIDs
 */
export async function getOfflineUuids() {
    return offlineDb.getAllOfflineUuids();
}

/**
 * Refresh metadata for all songs in an offline playlist.
 * Fetches updated song info from server and updates IndexedDB without re-downloading audio.
 */
export async function refreshPlaylistMetadata(playlistId, onProgress = null) {
    try {
        // Get the offline playlist
        const playlist = await offlineDb.getOfflinePlaylist(playlistId);
        if (!playlist) {
            return { success: false, reason: 'not-found' };
        }

        // Fetch fresh song data from server
        const songs = await fetchAllPlaylistSongs(playlistId);
        if (songs.length === 0) {
            return { success: true, updated: 0 };
        }

        // Update metadata for each song that we have offline
        const offlineUuids = await offlineDb.getAllOfflineUuids();
        let updated = 0;

        for (let i = 0; i < songs.length; i++) {
            const song = songs[i];

            // Only update if we have the audio file
            if (offlineUuids.has(song.uuid)) {
                // Get existing playlist associations
                const existing = await offlineDb.getSongMetadata(song.uuid);
                const playlistIds = existing?.playlistIds || [];

                // Make sure this playlist is in the list
                if (!playlistIds.includes(playlistId)) {
                    playlistIds.push(playlistId);
                }

                // Save updated metadata, preserving existing downloadSource
                await offlineDb.saveSongMetadata(song, playlistIds, existing?.downloadSource);
                updated++;
            }

            if (onProgress) {
                onProgress({ current: i + 1, total: songs.length, updated });
            }
        }

        return { success: true, updated, total: songs.length };
    } catch (error) {
        console.error('[Offline Audio] Metadata refresh failed:', error);
        return { success: false, reason: 'error', error: error.message };
    }
}

/**
 * Refresh metadata for ALL offline songs.
 * Fetches updated song info from server by UUID and updates IndexedDB.
 */
export async function refreshAllMetadata(onProgress = null) {
    try {
        const offlineUuids = await offlineDb.getAllOfflineUuids();
        const uuidArray = [...offlineUuids];

        if (uuidArray.length === 0) {
            return { success: true, updated: 0 };
        }

        let updated = 0;
        const batchSize = 100;  // Larger batches with bulk API

        for (let i = 0; i < uuidArray.length; i += batchSize) {
            const batch = uuidArray.slice(i, i + batchSize);

            // Bulk fetch song details
            let songs = [];
            try {
                songs = await api.songs.getBulk(batch);
            } catch (e) {
                console.error('[Offline Audio] Bulk fetch failed for batch:', e);
                continue;
            }

            for (const song of songs) {
                if (song && song.uuid) {
                    // Get existing playlist associations
                    const existing = await offlineDb.getSongMetadata(song.uuid);
                    const playlistIds = existing?.playlistIds || [];

                    // Save updated metadata, preserving existing downloadSource
                    await offlineDb.saveSongMetadata(song, playlistIds, existing?.downloadSource);
                    updated++;
                }
            }

            if (onProgress) {
                onProgress({ current: Math.min(i + batchSize, uuidArray.length), total: uuidArray.length, updated });
            }
        }

        return { success: true, updated, total: uuidArray.length };
    } catch (error) {
        console.error('[Offline Audio] Full metadata refresh failed:', error);
        return { success: false, reason: 'error', error: error.message };
    }
}

/**
 * Fetch all songs from a playlist using batched requests (bypasses 1000 item limit)
 */
async function fetchAllPlaylistSongs(playlistId) {
    const songs = [];
    let cursor = null;
    const batchSize = 500;

    do {
        const result = await api.playlists.getSongs(playlistId, { cursor, limit: batchSize });
        const items = Array.isArray(result) ? result : (result.items || result.songs || []);
        songs.push(...items);
        cursor = result.nextCursor;
    } while (cursor);

    return songs;
}

/**
 * Download an entire playlist for offline use (or update an existing one)
 */
export async function downloadPlaylist(playlistId, onProgress = null) {
    // Create abort controller for cancellation
    const abortController = new AbortController();
    let cancelled = false;

    // Store reference for cancellation
    currentDownload = {
        playlistId,
        abort: () => {
            cancelled = true;
            abortController.abort();
        }
    };

    try {
        // Fetch all playlist songs using batched requests
        const songs = await fetchAllPlaylistSongs(playlistId);

        if (songs.length === 0) {
            throw new Error('Playlist is empty');
        }

        // Get playlist metadata
        const playlistListResult = await api.playlists.list();
        // Handle different response formats
        const playlistList = Array.isArray(playlistListResult) ? playlistListResult :
            (playlistListResult.playlists || playlistListResult.items || []);
        const playlist = playlistList.find(p => p.id === playlistId);
        const playlistName = playlist?.name || `Playlist ${playlistId}`;

        // Filter out songs that can't be cached
        const downloadableSongs = songs.filter(s => canCacheOffline(s.type));
        const skippedCount = songs.length - downloadableSongs.length;

        // Check which songs are already downloaded
        const existingPlaylist = await offlineDb.getOfflinePlaylist(playlistId);
        const alreadyDownloaded = new Set();
        if (existingPlaylist) {
            for (const uuid of existingPlaylist.songUuids) {
                if (await offlineDb.hasAudioFile(uuid)) {
                    alreadyDownloaded.add(uuid);
                }
            }
        }

        // Filter to only songs that need downloading
        const songsToDownload = downloadableSongs.filter(s => !alreadyDownloaded.has(s.uuid));

        // Initialize progress
        const total = downloadableSongs.length;
        const toDownload = songsToDownload.length;
        let downloaded = alreadyDownloaded.size;
        let totalSize = existingPlaylist?.totalSize || 0;
        const errors = [];

        // Update progress in store
        setDownloadProgress({
            playlistId,
            playlistName,
            current: downloaded,
            total,
            currentSongName: songsToDownload[0]?.title || ''
        });

        // Save/update playlist record with full song list
        await offlineDb.saveOfflinePlaylist({
            id: playlistId,
            name: playlistName,
            description: playlist?.description || '',
            songUuids: downloadableSongs.map(s => s.uuid),
            totalSize,
            downloadedCount: downloaded,
            totalCount: total,
            isComplete: toDownload === 0
        });
        addOfflinePlaylist(playlistId);

        // Download only the missing songs
        for (let i = 0; i < songsToDownload.length; i++) {
            if (cancelled) {
                throw new Error('Download cancelled');
            }

            const song = songsToDownload[i];

            // Update progress
            setDownloadProgress({
                playlistId,
                playlistName,
                current: downloaded,
                total,
                currentSongName: song.title
            });

            if (onProgress) {
                onProgress({
                    current: downloaded,
                    total,
                    song: song.title,
                    artist: song.artist
                });
            }

            // Download song
            const result = await downloadSong(song, playlistId, abortController.signal);

            if (result.success) {
                downloaded++;
                if (result.size) {
                    totalSize += result.size;
                }
            } else if (result.reason !== 'aborted') {
                errors.push({ song: song.title, reason: result.reason });
            }

            // Update playlist progress
            await offlineDb.updateOfflinePlaylistProgress(playlistId, downloaded, totalSize);
        }

        // Mark complete
        await offlineDb.updateOfflinePlaylistProgress(playlistId, downloaded, totalSize);

        // Clear progress
        setDownloadProgress(null);
        await refreshDiskUsage();

        currentDownload = null;

        return {
            success: true,
            downloaded: toDownload,
            alreadyCached: alreadyDownloaded.size,
            total,
            totalSize,
            skipped: skippedCount,
            errors
        };

    } catch (error) {
        setDownloadProgress(null);
        currentDownload = null;

        if (error.message === 'Download cancelled') {
            return { success: false, reason: 'cancelled' };
        }

        console.error('[Offline Audio] Playlist download failed:', error);
        return { success: false, reason: 'error', error: error.message };
    }
}

/**
 * Update/sync an offline playlist - downloads new songs, updates song list
 * This is an alias for downloadPlaylist which now handles updates automatically
 */
export async function updateOfflinePlaylist(playlistId, onProgress = null) {
    return downloadPlaylist(playlistId, onProgress);
}

// Track current download for cancellation
let currentDownload = null;

/**
 * Cancel the current playlist download
 */
export function cancelDownload() {
    if (currentDownload) {
        currentDownload.abort();
        return true;
    }
    return false;
}

/**
 * Get the current download status
 */
export function getDownloadStatus() {
    return currentDownload ? {
        playlistId: currentDownload.playlistId,
        inProgress: true
    } : null;
}

/**
 * Delete an offline playlist and optionally its orphaned audio files
 */
export async function deleteOfflinePlaylist(playlistId, removeOrphanedAudio = true) {
    // Get playlist songs
    const playlist = await offlineDb.getOfflinePlaylist(playlistId);
    if (!playlist) {
        return { success: false, reason: 'not-found' };
    }

    // Remove playlist reference from audio files
    for (const uuid of playlist.songUuids) {
        await offlineDb.removePlaylistFromAudioFile(uuid, playlistId);
    }

    // Delete playlist record
    await offlineDb.deleteOfflinePlaylist(playlistId);
    removeOfflinePlaylist(playlistId);

    // Optionally remove orphaned audio files
    let removedCount = 0;
    if (removeOrphanedAudio) {
        const orphans = await offlineDb.getOrphanedAudioFiles();
        for (const uuid of orphans) {
            await deleteSong(uuid);
            removedCount++;
        }
    }

    await refreshDiskUsage();

    return {
        success: true,
        removedSongs: removedCount
    };
}

/**
 * Get storage used by a specific playlist
 */
export async function getPlaylistStorageSize(playlistId) {
    const playlist = await offlineDb.getOfflinePlaylist(playlistId);
    return playlist?.totalSize || 0;
}

/**
 * Get all offline playlist info
 */
export async function getOfflinePlaylists() {
    return offlineDb.getAllOfflinePlaylists();
}

/**
 * Check if a playlist is available offline
 */
export async function isPlaylistOffline(playlistId) {
    const playlist = await offlineDb.getOfflinePlaylist(playlistId);
    return playlist !== null;
}

/**
 * Clean up orphaned audio files (not in any playlist)
 */
export async function cleanupOrphanedFiles() {
    const orphans = await offlineDb.getOrphanedAudioFiles();
    let removedCount = 0;
    let freedBytes = 0;

    for (const uuid of orphans) {
        const file = await offlineDb.getAudioFile(uuid);
        if (file) {
            freedBytes += file.size;
        }
        await deleteSong(uuid);
        removedCount++;
    }

    return { removedCount, freedBytes };
}

/**
 * Get estimated storage available
 */
export async function getStorageInfo() {
    const estimate = await offlineDb.getStorageEstimate();
    const usage = await offlineDb.getDiskUsage();

    return {
        estimate,
        usage,
        canStore: estimate ? estimate.available > 0 : true
    };
}

// Track current folder download for cancellation
let currentFolderDownload = null;

/**
 * Download all songs in a folder (VFS path)
 * Uses songs.byPath() API which returns full song objects with proper type field.
 * Shows progress using the same mechanism as playlist downloads.
 */
export async function downloadFolder(path, folderName = null) {
    // Create abort controller for cancellation
    const abortController = new AbortController();
    let cancelled = false;

    // Store reference for cancellation
    currentFolderDownload = {
        path,
        abort: () => {
            cancelled = true;
            abortController.abort();
        }
    };

    const displayName = folderName || path.split('/').filter(p => p).pop() || 'Root';
    const folderId = 'path:' + path;

    try {
        // First, fetch all songs using songs.byPath() API
        // This returns full song objects with proper type field (mp3, flac, etc.)
        setDownloadProgress({
            playlistId: folderId,
            playlistName: displayName,
            current: 0,
            total: 0,
            currentSongName: 'Fetching songs...'
        });

        const allSongs = [];
        let cursor = null;
        do {
            const result = await api.songs.byPath(path, { cursor, limit: 500 });
            allSongs.push(...(result.items || []));
            cursor = result.nextCursor;
        } while (cursor);

        if (allSongs.length === 0) {
            setDownloadProgress(null);
            currentFolderDownload = null;
            return { success: true, downloaded: 0, total: 0, message: 'No songs found in folder' };
        }

        // Filter to downloadable songs (not transcode-required)
        const downloadableSongs = allSongs.filter(s => canCacheOffline(s.type));
        const skippedCount = allSongs.length - downloadableSongs.length;

        // Filter to songs not already downloaded
        const songsToDownload = [];
        for (const song of downloadableSongs) {
            if (!offlineStore.state.offlineSongUuids.has(song.uuid)) {
                songsToDownload.push(song);
            }
        }

        const total = downloadableSongs.length;
        const toDownload = songsToDownload.length;
        let downloaded = downloadableSongs.length - toDownload;
        let totalSize = 0;
        const errors = [];
        const downloadedUuids = [];

        // Update progress
        setDownloadProgress({
            playlistId: folderId,
            playlistName: displayName,
            current: downloaded,
            total,
            currentSongName: songsToDownload[0]?.title || ''
        });

        // Download songs
        for (const song of songsToDownload) {
            if (cancelled) {
                throw new Error('Download cancelled');
            }

            // Update progress
            setDownloadProgress({
                playlistId: folderId,
                playlistName: displayName,
                current: downloaded,
                total,
                currentSongName: song.title || 'Unknown'
            });

            const result = await downloadSong(song, null, abortController.signal);

            if (result.success) {
                downloaded++;
                downloadedUuids.push(song.uuid);
                if (result.size) {
                    totalSize += result.size;
                }
            } else if (result.reason === 'aborted') {
                throw new Error('Download cancelled');
            } else {
                errors.push({ uuid: song.uuid, error: result.error || result.reason });
            }
        }

        // Clear progress
        setDownloadProgress(null);
        await refreshDiskUsage();
        currentFolderDownload = null;

        // Track this folder download if any songs were downloaded or already cached
        if (downloadableSongs.length > 0) {
            const folderRecord = {
                id: folderId,
                type: 'path',
                path: path,
                filters: null,
                name: displayName,
                songUuids: downloadableSongs.map(s => s.uuid),
                totalSize: totalSize,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            await offlineDb.saveOfflineFolder(folderRecord);
            setOfflineFolder(folderRecord);

            // Add folder reference to all audio files
            for (const song of downloadableSongs) {
                await offlineDb.addFolderToAudioFile(song.uuid, folderId);
            }
        }

        return {
            success: true,
            downloaded: toDownload - errors.length,
            alreadyCached: downloadableSongs.length - toDownload,
            total,
            totalSize,
            skipped: skippedCount,
            errors
        };

    } catch (error) {
        setDownloadProgress(null);
        currentFolderDownload = null;

        if (error.message === 'Download cancelled') {
            return { success: false, reason: 'cancelled' };
        }

        console.error('[Offline Audio] Folder download failed:', error);
        return { success: false, reason: 'error', error: error.message };
    }
}

/**
 * Cancel the current folder download
 */
export function cancelFolderDownload() {
    if (currentFolderDownload) {
        currentFolderDownload.abort();
        return true;
    }
    return false;
}

// Track current hierarchy download for cancellation
let currentFilterDownload = null;

/**
 * Download all songs matching hierarchy filters (category/genre/artist/album)
 * Uses songs.byFilter() API which returns full song objects with proper type field.
 * Shows progress using the same mechanism as playlist downloads.
 */
export async function downloadByFilter(filters, displayName = null) {
    // Create abort controller for cancellation
    const abortController = new AbortController();
    let cancelled = false;

    // Store reference for cancellation
    currentFilterDownload = {
        filters,
        abort: () => {
            cancelled = true;
            abortController.abort();
        }
    };

    // Build display name from filters if not provided
    const name = displayName || buildFilterDisplayName(filters);
    const filterId = 'filter:' + JSON.stringify(filters);

    try {
        // First, fetch all songs using songs.byFilter() API
        setDownloadProgress({
            playlistId: filterId,
            playlistName: name,
            current: 0,
            total: 0,
            currentSongName: 'Fetching songs...'
        });

        const allSongs = [];
        let cursor = null;
        do {
            const result = await api.songs.byFilter({
                category: filters.category,
                genre: filters.genre,
                artist: filters.artist,
                album: filters.album,
                cursor,
                limit: 500
            });
            allSongs.push(...(result.items || []));
            cursor = result.nextCursor;
        } while (cursor);

        if (allSongs.length === 0) {
            setDownloadProgress(null);
            currentFilterDownload = null;
            return { success: true, downloaded: 0, total: 0, message: 'No songs found' };
        }

        // Filter to downloadable songs (not transcode-required)
        const downloadableSongs = allSongs.filter(s => canCacheOffline(s.type));
        const skippedCount = allSongs.length - downloadableSongs.length;

        // Filter to songs not already downloaded
        const songsToDownload = [];
        for (const song of downloadableSongs) {
            if (!offlineStore.state.offlineSongUuids.has(song.uuid)) {
                songsToDownload.push(song);
            }
        }

        const total = downloadableSongs.length;
        const toDownload = songsToDownload.length;
        let downloaded = downloadableSongs.length - toDownload;
        let totalSize = 0;
        const errors = [];

        // Update progress
        setDownloadProgress({
            playlistId: filterId,
            playlistName: name,
            current: downloaded,
            total,
            currentSongName: songsToDownload[0]?.title || ''
        });

        // Download songs
        for (const song of songsToDownload) {
            if (cancelled) {
                throw new Error('Download cancelled');
            }

            // Update progress
            setDownloadProgress({
                playlistId: filterId,
                playlistName: name,
                current: downloaded,
                total,
                currentSongName: song.title || 'Unknown'
            });

            const result = await downloadSong(song, null, abortController.signal);

            if (result.success) {
                downloaded++;
                if (result.size) {
                    totalSize += result.size;
                }
            } else if (result.reason === 'aborted') {
                throw new Error('Download cancelled');
            } else {
                errors.push({ uuid: song.uuid, error: result.error || result.reason });
            }
        }

        // Clear progress
        setDownloadProgress(null);
        await refreshDiskUsage();
        currentFilterDownload = null;

        // Track this filter download if any songs were downloaded or already cached
        if (downloadableSongs.length > 0) {
            const folderRecord = {
                id: filterId,
                type: 'filter',
                path: null,
                filters: filters,
                name: name,
                songUuids: downloadableSongs.map(s => s.uuid),
                totalSize: totalSize,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            await offlineDb.saveOfflineFolder(folderRecord);
            setOfflineFolder(folderRecord);

            // Add folder reference to all audio files
            for (const song of downloadableSongs) {
                await offlineDb.addFolderToAudioFile(song.uuid, filterId);
            }
        }

        return {
            success: true,
            downloaded: toDownload - errors.length,
            alreadyCached: downloadableSongs.length - toDownload,
            total,
            totalSize,
            skipped: skippedCount,
            errors
        };

    } catch (error) {
        setDownloadProgress(null);
        currentFilterDownload = null;

        if (error.message === 'Download cancelled') {
            return { success: false, reason: 'cancelled' };
        }

        console.error('[Offline Audio] Filter download failed:', error);
        return { success: false, reason: 'error', error: error.message };
    }
}

/**
 * Build a display name from filter values
 */
function buildFilterDisplayName(filters) {
    const parts = [];
    if (filters.category) parts.push(filters.category);
    if (filters.genre) parts.push(filters.genre);
    if (filters.artist) parts.push(filters.artist);
    if (filters.album) parts.push(filters.album);
    return parts.join(' / ') || 'All Songs';
}

/**
 * Cancel the current filter download
 */
export function cancelFilterDownload() {
    if (currentFilterDownload) {
        currentFilterDownload.abort();
        return true;
    }
    return false;
}

/**
 * Get all offline folders (both path-based and filter-based downloads)
 */
export async function getOfflineFolders() {
    return offlineDb.getAllOfflineFolders();
}

/**
 * Delete an offline folder download and optionally remove orphaned audio files.
 * Works for both path-based (VFS) and filter-based (hierarchy) downloads.
 */
export async function deleteOfflineFolderDownload(folderId, removeOrphanedAudio = true) {
    // Get folder record
    const folder = await offlineDb.getOfflineFolder(folderId);
    if (!folder) {
        return { success: false, reason: 'not-found' };
    }

    // Remove folder reference from audio files
    for (const uuid of folder.songUuids) {
        await offlineDb.removeFolderFromAudioFile(uuid, folderId);
    }

    // Delete folder record
    await offlineDb.deleteOfflineFolder(folderId);
    removeOfflineFolder(folderId);

    // Optionally remove orphaned audio files (not in any playlist or folder)
    let removedCount = 0;
    if (removeOrphanedAudio) {
        const orphans = await offlineDb.getOrphanedAudioFiles();
        for (const uuid of orphans) {
            await deleteSong(uuid);
            removedCount++;
        }
    }

    await refreshDiskUsage();
    await computeOfflineFilterSets();

    return {
        success: true,
        removedSongs: removedCount
    };
}

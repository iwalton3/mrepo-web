/**
 * offline-db.js - IndexedDB wrapper for offline music player storage
 *
 * Manages all offline data: audio files, playlists, metadata, queue, settings, favorites
 */

const DB_NAME = 'music-player-offline';
const DB_VERSION = 2;

// Store names
const STORES = {
    AUDIO_FILES: 'audio-files',
    OFFLINE_PLAYLISTS: 'offline-playlists',
    OFFLINE_FOLDERS: 'offline-folders',
    SONG_METADATA: 'song-metadata',
    QUEUE_CACHE: 'queue-cache',
    SETTINGS_CACHE: 'settings-cache',
    FAVORITES_CACHE: 'favorites-cache',
    PENDING_WRITES: 'pending-writes',
    DISK_USAGE: 'disk-usage'
};

let dbInstance = null;
let dbPromise = null;

/**
 * Open the database, creating stores if needed
 */
export function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('Failed to open IndexedDB:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            dbInstance = request.result;
            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Audio files store
            if (!db.objectStoreNames.contains(STORES.AUDIO_FILES)) {
                const audioStore = db.createObjectStore(STORES.AUDIO_FILES, { keyPath: 'uuid' });
                audioStore.createIndex('playlistId', 'playlistIds', { multiEntry: true });
                audioStore.createIndex('downloadedAt', 'downloadedAt');
                audioStore.createIndex('lastAccessedAt', 'lastAccessedAt');
            }

            // Offline playlists store
            if (!db.objectStoreNames.contains(STORES.OFFLINE_PLAYLISTS)) {
                const playlistStore = db.createObjectStore(STORES.OFFLINE_PLAYLISTS, { keyPath: 'id' });
                playlistStore.createIndex('downloadedAt', 'downloadedAt');
                playlistStore.createIndex('name', 'name');
            }

            // Song metadata store
            if (!db.objectStoreNames.contains(STORES.SONG_METADATA)) {
                const metadataStore = db.createObjectStore(STORES.SONG_METADATA, { keyPath: 'uuid' });
                metadataStore.createIndex('artist', 'artist');
                metadataStore.createIndex('album', 'album');
                metadataStore.createIndex('playlistId', 'playlistIds', { multiEntry: true });
            }

            // Queue cache store (single record with key 'current')
            if (!db.objectStoreNames.contains(STORES.QUEUE_CACHE)) {
                db.createObjectStore(STORES.QUEUE_CACHE, { keyPath: 'id' });
            }

            // Settings cache store
            if (!db.objectStoreNames.contains(STORES.SETTINGS_CACHE)) {
                db.createObjectStore(STORES.SETTINGS_CACHE, { keyPath: 'key' });
            }

            // Favorites cache store
            if (!db.objectStoreNames.contains(STORES.FAVORITES_CACHE)) {
                db.createObjectStore(STORES.FAVORITES_CACHE, { keyPath: 'uuid' });
            }

            // Pending writes queue
            if (!db.objectStoreNames.contains(STORES.PENDING_WRITES)) {
                const pendingStore = db.createObjectStore(STORES.PENDING_WRITES, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                pendingStore.createIndex('createdAt', 'createdAt');
                pendingStore.createIndex('type', 'type');
            }

            // Disk usage tracking
            if (!db.objectStoreNames.contains(STORES.DISK_USAGE)) {
                db.createObjectStore(STORES.DISK_USAGE, { keyPath: 'category' });
            }

            // Offline folders store (for tracking downloaded folders/hierarchies)
            if (!db.objectStoreNames.contains(STORES.OFFLINE_FOLDERS)) {
                const foldersStore = db.createObjectStore(STORES.OFFLINE_FOLDERS, { keyPath: 'id' });
                foldersStore.createIndex('type', 'type');
                foldersStore.createIndex('createdAt', 'createdAt');
            }
        };
    });

    return dbPromise;
}

/**
 * Get the database instance
 */
async function getDb() {
    if (dbInstance) return dbInstance;
    return openDatabase();
}

/**
 * Close the database connection
 */
export function closeDatabase() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
        dbPromise = null;
    }
}

// =============================================================================
// Audio Files
// =============================================================================

/**
 * Save an audio file blob
 * @param {string} uuid - Song UUID
 * @param {Blob} blob - Audio file blob
 * @param {string} mimeType - MIME type
 * @param {number[]} playlistIds - Associated playlist IDs
 * @param {Object} [downloadSource] - Source of individual download
 *   { type: 'browse', path: '/Jazz/Miles Davis' }
 *   { type: 'partial-playlist', playlistName: 'My Playlist', playlistId: 123 }
 */
export async function saveAudioFile(uuid, blob, mimeType, playlistIds = [], downloadSource = null) {
    const db = await getDb();
    const size = blob.size;

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORES.AUDIO_FILES, STORES.DISK_USAGE], 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);

        const record = {
            uuid,
            blob,
            mimeType,
            size,
            playlistIds,
            downloadedAt: Date.now(),
            lastAccessedAt: Date.now()
        };

        // Add downloadSource if provided (for individual downloads)
        if (downloadSource) {
            record.downloadSource = downloadSource;
        }

        const request = store.put(record);

        request.onsuccess = async () => {
            // Update disk usage
            await updateDiskUsage('audio', size, 1);
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get an audio file by UUID
 */
export async function getAudioFile(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readonly');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                // Update last accessed time in background
                updateAudioLastAccessed(uuid);
                resolve({
                    blob: record.blob,
                    mimeType: record.mimeType,
                    size: record.size
                });
            } else {
                resolve(null);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Update last accessed timestamp for an audio file
 */
async function updateAudioLastAccessed(uuid) {
    const db = await getDb();

    return new Promise((resolve) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.lastAccessedAt = Date.now();
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => resolve();
    });
}

/**
 * Delete an audio file
 */
export async function deleteAudioFile(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORES.AUDIO_FILES, STORES.DISK_USAGE], 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);

        // First get the file to know its size
        const getRequest = store.get(uuid);
        getRequest.onsuccess = async () => {
            const record = getRequest.result;
            if (record) {
                const deleteRequest = store.delete(uuid);
                deleteRequest.onsuccess = async () => {
                    await updateDiskUsage('audio', -record.size, -1);
                    resolve(true);
                };
                deleteRequest.onerror = () => reject(deleteRequest.error);
            } else {
                resolve(false);
            }
        };
        getRequest.onerror = () => reject(getRequest.error);
    });
}

/**
 * Check if an audio file exists offline
 */
export async function hasAudioFile(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readonly');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.count(IDBKeyRange.only(uuid));

        request.onsuccess = () => resolve(request.result > 0);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all offline song UUIDs
 */
export async function getAllOfflineUuids() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readonly');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.getAllKeys();

        request.onsuccess = () => resolve(new Set(request.result));
        request.onerror = () => reject(request.error);
    });
}

/**
 * Add playlist ID to an audio file's playlistIds array
 */
export async function addPlaylistToAudioFile(uuid, playlistId) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                if (!record.playlistIds.includes(playlistId)) {
                    record.playlistIds.push(playlistId);
                    store.put(record);
                }
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Remove playlist ID from an audio file's playlistIds array
 */
export async function removePlaylistFromAudioFile(uuid, playlistId) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.playlistIds = record.playlistIds.filter(id => id !== playlistId);
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Add folder ID to an audio file's folderIds array
 */
export async function addFolderToAudioFile(uuid, folderId) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                // Initialize folderIds if not present (backwards compatibility)
                if (!record.folderIds) record.folderIds = [];
                if (!record.folderIds.includes(folderId)) {
                    record.folderIds.push(folderId);
                    store.put(record);
                }
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Remove folder ID from an audio file's folderIds array
 */
export async function removeFolderFromAudioFile(uuid, folderId) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.folderIds = (record.folderIds || []).filter(id => id !== folderId);
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Set download source on an existing audio file (for individual downloads)
 */
export async function setAudioFileDownloadSource(uuid, downloadSource) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readwrite');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.downloadSource = downloadSource;
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Set download source on existing song metadata (for individual downloads)
 */
export async function setSongMetadataDownloadSource(uuid, downloadSource) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readwrite');
        const store = tx.objectStore(STORES.SONG_METADATA);
        const request = store.get(uuid);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.downloadSource = downloadSource;
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get audio files that are orphaned (not in any playlist, folder, or individual download)
 * Excludes files with downloadSource since those were deliberately downloaded
 */
export async function getOrphanedAudioFiles() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readonly');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.getAll();

        request.onsuccess = () => {
            const orphans = request.result.filter(r => {
                const noPlaylists = !r.playlistIds || r.playlistIds.length === 0;
                const noFolders = !r.folderIds || r.folderIds.length === 0;
                const noDownloadSource = !r.downloadSource;  // Exclude individual downloads
                return noPlaylists && noFolders && noDownloadSource;
            });
            resolve(orphans.map(r => r.uuid));
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get individually downloaded files (files with downloadSource but no playlist/folder)
 * Returns full records with downloadSource info for grouping in UI
 */
export async function getIndividuallyDownloadedFiles() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.AUDIO_FILES, 'readonly');
        const store = tx.objectStore(STORES.AUDIO_FILES);
        const request = store.getAll();

        request.onsuccess = () => {
            const individual = request.result.filter(r => {
                const noPlaylists = !r.playlistIds || r.playlistIds.length === 0;
                const noFolders = !r.folderIds || r.folderIds.length === 0;
                const hasDownloadSource = !!r.downloadSource;
                return noPlaylists && noFolders && hasDownloadSource;
            });
            resolve(individual);
        };
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Offline Playlists
// =============================================================================

/**
 * Save an offline playlist
 */
export async function saveOfflinePlaylist(playlist) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_PLAYLISTS, 'readwrite');
        const store = tx.objectStore(STORES.OFFLINE_PLAYLISTS);

        const record = {
            id: playlist.id,
            name: playlist.name,
            description: playlist.description || '',
            songUuids: playlist.songUuids || [],
            totalSize: playlist.totalSize || 0,
            downloadedCount: playlist.downloadedCount || 0,
            totalCount: playlist.totalCount || 0,
            downloadedAt: playlist.downloadedAt || Date.now(),
            isComplete: playlist.isComplete || false
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get an offline playlist by ID
 */
export async function getOfflinePlaylist(id) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_PLAYLISTS, 'readonly');
        const store = tx.objectStore(STORES.OFFLINE_PLAYLISTS);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all offline playlists
 */
export async function getAllOfflinePlaylists() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_PLAYLISTS, 'readonly');
        const store = tx.objectStore(STORES.OFFLINE_PLAYLISTS);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete an offline playlist
 */
export async function deleteOfflinePlaylist(id) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_PLAYLISTS, 'readwrite');
        const store = tx.objectStore(STORES.OFFLINE_PLAYLISTS);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Update offline playlist download progress
 */
export async function updateOfflinePlaylistProgress(id, downloadedCount, totalSize) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_PLAYLISTS, 'readwrite');
        const store = tx.objectStore(STORES.OFFLINE_PLAYLISTS);
        const request = store.get(id);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.downloadedCount = downloadedCount;
                record.totalSize = totalSize;
                record.isComplete = downloadedCount >= record.totalCount;
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Song Metadata
// =============================================================================

/**
 * Save song metadata
 * @param {Object} song - Song object with metadata
 * @param {number[]} playlistIds - Associated playlist IDs
 * @param {Object} [downloadSource] - Source of individual download
 */
export async function saveSongMetadata(song, playlistIds = [], downloadSource = null) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readwrite');
        const store = tx.objectStore(STORES.SONG_METADATA);

        const record = {
            uuid: song.uuid,
            title: song.title,
            artist: song.artist,
            album: song.album,
            duration_seconds: song.duration_seconds,
            type: song.type,
            track_number: song.track_number,
            disc_number: song.disc_number,
            category: song.category,
            genre: song.genre,
            replay_gain_track: song.replay_gain_track,
            replay_gain_album: song.replay_gain_album,
            // Store file path for offline browsing (VFS path preferred)
            filepath: song.virtual_file || song.file || '',
            playlistIds,
            cachedAt: Date.now()
        };

        // Add downloadSource if provided (for individual downloads)
        if (downloadSource) {
            record.downloadSource = downloadSource;
        }

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get song metadata by UUID
 */
export async function getSongMetadata(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readonly');
        const store = tx.objectStore(STORES.SONG_METADATA);
        const request = store.get(uuid);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get multiple song metadata by UUIDs
 */
export async function getSongsMetadata(uuids) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readonly');
        const store = tx.objectStore(STORES.SONG_METADATA);
        const results = [];
        let pending = uuids.length;

        if (pending === 0) {
            resolve([]);
            return;
        }

        for (const uuid of uuids) {
            const request = store.get(uuid);
            request.onsuccess = () => {
                if (request.result) {
                    results.push(request.result);
                } else {
                    // Return placeholder for unavailable song (no cached metadata)
                    results.push({ uuid, unavailable: true });
                }
                pending--;
                if (pending === 0) {
                    resolve(results);
                }
            };
            request.onerror = () => {
                // Return placeholder on error too
                results.push({ uuid, unavailable: true });
                pending--;
                if (pending === 0) {
                    resolve(results);
                }
            };
        }
    });
}

/**
 * Delete song metadata
 */
export async function deleteSongMetadata(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readwrite');
        const store = tx.objectStore(STORES.SONG_METADATA);
        const request = store.delete(uuid);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all song metadata
 */
export async function getAllSongMetadata() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readonly');
        const store = tx.objectStore(STORES.SONG_METADATA);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Search song metadata in IndexedDB (for offline search)
 * Simple text search on title, artist, album, filename, and filepath
 */
export async function searchOfflineSongs(query) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SONG_METADATA, 'readonly');
        const store = tx.objectStore(STORES.SONG_METADATA);
        const request = store.getAll();

        request.onsuccess = () => {
            const allSongs = request.result;
            const queryLower = query.toLowerCase();

            // Text search on title, artist, album, filename, and filepath
            const results = allSongs.filter(song => {
                const title = (song.title || '').toLowerCase();
                const artist = (song.artist || '').toLowerCase();
                const album = (song.album || '').toLowerCase();
                const filepath = (song.filepath || song.file || '').toLowerCase();
                const filename = filepath.split('/').pop() || '';
                return title.includes(queryLower) ||
                       artist.includes(queryLower) ||
                       album.includes(queryLower) ||
                       filename.includes(queryLower) ||
                       filepath.includes(queryLower);
            });

            // Sort by relevance (title matches first, then artist, then album)
            results.sort((a, b) => {
                const aTitle = (a.title || '').toLowerCase().includes(queryLower);
                const bTitle = (b.title || '').toLowerCase().includes(queryLower);
                if (aTitle !== bTitle) return bTitle - aTitle;
                return 0;
            });

            resolve(results);
        };
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Queue Cache
// =============================================================================

/**
 * Save queue state
 */
export async function saveQueueCache(queueData) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.QUEUE_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.QUEUE_CACHE);

        const record = {
            id: 'current',
            items: queueData.items || [],
            queueIndex: queueData.queueIndex || 0,
            scaEnabled: queueData.scaEnabled || false,
            playMode: queueData.playMode || 'sequential',
            lastSyncedAt: queueData.lastSyncedAt || Date.now(),
            localTimestamp: Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get cached queue state
 */
export async function getQueueCache() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.QUEUE_CACHE, 'readonly');
        const store = tx.objectStore(STORES.QUEUE_CACHE);
        const request = store.get('current');

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Temp Queue (local-only queue that doesn't sync)
// =============================================================================

/**
 * Save temp queue state (both the temp queue and the saved original queue)
 */
export async function saveTempQueueState(tempQueue, savedQueue = null) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.QUEUE_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.QUEUE_CACHE);

        // Save temp queue
        const tempRecord = {
            id: 'temp-queue',
            items: tempQueue.items || [],
            queueIndex: tempQueue.queueIndex || 0,
            shuffle: tempQueue.shuffle || false,
            repeatMode: tempQueue.repeatMode || 'none',
            localTimestamp: Date.now()
        };
        store.put(tempRecord);

        // Save original queue if provided (only on first enter)
        if (savedQueue) {
            const savedRecord = {
                id: 'temp-queue-saved',
                items: savedQueue.items || [],
                queueIndex: savedQueue.queueIndex || 0,
                scaEnabled: savedQueue.scaEnabled || false,
                playMode: savedQueue.playMode || 'sequential',
                localTimestamp: Date.now()
            };
            store.put(savedRecord);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get temp queue state (returns both temp queue and saved original)
 */
export async function getTempQueueState() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.QUEUE_CACHE, 'readonly');
        const store = tx.objectStore(STORES.QUEUE_CACHE);

        const tempRequest = store.get('temp-queue');
        const savedRequest = store.get('temp-queue-saved');

        let tempQueue = null;
        let savedQueue = null;

        tempRequest.onsuccess = () => {
            tempQueue = tempRequest.result || null;
        };

        savedRequest.onsuccess = () => {
            savedQueue = savedRequest.result || null;
        };

        tx.oncomplete = () => resolve({ tempQueue, savedQueue });
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Clear temp queue state (when exiting temp queue mode)
 */
export async function clearTempQueueState() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.QUEUE_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.QUEUE_CACHE);

        store.delete('temp-queue');
        store.delete('temp-queue-saved');

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// =============================================================================
// Settings Cache
// =============================================================================

/**
 * Save a setting
 */
export async function saveSetting(key, value) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SETTINGS_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.SETTINGS_CACHE);

        const record = {
            key,
            value,
            lastSyncedAt: Date.now(),
            localTimestamp: Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get a setting
 */
export async function getSetting(key) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SETTINGS_CACHE, 'readonly');
        const store = tx.objectStore(STORES.SETTINGS_CACHE);
        const request = store.get(key);

        request.onsuccess = () => {
            const record = request.result;
            resolve(record ? record.value : null);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get a setting with metadata
 */
export async function getSettingWithMeta(key) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SETTINGS_CACHE, 'readonly');
        const store = tx.objectStore(STORES.SETTINGS_CACHE);
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Favorites Cache
// =============================================================================

/**
 * Save favorites set
 */
export async function setFavorites(uuids) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.FAVORITES_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.FAVORITES_CACHE);

        // Clear existing and add new
        store.clear();
        for (const uuid of uuids) {
            store.put({ uuid });
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get all favorites
 */
export async function getFavorites() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.FAVORITES_CACHE, 'readonly');
        const store = tx.objectStore(STORES.FAVORITES_CACHE);
        const request = store.getAllKeys();

        request.onsuccess = () => resolve(new Set(request.result));
        request.onerror = () => reject(request.error);
    });
}

/**
 * Add a favorite
 */
export async function addFavorite(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.FAVORITES_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.FAVORITES_CACHE);
        const request = store.put({ uuid });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Remove a favorite
 */
export async function removeFavorite(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.FAVORITES_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.FAVORITES_CACHE);
        const request = store.delete(uuid);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Check if a song is a favorite
 */
export async function isFavorite(uuid) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.FAVORITES_CACHE, 'readonly');
        const store = tx.objectStore(STORES.FAVORITES_CACHE);
        const request = store.count(IDBKeyRange.only(uuid));

        request.onsuccess = () => resolve(request.result > 0);
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Pending Writes
// =============================================================================

/**
 * Add a pending write to the queue
 */
export async function addPendingWrite(write) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PENDING_WRITES, 'readwrite');
        const store = tx.objectStore(STORES.PENDING_WRITES);

        const record = {
            type: write.type,
            operation: write.operation,
            payload: write.payload,
            createdAt: Date.now(),
            retryCount: 0
        };

        const request = store.add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all pending writes
 */
export async function getPendingWrites() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PENDING_WRITES, 'readonly');
        const store = tx.objectStore(STORES.PENDING_WRITES);
        const index = store.index('createdAt');
        const request = index.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get pending write count
 */
export async function getPendingWriteCount() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PENDING_WRITES, 'readonly');
        const store = tx.objectStore(STORES.PENDING_WRITES);
        const request = store.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete a pending write
 */
export async function deletePendingWrite(id) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PENDING_WRITES, 'readwrite');
        const store = tx.objectStore(STORES.PENDING_WRITES);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Update pending write retry count
 */
export async function updatePendingWriteRetry(id) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PENDING_WRITES, 'readwrite');
        const store = tx.objectStore(STORES.PENDING_WRITES);
        const request = store.get(id);

        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.retryCount++;
                store.put(record);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Disk Usage
// =============================================================================

/**
 * Get disk usage by category
 */
export async function getDiskUsage() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.DISK_USAGE, 'readonly');
        const store = tx.objectStore(STORES.DISK_USAGE);
        const request = store.getAll();

        request.onsuccess = () => {
            const usage = {
                audio: { bytes: 0, count: 0 },
                metadata: { bytes: 0, count: 0 },
                total: 0
            };

            for (const record of request.result) {
                if (usage[record.category]) {
                    usage[record.category] = {
                        bytes: record.bytes,
                        count: record.count
                    };
                }
            }

            usage.total = usage.audio.bytes + usage.metadata.bytes;
            resolve(usage);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Update disk usage for a category
 */
export async function updateDiskUsage(category, bytesDelta, countDelta) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.DISK_USAGE, 'readwrite');
        const store = tx.objectStore(STORES.DISK_USAGE);
        const request = store.get(category);

        request.onsuccess = () => {
            const existing = request.result || { category, bytes: 0, count: 0 };
            existing.bytes = Math.max(0, existing.bytes + bytesDelta);
            existing.count = Math.max(0, existing.count + countDelta);
            store.put(existing);
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Reset disk usage tracking
 */
export async function resetDiskUsage() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.DISK_USAGE, 'readwrite');
        const store = tx.objectStore(STORES.DISK_USAGE);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// =============================================================================
// Offline Folders (downloaded folder/hierarchy tracking)
// =============================================================================

/**
 * Save an offline folder record
 * Folder record structure:
 * {
 *   id: string,           // 'path:/Music/Rock' or 'filter:category=...&artist=...'
 *   type: 'path' | 'filter',
 *   path: string | null,  // For path type: '/Music/Rock'
 *   filters: object | null, // For filter type: { category, genre, artist, album }
 *   name: string,         // Display name
 *   songUuids: string[],  // UUIDs of songs in this set
 *   totalSize: number,    // Total bytes
 *   createdAt: number,
 *   updatedAt: number
 * }
 */
export async function saveOfflineFolder(folder) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_FOLDERS, 'readwrite');
        const store = tx.objectStore(STORES.OFFLINE_FOLDERS);
        const request = store.put(folder);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get an offline folder by ID
 */
export async function getOfflineFolder(id) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_FOLDERS, 'readonly');
        const store = tx.objectStore(STORES.OFFLINE_FOLDERS);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all offline folders
 */
export async function getAllOfflineFolders() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_FOLDERS, 'readonly');
        const store = tx.objectStore(STORES.OFFLINE_FOLDERS);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete an offline folder by ID
 */
export async function deleteOfflineFolder(id) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_FOLDERS, 'readwrite');
        const store = tx.objectStore(STORES.OFFLINE_FOLDERS);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Update an existing offline folder (merge song UUIDs)
 */
export async function updateOfflineFolder(id, updates) {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_FOLDERS, 'readwrite');
        const store = tx.objectStore(STORES.OFFLINE_FOLDERS);
        const request = store.get(id);

        request.onsuccess = () => {
            const existing = request.result;
            if (existing) {
                const updated = { ...existing, ...updates, updatedAt: Date.now() };
                store.put(updated);
            }
            resolve(existing);
        };
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Clear all offline data
 */
export async function clearAllData() {
    const db = await getDb();

    return new Promise((resolve, reject) => {
        const storeNames = Object.values(STORES);
        const tx = db.transaction(storeNames, 'readwrite');

        for (const storeName of storeNames) {
            tx.objectStore(storeName).clear();
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get estimated storage info using navigator.storage API
 */
export async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return {
            quota: estimate.quota,
            usage: estimate.usage,
            available: estimate.quota - estimate.usage,
            percentUsed: (estimate.usage / estimate.quota * 100).toFixed(1)
        };
    }
    return null;
}

// Export store names for use in other modules
export { STORES };

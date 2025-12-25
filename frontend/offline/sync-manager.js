/**
 * sync-manager.js - Handles syncing pending writes when coming back online
 *
 * Uses transactional batch sync:
 * 1. Push all operations to server with session ID
 * 2. Server commits all operations atomically
 * 3. On success, clear local pending writes
 * 4. On failure, keep local writes for retry
 */

import * as api from '../api/music-api.js';
import * as offlineDb from './offline-db.js';
import offlineStore, {
    setLastSyncTime,
    refreshPendingWriteCount,
    setSyncFailed,
    clearSyncFailed,
    setLastQueueSyncTime
} from './offline-store.js';
import { notifyPlaylistsChanged } from './offline-api.js';

const MAX_RETRIES = 3;

// Promise-based lock to prevent concurrent sync operations
let syncLockPromise = null;

/**
 * Show a toast notification using the app's cl-toast component
 */
function showSyncToast(summary, detail, severity = 'error') {
    const toast = document.querySelector('cl-toast');
    if (toast) {
        toast.show({
            severity,
            summary,
            detail,
            life: severity === 'error' ? 8000 : 5000
        });
    }
}

// Track pending playlist IDs resolved during current sync session
// Maps pending-xxx -> realId (cleared between syncs)
const resolvedPendingIds = new Map();

/**
 * Generate a UUID for sync session
 */
function generateSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Process a single pending write
 */
async function processWrite(write) {
    const { type, operation, payload } = write;

    try {
        switch (type) {
            case 'queue':
                await processQueueWrite(operation, payload);
                break;

            case 'preferences':
                await processPreferencesWrite(operation, payload);
                break;

            case 'eqPresets':
                await processEqPresetsWrite(operation, payload);
                break;

            case 'playlists':
                await processPlaylistsWrite(operation, payload);
                break;

            case 'playback':
                await processPlaybackWrite(operation, payload);
                break;

            case 'history':
                await processHistoryWrite(operation, payload);
                break;

            default:
                console.warn(`[Sync] Unknown write type: ${type}`);
        }

        return { success: true };
    } catch (error) {
        console.error(`[Sync] Failed to process ${type}.${operation}:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Process queue writes
 */
async function processQueueWrite(operation, payload) {
    switch (operation) {
        case 'add':
            await api.queue.add(payload.songUuids, payload.position);
            break;
        case 'remove':
            await api.queue.remove(payload.positions);
            break;
        case 'clear':
            await api.queue.clear();
            break;
        case 'setIndex':
            // Pass device ID and sequence for conflict resolution
            await api.queue.setIndex(payload.index, payload.deviceId || null, payload.seq || null);
            break;
        case 'reorder':
            await api.queue.reorder(payload.fromPos, payload.toPos);
            break;
    }
}

/**
 * Process preferences writes
 */
async function processPreferencesWrite(operation, payload) {
    if (operation === 'set') {
        await api.preferences.set(payload);
    }
}

/**
 * Process EQ presets writes
 */
async function processEqPresetsWrite(operation, payload) {
    switch (operation) {
        case 'save':
            await api.eqPresets.save(payload);
            break;
        case 'delete':
            await api.eqPresets.delete(payload.uuid);
            break;
    }
}

/**
 * Resolve a pending playlist ID to its real server ID
 * Returns the original ID if it's not a pending ID or if no real ID is found
 */
async function resolvePendingPlaylistId(playlistId) {
    const stringId = String(playlistId);
    if (!stringId.startsWith('pending-')) {
        return playlistId;
    }

    // Check the in-memory map first (for same sync session)
    if (resolvedPendingIds.has(stringId)) {
        return resolvedPendingIds.get(stringId);
    }

    // Fall back to checking the cache (for across sync sessions)
    const cachedPlaylists = await offlineDb.getSetting('playlists') || [];
    const playlist = cachedPlaylists.find(p => p.id === stringId);

    // If we found a mapping and it has a non-pending ID, use that
    // (This happens after createFromQueue sync updates the cache)
    if (playlist && !String(playlist.id).startsWith('pending-')) {
        return playlist.id;
    }

    // Still pending - this operation should be skipped or the pending playlist wasn't synced yet
    console.warn(`[Sync] Playlist ${stringId} hasn't been synced yet, skipping operation`);
    return null;
}

/**
 * Process playlists writes
 */
async function processPlaylistsWrite(operation, payload) {
    // For operations that need a real playlist ID, resolve pending IDs
    const needsResolvedId = ['addSong', 'removeSong', 'removeSongs', 'addSongsBatch', 'sort', 'reorder', 'delete'];
    let resolvedPlaylistId = payload.playlistId;

    if (needsResolvedId.includes(operation) && payload.playlistId) {
        resolvedPlaylistId = await resolvePendingPlaylistId(payload.playlistId);
        if (resolvedPlaylistId === null) {
            // Pending playlist not yet synced - skip this operation
            // It will be handled when createFromQueue syncs
            return;
        }
    }

    switch (operation) {
        case 'addSong':
            await api.playlists.addSong(resolvedPlaylistId, payload.songUuid);
            break;
        case 'removeSong':
            await api.playlists.removeSong(resolvedPlaylistId, payload.songUuid);
            break;
        case 'removeSongs':
            await api.playlists.removeSongs(resolvedPlaylistId, payload.songUuids);
            break;
        case 'addSongsBatch':
            await api.playlists.addSongsBatch(resolvedPlaylistId, payload.songUuids);
            break;
        case 'sort':
            await api.playlists.sort(resolvedPlaylistId, payload.sortBy, payload.order);
            break;
        case 'reorder':
            await api.playlists.reorder(resolvedPlaylistId, payload.positions);
            break;
        case 'delete':
            // Skip delete for pending playlists that never got synced
            if (String(payload.playlistId).startsWith('pending-')) {
                return;
            }
            await api.playlists.delete(resolvedPlaylistId);
            break;
        case 'create':
            // Create playlist and store ID mapping for subsequent operations
            const createResult = await api.playlists.create(payload.name, payload.description, payload.isPublic);
            if (payload.tempId) {
                // Store temp -> real ID mapping for subsequent operations in this sync
                if (createResult.id) {
                    resolvedPendingIds.set(payload.tempId, createResult.id);
                }
                await offlineDb.saveSetting(`pending-playlist-songs:${payload.tempId}`, null);
                // Update cached playlists to replace tempId with real ID
                const createCachedPlaylists = await offlineDb.getSetting('playlists') || [];
                const createIdx = createCachedPlaylists.findIndex(p => p.id === payload.tempId);
                if (createIdx >= 0) {
                    createCachedPlaylists[createIdx] = { ...createCachedPlaylists[createIdx], ...createResult, pending: false };
                    await offlineDb.saveSetting('playlists', createCachedPlaylists);
                }
            }
            break;
        case 'createFromQueue':
            // Create playlist and add songs from queue
            const result = await api.playlists.create(payload.name, payload.description, payload.isPublic);
            if (result.id && payload.songUuids?.length > 0) {
                await api.playlists.addSongsBatch(result.id, payload.songUuids);
            }
            // Clean up pending playlist data and store ID mapping
            if (payload.tempId) {
                // Store temp -> real ID mapping for subsequent operations in this sync
                if (result.id) {
                    resolvedPendingIds.set(payload.tempId, result.id);
                }
                await offlineDb.saveSetting(`pending-playlist-songs:${payload.tempId}`, null);
                // Update cached playlists to replace tempId with real ID
                const cachedPlaylists = await offlineDb.getSetting('playlists') || [];
                const idx = cachedPlaylists.findIndex(p => p.id === payload.tempId);
                if (idx >= 0) {
                    cachedPlaylists[idx] = { ...cachedPlaylists[idx], ...result, pending: false };
                    await offlineDb.saveSetting('playlists', cachedPlaylists);
                }
            }
            break;
    }
}

/**
 * Process playback writes
 */
async function processPlaybackWrite(operation, payload) {
    if (operation === 'setState') {
        await api.playback.setState(payload);
    }
}

/**
 * Process history writes
 */
async function processHistoryWrite(operation, payload) {
    if (operation === 'record') {
        // Fire and forget - history is not critical
        try {
            await api.history.record(
                payload.songUuid,
                payload.durationSeconds,
                payload.skipped,
                payload.source || 'browse'
            );
        } catch (e) {
            // Ignore history sync failures
        }
    }
}

/**
 * Convert local write format to server op_type
 */
function toOpType(type, operation) {
    // Map local format to server format
    const mapping = {
        'queue.add': 'queue.add',
        'queue.remove': 'queue.remove',
        'queue.clear': 'queue.clear',
        'queue.setIndex': 'queue.setIndex',
        'queue.reorder': 'queue.reorder',
        'queue.reorderBatch': 'queue.reorder',  // Server handles as single reorder
        'playlists.addSong': 'playlists.addSong',
        'playlists.removeSong': 'playlists.removeSong',
        'playlists.removeSongs': 'playlists.removeSongs',
        'playlists.addSongsBatch': 'playlists.addSongsBatch',
        'playlists.reorder': 'playlists.reorder',
        'playlists.sort': 'playlists.sort',
        'playlists.create': 'playlists.create',
        'playlists.createFromQueue': 'playlists.create',  // Handle separately
        'playlists.delete': 'playlists.delete',
        'preferences.set': 'preferences.set',
        'history.record': 'history.record',
        'eqPresets.save': 'eqPresets.save',
        'eqPresets.delete': 'eqPresets.delete',
        'playback.setState': 'playback.setState'
    };
    return mapping[`${type}.${operation}`] || `${type}.${operation}`;
}

/**
 * Transform payload for server format if needed
 */
function transformPayload(type, operation, payload) {
    // Handle playlist ID resolution for pending playlists
    if (payload.playlistId && String(payload.playlistId).startsWith('pending-')) {
        const resolvedId = resolvedPendingIds.get(String(payload.playlistId));
        if (resolvedId) {
            payload = { ...payload, playlistId: resolvedId };
        }
    }

    // Special handling for createFromQueue - split into create + addSongs
    if (type === 'playlists' && operation === 'createFromQueue') {
        // This will be handled specially in the sync loop
        return payload;
    }

    return payload;
}

/**
 * Sync all pending writes to server using transactional batch sync.
 *
 * Flow:
 * 1. Generate session ID
 * 2. Push each operation to server
 * 3. Call commit to execute all atomically
 * 4. On success, clear local pending writes
 * 5. On failure, keep local writes for retry
 */
async function _doSyncPendingWrites() {
    const writes = await offlineDb.getPendingWrites();

    if (writes.length === 0) {
        return { success: true, synced: 0 };
    }

    const sessionId = generateSessionId();
    let seq = 0;
    let pushed = 0;

    // Phase 1: Push all operations to server
    for (const write of writes) {
        const { type, operation, payload } = write;
        const opType = toOpType(type, operation);
        let transformedPayload = transformPayload(type, operation, payload);

        // Special handling for createFromQueue - split into create + addSongsBatch
        if (type === 'playlists' && operation === 'createFromQueue') {
            // First push create operation with tempId so server can track ID mapping
            const createPayload = {
                name: payload.name,
                description: payload.description || '',
                isPublic: payload.isPublic || false,
                tempId: payload.tempId
            };
            const createResult = await api.sync.push(sessionId, seq++, 'playlists.create', createPayload);
            if (createResult.error) {
                console.error('[Sync] Failed to push create operation:', createResult.error);
                await api.sync.discard(sessionId);
                return { success: false, error: createResult.error };
            }
            pushed++;

            // Then push addSongsBatch with tempId as playlistId
            // Server will resolve tempId -> real ID during commit
            if (payload.songUuids?.length > 0 && payload.tempId) {
                const addSongsPayload = {
                    playlistId: payload.tempId,
                    songUuids: payload.songUuids
                };
                const addResult = await api.sync.push(sessionId, seq++, 'playlists.addSongsBatch', addSongsPayload);
                if (addResult.error) {
                    console.error('[Sync] Failed to push addSongsBatch operation:', addResult.error);
                    await api.sync.discard(sessionId);
                    return { success: false, error: addResult.error };
                }
                pushed++;
            }
            continue;
        }

        // Handle regular playlist create - include tempId so server can track ID mapping
        if (type === 'playlists' && operation === 'create') {
            transformedPayload = {
                ...transformedPayload,
                tempId: payload.tempId
            };
        }

        const result = await api.sync.push(sessionId, seq++, opType, transformedPayload);
        if (result.error) {
            console.error(`[Sync] Failed to push ${opType}:`, result.error);
            // Discard the session and abort
            await api.sync.discard(sessionId);
            return { success: false, error: result.error };
        }
        pushed++;
    }

    if (pushed === 0) {
        return { success: true, synced: 0 };
    }

    // Phase 2: Commit all operations
    const commitResult = await api.sync.commit(sessionId);

    if (commitResult.error) {
        console.error('[Sync] Commit failed:', commitResult.error, 'at operation:', commitResult.failed_op);
        // Keep local writes for retry - don't delete them
        // Update retry count on all writes
        for (const write of writes) {
            await offlineDb.updatePendingWriteRetry(write.id);
        }
        await refreshPendingWriteCount();

        // Set sync failure state and show toast
        setSyncFailed(commitResult.error);
        showSyncToast('Sync Failed', 'Go to Settings to retry or discard changes.', 'error');

        return { success: false, error: commitResult.error };
    }

    // Phase 3: Success - clear local pending writes
    for (const write of writes) {
        await offlineDb.deletePendingWrite(write.id);
    }

    await refreshPendingWriteCount();
    await setLastSyncTime();

    // Clear any previous sync failure state
    clearSyncFailed();

    // Invalidate playlist cache to force refresh from server
    notifyPlaylistsChanged();

    return {
        success: true,
        synced: commitResult.executed,
        skipped: commitResult.skipped
    };
}

export async function syncPendingWrites() {
    // If a sync is in progress, wait for it and return its result
    if (syncLockPromise) {
        return await syncLockPromise;
    }

    if (!offlineStore.state.isOnline) {
        return { skipped: true };
    }

    // Create lock promise before any async work
    let releaseLock;
    syncLockPromise = new Promise(resolve => { releaseLock = resolve; });
    resolvedPendingIds.clear();

    let result;
    try {
        result = await _doSyncPendingWrites();
    } catch (error) {
        console.error('[Sync] Unexpected error:', error);
        setSyncFailed(error.message);
        showSyncToast('Sync Failed', 'Go to Settings to retry or discard changes.', 'error');
        result = { success: false, error: error.message };
    } finally {
        releaseLock(result);
        syncLockPromise = null;
    }
    return result;
}

async function _doSyncPendingWritesLegacy() {
    const writes = await offlineDb.getPendingWrites();

    if (writes.length === 0) {
        return { success: true, synced: 0 };
    }

    let synced = 0;
    let failed = 0;

    for (const write of writes) {
        const result = await processWrite(write);

        if (result.success) {
            await offlineDb.deletePendingWrite(write.id);
            synced++;
        } else {
            await offlineDb.updatePendingWriteRetry(write.id);
            console.warn(`[Sync] Retry ${write.retryCount + 1} for ${write.type}.${write.operation}`);
            failed++;
        }
    }

    await refreshPendingWriteCount();

    if (failed > 0) {
        setSyncFailed(`${failed} operations failed`);
        showSyncToast('Sync Incomplete', `${failed} changes failed to sync. Go to Settings to retry.`, 'error');
    } else {
        clearSyncFailed();
        await setLastSyncTime();
        notifyPlaylistsChanged();
    }

    return { success: failed === 0, synced, failed };
}

/**
 * Legacy sync function - processes writes one by one without transaction.
 * Used as fallback if transactional sync is not available.
 */
export async function syncPendingWritesLegacy() {
    // If a sync is in progress, wait for it and return its result
    if (syncLockPromise) {
        return await syncLockPromise;
    }

    if (!offlineStore.state.isOnline) {
        return { skipped: true };
    }

    // Create lock promise before any async work
    let releaseLock;
    syncLockPromise = new Promise(resolve => { releaseLock = resolve; });
    resolvedPendingIds.clear();

    let result;
    try {
        result = await _doSyncPendingWritesLegacy();
    } catch (error) {
        setSyncFailed(error.message);
        showSyncToast('Sync Failed', 'Go to Settings to retry or discard changes.', 'error');
        result = { success: false, error: error.message };
    } finally {
        releaseLock(result);
        syncLockPromise = null;
    }
    return result;
}

/**
 * Fetch entire queue from server in batches using cursor pagination.
 * @param {number} batchSize - Number of items per batch
 * @returns {Object} - Queue state with all items
 */
async function fetchQueueInBatches(batchSize = 1000) {
    let allItems = [];
    let cursor = null;
    let queueState = null;

    do {
        const result = await api.queue.list({ cursor, limit: batchSize });
        queueState = result;

        const items = result.items || result;
        if (Array.isArray(items)) {
            allItems = allItems.concat(items);
        }

        cursor = result.cursor || result.nextCursor;
    } while (cursor);

    return {
        items: allItems,
        queueIndex: queueState?.queueIndex || 0,
        activeDeviceId: queueState?.activeDeviceId || null,
        activeDeviceSeq: queueState?.activeDeviceSeq || 0,
        queueIndexUpdatedAt: queueState?.queueIndexUpdatedAt || 0,
        scaEnabled: queueState?.scaEnabled || false,
        playMode: queueState?.playMode || 'sequential',
        lastModified: queueState?.lastModified || 0
    };
}

/**
 * Add queue items to server in batches to handle large queues and invalid items gracefully.
 * @param {string[]} uuids - Array of song UUIDs to add
 * @param {number} batchSize - Number of items per batch
 * @returns {Object} - { added: number, failed: number }
 */
async function addQueueItemsInBatches(uuids, batchSize = 500) {
    let added = 0;
    let failed = 0;

    for (let i = 0; i < uuids.length; i += batchSize) {
        const batch = uuids.slice(i, i + batchSize);
        try {
            await api.queue.add(batch);
            added += batch.length;
        } catch (e) {
            // Try adding items individually to skip invalid ones
            for (const uuid of batch) {
                try {
                    await api.queue.add([uuid]);
                    added++;
                } catch (itemError) {
                    failed++;
                }
            }
        }
    }

    return { added, failed };
}

/**
 * Sync queue state with server (last-write-wins)
 * After syncing, fetches full metadata from server to restore any incomplete items.
 */
export async function syncQueueState() {
    if (!offlineStore.state.isOnline) return;

    try {
        // After batch sync, server has authoritative state - just fetch it
        // All local changes were already synced via syncPendingWrites()
        const fullServerState = await fetchQueueInBatches();

        await offlineDb.saveQueueCache({
            items: fullServerState.items,
            queueIndex: fullServerState.queueIndex,
            activeDeviceId: fullServerState.activeDeviceId || null,
            activeDeviceSeq: fullServerState.activeDeviceSeq || 0,
            scaEnabled: fullServerState.scaEnabled,
            playMode: fullServerState.playMode,
            lastSyncedAt: Date.now()
        });

        // Notify player to refresh
        window.dispatchEvent(new CustomEvent('queue-items-restored', {
            detail: {
                items: fullServerState.items,
                queueIndex: fullServerState.queueIndex
            }
        }));

        // Record sync completion time for refresh cooldown
        setLastQueueSyncTime();
    } catch (error) {
        // Queue sync errors are non-fatal
    }
}

/**
 * Sync preferences with server (last-write-wins)
 */
export async function syncPreferences() {
    if (!offlineStore.state.isOnline) return;

    try {
        const cached = await offlineDb.getSettingWithMeta('preferences');
        if (!cached) return;

        // Get server state
        const serverPrefs = await api.preferences.get();
        const serverTimestamp = serverPrefs.lastModified || 0;

        if (cached.localTimestamp > serverTimestamp) {
            // Local is newer - push to server
            await api.preferences.set(cached.value);
        } else {
            // Server is newer - update local
            await offlineDb.saveSetting('preferences', serverPrefs);
        }
    } catch (error) {
        // Preferences sync errors are non-fatal
    }
}

/**
 * Full sync when coming online
 */
export async function fullSync() {
    // First, sync pending writes
    await syncPendingWrites();

    // Then sync state (syncQueueState also restores incomplete items)
    await Promise.all([
        syncQueueState(),
        syncPreferences()
    ]);

    await setLastSyncTime();
}

/**
 * Set up event listeners for online/offline
 */
function setupListeners() {
    // Listen for online event from offline-store
    window.addEventListener('offline-store-online', () => {
        // Small delay to ensure network is stable
        setTimeout(() => {
            fullSync().catch(e => {
                console.error('[Sync] Auto-sync failed on reconnect:', e);
            });
        }, 1000);
    });
}

// Set up listeners on module load
setupListeners();

/**
 * Discard all pending writes without syncing
 */
export async function discardPendingWrites() {
    const writes = await offlineDb.getPendingWrites();
    for (const write of writes) {
        await offlineDb.deletePendingWrite(write.id);
    }
    await refreshPendingWriteCount();
    clearSyncFailed();
    return { discarded: writes.length };
}

// Export function to check if sync is in progress
export function isSyncing() {
    return syncLockPromise !== null;
}

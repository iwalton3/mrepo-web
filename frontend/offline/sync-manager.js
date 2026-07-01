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
    const { id, type, operation, payload } = write;

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
                await processHistoryWrite(operation, payload, id);
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
 * Process history writes.
 * Returns true when the write completed (or is permanently unprocessable)
 * and may be deleted; false when it failed transiently and must be retried.
 */
async function processHistoryWrite(operation, payload, pendingWriteId) {
    if (operation === 'record') {
        try {
            const result = await api.history.record(
                payload.songUuid,
                payload.durationSeconds,
                payload.skipped,
                payload.source || 'browse'
            );
            if (result?.error) {
                // In-band server rejection won't improve on retry
                console.warn('[Sync] History record rejected:', result.error);
                return true;
            }
            // Store mapping from local ID to server ID for potential later updates
            // This handles the case where sync happens before song ends/is skipped
            if (result?.id && pendingWriteId) {
                await offlineDb.saveHistoryIdMapping(`local:${pendingWriteId}`, result.id);
            }
            return true;
        } catch (e) {
            // Network failure mid-sync: keep the write so the plays aren't lost
            console.warn('[Sync] History record failed, will retry:', e.message);
            return false;
        }
    } else if (operation === 'update') {
        // Update an existing history entry (e.g., song started online, skipped offline)
        try {
            const result = await api.history.update(
                payload.historyId,
                payload.durationSeconds,
                payload.skipped
            );
            if (result?.error) {
                console.warn('[Sync] History update rejected:', result.error);
            }
            return true;
        } catch (e) {
            console.warn('[Sync] History update failed, will retry:', e.message);
            return false;
        }
    }
    return true; // Unknown operation - drop it
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
        'queue.reorderBatch': 'queue.reorderBatch',
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

    // Load persisted pending->real playlist ID mappings from earlier sync
    // sessions so ops queued against a playlist created (and synced) offline
    // still resolve after the in-memory map was cleared
    const persistedIdMap = await offlineDb.getSetting('playlist-id-map') || {};
    for (const [tempId, realId] of Object.entries(persistedIdMap)) {
        resolvedPendingIds.set(tempId, realId);
    }

    // Separate history writes - they need special handling for ID mapping
    const historyWrites = writes.filter(w => w.type === 'history');
    const batchWrites = writes.filter(w => w.type !== 'history');

    // Process history writes first (individually, stores ID mappings).
    // Failed writes are kept for retry so plays aren't silently lost;
    // permanently failing ones are dropped after MAX_RETRIES.
    let historySynced = 0;
    for (const write of historyWrites) {
        const done = await processHistoryWrite(write.operation, write.payload, write.id);
        if (done) {
            await offlineDb.deletePendingWrite(write.id);
            historySynced++;
        } else if ((write.retryCount || 0) + 1 >= MAX_RETRIES) {
            await offlineDb.deletePendingWrite(write.id);
            console.error('[Sync] Dropped history write after repeated failures');
        } else {
            await offlineDb.updatePendingWriteRetry(write.id);
        }
    }

    if (batchWrites.length === 0) {
        await refreshPendingWriteCount();
        return { success: true, synced: historySynced };
    }

    // Commit idempotency: reuse the session ID when retrying the SAME batch,
    // so a commit whose response was lost isn't re-applied by the server.
    // If the batch composition changed, discard the old session and start fresh.
    const batchKey = batchWrites.map(w => w.id).join(',');
    const storedSession = await offlineDb.getSetting('sync-session');
    let sessionId;
    if (storedSession && storedSession.batchKey === batchKey) {
        sessionId = storedSession.sessionId;
    } else {
        if (storedSession) {
            try { await api.sync.discard(storedSession.sessionId); } catch (e) { /* best effort */ }
        }
        sessionId = generateSessionId();
        await offlineDb.saveSetting('sync-session', { sessionId, batchKey });
    }

    let seq = 0;
    let pushed = 0;
    // Map server seq -> pending write, so a commit failure reporting
    // failed_seq identifies the exact poison write
    const seqToWrite = new Map();

    // Phase 1: Push all non-history operations to server
    for (const write of batchWrites) {
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
            seqToWrite.set(seq, write);
            const createResult = await api.sync.push(sessionId, seq++, 'playlists.create', createPayload);
            if (createResult.error) {
                console.error('[Sync] Failed to push create operation:', createResult.error);
                await api.sync.discard(sessionId);
                await offlineDb.saveSetting('sync-session', null);
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
                seqToWrite.set(seq, write);
                const addResult = await api.sync.push(sessionId, seq++, 'playlists.addSongsBatch', addSongsPayload);
                if (addResult.error) {
                    console.error('[Sync] Failed to push addSongsBatch operation:', addResult.error);
                    await api.sync.discard(sessionId);
                    await offlineDb.saveSetting('sync-session', null);
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

        seqToWrite.set(seq, write);
        const result = await api.sync.push(sessionId, seq++, opType, transformedPayload);
        if (result.error) {
            console.error(`[Sync] Failed to push ${opType}:`, result.error);
            // Discard the session and abort
            await api.sync.discard(sessionId);
            await offlineDb.saveSetting('sync-session', null);
            return { success: false, error: result.error };
        }
        pushed++;
    }

    if (pushed === 0) {
        await offlineDb.saveSetting('sync-session', null);
        return { success: true, synced: 0 };
    }

    // Phase 2: Commit all operations
    const commitResult = await api.sync.commit(sessionId);

    if (commitResult.error) {
        console.error('[Sync] Commit failed:', commitResult.error, 'at operation:', commitResult.failed_op);

        // Poison-pill guard: the batch commits atomically, so a single op the
        // server permanently rejects blocks EVERY queued change forever — each
        // reconnect re-pushes the whole batch, fails at the same op, rolls back,
        // and nothing syncs while offline edits pile up behind it. The server
        // reports failed_seq, identifying the exact write; gate on THAT write's
        // own retry count (batch-max would let an unrelated stale write trigger
        // dropping a healthy one). Fall back to op_type matching for older
        // servers that don't send failed_seq.
        const poison = commitResult.failed_seq != null
            ? seqToWrite.get(commitResult.failed_seq)
            : (commitResult.failed_op
                ? batchWrites.find(w => toOpType(w.type, w.operation) === commitResult.failed_op)
                : null);

        if (poison && (poison.retryCount || 0) + 1 >= MAX_RETRIES) {
            await offlineDb.deletePendingWrite(poison.id);
            // Batch composition changed - next attempt needs a fresh session
            await offlineDb.saveSetting('sync-session', null);
            console.error(`[Sync] Dropped poison write after ${(poison.retryCount || 0) + 1} attempts:`, poison.type, poison.operation);
            showSyncToast('Change discarded', `A "${poison.type}.${poison.operation}" change couldn't be saved and was discarded after repeated failures.`, 'error');
            // Bump retries on the rest so genuinely-failing batches still converge
            for (const write of batchWrites) {
                if (write.id !== poison.id) await offlineDb.updatePendingWriteRetry(write.id);
            }
            await refreshPendingWriteCount();
            // Don't latch sync-failed — let the next sync proceed with the rest.
            return { success: false, error: commitResult.error, droppedPoison: true };
        }

        // Keep local writes for retry - don't delete them.
        // Bump retry count on the batch writes (history writes were already
        // deleted above, so don't touch them).
        for (const write of batchWrites) {
            await offlineDb.updatePendingWriteRetry(write.id);
        }

        await refreshPendingWriteCount();

        // Set sync failure state and show toast
        setSyncFailed(commitResult.error);
        showSyncToast('Sync Failed', 'Go to Settings to retry or discard changes.', 'error');

        return { success: false, error: commitResult.error };
    }

    // Phase 3: Success - clear local pending writes (history already deleted
    // above) and the session record (commit is done; a new batch = new session)
    for (const write of batchWrites) {
        await offlineDb.deletePendingWrite(write.id);
    }
    await offlineDb.saveSetting('sync-session', null);

    // Apply the server's pending->real playlist ID mappings: persist for
    // future sync sessions, rewrite the cached playlists entry, and drop the
    // pending-playlist-songs staging data (cross-session pending IDs were
    // previously only resolved by the unused legacy path)
    const tempIdMap = commitResult.tempIdMap || {};
    if (Object.keys(tempIdMap).length > 0) {
        const idMap = await offlineDb.getSetting('playlist-id-map') || {};
        Object.assign(idMap, tempIdMap);
        await offlineDb.saveSetting('playlist-id-map', idMap);

        const cachedPlaylists = await offlineDb.getSetting('playlists') || [];
        let cacheChanged = false;
        for (const [tempId, realId] of Object.entries(tempIdMap)) {
            resolvedPendingIds.set(tempId, realId);
            const idx = cachedPlaylists.findIndex(p => String(p.id) === String(tempId));
            if (idx >= 0) {
                cachedPlaylists[idx] = { ...cachedPlaylists[idx], id: realId, pending: false };
                cacheChanged = true;
            }
            await offlineDb.saveSetting(`pending-playlist-songs:${tempId}`, null);
        }
        if (cacheChanged) {
            await offlineDb.saveSetting('playlists', cachedPlaylists);
        }
    }

    await refreshPendingWriteCount();
    await setLastSyncTime();

    // Clear any previous sync failure state
    clearSyncFailed();

    // Invalidate playlist cache to force refresh from server
    notifyPlaylistsChanged();

    return {
        success: true,
        synced: (commitResult.executed || 0) + historySynced,
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
 * Refresh the local preferences cache from the server.
 *
 * Offline preference changes are pushed through the pending-write batch
 * (preferences.set ops), so this is pull-only. The old implementation
 * compared the client clock against a server field the API never sends
 * (lastModified vs updated_at) and pushed camelCase keys destructured from
 * a snake_case cache — both sides of that "last-write-wins" were broken.
 * Skip the pull while preference writes are still queued so the local
 * changes aren't clobbered before they sync.
 */
export async function syncPreferences() {
    if (!offlineStore.state.isOnline) return;

    try {
        const pending = await offlineDb.getPendingWrites();
        if (pending.some(w => w.type === 'preferences')) return;

        const serverPrefs = await api.preferences.get();
        if (serverPrefs && !serverPrefs.error) {
            await offlineDb.saveSetting('preferences', serverPrefs);
        }
    } catch (error) {
        // Preferences sync errors are non-fatal
    }
}

// Single-flight guard: online events, work-offline toggles, and transient-5xx
// recovery can all trigger fullSync at once; concurrent runs interleave queue
// cache writes and reset the live player queue repeatedly
let fullSyncInFlight = null;

/**
 * Full sync when coming online
 */
export async function fullSync() {
    if (fullSyncInFlight) {
        return fullSyncInFlight;
    }

    fullSyncInFlight = (async () => {
        // First, push pending writes
        const writeResult = await syncPendingWrites();

        // Only adopt server state as authoritative when the push actually
        // succeeded (or there was nothing to push). After a FAILED push the
        // server is missing this client's offline edits — overwriting the
        // local queue with it would visually revert the user's changes while
        // their pending writes still exist.
        if (writeResult && writeResult.success === false) {
            await syncPreferences(); // pull-only, guarded against pending writes
            return;
        }

        // Then sync state (syncQueueState also restores incomplete items)
        await Promise.all([
            syncQueueState(),
            syncPreferences()
        ]);

        await setLastSyncTime();
    })().finally(() => {
        fullSyncInFlight = null;
    });

    return fullSyncInFlight;
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
    // Wait for any in-flight sync so we don't delete writes mid-push (the
    // server could still commit ops the user just discarded)
    if (syncLockPromise) {
        await syncLockPromise;
    }

    const writes = await offlineDb.getPendingWrites();
    for (const write of writes) {
        await offlineDb.deletePendingWrite(write.id);
    }

    // Drop the reusable session (and its server-side ops) so a later sync
    // can't commit the discarded batch
    const storedSession = await offlineDb.getSetting('sync-session');
    if (storedSession) {
        await offlineDb.saveSetting('sync-session', null);
        if (offlineStore.state.isOnline) {
            try { await api.sync.discard(storedSession.sessionId); } catch (e) { /* best effort */ }
        }
    }

    await refreshPendingWriteCount();
    clearSyncFailed();
    return { discarded: writes.length };
}

// Export function to check if sync is in progress
export function isSyncing() {
    return syncLockPromise !== null;
}

/**
 * offline-settings.js - Offline settings section for settings page
 *
 * Shows work offline toggle, online/offline status, storage usage,
 * and list of offline playlists.
 */

import { defineComponent, html, when, each } from '../lib/framework.js';
import offlineStore, {
    setWorkOfflineMode,
    formatBytes,
    initializeOfflineStore,
    refreshDiskUsage,
    computeOfflineFilterSets
} from '../offline/offline-store.js';
import { getOfflinePlaylists, deleteOfflinePlaylist, cleanupOrphanedFiles, refreshPlaylistMetadata, refreshAllMetadata, getOfflineFolders, deleteOfflineFolderDownload, deleteSong } from '../offline/offline-audio.js';
import { fullSync, discardPendingWrites } from '../offline/sync-manager.js';
import { notifyPlaylistsChanged } from '../offline/offline-api.js';
import * as offlineDb from '../offline/offline-db.js';
import '../componentlib/overlay/dialog.js';
import '../componentlib/button/button.js';

export default defineComponent('offline-settings', {
    stores: { offline: offlineStore },

    data() {
        return {
            offlinePlaylists: [],
            offlineFolders: [],
            individualSongs: [],  // Songs downloaded individually, not part of any playlist/folder
            isLoading: true,
            isSyncing: false,
            isClearing: false,
            isRefreshingMetadata: false,
            refreshingPlaylistId: null,
            deletingFolderId: null,
            deletingIndividualUuid: null,
            deletingGroupPath: null,
            expandedGroups: new Set(),  // Collapsed by default
            syncStatus: '',
            isPersisted: false,
            canRequestPersist: false,
            confirmDialog: { show: false, title: '', message: '', action: null, confirmLabel: 'Confirm', severity: 'danger' },
            pendingDeletePlaylist: null,
            pendingDeleteFolder: null,
            pendingDeleteSong: null
        };
    },

    async mounted() {
        await this.loadData();
        await this.checkPersistentStorage();
    },

    methods: {
        async loadData() {
            this.state.isLoading = true;
            try {
                await initializeOfflineStore();
                this.state.offlinePlaylists = await getOfflinePlaylists();
                this.state.offlineFolders = await getOfflineFolders();
                await this.loadIndividualSongs();
                await refreshDiskUsage();
            } catch (e) {
                console.error('Failed to load offline data:', e);
            }
            this.state.isLoading = false;
        },

        async loadIndividualSongs() {
            try {
                // Get individually downloaded files (with downloadSource and size)
                const individualFiles = await offlineDb.getIndividuallyDownloadedFiles();
                if (individualFiles.length === 0) {
                    this.state.individualSongs = [];
                    return;
                }

                // Get metadata for these songs
                const uuids = individualFiles.map(f => f.uuid);
                const metadata = await offlineDb.getSongsMetadata(uuids);

                // Build maps for downloadSource and size
                const sourceMap = new Map(individualFiles.map(f => [f.uuid, f.downloadSource]));
                const sizeMap = new Map(individualFiles.map(f => [f.uuid, f.size || 0]));

                // Add downloadSource and size to each metadata item
                this.state.individualSongs = metadata
                    .filter(m => m && !m.unavailable)
                    .map(m => ({
                        ...m,
                        downloadSource: sourceMap.get(m.uuid) || { type: 'browse', path: 'Unknown' },
                        fileSize: sizeMap.get(m.uuid) || 0
                    }));
            } catch (e) {
                console.error('Failed to load individual songs:', e);
                this.state.individualSongs = [];
            }
        },

        // Group individual songs by download source
        getGroupedIndividualSongs() {
            const songs = this.state.individualSongs;
            if (!songs.length) return [];

            // Helper to get display name for a download source
            const getSourceName = (source) => {
                if (!source) return 'Unknown';
                if (source.type === 'playlist') {
                    return `Playlist: ${source.playlistName || 'Unknown'}`;
                }
                return source.path || 'Unknown';
            };

            // Group by download source
            const groups = new Map();
            for (const song of songs) {
                const sourceName = getSourceName(song.downloadSource);
                if (!groups.has(sourceName)) {
                    groups.set(sourceName, { songs: [], totalSize: 0 });
                }
                const group = groups.get(sourceName);
                group.songs.push(song);
                group.totalSize += song.fileSize || 0;
            }

            // Convert to array sorted by name
            return Array.from(groups.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([path, { songs: groupSongs, totalSize }]) => ({ path, songs: groupSongs, totalSize }));
        },

        toggleGroupExpanded(path) {
            const expanded = new Set(this.state.expandedGroups || []);
            if (expanded.has(path)) {
                expanded.delete(path);
            } else {
                expanded.add(path);
            }
            this.state.expandedGroups = expanded;
        },

        async handleDeleteGroupSongs(group) {
            const count = group.songs.length;
            this.state.confirmDialog = {
                show: true,
                title: 'Delete All Songs from Source',
                message: `Delete ${count} song${count === 1 ? '' : 's'} downloaded from "${group.path}"? This will remove the audio files but keep them in your library.`,
                severity: 'danger',
                confirmLabel: 'Delete All',
                action: async () => {
                    this.state.deletingGroupPath = group.path;
                    try {
                        for (const song of group.songs) {
                            await deleteSong(song.uuid);
                        }
                        await this.loadIndividualSongs();
                        await refreshDiskUsage();
                    } catch (e) {
                        console.error('Failed to delete group songs:', e);
                    }
                    this.state.deletingGroupPath = null;
                }
            };
        },

        async handleWorkOfflineToggle(e) {
            const enabled = e.target.checked;
            setWorkOfflineMode(enabled);

            // If disabling work offline and we're online, trigger sync
            if (!enabled && navigator.onLine) {
                this.state.isSyncing = true;
                this.state.syncStatus = 'Syncing...';
                try {
                    const result = await fullSync();
                    if (result && result.synced !== undefined) {
                        this.state.syncStatus = `Synced ${result.synced} changes`;
                    } else {
                        this.state.syncStatus = 'Synced';
                    }
                } catch (e) {
                    console.error('Auto-sync failed:', e);
                    this.state.syncStatus = 'Sync failed';
                }
                this.state.isSyncing = false;
                // Clear status after a delay
                setTimeout(() => { this.state.syncStatus = ''; }, 3000);
            }
        },

        async handleSync() {
            this.state.isSyncing = true;
            this.state.syncStatus = 'Syncing...';

            try {
                const result = await fullSync();
                if (result && result.synced !== undefined) {
                    this.state.syncStatus = `Synced ${result.synced} changes`;
                } else {
                    this.state.syncStatus = 'Sync complete';
                }
            } catch (e) {
                this.state.syncStatus = 'Sync failed';
            }

            this.state.isSyncing = false;
            setTimeout(() => this.state.syncStatus = '', 3000);
        },

        handleDiscardChanges() {
            this.showConfirmDialog(
                'Discard Pending Changes',
                'Discard all pending offline changes? These changes will be lost and cannot be recovered.',
                'discardChanges',
                'Discard'
            );
        },

        async doDiscardChanges() {
            this.state.isSyncing = true;
            try {
                const result = await discardPendingWrites();
                this.state.syncStatus = `Discarded ${result.discarded} changes`;
            } catch (e) {
                this.state.syncStatus = 'Failed to discard';
            }
            this.state.isSyncing = false;
            setTimeout(() => this.state.syncStatus = '', 3000);
        },

        handleDeletePlaylist(playlist) {
            this.state.pendingDeletePlaylist = playlist;
            this.showConfirmDialog(
                'Remove Offline Playlist',
                `Remove "${playlist.name}" from offline storage? This will free up ${formatBytes(playlist.totalSize)}.`,
                'deletePlaylist',
                'Remove'
            );
        },

        async doDeletePlaylist() {
            const playlist = this.state.pendingDeletePlaylist;
            if (!playlist) return;

            try {
                await deleteOfflinePlaylist(playlist.id);
                this.state.offlinePlaylists = await getOfflinePlaylists();
                // Notify playlists page to refresh
                notifyPlaylistsChanged();
            } catch (e) {
                console.error('Failed to delete offline playlist:', e);
            }
            this.state.pendingDeletePlaylist = null;
        },

        handleDeleteFolder(folder) {
            this.state.pendingDeleteFolder = folder;
            this.showConfirmDialog(
                'Remove Offline Folder',
                `Remove "${folder.name}" from offline storage? This will free up ${formatBytes(folder.totalSize)}. Songs not in other playlists or folders will be deleted.`,
                'deleteFolder',
                'Remove'
            );
        },

        async doDeleteFolder() {
            const folder = this.state.pendingDeleteFolder;
            if (!folder) return;

            this.state.deletingFolderId = folder.id;
            try {
                await deleteOfflineFolderDownload(folder.id);
                this.state.offlineFolders = await getOfflineFolders();
            } catch (e) {
                console.error('Failed to delete offline folder:', e);
            }
            this.state.deletingFolderId = null;
            this.state.pendingDeleteFolder = null;
        },

        handleDeleteIndividualSong(song) {
            this.state.pendingDeleteSong = song;
            this.showConfirmDialog(
                'Remove Downloaded Song',
                `Remove "${song.title}" by ${song.artist} from offline storage?`,
                'deleteSong',
                'Remove'
            );
        },

        async doDeleteSong() {
            const song = this.state.pendingDeleteSong;
            if (!song) return;

            this.state.deletingIndividualUuid = song.uuid;
            try {
                await deleteSong(song.uuid);
                await this.loadIndividualSongs();
                await refreshDiskUsage();
            } catch (e) {
                console.error('Failed to delete individual song:', e);
            }
            this.state.deletingIndividualUuid = null;
            this.state.pendingDeleteSong = null;
        },

        getFolderIcon(folder) {
            return folder.type === 'path' ? '📁' : '🏷️';
        },

        async handleCleanup() {
            this.state.isClearing = true;
            try {
                const result = await cleanupOrphanedFiles();
                const toast = document.querySelector('cl-toast');
                if (result.removedCount > 0) {
                    if (toast) toast.show({ severity: 'success', summary: 'Cleanup Complete', detail: `Cleaned up ${result.removedCount} orphaned files, freed ${formatBytes(result.freedBytes)}` });
                } else {
                    if (toast) toast.show({ severity: 'info', summary: 'Cleanup', detail: 'No orphaned files found' });
                }
            } catch (e) {
                console.error('Failed to cleanup:', e);
            }
            this.state.isClearing = false;
        },

        async handleRefreshPlaylistMetadata(playlist) {
            if (!navigator.onLine) {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'error', summary: 'Offline', detail: 'Cannot refresh metadata while offline' });
                return;
            }

            this.state.refreshingPlaylistId = playlist.id;
            this.state.syncStatus = 'Refreshing metadata...';

            try {
                const result = await refreshPlaylistMetadata(playlist.id, (progress) => {
                    this.state.syncStatus = `Refreshing... ${progress.current}/${progress.total}`;
                });

                if (result.success) {
                    this.state.syncStatus = `Updated ${result.updated} songs`;
                    await computeOfflineFilterSets();
                } else {
                    this.state.syncStatus = 'Refresh failed: ' + (result.reason || 'Unknown error');
                }
            } catch (e) {
                console.error('Metadata refresh failed:', e);
                this.state.syncStatus = 'Refresh failed';
            }

            this.state.refreshingPlaylistId = null;
            setTimeout(() => this.state.syncStatus = '', 3000);
        },

        async handleRefreshAllMetadata() {
            if (!navigator.onLine) {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'error', summary: 'Offline', detail: 'Cannot refresh metadata while offline' });
                return;
            }

            this.state.isRefreshingMetadata = true;
            this.state.syncStatus = 'Refreshing all metadata...';

            try {
                const result = await refreshAllMetadata((progress) => {
                    this.state.syncStatus = `Refreshing... ${progress.current}/${progress.total}`;
                });

                if (result.success) {
                    this.state.syncStatus = `Updated ${result.updated} songs`;
                    await computeOfflineFilterSets();
                } else {
                    this.state.syncStatus = 'Refresh failed: ' + (result.reason || 'Unknown error');
                }
            } catch (e) {
                console.error('Full metadata refresh failed:', e);
                this.state.syncStatus = 'Refresh failed';
            }

            this.state.isRefreshingMetadata = false;
            setTimeout(() => this.state.syncStatus = '', 3000);
        },

        async checkPersistentStorage() {
            if (navigator.storage && navigator.storage.persisted) {
                this.state.isPersisted = await navigator.storage.persisted();
                this.state.canRequestPersist = !this.state.isPersisted && !!navigator.storage.persist;
            }
        },

        async handleRequestPersist() {
            if (!navigator.storage || !navigator.storage.persist) return;

            try {
                const granted = await navigator.storage.persist();
                this.state.isPersisted = granted;
                this.state.canRequestPersist = !granted;

                // Refresh storage estimate to show updated quota
                await refreshDiskUsage();

                const toast = document.querySelector('cl-toast');
                if (granted) {
                    if (toast) toast.show({ severity: 'success', summary: 'Storage Granted', detail: 'Persistent storage granted! Your offline data will be preserved.' });
                } else {
                    if (toast) toast.show({ severity: 'warn', summary: 'Storage Denied', detail: 'Persistent storage was not granted. The browser may clear offline data when storage is low.' });
                }
            } catch (e) {
                console.error('Failed to request persistent storage:', e);
            }
        },

        handleClearAll() {
            this.showConfirmDialog(
                'Clear All Offline Data',
                'Clear ALL offline data? This will remove all cached playlists, songs, and settings.',
                'clearAll',
                'Clear All'
            );
        },

        async doClearAll() {
            this.state.isClearing = true;
            try {
                await offlineDb.clearAllData();
                await this.loadData();
            } catch (e) {
                console.error('Failed to clear all data:', e);
            }
            this.state.isClearing = false;
        },

        showConfirmDialog(title, message, action, confirmLabel = 'Confirm') {
            this.state.confirmDialog = { show: true, title, message, action, confirmLabel, severity: 'danger' };
        },

        handleConfirmDialogConfirm() {
            const { action } = this.state.confirmDialog;
            this.state.confirmDialog = { show: false, title: '', message: '', action: null, confirmLabel: 'Confirm', severity: 'danger' };

            if (action === 'deletePlaylist') {
                this.doDeletePlaylist();
            } else if (action === 'deleteFolder') {
                this.doDeleteFolder();
            } else if (action === 'deleteSong') {
                this.doDeleteSong();
            } else if (action === 'clearAll') {
                this.doClearAll();
            } else if (action === 'discardChanges') {
                this.doDiscardChanges();
            }
        },

        handleConfirmDialogCancel() {
            this.state.confirmDialog = { show: false, title: '', message: '', action: null, confirmLabel: 'Confirm', severity: 'danger' };
            this.state.pendingDeletePlaylist = null;
            this.state.pendingDeleteFolder = null;
            this.state.pendingDeleteSong = null;
        },

        formatLastSync() {
            const lastSync = this.stores.offline.lastSyncTime;
            if (!lastSync) return 'Never';

            const diff = Date.now() - lastSync;
            if (diff < 60000) return 'Just now';
            if (diff < 3600000) return `${Math.floor(diff / 60000)} minutes ago`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
            return new Date(lastSync).toLocaleDateString();
        },

        getCacheStatusText() {
            const status = this.stores.offline.cacheStatus;
            const progress = this.stores.offline.cacheProgress;

            switch (status) {
                case 'checking':
                    return 'Checking cache...';
                case 'caching':
                    if (progress) {
                        return `Caching: ${progress.current}/${progress.total}`;
                    }
                    return 'Caching...';
                case 'ready':
                    return `Ready (v${this.stores.offline.cacheVersion || '?'})`;
                case 'error':
                    return 'Cache error';
                default:
                    return 'Unknown';
            }
        }
    },

    template() {
        const { offlinePlaylists, offlineFolders, individualSongs, isLoading, isSyncing, isClearing, isRefreshingMetadata, refreshingPlaylistId, deletingFolderId, deletingIndividualUuid, syncStatus, isPersisted, canRequestPersist, confirmDialog } = this.state;
        const {
            isOnline, workOfflineMode, pendingWriteCount, diskUsage
        } = this.stores.offline;

        return html`
            <div class="offline-settings">
                <!-- Status Section -->
                <div class="status-row">
                    <div class="status-item">
                        <span class="status-label">Status</span>
                        <span class="status-value ${workOfflineMode ? 'offline' : (isOnline ? 'online' : 'offline')}">
                            ${workOfflineMode ? '○ Work Offline' : (isOnline ? '● Online' : '○ Offline')}
                        </span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">App Cache</span>
                        <span class="status-value">${this.getCacheStatusText()}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Last Sync</span>
                        <span class="status-value">${this.formatLastSync()}</span>
                    </div>
                </div>

                <!-- Work Offline Toggle -->
                <div class="setting-row">
                    <label>Work Offline</label>
                    <div class="setting-control">
                        <label class="toggle">
                            <input type="checkbox" checked="${workOfflineMode}"
                                   on-change="handleWorkOfflineToggle">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <p class="setting-help">
                        Completely disable network access. Only cached content will be available.
                        Changes will be queued and synced when disabled.
                    </p>
                </div>

                <!-- Pending Writes / Sync Status -->
                ${when(pendingWriteCount > 0 || this.stores.offline.syncFailed, () => {
                    const { syncFailed, syncError } = this.stores.offline;
                    return html`
                        <div class="pending-writes ${syncFailed ? 'sync-failed' : ''}">
                            ${when(syncFailed, html`
                                <div class="sync-error-banner">
                                    <span class="error-icon">⚠</span>
                                    <span class="error-text">Sync failed${syncError ? `: ${syncError}` : ''}</span>
                                </div>
                            `)}
                            <div class="pending-row">
                                <span class="pending-count">${pendingWriteCount} pending change${pendingWriteCount !== 1 ? 's' : ''}</span>
                                <div class="pending-actions">
                                    <button class="sync-btn" on-click="handleSync" disabled="${isSyncing || !isOnline}">
                                        ${isSyncing ? 'Syncing...' : 'Retry Sync'}
                                    </button>
                                    <button class="discard-btn" on-click="handleDiscardChanges" disabled="${isSyncing}">
                                        Discard
                                    </button>
                                </div>
                            </div>
                            ${when(syncStatus, html`<span class="sync-status">${syncStatus}</span>`)}
                        </div>
                    `;
                })}

                <!-- Storage Usage -->
                <div class="storage-section">
                    <h3>Storage Usage</h3>

                    <div class="storage-stats">
                        <div class="storage-stat">
                            <span class="stat-label">Audio Files</span>
                            <span class="stat-value">${formatBytes(diskUsage.audio.bytes)}</span>
                            <span class="stat-count">${diskUsage.audio.count} songs</span>
                        </div>
                        <div class="storage-stat total">
                            <span class="stat-label">Total Used</span>
                            <span class="stat-value">${formatBytes(diskUsage.total)}</span>
                        </div>
                    </div>

                    <div class="persist-row">
                        <span class="persist-status">
                            ${isPersisted ? '🔒 Storage is persistent' : '⚠️ Storage may be cleared by browser'}
                        </span>
                        ${when(canRequestPersist, html`
                            <button class="persist-btn" on-click="handleRequestPersist">
                                Request Persistent Storage
                            </button>
                        `)}
                    </div>
                </div>

                <!-- Offline Playlists -->
                <div class="playlists-section">
                    <h3>Offline Playlists</h3>

                    ${when(isLoading, html`
                        <p class="loading">Loading...</p>
                    `, () => html`
                        ${when(offlinePlaylists.length === 0, html`
                            <p class="empty">No playlists saved for offline use.</p>
                            <p class="empty-hint">Go to Playlists and tap the download button.</p>
                        `, () => html`
                            <ul class="playlist-list">
                                ${each(offlinePlaylists, (playlist) => html`
                                    <li class="playlist-item">
                                        <div class="playlist-info">
                                            <span class="playlist-name">${playlist.name}</span>
                                            <span class="playlist-meta">
                                                ${playlist.downloadedCount}/${playlist.totalCount} songs
                                                · ${formatBytes(playlist.totalSize)}
                                            </span>
                                        </div>
                                        <div class="playlist-actions">
                                            <button class="refresh-btn"
                                                    on-click="${() => this.handleRefreshPlaylistMetadata(playlist)}"
                                                    disabled="${refreshingPlaylistId === playlist.id || !isOnline}"
                                                    title="Refresh metadata from server">
                                                ${refreshingPlaylistId === playlist.id ? '⟳' : '↻'}
                                            </button>
                                            <button class="delete-btn"
                                                    on-click="${() => this.handleDeletePlaylist(playlist)}"
                                                    title="Remove from offline">
                                                🗑
                                            </button>
                                        </div>
                                    </li>
                                `)}
                            </ul>
                        `)}
                    `)}
                </div>

                <!-- Offline Folders -->
                ${when(offlineFolders.length > 0, () => html`
                    <div class="folders-section">
                        <h3>Offline Folders & Hierarchies</h3>
                        <ul class="folder-list">
                            ${each(offlineFolders, (folder) => html`
                                <li class="folder-item">
                                    <div class="folder-info">
                                        <span class="folder-icon">${this.getFolderIcon(folder)}</span>
                                        <div class="folder-details">
                                            <span class="folder-name">${folder.name}</span>
                                            <span class="folder-meta">
                                                ${folder.songUuids.length} songs
                                                · ${formatBytes(folder.totalSize)}
                                            </span>
                                        </div>
                                    </div>
                                    <div class="folder-actions">
                                        <button class="delete-btn"
                                                on-click="${() => this.handleDeleteFolder(folder)}"
                                                disabled="${deletingFolderId === folder.id}"
                                                title="Remove from offline">
                                            ${deletingFolderId === folder.id ? '...' : '🗑'}
                                        </button>
                                    </div>
                                </li>
                            `)}
                        </ul>
                    </div>
                `)}

                <!-- Individually Downloaded Songs -->
                ${when(individualSongs.length > 0, () => {
                    const groups = this.getGroupedIndividualSongs();
                    const { expandedGroups, deletingGroupPath } = this.state;
                    return html`
                        <div class="individual-songs-section">
                            <h3>Individual Downloads (${individualSongs.length})</h3>
                            <p class="section-description">Songs downloaded via context menu, grouped by browse location.</p>
                            ${each(groups, (group) => {
                                const isExpanded = expandedGroups.has(group.path);
                                const isDeleting = deletingGroupPath === group.path;
                                return html`
                                    <div class="download-group ${isExpanded ? 'expanded' : ''}">
                                        <div class="group-header" on-click="${() => this.toggleGroupExpanded(group.path)}">
                                            <span class="expand-icon">${isExpanded ? '▼' : '▶'}</span>
                                            <span class="group-path">${group.path}</span>
                                            <span class="group-info">
                                                <span class="group-count">${group.songs.length} song${group.songs.length === 1 ? '' : 's'}</span>
                                                <span class="group-size">${formatBytes(group.totalSize)}</span>
                                            </span>
                                            <button class="delete-group-btn"
                                                    on-click-stop="${() => this.handleDeleteGroupSongs(group)}"
                                                    disabled="${isDeleting}"
                                                    title="Delete all songs from this source">
                                                ${isDeleting ? '...' : 'Delete All'}
                                            </button>
                                        </div>
                                        ${when(isExpanded, () => html`
                                            <ul class="song-list">
                                                ${each(group.songs, (song) => html`
                                                    <li class="song-item">
                                                        <div class="song-info">
                                                            <span class="song-title">${song.title || 'Unknown'}</span>
                                                            <span class="song-artist">${song.artist || 'Unknown Artist'}</span>
                                                        </div>
                                                        <div class="song-actions">
                                                            <button class="delete-btn"
                                                                    on-click="${() => this.handleDeleteIndividualSong(song)}"
                                                                    disabled="${deletingIndividualUuid === song.uuid}"
                                                                    title="Remove from offline">
                                                                ${deletingIndividualUuid === song.uuid ? '...' : '🗑'}
                                                            </button>
                                                        </div>
                                                    </li>
                                                `)}
                                            </ul>
                                        `)}
                                    </div>
                                `;
                            })}
                        </div>
                    `;
                })}

                <!-- Actions -->
                <div class="actions-section">
                    <button class="action-btn" on-click="handleRefreshAllMetadata" disabled="${isRefreshingMetadata || !isOnline}">
                        ${isRefreshingMetadata ? 'Refreshing...' : 'Refresh All Metadata'}
                    </button>
                    <button class="action-btn secondary" on-click="handleCleanup" disabled="${isClearing}">
                        ${isClearing ? 'Cleaning...' : 'Cleanup Orphaned Files'}
                    </button>
                    <button class="action-btn danger" on-click="handleClearAll" disabled="${isClearing}">
                        ${isClearing ? 'Clearing...' : 'Clear All Offline Data'}
                    </button>
                </div>
                ${when(syncStatus, html`<div class="sync-status-global">${syncStatus}</div>`)}

                ${when(confirmDialog.show, () => html`
                    <cl-dialog visible="true" header="${confirmDialog.title}" on-close="handleConfirmDialogCancel">
                        <p>${confirmDialog.message}</p>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                            <cl-button severity="${confirmDialog.severity}" on-click="handleConfirmDialogConfirm">${confirmDialog.confirmLabel}</cl-button>
                        </div>
                    </cl-dialog>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .offline-settings {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
        }

        /* Status Row */
        .status-row {
            display: flex;
            flex-wrap: wrap;
            gap: 1rem;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
        }

        .status-item {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .status-label {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        .status-value {
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
        }

        .status-value.online {
            color: var(--success-500, #22c55e);
        }

        .status-value.offline {
            color: var(--danger-500, #ef4444);
        }

        /* Setting Row */
        .setting-row {
            margin-bottom: 1rem;
        }

        .setting-row > label {
            display: block;
            font-weight: 500;
            margin-bottom: 0.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .setting-control {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .setting-help {
            margin: 0.5rem 0 0;
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        /* Toggle Switch */
        .toggle {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 24px;
            cursor: pointer;
        }

        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--surface-300, #404040);
            border-radius: 24px;
            transition: background 0.2s;
        }

        .toggle-slider::before {
            content: '';
            position: absolute;
            width: 18px;
            height: 18px;
            left: 3px;
            bottom: 3px;
            background: var(--text-primary, #e0e0e0);
            border-radius: 50%;
            transition: transform 0.2s;
        }

        .toggle input:checked + .toggle-slider {
            background: var(--primary-500, #2196f3);
        }

        .toggle input:checked + .toggle-slider::before {
            transform: translateX(24px);
        }

        /* Pending Writes */
        .pending-writes {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            border-left: 3px solid var(--primary-500, #2196f3);
        }

        .pending-writes.sync-failed {
            border-left-color: var(--danger-500, #ef4444);
            background: var(--danger-100, #3d2020);
        }

        .sync-error-banner {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            color: var(--danger-500, #ef4444);
            font-size: 0.875rem;
            font-weight: 500;
        }

        .error-icon {
            font-size: 1rem;
        }

        .pending-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            flex-wrap: wrap;
        }

        .pending-actions {
            display: flex;
            gap: 0.5rem;
        }

        .pending-count {
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .sync-failed .pending-count {
            color: var(--text-primary, #e0e0e0);
        }

        .sync-btn {
            padding: 0.375rem 0.75rem;
            border: 1px solid var(--primary-500, #2196f3);
            border-radius: 4px;
            background: transparent;
            color: var(--primary-500, #2196f3);
            cursor: pointer;
            font-size: 0.75rem;
        }

        .sync-btn:hover:not(:disabled) {
            background: var(--primary-500, #2196f3);
            color: white;
        }

        .sync-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .discard-btn {
            padding: 0.375rem 0.75rem;
            border: 1px solid var(--danger-500, #ef4444);
            border-radius: 4px;
            background: transparent;
            color: var(--danger-500, #ef4444);
            cursor: pointer;
            font-size: 0.75rem;
        }

        .discard-btn:hover:not(:disabled) {
            background: var(--danger-500, #ef4444);
            color: white;
        }

        .discard-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .sync-status {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        /* Storage Section */
        .storage-section h3,
        .playlists-section h3 {
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 0.75rem;
        }

        .storage-stats {
            display: flex;
            flex-wrap: wrap;
            gap: 1rem;
        }

        .storage-stat {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            min-width: 100px;
        }

        .storage-stat.total {
            background: var(--primary-500, #2196f3);
        }

        .storage-stat.total .stat-label,
        .storage-stat.total .stat-value,
        .storage-stat.total .stat-count {
            color: white;
        }

        .stat-label {
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
        }

        .stat-value {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
        }

        .stat-count {
            font-size: 0.7rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Persistent Storage */
        .persist-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            margin-top: 1rem;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            flex-wrap: wrap;
        }

        .persist-status {
            font-size: 0.8125rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .persist-btn {
            padding: 0.375rem 0.75rem;
            border: 1px solid var(--primary-500, #2196f3);
            border-radius: 4px;
            background: transparent;
            color: var(--primary-500, #2196f3);
            cursor: pointer;
            font-size: 0.75rem;
        }

        .persist-btn:hover {
            background: var(--primary-500, #2196f3);
            color: white;
        }

        /* Playlists Section */
        .loading, .empty {
            color: var(--text-muted, #707070);
            font-size: 0.875rem;
        }

        .empty-hint {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            margin-top: 0.25rem;
        }

        .playlist-list {
            list-style: none;
            padding: 0;
            margin: 0;
            max-height: 50vh;
            overflow-y: auto;
        }

        .playlist-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            margin-bottom: 0.5rem;
        }

        .playlist-info {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
        }

        .playlist-name {
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
        }

        .playlist-meta {
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
        }

        .playlist-actions {
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }

        .refresh-btn {
            padding: 0.25rem 0.5rem;
            border: none;
            background: transparent;
            color: var(--text-muted, #707070);
            cursor: pointer;
            font-size: 1rem;
        }

        .refresh-btn:hover:not(:disabled) {
            color: var(--primary-500, #2196f3);
        }

        .refresh-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .delete-btn {
            padding: 0.25rem 0.5rem;
            border: none;
            background: transparent;
            color: var(--text-primary, #ffffff);
            cursor: pointer;
            font-size: 1.25rem;
        }

        .delete-btn:hover {
            color: var(--danger-500, #ef4444);
        }

        .sync-status-global {
            margin-top: 0.5rem;
            padding: 0.5rem;
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            text-align: center;
            background: var(--surface-100, #242424);
            border-radius: 4px;
        }

        /* Folders Section */
        .folders-section h3 {
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 0.75rem;
        }

        .folder-list {
            list-style: none;
            padding: 0;
            margin: 0;
            max-height: 50vh;
            overflow-y: auto;
        }

        .folder-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            margin-bottom: 0.5rem;
        }

        .folder-info {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            min-width: 0;
            flex: 1;
        }

        .folder-icon {
            font-size: 1.25rem;
            flex-shrink: 0;
        }

        .folder-details {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
            min-width: 0;
        }

        .folder-name {
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .folder-meta {
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
        }

        .folder-actions {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            flex-shrink: 0;
        }

        /* Individual Songs Section */
        .individual-songs-section h3 {
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 0.5rem;
        }

        .section-description {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            margin: 0 0 0.75rem;
        }

        .download-group {
            margin-bottom: 0.5rem;
        }

        .group-header {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-200, #2d2d2d);
            border-radius: 6px;
            cursor: pointer;
            user-select: none;
        }

        .download-group.expanded .group-header {
            border-radius: 6px 6px 0 0;
        }

        .group-header:hover {
            background: var(--surface-300, #383838);
        }

        .expand-icon {
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
            flex-shrink: 0;
            width: 1rem;
        }

        .group-path {
            font-size: 0.8rem;
            color: var(--text-primary, #e0e0e0);
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
            min-width: 0;
        }

        .group-info {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            flex-shrink: 0;
        }

        .group-count {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        .group-size {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            font-weight: 500;
        }

        .delete-group-btn {
            padding: 0.25rem 0.5rem;
            font-size: 0.7rem;
            background: var(--surface-300, #383838);
            color: var(--text-secondary, #a0a0a0);
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }

        .delete-group-btn:hover:not(:disabled) {
            background: var(--danger-bg, #3d2020);
            color: var(--danger-text, #ff6b6b);
        }

        .delete-group-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .download-group .song-list {
            border-radius: 0 0 6px 6px;
            background: var(--surface-100, #242424);
        }

        .download-group .song-item:first-child {
            border-radius: 0;
        }

        .download-group .song-item:last-child {
            border-radius: 0 0 6px 6px;
            margin-bottom: 0;
        }

        .song-list {
            list-style: none;
            padding: 0;
            margin: 0;
            max-height: 30vh;
            overflow-y: auto;
        }

        .song-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            margin-bottom: 0.5rem;
        }

        .song-info {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
            min-width: 0;
            flex: 1;
        }

        .song-title {
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .song-artist {
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .song-actions {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            flex-shrink: 0;
        }

        /* Actions */
        .actions-section {
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            padding-top: 1rem;
            border-top: 1px solid var(--surface-200, #2d2d2d);
        }

        .action-btn {
            padding: 0.5rem 1rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.8125rem;
        }

        .action-btn:hover:not(:disabled) {
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
        }

        .action-btn.danger:hover:not(:disabled) {
            background: var(--danger-100, #450a0a);
            color: var(--danger-500, #ef4444);
            border-color: var(--danger-500, #ef4444);
        }

        .action-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
    `
});

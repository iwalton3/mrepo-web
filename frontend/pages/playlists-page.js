/**
 * Playlists Page
 *
 * Playlist management:
 * - My Playlists list
 * - Public playlists discovery
 * - Playlist detail view
 * - Sharing functionality
 */

import { defineComponent, html, when, each, memoEach, untracked, flushSync } from '../lib/framework.js';
import { rafThrottle } from '../lib/utils.js';
import { songs as songsApi, playlists as playlistsApi, auth } from '../offline/offline-api.js';
import offlineStore, { shouldShowOfflineWarnings, setDownloadProgress, computeOfflineFilterSets } from '../offline/offline-store.js';
import { downloadSong, canCacheOffline } from '../offline/offline-audio.js';
import { player } from '../stores/player-store.js';
import { showSongContextMenu, navigateToArtist, navigateToAlbum } from '../components/song-context-menu.js';
import '../components/scroll-to-top.js';
import '../components/playlist-download-btn.js';
import '../componentlib/button/button.js';
import '../componentlib/overlay/dialog.js';
import '../componentlib/misc/spinner.js';

export default defineComponent('playlists-page', {
    props: {
        params: {}  // { id } for playlist detail, { token } for shared
    },

    data() {
        return {
            view: 'list',           // 'list', 'detail', 'shared'
            tab: 'my',              // 'my', 'public'
            myPlaylists: [],
            publicPlaylists: [],
            currentPlaylist: null,
            playlistSongs: untracked([]),  // Large list - untracked for performance
            playlistVersion: 0,  // Bumped on reorder to invalidate memoEach cache
            isLoading: false,
            isAuthenticated: false,
            showCreateDialog: false,
            showShareDialog: false,
            newPlaylistName: '',
            newPlaylistDesc: '',
            newPlaylistPublic: false,
            shareToken: null,
            cursor: null,
            hasMore: false,
            totalCount: 0,
            // Windowed rendering
            visibleStart: 0,
            visibleEnd: 50,
            // Search state
            showAddSongs: false,
            searchQuery: '',
            searchResults: [],
            searchLoading: false,
            // Sorting state
            isSorting: false,
            showSortMenu: false,
            // Selection mode
            selectionMode: false,
            selectedIndices: new Set(),
            isDownloadingSelection: false,
            // Confirm dialog
            confirmDialog: { show: false, title: '', message: '', action: null },
            pendingDeletePlaylist: null
        };
    },

    async mounted() {
        // Check auth
        try {
            const result = await auth.checkUser();
            this.state.isAuthenticated = result.authenticated;
        } catch (e) {
            console.error('Auth check failed:', e);
        }

        // Listen for playlist changes from other components
        this._playlistsChangedHandler = () => this.loadPlaylists(true);
        window.addEventListener('playlists-changed', this._playlistsChangedHandler);

        // Always load playlists first with force refresh (catches playlists created on other devices)
        await this.loadPlaylists(true);

        // Determine view from params
        const { id, token } = this.props.params || {};
        if (token) {
            this.state.view = 'shared';
            this.loadSharedPlaylist(token);
        } else if (id) {
            this.state.view = 'detail';
            this.loadPlaylistDetail(id);
        }
    },

    unmounted() {
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }
        if (this._scrollHandler) {
            window.removeEventListener('scroll', this._scrollHandler, true);
        }
        if (this._playlistsChangedHandler) {
            window.removeEventListener('playlists-changed', this._playlistsChangedHandler);
        }
    },

    async propsChanged(prop, newValue, oldValue) {
        if (prop === 'params') {
            // Skip if params haven't actually changed
            const oldId = oldValue?.id;
            const oldToken = oldValue?.token;
            const { id, token } = newValue || {};

            if (id === oldId && token === oldToken) return;

            if (token) {
                this.state.view = 'shared';
                this.loadSharedPlaylist(token);
            } else if (id) {
                // Ensure playlists are loaded for playlist info
                if (this.state.myPlaylists.length === 0) {
                    await this.loadPlaylists(true);
                }
                this.state.view = 'detail';
                this.loadPlaylistDetail(id);
            } else {
                // Navigating to list view - always refresh
                this.state.view = 'list';
                this.loadPlaylists(true);
            }
        }
    },

    methods: {
        /**
         * Check if we're on a touch device (mobile).
         * Drag-drop is disabled on touch devices to prevent conflicts with long-press context menu.
         */
        isTouchDevice() {
            return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        },

        // Selection mode methods
        toggleSelectionMode() {
            this.state.selectionMode = !this.state.selectionMode;
            this.state.playlistVersion++;  // Invalidate memoEach cache
            if (!this.state.selectionMode) {
                this.clearSelection();
            }
        },

        isSelected(index) {
            return this.state.selectedIndices.has(index);
        },

        toggleSelection(index, e) {
            if (e) e.stopPropagation();
            const newSet = new Set(this.state.selectedIndices);

            // Shift+click for range selection
            if (e && e.shiftKey && this._lastSelectedIndex !== undefined) {
                const start = Math.min(this._lastSelectedIndex, index);
                const end = Math.max(this._lastSelectedIndex, index);
                for (let i = start; i <= end; i++) {
                    newSet.add(i);
                }
            } else {
                if (newSet.has(index)) {
                    newSet.delete(index);
                } else {
                    newSet.add(index);
                }
                this._lastSelectedIndex = index;
            }

            this.state.selectedIndices = newSet;
            this.state.playlistVersion++;  // Invalidate memoEach cache
        },

        selectAll() {
            const songs = this.state.playlistSongs;
            const newSet = new Set();
            for (let i = 0; i < songs.length; i++) {
                if (songs[i]) newSet.add(i);
            }
            this.state.selectedIndices = newSet;
            this.state.playlistVersion++;  // Invalidate memoEach cache
        },

        clearSelection() {
            this.state.selectedIndices = new Set();
            this._lastSelectedIndex = undefined;
            this.state.playlistVersion++;  // Invalidate memoEach cache
        },

        async handleDeleteSelected() {
            if (!this.state.currentPlaylist) return;
            const indices = [...this.state.selectedIndices];
            if (indices.length === 0) return;

            const songs = this.state.playlistSongs;
            const songUuids = indices.map(i => songs[i]?.uuid).filter(Boolean);

            if (songUuids.length === 0) return;

            try {
                await playlistsApi.removeSongs(this.state.currentPlaylist.id, songUuids);

                // Update local state
                const newSongs = this.state.playlistSongs.filter((_, i) => !this.state.selectedIndices.has(i));
                this.state.playlistSongs = newSongs;
                this.state.totalCount = newSongs.length;
                this.state.playlistVersion++;

                this.clearSelection();
                this.state.selectionMode = false;
            } catch (e) {
                console.error('Failed to delete selected songs:', e);
            }
        },

        async handleAddSelectedToQueue() {
            const indices = [...this.state.selectedIndices];
            if (indices.length === 0) return;

            const songs = this.state.playlistSongs;
            const selectedSongs = indices.map(i => songs[i]).filter(Boolean);

            try {
                await player.addToQueue(selectedSongs);
                this.clearSelection();
                this.state.selectionMode = false;
            } catch (e) {
                console.error('Failed to add to queue:', e);
            }
        },

        async handleDownloadSelected() {
            const indices = [...this.state.selectedIndices];
            if (indices.length === 0) return;

            const songs = this.state.playlistSongs;
            const selectedSongs = indices.map(i => songs[i]).filter(Boolean);

            // Filter out already offline songs first
            const notOffline = selectedSongs.filter(s =>
                s && s.uuid &&
                !offlineStore.state.offlineSongUuids.has(s.uuid)
            );

            if (notOffline.length === 0) {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'info', summary: 'Info', detail: 'All selected songs are already downloaded' });
                return;
            }

            // Fetch full metadata for songs missing type field or with type='file' (VFS items)
            const needsMetadata = notOffline.filter(s => (!s.type || s.type === 'file') && s.uuid);
            let metadataMap = new Map();

            if (needsMetadata.length > 0) {
                try {
                    const uuids = needsMetadata.map(s => s.uuid);
                    const fullSongs = await songsApi.getBulk(uuids);
                    metadataMap = new Map(fullSongs.map(s => [s.uuid, s]));
                } catch (e) {
                    console.error('[Playlists] Failed to fetch song metadata:', e);
                }
            }

            // Get full metadata for each song, then filter by type
            const downloadable = notOffline
                .map(item => (item.type && item.type !== 'file') ? item : (metadataMap.get(item.uuid) || item))
                .filter(s => canCacheOffline(s.type));

            if (downloadable.length === 0) {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'info', summary: 'Info', detail: 'No downloadable songs selected (transcode-only formats)' });
                return;
            }

            // Build downloadSource from playlist context
            const playlist = this.state.currentPlaylist;
            const playlistId = playlist?.id;
            const downloadSource = playlistId
                ? { type: 'playlist', playlistId, playlistName: playlist.name || 'Playlist' }
                : null;

            this.state.isDownloadingSelection = true;

            for (let i = 0; i < downloadable.length; i++) {
                const song = downloadable[i];
                setDownloadProgress({
                    playlistId: 'selection',
                    playlistName: 'Selected Songs',
                    current: i,
                    total: downloadable.length,
                    currentSongName: song.title
                });
                // Don't pass playlistId - these are individual downloads, not playlist downloads
                // downloadSource tracks where they came from for the UI
                await downloadSong(song, null, null, downloadSource);
            }

            setDownloadProgress(null);
            await computeOfflineFilterSets();
            this.state.isDownloadingSelection = false;
            this.clearSelection();
            this.state.selectionMode = false;
        },

        getDisplayTitle(song) {
            if (!song) return 'Unknown';
            if (song.title) return song.title;
            // Fallback to filename without extension
            const path = song.virtual_file || song.file || '';
            const filename = path.split('/').pop() || '';
            return filename.replace(/\.[^.]+$/, '') || 'Unknown';
        },

        getSongCountDisplay(availableCount, playlist) {
            const isOffline = shouldShowOfflineWarnings();
            const originalCount = playlist?.song_count || 0;

            if (!isOffline) {
                return `${availableCount} songs`;
            }

            // In offline mode, show availability info
            if (availableCount === 0 && originalCount > 0) {
                return `No songs available offline (${originalCount} total)`;
            } else if (availableCount > 0 && originalCount > availableCount) {
                return `${availableCount}/${originalCount} songs available offline`;
            } else if (availableCount > 0) {
                return `${availableCount} songs`;
            }
            return 'No songs';
        },

        getEmptyMessage(playlist) {
            const isOffline = shouldShowOfflineWarnings();
            const originalCount = playlist?.song_count || 0;

            if (isOffline && originalCount > 0) {
                return `${originalCount} songs unavailable offline`;
            }
            return 'No songs in playlist';
        },

        async loadPlaylists(forceRefresh = false) {
            this.state.isLoading = true;
            try {
                if (this.state.isAuthenticated) {
                    const result = await playlistsApi.list(forceRefresh);
                    this.state.myPlaylists = result.items || [];
                }
            } catch (e) {
                console.error('Failed to load playlists:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async loadPublicPlaylists() {
            if (this.state.publicPlaylists.length > 0) return;

            this.state.isLoading = true;
            try {
                const result = await playlistsApi.public({ limit: 50 });
                this.state.publicPlaylists = result.items || [];
                this.state.hasMore = result.hasMore;
            } catch (e) {
                console.error('Failed to load public playlists:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async loadPlaylistDetail(id) {
            this.state.isLoading = true;
            this.state.cursor = null;
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;
            // Clear selection when switching playlists
            this.state.selectionMode = false;
            this.state.selectedIndices = new Set();
            try {
                // Get first batch with totalCount
                const result = await playlistsApi.getSongs(id, { limit: 100 });
                const totalCount = result.totalCount || result.items.length;

                // Create sparse array and fill first batch
                const songs = new Array(totalCount).fill(null);
                result.items.forEach((item, i) => {
                    songs[i] = item;
                });

                this.state.playlistSongs = songs;
                this.state.totalCount = totalCount;
                this.state.cursor = result.nextCursor;
                this.state.hasMore = result.hasMore;

                // Find playlist info from our lists (check both my playlists and public)
                let found = this.state.myPlaylists.find(p => p.id == id)
                    || this.state.publicPlaylists.find(p => p.id == id);

                // If not found and public playlists not loaded, try loading them
                if (!found && this.state.publicPlaylists.length === 0) {
                    try {
                        const publicResult = await playlistsApi.public({ limit: 50 });
                        this.state.publicPlaylists = publicResult.items || [];
                        found = this.state.publicPlaylists.find(p => p.id == id);
                    } catch (e) {
                        console.warn('Failed to load public playlists:', e);
                    }
                }

                if (found) {
                    this.state.currentPlaylist = found;
                } else {
                    // Create minimal placeholder so page at least renders
                    this.state.currentPlaylist = { id, name: 'Playlist', song_count: totalCount };
                }

                // Setup scroll listener for windowed rendering
                this._setupScrollListener();

                // Start background loading of remaining items
                if (result.hasMore) {
                    this._loadRemainingInBackground(id, result.nextCursor);
                }
            } catch (e) {
                console.error('Failed to load playlist:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async loadSharedPlaylist(token) {
            this.state.isLoading = true;
            this.state.cursor = null;
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;
            try {
                const playlist = await playlistsApi.byToken(token);
                if (playlist.error) {
                    console.error('Playlist not found');
                    return;
                }
                this.state.currentPlaylist = playlist;

                const result = await playlistsApi.getSongs(playlist.id, { limit: 100 });
                const totalCount = result.totalCount || result.items.length;

                // Create sparse array
                const songs = new Array(totalCount).fill(null);
                result.items.forEach((item, i) => {
                    songs[i] = item;
                });

                this.state.playlistSongs = songs;
                this.state.totalCount = totalCount;
                this.state.cursor = result.nextCursor;
                this.state.hasMore = result.hasMore;

                this._setupScrollListener();

                if (result.hasMore) {
                    this._loadRemainingInBackground(playlist.id, result.nextCursor);
                }
            } catch (e) {
                console.error('Failed to load shared playlist:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async loadMoreSongs() {
            if (!this.state.currentPlaylist || this.state.isLoading || !this.state.hasMore) return;

            this.state.isLoading = true;
            try {
                const result = await playlistsApi.getSongs(this.state.currentPlaylist.id, {
                    cursor: this.state.cursor,
                    limit: 100
                });

                this.state.playlistSongs = [...this.state.playlistSongs, ...result.items];
                this.state.cursor = result.nextCursor;
                this.state.hasMore = result.hasMore;

                // Re-setup infinite scroll after loading more
                this._setupInfiniteScroll();
            } catch (e) {
                console.error('Failed to load more songs:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        handleTabChange(tab) {
            this.state.tab = tab;
            if (tab === 'public') {
                this.loadPublicPlaylists();
            }
        },

        handlePlaylistClick(playlist) {
            window.location.hash = `/playlists/${playlist.id}/`;
        },

        handleBackToList() {
            this.state.view = 'list';
            this.state.currentPlaylist = null;
            this.state.playlistSongs = [];
            // Clear selection when leaving detail view
            this.state.selectionMode = false;
            this.state.selectedIndices = new Set();
            window.location.hash = '/playlists/';
        },

        openCreateDialog() {
            this.state.showCreateDialog = true;
            this.state.newPlaylistName = '';
            this.state.newPlaylistDesc = '';
            this.state.newPlaylistPublic = false;
        },

        closeCreateDialog() {
            this.state.showCreateDialog = false;
        },

        async handleCreatePlaylist() {
            if (!this.state.newPlaylistName.trim()) return;

            try {
                const result = await playlistsApi.create(
                    this.state.newPlaylistName,
                    this.state.newPlaylistDesc,
                    this.state.newPlaylistPublic
                );
                if (!result.error) {
                    this.state.showCreateDialog = false;
                    this.loadPlaylists();
                }
            } catch (e) {
                console.error('Failed to create playlist:', e);
            }
        },

        handleDeletePlaylist(playlist, e) {
            e.stopPropagation();
            this.state.pendingDeletePlaylist = playlist;
            this.showConfirmDialog(
                'Delete Playlist',
                `Delete "${playlist.name}"?`,
                'deletePlaylist'
            );
        },

        async doDeletePlaylist() {
            const playlist = this.state.pendingDeletePlaylist;
            if (!playlist) return;

            try {
                await playlistsApi.delete(playlist.id);
                this.loadPlaylists();
            } catch (err) {
                console.error('Failed to delete playlist:', err);
            }
            this.state.pendingDeletePlaylist = null;
        },

        showConfirmDialog(title, message, action) {
            this.state.confirmDialog = { show: true, title, message, action };
        },

        handleConfirmDialogConfirm() {
            const { action } = this.state.confirmDialog;
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };

            if (action === 'deletePlaylist') {
                this.doDeletePlaylist();
            }
        },

        handleConfirmDialogCancel() {
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };
            this.state.pendingDeletePlaylist = null;
        },

        async handleShare() {
            if (!this.state.currentPlaylist) return;
            try {
                const result = await playlistsApi.share(this.state.currentPlaylist.id);
                this.state.shareToken = result.share_token;
                this.state.showShareDialog = true;
            } catch (e) {
                console.error('Failed to get share token:', e);
            }
        },

        closeShareDialog() {
            this.state.showShareDialog = false;
        },

        copyShareLink() {
            // Use pathname to preserve base path for subpath hosting
            const basePath = window.location.pathname.replace(/\/$/, '');
            const url = `${window.location.origin}${basePath}/#/share/${this.state.shareToken}/`;
            navigator.clipboard.writeText(url).then(() => {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'success', summary: 'Copied', detail: 'Link copied to clipboard!' });
            });
        },

        async handleClone() {
            if (!this.state.currentPlaylist) return;
            try {
                const result = await playlistsApi.clone(this.state.currentPlaylist.id);
                if (!result.error) {
                    const toast = document.querySelector('cl-toast');
                    if (toast) toast.show({ severity: 'success', summary: 'Cloned', detail: `Playlist cloned as "${result.name}"` });
                    this.loadPlaylists();
                }
            } catch (e) {
                console.error('Failed to clone playlist:', e);
            }
        },

        async handleTogglePublic() {
            if (!this.state.currentPlaylist) return;
            const newValue = !this.state.currentPlaylist.is_public;
            try {
                const result = await playlistsApi.update(this.state.currentPlaylist.id, { isPublic: newValue });
                if (!result.error) {
                    // Update local state
                    this.state.currentPlaylist = {
                        ...this.state.currentPlaylist,
                        is_public: newValue
                    };
                    // Update in myPlaylists list
                    this.state.myPlaylists = this.state.myPlaylists.map(p =>
                        p.id === this.state.currentPlaylist.id
                            ? { ...p, is_public: newValue }
                            : p
                    );
                }
            } catch (e) {
                console.error('Failed to update playlist:', e);
            }
        },

        toggleSortMenu() {
            this.state.showSortMenu = !this.state.showSortMenu;
        },

        closeSortMenu() {
            this.state.showSortMenu = false;
        },

        async handleSortPlaylist(sortBy, order = 'asc') {
            if (!this.state.currentPlaylist) return;
            this.state.isSorting = true;
            this.state.showSortMenu = false;

            try {
                await playlistsApi.sort(this.state.currentPlaylist.id, sortBy, order);
                // Reload the playlist from server after sorting
                await this.loadPlaylistDetail(this.state.currentPlaylist.id);
            } catch (e) {
                console.error('Failed to sort playlist:', e);
            } finally {
                this.state.isSorting = false;
            }
        },

        handleSongClick(song) {
            // Don't play unavailable songs when offline
            if (this.isUnavailableOffline(song)) {
                return;
            }
            player.addToQueue(song, true);
        },

        /**
         * Check if a song is unavailable in offline mode.
         * Returns true if:
         * - Song has explicit unavailable flag (placeholder from getSongsMetadata)
         * - In offline mode and song is not cached
         */
        isUnavailableOffline(song) {
            if (!song) return false;
            // Check explicit unavailable flag (placeholder from getSongsMetadata)
            if (song.unavailable) return true;
            // Not in offline mode = nothing is unavailable
            if (offlineStore.state.isOnline && !offlineStore.state.workOfflineMode) {
                return false;
            }
            // In offline mode - check if song is cached
            return !offlineStore.state.offlineSongUuids.has(song.uuid);
        },

        handleSongContextMenu(song, e) {
            e.preventDefault();
            e.stopPropagation();
            showSongContextMenu(song, e.clientX, e.clientY);
        },

        async handlePlayAll() {
            if (!this.state.currentPlaylist) return;
            await player.clearQueue();
            await player.addByPlaylist(this.state.currentPlaylist.id, false);
        },

        async handleShuffleAll() {
            if (!this.state.currentPlaylist) return;
            await player.clearQueue();
            await player.addByPlaylist(this.state.currentPlaylist.id, true);
        },

        async handleStartRadio() {
            if (!this.state.currentPlaylist) return;
            await player.startScaFromPlaylist(this.state.currentPlaylist.id);
        },

        async handleRemoveSong(song, e) {
            e.stopPropagation();
            if (!this.state.currentPlaylist) return;
            try {
                await playlistsApi.removeSong(this.state.currentPlaylist.id, song.uuid);
                this.state.playlistSongs = this.state.playlistSongs.filter(s => s.uuid !== song.uuid);
                this.state.totalCount = this.state.playlistSongs.length;
                this.state.playlistVersion++;  // Invalidate memoEach cache
            } catch (e) {
                console.error('Failed to remove song:', e);
            }
        },

        // Playlist song reordering
        async handlePlaylistMoveUp(index, e) {
            e.stopPropagation();
            if (index > 0) {
                await this.reorderPlaylistSongs(index, index - 1);
            }
        },

        async handlePlaylistMoveDown(index, e) {
            e.stopPropagation();
            if (index < this.state.playlistSongs.length - 1) {
                await this.reorderPlaylistSongs(index, index + 1);
            }
        },

        async reorderPlaylistSongs(fromIndex, toIndex) {
            if (!this.state.currentPlaylist) return;
            const songs = [...this.state.playlistSongs];
            const [moved] = songs.splice(fromIndex, 1);
            // When moving down, adjust for the index shift after removal
            const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            songs.splice(insertIndex, 0, moved);

            // Optimistically update UI
            this.state.playlistSongs = songs;
            this.state.playlistVersion++;  // Invalidate memoEach cache for correct numbering

            // Build positions array for API - backend expects [{uuid, position}, ...]
            const positions = songs.map((s, i) => ({ uuid: s.uuid, position: i }));

            try {
                await playlistsApi.reorder(this.state.currentPlaylist.id, positions);
            } catch (e) {
                console.error('Failed to reorder playlist:', e);
                // Reload to restore correct state
                this.loadPlaylistDetail(this.state.currentPlaylist.id);
            }
        },

        async reorderPlaylistSongsBatch(indices, targetIndex) {
            if (!this.state.currentPlaylist) return;
            // Move all items at indices to targetIndex, maintaining relative order
            const sortedIndices = [...indices].sort((a, b) => a - b);
            const songs = [...this.state.playlistSongs];
            const items = sortedIndices.map(i => songs[i]);

            // Remove items from highest index first to preserve indices
            for (const idx of [...sortedIndices].reverse()) {
                songs.splice(idx, 1);
            }

            // Calculate adjusted target (accounting for removed items before target)
            let adjustedTarget = targetIndex;
            for (const idx of sortedIndices) {
                if (idx < targetIndex) adjustedTarget--;
            }
            // Clamp to valid range
            adjustedTarget = Math.max(0, Math.min(adjustedTarget, songs.length));

            // Insert all items at target position
            songs.splice(adjustedTarget, 0, ...items);

            // Optimistically update UI
            this.state.playlistSongs = songs;
            this.state.playlistVersion++;

            // Build positions array for API
            const positions = songs.map((s, i) => ({ uuid: s.uuid, position: i }));

            try {
                await playlistsApi.reorder(this.state.currentPlaylist.id, positions);
            } catch (e) {
                console.error('Failed to batch reorder playlist:', e);
                // Reload to restore correct state
                this.loadPlaylistDetail(this.state.currentPlaylist.id);
            }
        },

        handlePlaylistDragStart(index, e) {
            // Check if dragging a selected item - enable group drag
            if (this.state.selectionMode && this.state.selectedIndices.has(index)) {
                this._groupDrag = true;
                this._draggedIndices = [...this.state.selectedIndices].sort((a, b) => a - b);
                // Add group-dragging class to all selected items
                this._draggedIndices.forEach(i => {
                    const item = this.querySelector(`.song-item[data-index="${i}"]`);
                    if (item) item.classList.add('group-dragging');
                });
            } else {
                this._groupDrag = false;
                this._draggedIndices = [index];
            }
            this._dragIndex = index;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
            e.currentTarget.classList.add('dragging');
        },

        handlePlaylistDragEnd(e) {
            e.currentTarget.classList.remove('dragging');
            // Clear all drag-over and group-dragging classes
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            this.querySelectorAll('.group-dragging').forEach(el => el.classList.remove('group-dragging'));
            this._dragIndex = null;
            this._groupDrag = false;
            this._draggedIndices = null;
        },

        handlePlaylistDragOver(index, e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Handle drag-over state here instead of dragEnter/Leave for consistency
            if (this._dragIndex !== null && this._dragIndex !== index) {
                const songItem = e.currentTarget;
                if (!songItem.classList.contains('drag-over')) {
                    // Clear previous drag-over and set new one
                    this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                    songItem.classList.add('drag-over');
                }
            }
        },

        handlePlaylistDragEnter(index, e) {
            // Handled in dragOver for consistency
        },

        handlePlaylistDragLeave(e) {
            // Only remove if leaving the container entirely
            const relatedTarget = e.relatedTarget;
            if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
                e.currentTarget.classList.remove('drag-over');
            }
        },

        async handlePlaylistDrop(index, e) {
            e.preventDefault();
            // Clear all drag-over and group-dragging classes
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            this.querySelectorAll('.group-dragging').forEach(el => el.classList.remove('group-dragging'));

            if (this._dragIndex !== null && this._dragIndex !== index) {
                if (this._groupDrag && this._draggedIndices && this._draggedIndices.length > 1) {
                    // Group drag: move all selected items
                    const sortedIndices = [...this._draggedIndices].sort((a, b) => a - b);

                    // Calculate where items will end up (same logic as reorderPlaylistSongsBatch)
                    let adjustedTarget = index;
                    for (const idx of sortedIndices) {
                        if (idx < index) adjustedTarget--;
                    }
                    adjustedTarget = Math.max(0, adjustedTarget);

                    // New positions: adjustedTarget, adjustedTarget+1, adjustedTarget+2, ...
                    const newSet = new Set();
                    for (let i = 0; i < sortedIndices.length; i++) {
                        newSet.add(adjustedTarget + i);
                    }

                    await this.reorderPlaylistSongsBatch(this._draggedIndices, index);

                    // Update selection to new positions
                    this.state.selectedIndices = newSet;
                    this.state.playlistVersion++;
                } else {
                    await this.reorderPlaylistSongs(this._dragIndex, index);
                }
            }
            this._dragIndex = null;
            this._groupDrag = false;
            this._draggedIndices = null;
        },

        // Helper to find current index of a song by UUID
        _findSongIndex(uuid) {
            return this.state.playlistSongs.findIndex(s => s.uuid === uuid);
        },

        // Touch drag on whole item in selection mode (mobile)
        // Differs from handleHandleTouchStart: doesn't preventDefault immediately,
        // allows tap-to-select while still enabling drag-to-reorder
        handleSelectionTouchStart(uuid, e) {
            const touch = e.touches[0];
            this._selectionTouchStartX = touch.clientX;
            this._selectionTouchStartY = touch.clientY;
            this._selectionDragActive = false;
            this._touchDragUuid = uuid;
            this._touchDropUuid = null;

            // Check if touching a selected item - enable group drag
            const touchedIndex = this._findSongIndex(uuid);
            if (this.state.selectedIndices.has(touchedIndex)) {
                this._touchGroupDrag = true;
                this._touchDraggedIndices = [...this.state.selectedIndices].sort((a, b) => a - b);
            } else {
                this._touchGroupDrag = false;
                this._touchDraggedIndices = null;
            }
        },

        // Touch drag on the drag handle (mobile)
        handleHandleTouchStart(uuid, e) {
            e.stopPropagation();
            e.preventDefault();
            this._touchDragUuid = uuid;
            this._touchDropUuid = null;
            this._selectionDragActive = true; // Mark as active drag

            // Check if touching a selected item - enable group drag
            const touchedIndex = this._findSongIndex(uuid);
            if (this.state.selectionMode && this.state.selectedIndices.has(touchedIndex)) {
                this._touchGroupDrag = true;
                this._touchDraggedIndices = [...this.state.selectedIndices].sort((a, b) => a - b);
                // Add group-dragging class to all selected items
                this._touchDraggedIndices.forEach(i => {
                    const item = this.querySelector(`.song-item[data-index="${i}"]`);
                    if (item) item.classList.add('group-dragging');
                });
            } else {
                this._touchGroupDrag = false;
                this._touchDraggedIndices = null;
            }

            // Add dragging class to the source item
            const sourceItem = this.querySelector(`.song-item[data-uuid="${uuid}"]`);
            if (sourceItem) {
                sourceItem.classList.add('dragging');
            }
        },

        handleHandleTouchMove(e) {
            if (!this._touchDragUuid) return;

            const touch = e.touches[0];

            // In selection mode, only activate drag after sufficient movement
            if (this.state.selectionMode && !this._selectionDragActive) {
                const dx = Math.abs(touch.clientX - this._selectionTouchStartX);
                const dy = Math.abs(touch.clientY - this._selectionTouchStartY);
                if (dx < 10 && dy < 10) return; // Not enough movement yet

                // Activate drag mode
                this._selectionDragActive = true;

                // Add dragging class to source item
                const sourceItem = this.querySelector(`.song-item[data-uuid="${this._touchDragUuid}"]`);
                if (sourceItem) sourceItem.classList.add('dragging');

                // Add group-dragging class if group drag
                if (this._touchGroupDrag && this._touchDraggedIndices) {
                    this._touchDraggedIndices.forEach(i => {
                        const item = this.querySelector(`.song-item[data-index="${i}"]`);
                        if (item) item.classList.add('group-dragging');
                    });
                }
            }

            e.stopPropagation();
            e.preventDefault();

            // Clear previous drag-over classes (query fresh from DOM)
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

            // Reset drop target - will be set if over valid target
            this._touchDropUuid = null;

            // Find which item we're over
            const elemUnder = document.elementFromPoint(touch.clientX, touch.clientY);
            if (elemUnder) {
                const songItem = elemUnder.closest('.song-item');
                if (songItem && songItem.dataset.uuid && !songItem.classList.contains('dragging')) {
                    const uuid = songItem.dataset.uuid;
                    if (uuid !== this._touchDragUuid) {
                        songItem.classList.add('drag-over');
                        this._touchDropUuid = uuid;
                    }
                }
            }
        },

        async handleHandleTouchEnd(e) {
            // In selection mode, if drag wasn't activated, let click handler handle selection
            const wasDragActive = this._selectionDragActive;
            if (this.state.selectionMode && !wasDragActive) {
                // Reset state without preventing default - click will handle selection
                this._touchDragUuid = null;
                this._touchDropUuid = null;
                this._touchGroupDrag = false;
                this._touchDraggedIndices = null;
                this._selectionDragActive = false;
                return;
            }

            e.stopPropagation();
            e.preventDefault();

            // Clear all drag classes (query fresh from DOM, not cached elements)
            this.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            this.querySelectorAll('.group-dragging').forEach(el => el.classList.remove('group-dragging'));

            // Perform the reorder if we have valid UUIDs
            if (this._touchDragUuid && this._touchDropUuid && this._touchDragUuid !== this._touchDropUuid) {
                // Look up current indices from UUIDs
                const fromIndex = this._findSongIndex(this._touchDragUuid);
                const toIndex = this._findSongIndex(this._touchDropUuid);
                if (fromIndex !== -1 && toIndex !== -1) {
                    if (this._touchGroupDrag && this._touchDraggedIndices && this._touchDraggedIndices.length > 1) {
                        // Group drag: move all selected items
                        const sortedIndices = [...this._touchDraggedIndices].sort((a, b) => a - b);

                        // Calculate where items will end up (same logic as reorderPlaylistSongsBatch)
                        let adjustedTarget = toIndex;
                        for (const idx of sortedIndices) {
                            if (idx < toIndex) adjustedTarget--;
                        }
                        adjustedTarget = Math.max(0, adjustedTarget);

                        // New positions: adjustedTarget, adjustedTarget+1, adjustedTarget+2, ...
                        const newSet = new Set();
                        for (let i = 0; i < sortedIndices.length; i++) {
                            newSet.add(adjustedTarget + i);
                        }

                        await this.reorderPlaylistSongsBatch(this._touchDraggedIndices, toIndex);

                        // Update selection to new positions
                        this.state.selectedIndices = newSet;
                        this.state.playlistVersion++;
                    } else {
                        await this.reorderPlaylistSongs(fromIndex, toIndex);
                    }
                }
            }

            this._touchDragUuid = null;
            this._touchDropUuid = null;
            this._touchGroupDrag = false;
            this._touchDraggedIndices = null;
            this._selectionDragActive = false;
        },

        // Touch long press for context menu (mobile)
        handleTouchStart(song, e) {
            if (this._longPressTimer) {
                clearTimeout(this._longPressTimer);
            }

            const touch = e.touches[0];
            this._touchStartX = touch.clientX;
            this._touchStartY = touch.clientY;

            this._longPressTimer = setTimeout(() => {
                showSongContextMenu(song, this._touchStartX, this._touchStartY);
                this._longPressTriggered = true;
            }, 500);
        },

        handleTouchMove(e) {
            if (!this._longPressTimer) return;

            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - this._touchStartX);
            const dy = Math.abs(touch.clientY - this._touchStartY);

            if (dx > 10 || dy > 10) {
                clearTimeout(this._longPressTimer);
                this._longPressTimer = null;
            }
        },

        handleTouchEnd(e) {
            if (this._longPressTimer) {
                clearTimeout(this._longPressTimer);
                this._longPressTimer = null;
            }
            if (this._longPressTriggered) {
                e.preventDefault();
                this._longPressTriggered = false;
            }
        },

        toggleAddSongs() {
            this.state.showAddSongs = !this.state.showAddSongs;
            if (!this.state.showAddSongs) {
                this.state.searchQuery = '';
                this.state.searchResults = [];
            }
        },

        handleSearchInput(e) {
            this.state.searchQuery = e.target.value;
        },

        async handleSearch(e) {
            e?.preventDefault?.();
            const query = this.state.searchQuery.trim();
            if (!query) return;

            this.state.searchLoading = true;
            try {
                const result = await songsApi.search(query, { limit: 50 });
                this.state.searchResults = result.items || [];
            } catch (e) {
                console.error('Search failed:', e);
            } finally {
                this.state.searchLoading = false;
            }
        },

        handleSearchKeyDown(e) {
            if (e.key === 'Enter') {
                this.handleSearch();
            }
        },

        async handleAddSongToPlaylist(song, e) {
            e.stopPropagation();
            if (!this.state.currentPlaylist) return;
            try {
                await playlistsApi.addSong(this.state.currentPlaylist.id, song.uuid);
                // Add to local state
                if (!this.state.playlistSongs.find(s => s.uuid === song.uuid)) {
                    this.state.playlistSongs = [...this.state.playlistSongs, song];
                }
            } catch (e) {
                console.error('Failed to add song:', e);
            }
        },

        isSongInPlaylist(song) {
            return this.state.playlistSongs.some(s => s.uuid === song.uuid);
        },

        // Render function for song list item
        renderSongItem(song, index) {
            const view = this.state.view;
            const playlistSongs = this.state.playlistSongs;
            const selectionMode = this.state.selectionMode;
            const isSelected = this.isSelected(index);

            // Placeholder for unloaded items
            if (!song) {
                return html`
                    <div class="song-item loading-placeholder">
                        <span class="song-num">${index + 1}</span>
                        <div class="song-info">
                            <div class="song-title">Loading...</div>
                        </div>
                    </div>
                `;
            }

            return html`
                <div class="song-item ${selectionMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''} ${this.isUnavailableOffline(song) ? 'unavailable' : ''}"
                     data-uuid="${song.uuid}"
                     data-index="${index}"
                     draggable="${view !== 'shared' && !this.isTouchDevice()}"
                     on-click="${(e) => selectionMode ? this.toggleSelection(index, e) : this.handleSongClick(song)}"
                     on-contextmenu="${(e) => this.handleSongContextMenu(song, e)}"
                     on-touchstart="${(e) => selectionMode ? this.handleSelectionTouchStart(song.uuid, e) : this.handleTouchStart(song, e)}"
                     on-touchmove="${(e) => selectionMode ? this.handleHandleTouchMove(e) : this.handleTouchMove(e)}"
                     on-touchend="${(e) => selectionMode ? this.handleHandleTouchEnd(e) : this.handleTouchEnd(e)}"
                     on-dragstart="${(e) => { if (!this.isTouchDevice()) this.handlePlaylistDragStart(index, e); }}"
                     on-dragend="handlePlaylistDragEnd"
                     on-dragover="${(e) => this.handlePlaylistDragOver(index, e)}"
                     on-dragenter="${(e) => this.handlePlaylistDragEnter(index, e)}"
                     on-dragleave="handlePlaylistDragLeave"
                     on-drop="${(e) => this.handlePlaylistDrop(index, e)}">
                    ${when(view !== 'shared' && selectionMode, () => html`
                        <input type="checkbox" class="selection-checkbox" checked="${isSelected}" on-click="${(e) => this.toggleSelection(index, e)}">
                    `, () => when(view !== 'shared', html`
                        <span class="drag-handle" title="Drag to reorder"
                              on-touchstart="${(e) => this.handleHandleTouchStart(song.uuid, e)}"
                              on-touchmove="${(e) => this.handleHandleTouchMove(e)}"
                              on-touchend="${(e) => this.handleHandleTouchEnd(e)}">⋮⋮</span>
                    `))}
                    <span class="song-num">${index + 1}</span>
                    <div class="song-info">
                        <div class="song-title">${song.disc_number > 1 || song.track_number ? html`<span class="track-number">${song.disc_number > 1 ? `${song.disc_number}-` : ''}${song.track_number ? String(song.track_number).padStart(2, '0') : ''}</span>` : ''}${this.getDisplayTitle(song)}</div>
                        <div class="song-meta">
                            ${when(song.artist,
                                () => html`<a class="meta-link" on-click="${(e) => { e.stopPropagation(); if (!selectionMode) navigateToArtist(song.artist); }}">${song.artist}</a>`,
                                () => html`<span class="song-artist">Unknown</span>`
                            )}
                            ${when(song.album, () => html`
                                <span> • </span>
                                <a class="meta-link" on-click="${(e) => { e.stopPropagation(); if (!selectionMode) navigateToAlbum(song.artist, song.album); }}">${song.album}</a>
                            `)}
                        </div>
                    </div>
                    ${when(view !== 'shared', html`
                        <div class="song-item-actions">
                            <button class="remove-btn"
                                    on-click="${(e) => this.handleRemoveSong(song, e)}"
                                    title="Remove">
                                ✕
                            </button>
                        </div>
                    `)}
                </div>
            `;
        },

        _setupScrollListener() {
            // Clean up old listener
            if (this._scrollHandler) {
                window.removeEventListener('scroll', this._scrollHandler, true);
            }

            // Use rafThrottle to limit scroll handler to once per animation frame
            this._scrollHandler = rafThrottle(() => this._updateVisibleRange());
            window.addEventListener('scroll', this._scrollHandler, true);

            // Initial update
            requestAnimationFrame(() => this._updateVisibleRange());
        },

        _updateVisibleRange() {
            const container = this.refs.songsContainer;
            if (!container) return;

            const itemHeight = 52; // Must match CSS
            const buffer = 40; // Extra items above/below viewport

            const rect = container.getBoundingClientRect();
            const viewportTop = Math.max(0, -rect.top);
            const viewportBottom = viewportTop + window.innerHeight;

            let startIndex = Math.max(0, Math.floor(viewportTop / itemHeight) - buffer);
            let endIndex = Math.min(
                this.state.totalCount,
                Math.ceil(viewportBottom / itemHeight) + buffer
            );

            // Clamp to actual loaded items
            const loadedCount = this.state.playlistSongs.length;
            if (loadedCount > 0) {
                startIndex = Math.min(startIndex, loadedCount - 1);
                endIndex = Math.min(endIndex, loadedCount);
            }
            endIndex = Math.max(endIndex, startIndex + 1);

            // Bottom locking: ensure visibleStart doesn't cause content to extend past container
            const renderCount = endIndex - startIndex;
            const maxVisibleStart = Math.max(0, loadedCount - renderCount);
            startIndex = Math.min(startIndex, maxVisibleStart);

            if (startIndex !== this.state.visibleStart || endIndex !== this.state.visibleEnd) {
                // Use flushSync to ensure translateY and item slice update atomically
                flushSync(() => {
                    this.state.visibleStart = startIndex;
                    this.state.visibleEnd = endIndex;
                });
            }
        },

        async _loadRemainingInBackground(playlistId, cursor) {
            // Load remaining items in background with larger batches
            let currentCursor = cursor;
            let offset = this.state.playlistSongs.filter(s => s !== null).length;

            while (currentCursor) {
                try {
                    const result = await playlistsApi.getSongs(playlistId, {
                        cursor: currentCursor,
                        limit: 500  // Larger batches for background loading
                    });

                    // Update sparse array
                    const songs = [...this.state.playlistSongs];
                    result.items.forEach((item, i) => {
                        songs[offset + i] = item;
                    });
                    this.state.playlistSongs = songs;
                    this.state.hasMore = result.hasMore;

                    offset += result.items.length;
                    currentCursor = result.nextCursor;
                } catch (e) {
                    console.error('Background loading failed:', e);
                    break;
                }
            }
        }
    },

    template() {
        const { view, tab, myPlaylists, publicPlaylists, currentPlaylist, playlistSongs,
                isLoading, isAuthenticated, showCreateDialog, showShareDialog, shareToken,
                newPlaylistName, newPlaylistDesc, newPlaylistPublic, hasMore, totalCount,
                visibleStart, visibleEnd,
                showAddSongs, searchQuery, searchResults, searchLoading,
                isSorting, showSortMenu } = this.state;

        // List View
        if (view === 'list') {
            return html`
                <div class="playlists-page">
                    <!-- Tabs -->
                    <div class="tabs">
                        <button class="tab ${tab === 'my' ? 'active' : ''}"
                                on-click="${() => this.handleTabChange('my')}">
                            My Playlists
                        </button>
                        <button class="tab ${tab === 'public' ? 'active' : ''}"
                                on-click="${() => this.handleTabChange('public')}">
                            Discover
                        </button>
                    </div>

                    ${when(tab === 'my', html`
                        ${when(!isAuthenticated, html`
                            <div class="auth-prompt">
                                <p>Please <router-link to="/login/">log in</router-link> to manage your playlists</p>
                            </div>
                        `, html`
                            <div class="create-section">
                                <cl-button severity="primary" icon="+" on-click="openCreateDialog">
                                    Create Playlist
                                </cl-button>
                            </div>

                            ${when(isLoading && myPlaylists.length === 0, html`
                                <div class="loading"><cl-spinner></cl-spinner></div>
                            `, html`
                                ${when(myPlaylists.length === 0, html`
                                    <div class="empty">
                                        <p>No playlists yet. Create your first one!</p>
                                    </div>
                                `, html`
                                    <div class="playlist-list">
                                        ${each(myPlaylists, playlist => html`
                                            <div class="playlist-item" on-click="${() => this.handlePlaylistClick(playlist)}">
                                                <div class="playlist-icon">📋</div>
                                                <div class="playlist-info">
                                                    <div class="playlist-name">${playlist.name}</div>
                                                    <div class="playlist-meta">
                                                        ${playlist.song_count} songs
                                                        ${playlist.is_public ? ' • Public' : ''}
                                                    </div>
                                                </div>
                                                <div class="playlist-actions" on-click="${(e) => e.stopPropagation()}">
                                                    <playlist-download-btn
                                                        playlistId="${playlist.id}"
                                                        playlistName="${playlist.name}">
                                                    </playlist-download-btn>
                                                </div>
                                                <button class="delete-btn"
                                                        on-click="${(e) => this.handleDeletePlaylist(playlist, e)}"
                                                        title="Delete">
                                                    ✕
                                                </button>
                                            </div>
                                        `)}
                                    </div>
                                `)}
                            `)}
                        `)}
                    `, html`
                        <!-- Public Playlists -->
                        ${when(isLoading && publicPlaylists.length === 0, html`
                            <div class="loading"><cl-spinner></cl-spinner></div>
                        `, html`
                            ${when(publicPlaylists.length === 0, html`
                                <div class="empty">
                                    <p>No public playlists yet</p>
                                </div>
                            `, html`
                                <div class="playlist-list">
                                    ${each(publicPlaylists, playlist => html`
                                        <div class="playlist-item" on-click="${() => this.handlePlaylistClick(playlist)}">
                                            <div class="playlist-icon">📋</div>
                                            <div class="playlist-info">
                                                <div class="playlist-name">${playlist.name}</div>
                                                <div class="playlist-meta">
                                                    ${playlist.song_count} songs • by ${playlist.user_id}
                                                </div>
                                            </div>
                                            <div class="playlist-actions" on-click="${(e) => e.stopPropagation()}">
                                                <playlist-download-btn
                                                    playlistId="${playlist.id}"
                                                    playlistName="${playlist.name}">
                                                </playlist-download-btn>
                                            </div>
                                        </div>
                                    `)}
                                </div>
                            `)}
                        `)}
                    `)}

                    <!-- Create Dialog -->
                    ${when(showCreateDialog, html`
                        <cl-dialog visible="true" header="Create Playlist"
                            on-change="${(e, val) => { if (!val) this.closeCreateDialog(); }}">
                            <div class="dialog-form">
                                <div class="form-row">
                                    <label>Name</label>
                                    <input type="text" x-model="newPlaylistName">
                                </div>
                                <div class="form-row">
                                    <label>Description</label>
                                    <textarea rows="3" x-model="newPlaylistDesc">
                                    </textarea>
                                </div>
                                <div class="form-row checkbox">
                                    <label>
                                        <input type="checkbox" x-model="newPlaylistPublic">
                                        Make public
                                    </label>
                                </div>
                            </div>
                            <div slot="footer">
                                <cl-button severity="secondary" on-click="closeCreateDialog">Cancel</cl-button>
                                <cl-button severity="primary" on-click="handleCreatePlaylist">Create</cl-button>
                            </div>
                        </cl-dialog>
                    `)}

                    ${when(this.state.confirmDialog.show, () => html`
                        <cl-dialog visible="true" header="${this.state.confirmDialog.title}" on-close="handleConfirmDialogCancel">
                            <p>${this.state.confirmDialog.message}</p>
                            <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                                <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                                <cl-button severity="danger" on-click="handleConfirmDialogConfirm">Delete</cl-button>
                            </div>
                        </cl-dialog>
                    `)}
                </div>
            `;
        }

        // Detail View
        const hasSelection = this.state.selectionMode && this.state.selectedIndices.size > 0;
        return html`
            <div class="playlists-page detail-view ${hasSelection ? 'has-selection' : ''}">
                <button class="back-btn" on-click="handleBackToList">← Back to Playlists</button>

                ${when(currentPlaylist, () => html`
                    <div class="playlist-header">
                        <h1>${currentPlaylist.name}</h1>
                        ${when(currentPlaylist.description, html`
                            <p class="description">${currentPlaylist.description}</p>
                        `)}
                        <div class="playlist-stats">
                            ${this.getSongCountDisplay(totalCount, currentPlaylist)}
                            ${currentPlaylist.is_public ? ' • Public' : ''}
                        </div>
                    </div>

                    <div class="playlist-actions detail-actions">
                        <cl-button severity="primary" icon="▶️" on-click="handlePlayAll">Play All</cl-button>
                        <cl-button severity="secondary" icon="🔀" on-click="handleShuffleAll">Shuffle</cl-button>
                        <cl-button severity="secondary" icon="📻" on-click="handleStartRadio">Radio</cl-button>
                        ${when(view !== 'shared' && isAuthenticated, () => html`
                            <cl-button severity="secondary" icon="➕" on-click="toggleAddSongs">
                                ${showAddSongs ? 'Done Adding' : 'Add Songs'}
                            </cl-button>
                            <div class="sort-dropdown">
                                <cl-button severity="secondary" on-click="toggleSortMenu"
                                           disabled="${isSorting}">
                                    ${isSorting ? '⏳' : '↕️'} Sort
                                </cl-button>
                                ${when(showSortMenu, () => html`
                                    <div class="sort-menu" on-click-outside-stop="closeSortMenu">
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('artist')}">
                                            Artist (A-Z)
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('album')}">
                                            Album (A-Z)
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('track')}">
                                            Track Order
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('title')}">
                                            Title (A-Z)
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('year')}">
                                            Year (Oldest)
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('year', 'desc')}">
                                            Year (Newest)
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('duration')}">
                                            Duration (Short)
                                        </button>
                                        <button class="sort-option" on-click="${() => this.handleSortPlaylist('random')}">
                                            🔀 Shuffle
                                        </button>
                                    </div>
                                `)}
                            </div>
                            <cl-button severity="secondary" icon="🔗" on-click="handleShare">Share</cl-button>
                            <cl-button severity="${this.state.selectionMode ? 'primary' : 'secondary'}"
                                       on-click="toggleSelectionMode">
                                ${this.state.selectionMode ? '☑ Done' : '☑ Select'}
                            </cl-button>
                            <cl-button severity="${currentPlaylist.is_public ? 'success' : 'secondary'}"
                                       on-click="handleTogglePublic">
                                ${currentPlaylist.is_public ? '🌐 Public' : '🔒 Private'}
                            </cl-button>
                        `)}
                        ${when(view === 'shared' && isAuthenticated, html`
                            <cl-button severity="secondary" icon="📥" on-click="handleClone">Clone to My Playlists</cl-button>
                        `)}
                        <playlist-download-btn
                            playlistId="${currentPlaylist.id}"
                            playlistName="${currentPlaylist.name}"
                            variant="full">
                        </playlist-download-btn>
                    </div>

                    <!-- Add Songs Search Panel -->
                    ${when(showAddSongs, () => html`
                        <div class="add-songs-panel">
                            <div class="search-box">
                                <input type="text"
                                       class="search-input"
                                       placeholder="Search songs to add..."
                                       x-model="searchQuery"
                                       on-keydown="handleSearchKeyDown">
                                <cl-button severity="primary" on-click="handleSearch" loading="${searchLoading}">
                                    Search
                                </cl-button>
                            </div>

                            ${when(searchResults.length > 0, () => html`
                                <div class="search-results">
                                    ${each(searchResults, song => html`
                                        <div class="search-result-item">
                                            <div class="song-info">
                                                <div class="song-title">${this.getDisplayTitle(song)}</div>
                                                <div class="song-meta">
                                                    ${when(song.artist,
                                                        () => html`<a class="meta-link" on-click="${(e) => { e.stopPropagation(); navigateToArtist(song.artist); }}">${song.artist}</a>`,
                                                        () => html`<span>Unknown</span>`
                                                    )}
                                                </div>
                                            </div>
                                            ${when(this.isSongInPlaylist(song),
                                                html`<span class="added-badge">✓ Added</span>`,
                                                () => html`
                                                    <button class="add-song-btn"
                                                            on-click="${(e) => this.handleAddSongToPlaylist(song, e)}">
                                                        + Add
                                                    </button>
                                                `
                                            )}
                                        </div>
                                    `)}
                                </div>
                            `)}
                        </div>
                    `)}

                    ${when(isLoading && playlistSongs.length === 0, html`
                        <div class="loading"><cl-spinner></cl-spinner></div>
                    `, html`
                        ${when(totalCount === 0, () => html`
                            <div class="empty">${this.getEmptyMessage(currentPlaylist)}</div>
                        `, () => {
                            const itemHeight = 52;
                            const visibleSongs = playlistSongs.slice(visibleStart, visibleEnd);
                            const loadedCount = playlistSongs.filter(s => s !== null).length;

                            return html`
                                <div class="songs-container" ref="songsContainer"
                                     style="height: ${totalCount * itemHeight}px; position: relative;">
                                    <div class="songs-list" style="position: absolute; top: ${visibleStart * itemHeight}px; left: 0; right: 0;">
                                        ${memoEach(visibleSongs, (song, idx) => {
                                            const actualIndex = visibleStart + idx;
                                            return this.renderSongItem(song, actualIndex);
                                        }, (song, idx) => `${song?.uuid ?? `loading-${idx}`}-${this.state.playlistVersion ?? 0}`, { trustKey: true })}
                                    </div>
                                </div>
                            `;
                        })}
                    `)}

                    <!-- Selection Action Bar -->
                    ${when(this.state.selectionMode && this.state.selectedIndices.size > 0, () => html`
                        <div class="selection-bar">
                            <span class="selection-count">${this.state.selectedIndices.size}</span>
                            <div class="selection-actions">
                                <button class="selection-btn" on-click="selectAll">All</button>
                                <button class="selection-btn" on-click="clearSelection">None</button>
                                <button class="selection-btn" on-click="handleAddSelectedToQueue">Queue</button>
                                <button class="selection-btn" on-click="handleDownloadSelected"
                                        disabled="${this.state.isDownloadingSelection}">
                                    ${this.state.isDownloadingSelection ? '...' : 'DL'}
                                </button>
                                <button class="selection-btn danger" on-click="handleDeleteSelected">Del</button>
                            </div>
                        </div>
                    `)}
                `)}

                <!-- Share Dialog -->
                ${when(showShareDialog, html`
                    <cl-dialog visible="true" header="Share Playlist"
                        on-change="${(e, val) => { if (!val) this.closeShareDialog(); }}">
                        <p>Share this link with others:</p>
                        <div class="share-link">
                            <input type="text" readonly
                                   value="${window.location.origin}${window.location.pathname.replace(/\/$/, '')}/#/share/${shareToken}/">
                            <cl-button severity="primary" on-click="copyShareLink">Copy</cl-button>
                        </div>
                    </cl-dialog>
                `)}

                <scroll-to-top></scroll-to-top>

                ${when(this.state.confirmDialog.show, () => html`
                    <cl-dialog visible="true" header="${this.state.confirmDialog.title}" on-close="handleConfirmDialogCancel">
                        <p>${this.state.confirmDialog.message}</p>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                            <cl-button severity="danger" on-click="handleConfirmDialogConfirm">Delete</cl-button>
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

        .playlists-page {
            padding: 1rem;
            max-width: 800px;
            margin: 0 auto;
        }

        /* Tabs */
        .tabs {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .tab {
            flex: 1;
            padding: 0.75rem 1rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
            transition: background 0.2s;
        }

        .tab:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .tab.active {
            background: var(--selected-bg, #1e3a5f);
            border-color: var(--primary-400, #42a5f5);
        }

        /* Auth Prompt */
        .auth-prompt {
            text-align: center;
            padding: 3rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .auth-prompt a {
            color: var(--primary-400, #42a5f5);
        }

        /* Create Section */
        .create-section {
            margin-bottom: 1rem;
        }

        /* Loading / Empty */
        .loading,
        .empty {
            text-align: center;
            padding: 3rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Playlist List */
        .playlist-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .playlist-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-50, #1a1a1a);
            border: 1px solid var(--surface-200, #2d2d2d);
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.2s;
        }

        .playlist-item:hover {
            background: var(--surface-100, #242424);
        }

        .playlist-icon {
            font-size: 1.5rem;
        }

        .playlist-info {
            flex: 1;
        }

        .playlist-name {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
        }

        .playlist-meta {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .playlist-actions {
            display: flex;
            align-items: center;
            margin-left: auto;
            margin-right: 0.5rem;
        }

        .playlist-actions.detail-actions {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            margin: 0.5rem 0;
            margin-left: 0;
            margin-right: 0;
        }

        .delete-btn {
            background: none;
            border: none;
            cursor: pointer;
            padding: 0.5rem;
            color: var(--text-primary, #ffffff);
            font-size: 1.25rem;
        }

        .delete-btn:hover {
            color: var(--danger-500, #ef4444);
        }

        /* Dialog Form */
        .dialog-form {
            padding: 1rem 0;
        }

        .form-row {
            margin-bottom: 1rem;
        }

        .form-row label {
            display: block;
            font-weight: 500;
            margin-bottom: 0.25rem;
        }

        .form-row input[type="text"],
        .form-row textarea {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .form-row.checkbox label {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            cursor: pointer;
        }

        /* Detail View */
        .detail-view .back-btn {
            background: none;
            border: none;
            color: var(--primary-400, #42a5f5);
            cursor: pointer;
            padding: 0.5rem 0;
            margin-bottom: 1rem;
        }

        .playlist-header h1 {
            margin: 0 0 0.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .playlist-header .description {
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 0.5rem;
        }

        .playlist-stats {
            font-size: 0.875rem;
            color: var(--text-muted, #707070);
        }

        .playlist-actions {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            margin: 0.5rem 0;
        }

        /* Sort Dropdown */
        .sort-dropdown {
            position: relative;
        }

        .sort-menu {
            position: absolute;
            top: 100%;
            left: 0;
            z-index: 100;
            margin-top: 0.25rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            min-width: 150px;
            overflow: hidden;
        }

        .sort-option {
            display: block;
            width: 100%;
            padding: 0.625rem 1rem;
            border: none;
            background: none;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.8125rem;
            text-align: left;
            cursor: pointer;
            transition: background 0.15s;
        }

        .sort-option:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .sort-option:not(:last-child) {
            border-bottom: 1px solid var(--surface-300, #404040);
        }

        /* Songs List */
        .songs-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        /* Songs container - spacer for virtual scroll */
        .songs-container {
            border-radius: 8px;
            background: var(--surface-50, #1a1a1a);
        }

        .songs-list {
            display: flex;
            flex-direction: column;
        }

        .songs-status {
            text-align: center;
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            padding: 0.5rem;
            position: sticky;
            bottom: 0;
            background: var(--surface-100, #242424);
        }

        .loading-placeholder {
            opacity: 0.5;
        }

        .loading-placeholder .song-title {
            color: var(--text-muted, #707070);
            font-style: italic;
        }

        .song-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0 0.75rem;
            height: 52px;  /* Must match itemHeight in JS */
            box-sizing: border-box;
            background: var(--surface-50, #1a1a1a);
            cursor: pointer;
            transition: background 0.2s;
        }

        .song-item:hover {
            background: var(--surface-100, #242424);
        }

        .song-item.unavailable {
            opacity: 0.5;
        }

        .song-item.unavailable .song-title {
            color: var(--text-muted, #707070);
        }

        .song-num {
            width: 2rem;
            text-align: center;
            color: var(--text-muted, #707070);
            font-size: 0.875rem;
        }

        .song-info {
            flex: 1;
            min-width: 0;
            overflow: hidden;
        }

        .song-title {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text-primary, #e0e0e0);
        }

        .track-number {
            color: var(--text-muted, #707070);
            font-size: 0.85em;
            margin-right: 0.5em;
            font-weight: 400;
        }

        .song-artist {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .song-meta {
            display: block;
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .song-meta a,
        .song-meta span {
            white-space: nowrap;
        }

        .meta-link {
            color: var(--text-secondary, #a0a0a0);
            text-decoration: none;
            cursor: pointer;
            transition: color 0.15s;
        }

        .meta-link:hover {
            color: var(--primary-400, #42a5f5);
            text-decoration: underline;
        }

        .remove-btn {
            background: none;
            border: none;
            cursor: pointer;
            opacity: 0;
            padding: 0.5rem;
            color: var(--text-muted, #707070);
            transition: opacity 0.2s;
        }

        .song-item:hover .remove-btn {
            opacity: 1;
        }

        .remove-btn:hover {
            color: var(--danger-500, #dc3545);
        }

        /* Drag handle */
        .drag-handle {
            cursor: grab;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.75rem;
            padding: 0 0.25rem;
            opacity: 0;
            transition: opacity 0.15s;
            user-select: none;
        }

        .song-item:hover .drag-handle {
            opacity: 1;
        }

        /* Drag states */
        .song-item.dragging {
            opacity: 0.5;
            background: var(--surface-200, #2d2d2d);
        }

        .song-item.drag-over {
            border-top: 2px solid var(--primary-500, #0066cc);
            margin-top: -2px;
        }

        /* Selection mode styles */
        .song-item.selectable {
            cursor: pointer;
        }

        .song-item.selected {
            background: var(--primary-900, #1e3a5f);
        }

        .song-item.selected:hover {
            background: var(--primary-800, #2a4a70);
        }

        .selection-checkbox {
            width: 20px;
            height: 20px;
            margin-right: 8px;
            cursor: pointer;
            accent-color: var(--primary-500, #0066cc);
            flex-shrink: 0;
        }

        .selection-bar {
            position: fixed;
            bottom: 1rem;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            padding: 0.75rem 1.5rem;
            background: var(--surface-200, #2d2d2d);
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 100;
            max-width: calc(100% - 2rem);
        }

        /* Add bottom padding when selection bar is visible */
        .playlists-page.has-selection {
            padding-bottom: 5rem;
        }

        .selection-count {
            font-weight: 600;
            color: var(--text-primary, #fff);
        }

        .selection-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            justify-content: center;
        }

        .selection-btn {
            padding: 0.375rem 0.75rem;
            background: var(--surface-300, #404040);
            border: none;
            border-radius: 4px;
            color: var(--text-primary, #fff);
            cursor: pointer;
            font-size: 0.875rem;
            transition: background 0.2s;
        }

        .selection-btn:hover {
            background: var(--surface-400, #555);
        }

        .selection-btn.danger {
            background: var(--danger-500, #dc3545);
        }

        .selection-btn.danger:hover {
            background: var(--danger-600, #c82333);
        }

        /* Group drag visual feedback */
        .song-item.group-dragging {
            opacity: 0.7;
            background: var(--primary-800, #2a4a70);
        }

        /* Song item actions container */
        .song-item-actions {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            opacity: 0;
            transition: opacity 0.15s;
        }

        .song-item:hover .song-item-actions {
            opacity: 1;
        }

        /* Mobile: always show actions and drag handle */
        @media (max-width: 767px) {
            .song-item {
                user-select: none;
                -webkit-user-select: none;
            }

            /* Disable artist/album links on mobile to prevent accidental taps */
            .meta-link {
                pointer-events: none;
                cursor: default;
            }

            .drag-handle {
                display: flex;
                touch-action: none;
                padding: 0.75rem 0.5rem;
                opacity: 1;
            }

            .song-item-actions {
                opacity: 1;
            }
        }

        /* Share Dialog */
        .share-link {
            display: flex;
            gap: 0.5rem;
        }

        .share-link input {
            flex: 1;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        /* Infinite scroll sentinel */
        .load-more-sentinel {
            text-align: center;
            padding: 1rem;
            min-height: 50px;
        }

        /* Add Songs Panel */
        .add-songs-panel {
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 1rem;
        }

        .add-songs-panel .search-box {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .add-songs-panel .search-input {
            flex: 1;
            padding: 0.5rem 0.75rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-50, #1a1a1a);
            color: var(--text-primary, #e0e0e0);
        }

        .search-results {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .search-result-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-50, #1a1a1a);
            border-radius: 4px;
        }

        .search-result-item .song-info {
            flex: 1;
            overflow: hidden;
        }

        .search-result-item .song-title {
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
        }

        .search-result-item .song-artist {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .add-song-btn {
            background: var(--primary-500, #2196f3);
            color: white;
            border: none;
            border-radius: 4px;
            padding: 0.25rem 0.75rem;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .add-song-btn:hover {
            background: var(--primary-600, #1e88e5);
        }

        .added-badge {
            color: var(--success-500, #22c55e);
            font-size: 0.875rem;
        }

        .create-section {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
        }

        /* Mobile */
        @media (max-width: 767px) {
            .playlists-page {
                padding: 0.5rem;
            }

            .delete-btn,
            .remove-btn {
                opacity: 1;
            }
        }
    `
});

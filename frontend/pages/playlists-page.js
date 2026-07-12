/**
 * Playlists Page
 *
 * Playlist management:
 * - My Playlists list
 * - Public playlists discovery
 * - Playlist detail view
 * - Sharing functionality
 */

import { defineComponent, html, when, each, memoEach, untracked, Component } from 'vdx/framework.js';
import { createWindowing } from 'vdx/windowing.js';
import { createRowGestures } from 'vdx/gestures.js';
import { songs as songsApi, playlists as playlistsApi, auth, ai } from '../offline/offline-api.js';
import { profile } from '#profile';
import offlineStore, { shouldShowOfflineWarnings, setDownloadProgress, computeOfflineFilterSets, shouldUseOffline } from '../offline/offline-store.js';
import { downloadSong, canCacheOffline } from '../offline/offline-audio.js';
import { player } from '../stores/player-store.js';
import { showSongContextMenu, navigateToArtist, navigateToAlbum } from '../components/song-context-menu.js';
import '../components/scroll-to-top.js';
import '../components/playlist-download-btn.js';
import 'vdxui/button/button.js';
import 'vdxui/overlay/dialog.js';
import 'vdxui/misc/spinner.js';

export class PlaylistsPage extends Component {
    static props = {
        params: {}  // { id } for playlist detail, { token } for shared
    }

    constructor(props) {
        super(props);

        // Windowing controller owns the visible-range state and scroll/resize
        // plumbing. Created in data() so its state exists for the first render.
        // The detail view scrolls the window; measured against the songs spacer.
        this._win = createWindowing(this, {
            itemHeight: 52,
            buffer: 40,
            count: () => this.state.playlistSongs.length,
            scrollContainer: 'window',
            measureElement: () => this.refs.songsContainer
        });

        // Row-gesture controller: desktop drag-reorder, long-press context menu,
        // and touch drag (drag-handle in normal mode; selected-row body in
        // selection mode). All state is INDEX-based - playlists allow duplicate
        // songs, so uuid->index resolution finds the wrong copy. 'pointer' touch
        // targeting preserves the hovered-row gap the reorder call sites expect;
        // reorderPlaylistSongs/Batch receive the gap directly (they do their own
        // remove-shift), so no gapToRemoveInsertIndex translation here.
        this._g = createRowGestures(this, {
            itemHeight: 52,
            count: () => this.state.playlistSongs.length,
            rowClass: 'song-item',
            rowSelector: (i) => `.song-item[data-index="${i}"]`,
            touchTarget: 'pointer',
            excludeSelector: '.selection-checkbox',
            activationThreshold: 16,
            canDrag: (i) => this.state.selectedIndices.has(i),
            selection: {
                isSelected: (i) => this.state.selectionMode && this.state.selectedIndices.has(i),
                indices: () => [...this.state.selectedIndices]
            },
            onTap: (index, e) => {
                if (this.state.selectionMode) {
                    this.toggleSelection(index, e);
                } else {
                    const song = this.state.playlistSongs[index];
                    if (song) this.handleSongClick(song);
                }
            },
            onLongPress: (index, e) => {
                const song = this.state.playlistSongs[index];
                const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
                if (song && t) showSongContextMenu(song, t.clientX, t.clientY);
            },
            onContextMenu: (index, e) => {
                e.preventDefault();
                e.stopPropagation();
                const song = this.state.playlistSongs[index];
                if (song) showSongContextMenu(song, e.clientX, e.clientY);
            },
            onReorder: (fromIndices, gap) => {
                if (fromIndices.length > 1) {
                    // Group drag: reorderPlaylistSongsBatch treats the target as a
                    // gap and does the remove-shift internally. Remap the
                    // selection to the landed contiguous positions.
                    const sorted = [...fromIndices].sort((a, b) => a - b);
                    let adjustedTarget = gap;
                    for (const idx of sorted) if (idx < gap) adjustedTarget--;
                    adjustedTarget = Math.max(0, Math.min(adjustedTarget, this.state.playlistSongs.length - sorted.length));
                    const newSet = new Set();
                    for (let i = 0; i < sorted.length; i++) newSet.add(adjustedTarget + i);
                    this.reorderPlaylistSongsBatch(fromIndices, gap);
                    this.state.selectedIndices = newSet;
                    this.state.playlistVersion++;
                } else {
                    this.reorderPlaylistSongs(fromIndices[0], gap);
                }
            }
        });

        this.state = {
            view: 'list',           // 'list', 'detail', 'shared'
            tab: 'my',              // 'my', 'public'
            myPlaylists: [],
            publicPlaylists: [],
            currentPlaylist: null,
            playlistSongs: untracked([]),  // Large list - untracked for performance
            playlistVersion: 0,  // Bumped on reorder to invalidate memoEach cache
            isLoading: false,
            detailError: null,      // Error message for detail/shared load failures
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
            // Search state
            showAddSongs: false,
            searchQuery: '',
            searchResults: [],
            searchLoading: false,
            // Import state
            showImportDialog: false,
            importMode: 'new',  // 'new' or 'append'
            importTargetPlaylist: null,
            importNewName: '',
            importFile: null,
            importProgress: null,  // { completed, total } or null
            importError: null,
            // Sorting state
            isSorting: false,
            showSortMenu: false,
            // Selection mode
            selectionMode: false,
            selectedIndices: new Set(),
            isDownloadingSelection: false,
            // Confirm dialog
            confirmDialog: { show: false, title: '', message: '', action: null },
            pendingDeletePlaylist: null,
            // AI Extend dialog
            aiEnabled: false,
            showExtendDialog: false,
            extendCount: 10,
            extendDiversity: 0.3,
            isExtending: false,
            extendError: null,
            // Clone/Rename dialogs
            showRenameDialog: false,
            renameNewName: '',
            isRenaming: false,
            renameError: null,
            showCloneDialog: false,
            cloneNewName: '',
            isCloning: false,
            cloneError: null
        };
    }

    async mounted() {
        this._isMounted = true;

        // Register the listener BEFORE any awaits so a fast unmount during the async
        // work below doesn't cause the listener to register after unmount and leak.
        this._playlistsChangedHandler = () => this.loadPlaylists(true);
        window.addEventListener('playlists-changed', this._playlistsChangedHandler);

        // Honor deep-link params synchronously so a direct link to /playlists/5/ shows
        // the detail (or its loading state) immediately instead of flashing the list.
        const { id, token } = this.props.params || {};
        if (token) {
            this.state.view = 'shared';
            this.loadSharedPlaylist(token);  // byToken doesn't need the playlist list
        } else if (id) {
            this.state.view = 'detail';
            this.state.isLoading = true;  // render the loading indicator right away
        }

        // Check auth
        try {
            const result = await auth.checkUser();
            if (!this._isMounted) return;
            this.state.isAuthenticated = result.authenticated;
        } catch (e) {
            console.error('Auth check failed:', e);
        }

        // Check AI status (normalized adapter -> { available }); gates Extend AI
        try {
            const aiStatus = await ai.status();
            if (!this._isMounted) return;
            this.state.aiEnabled = aiStatus.available;
        } catch (e) {
            console.error('AI status check failed:', e);
            this.state.aiEnabled = false;
        }

        // Always load playlists first with force refresh (catches playlists created on other devices)
        await this.loadPlaylists(true);
        if (!this._isMounted) return;

        // Now that playlist metadata is available, load the deep-linked detail
        if (!token && id) {
            this.loadPlaylistDetail(id);
        }
    }

    unmounted() {
        this._isMounted = false;
        this._win.destroy();
        this._g.destroy();
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }
        if (this._playlistsChangedHandler) {
            window.removeEventListener('playlists-changed', this._playlistsChangedHandler);
        }
    }

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
                    if (!this._isMounted) return;
                }
                this.state.view = 'detail';
                this.loadPlaylistDetail(id);
            } else {
                // Navigating to list view - always refresh
                this.state.view = 'list';
                this.loadPlaylists(true);
            }
        }
    }

    // Selection mode methods
    toggleSelectionMode() {
        // No playlistVersion bump: selection mode/state live in the
        // memoEach key, so only rows whose key bits change re-render.
        this.state.selectionMode = !this.state.selectionMode;
        if (!this.state.selectionMode) {
            this.clearSelection();
        }
    }

    isSelected(index) {
        return this.state.selectedIndices.has(index);
    }

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
        // No version bump: the per-row selected bit in the memoEach key
        // re-renders exactly the toggled row(s).
    }

    selectAll() {
        const songs = this.state.playlistSongs;
        const newSet = new Set();
        for (let i = 0; i < songs.length; i++) {
            if (songs[i]) newSet.add(i);
        }
        this.state.selectedIndices = newSet;
    }

    clearSelection() {
        this.state.selectedIndices = new Set();
        this._lastSelectedIndex = undefined;
    }

    async handleDeleteSelected() {
        if (!this.state.currentPlaylist) return;
        const indices = [...this.state.selectedIndices];
        if (indices.length === 0) return;

        const songs = this.state.playlistSongs;
        // Keep uuids and indices aligned: `indices` addresses the exact rows
        // (duplicate-safe removal of only the selected copies); `songUuids`
        // is kept for the legacy/verification path.
        const validIndices = indices.filter(i => songs[i]?.uuid);
        const songUuids = validIndices.map(i => songs[i].uuid);

        if (songUuids.length === 0) return;

        try {
            await playlistsApi.removeSongs(this.state.currentPlaylist.id, songUuids, validIndices);

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
    }

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
    }

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
    }

    getDisplayTitle(song) {
        if (!song) return 'Unknown';
        if (song.title) return song.title;
        // Fallback to filename without extension
        const path = song.virtual_file || song.file || '';
        const filename = path.split('/').pop() || '';
        return filename.replace(/\.[^.]+$/, '') || 'Unknown';
    }

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
    }

    getEmptyMessage(playlist) {
        const isOffline = shouldShowOfflineWarnings();
        const originalCount = playlist?.song_count || 0;

        if (isOffline && originalCount > 0) {
            return `${originalCount} songs unavailable offline`;
        }
        return 'No songs in playlist';
    }

    // Latest-wins load: run() aborts the prior load so a slower earlier
    // response (mount / playlists-changed / propsChanged) can't overwrite a
    // newer one. Replaces the hand-rolled _listRequestId guard. This is a
    // single-fetch flow (no background pagination), so it's a clean createTask.
    _loadPlaylistsTask = this.createTask(async (signal, forceRefresh) => {
        this.state.isLoading = true;
        try {
            if (this.state.isAuthenticated) {
                const result = await playlistsApi.list(forceRefresh);
                signal.throwIfAborted();
                this.state.myPlaylists = result.items || [];
            }
        } catch (e) {
            if (signal.aborted) throw e;  // superseded: let the task swallow the abort
            console.error('Failed to load playlists:', e);
        } finally {
            if (!signal.aborted) this.state.isLoading = false;
        }
    });

    loadPlaylists(forceRefresh = false) {
        return this._loadPlaylistsTask.run(forceRefresh);
    }

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
    }

    async loadPlaylistDetail(id) {
        // Request-ID guard shared with loadSharedPlaylist (both fill the same detail
        // view). Navigating /playlists/5/ → /playlists/7/ quickly must not let the
        // slower response overwrite the newer playlist's data.
        const requestId = this._detailRequestId = (this._detailRequestId || 0) + 1;
        this.state.isLoading = true;
        this.state.detailError = null;
        this.state.cursor = null;
        // Clear selection when switching playlists
        this.state.selectionMode = false;
        this.state.selectedIndices = new Set();
        try {
            // Get first batch with totalCount
            const result = await playlistsApi.getSongs(id, { limit: 100 });
            if (this._detailRequestId !== requestId) return;  // Stale
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
                    if (this._detailRequestId !== requestId) return;  // Stale
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

            // Recompute the window once the new list has rendered
            requestAnimationFrame(() => this._win.refresh());

            // Start background loading of remaining items
            if (result.hasMore) {
                this._loadRemainingInBackground(id, result.nextCursor);
            }
        } catch (e) {
            if (this._detailRequestId !== requestId) return;  // Stale
            console.error('Failed to load playlist:', e);
            this.state.detailError = "Couldn't load playlist — check your connection.";
        } finally {
            if (this._detailRequestId === requestId) this.state.isLoading = false;
        }
    }

    async loadSharedPlaylist(token) {
        // Shares the detail request-ID counter with loadPlaylistDetail (same view).
        const requestId = this._detailRequestId = (this._detailRequestId || 0) + 1;
        this.state.isLoading = true;
        this.state.detailError = null;
        this.state.cursor = null;
        try {
            const playlist = await playlistsApi.byToken(token);
            if (this._detailRequestId !== requestId) return;  // Stale
            if (playlist.error) {
                this.state.detailError = 'This shared playlist link is invalid or has expired.';
                return;
            }
            this.state.currentPlaylist = playlist;

            // Token-scoped songs endpoint: the share view is typically
            // anonymous, and getSongs requires a logged-in user.
            const result = await playlistsApi.getSongsByToken(token, { limit: 100 });
            if (this._detailRequestId !== requestId) return;  // Stale
            if (result.error) {
                this.state.detailError = 'This shared playlist link is invalid or has expired.';
                return;
            }
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

            // Recompute the window once the new list has rendered
            requestAnimationFrame(() => this._win.refresh());

            if (result.hasMore) {
                this._loadRemainingInBackground(playlist.id, result.nextCursor, token);
            }
        } catch (e) {
            if (this._detailRequestId !== requestId) return;  // Stale
            console.error('Failed to load shared playlist:', e);
            this.state.detailError = 'This shared playlist link is invalid or has expired.';
        } finally {
            if (this._detailRequestId === requestId) this.state.isLoading = false;
        }
    }

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
    }

    handleTabChange(tab) {
        this.state.tab = tab;
        if (tab === 'public') {
            this.loadPublicPlaylists();
        }
    }

    handlePlaylistClick(playlist) {
        window.location.hash = `/playlists/${playlist.id}/`;
    }

    handleBackToList() {
        this.state.view = 'list';
        this.state.currentPlaylist = null;
        this.state.detailError = null;
        this.state.playlistSongs = [];
        // Clear selection when leaving detail view
        this.state.selectionMode = false;
        this.state.selectedIndices = new Set();
        window.location.hash = '/playlists/';
    }

    openCreateDialog() {
        this.state.showCreateDialog = true;
        this.state.newPlaylistName = '';
        this.state.newPlaylistDesc = '';
        this.state.newPlaylistPublic = false;
    }

    closeCreateDialog() {
        this.state.showCreateDialog = false;
    }

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
    }

    handleDeletePlaylist(playlist, e) {
        e.stopPropagation();
        this.state.pendingDeletePlaylist = playlist;
        this.showConfirmDialog(
            'Delete Playlist',
            `Delete "${playlist.name}"?`,
            'deletePlaylist'
        );
    }

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
    }

    showConfirmDialog(title, message, action) {
        this.state.confirmDialog = { show: true, title, message, action };
    }

    handleConfirmDialogConfirm() {
        const { action } = this.state.confirmDialog;
        this.state.confirmDialog = { show: false, title: '', message: '', action: null };

        if (action === 'deletePlaylist') {
            this.doDeletePlaylist();
        }
    }

    handleConfirmDialogCancel() {
        this.state.confirmDialog = { show: false, title: '', message: '', action: null };
        this.state.pendingDeletePlaylist = null;
    }

    async handleShare() {
        if (!this.state.currentPlaylist) return;
        try {
            const result = await playlistsApi.share(this.state.currentPlaylist.id);
            this.state.shareToken = result.share_token;
            this.state.showShareDialog = true;
        } catch (e) {
            console.error('Failed to get share token:', e);
        }
    }

    // AI Extend methods
    showExtendDialog() {
        this.state.showExtendDialog = true;
        this.state.extendError = null;
    }

    closeExtendDialog() {
        this.state.showExtendDialog = false;
        this.state.extendError = null;
    }

    // Rename playlist
    showRenamePlaylistDialog() {
        if (!this.state.currentPlaylist) return;
        this.state.renameNewName = this.state.currentPlaylist.name;
        this.state.renameError = null;
        this.state.showRenameDialog = true;
    }

    closeRenameDialog() {
        this.state.showRenameDialog = false;
        this.state.renameError = null;
    }

    async handleRenamePlaylist() {
        const name = this.state.renameNewName.trim();
        if (!name) {
            this.state.renameError = 'Please enter a name';
            return;
        }
        if (name === this.state.currentPlaylist.name) {
            this.state.showRenameDialog = false;
            return;
        }

        this.state.isRenaming = true;
        this.state.renameError = null;

        try {
            await playlistsApi.update(this.state.currentPlaylist.id, { name });
            this.state.currentPlaylist.name = name;
            this.state.showRenameDialog = false;
            await this.loadPlaylists(true);
            const toast = document.querySelector('cl-toast');
            if (toast) {
                toast.show({ severity: 'success', summary: 'Renamed', detail: `Playlist renamed to "${name}"` });
            }
        } catch (e) {
            this.state.renameError = e.message || 'Failed to rename playlist';
        } finally {
            this.state.isRenaming = false;
        }
    }

    // Clone playlist
    showClonePlaylistDialog() {
        if (!this.state.currentPlaylist) return;
        this.state.cloneNewName = `${this.state.currentPlaylist.name} (Copy)`;
        this.state.cloneError = null;
        this.state.showCloneDialog = true;
    }

    closeCloneDialog() {
        this.state.showCloneDialog = false;
        this.state.cloneError = null;
    }

    async handleClonePlaylist() {
        const name = this.state.cloneNewName.trim();
        if (!name) {
            this.state.cloneError = 'Please enter a name';
            return;
        }

        this.state.isCloning = true;
        this.state.cloneError = null;

        try {
            const result = await playlistsApi.clone(this.state.currentPlaylist.id, name);
            this.state.showCloneDialog = false;
            await this.loadPlaylists(true);
            const toast = document.querySelector('cl-toast');
            if (toast) {
                toast.show({ severity: 'success', summary: 'Cloned', detail: `Created "${result.name}"` });
            }
            // Navigate to the new playlist
            window.location.hash = `#/playlists/${result.id}/`;
        } catch (e) {
            this.state.cloneError = e.message || 'Failed to clone playlist';
        } finally {
            this.state.isCloning = false;
        }
    }

    async handleExtendPlaylist() {
        if (!this.state.currentPlaylist || this.state.isExtending) return;

        this.state.isExtending = true;
        this.state.extendError = null;

        try {
            const result = await ai.extendPlaylist(
                this.state.currentPlaylist.id,
                this.state.extendCount,
                this.state.extendDiversity
            );

            if (result.error) {
                this.state.extendError = result.error;
                return;
            }

            // Success - close dialog and reload playlist
            this.state.showExtendDialog = false;
            const addedCount = result.added?.length || result.added_count || 0;
            const toast = document.querySelector('cl-toast');
            if (toast) {
                toast.show({
                    severity: 'success',
                    summary: 'Extended',
                    detail: `Added ${addedCount} similar songs`
                });
            }

            // Reload playlist
            await this.loadPlaylistDetail(this.state.currentPlaylist.id);
        } catch (e) {
            console.error('Failed to extend playlist:', e);
            this.state.extendError = e.message || 'Failed to extend playlist';
        } finally {
            this.state.isExtending = false;
        }
    }

    closeShareDialog() {
        this.state.showShareDialog = false;
    }

    copyShareLink() {
        // Use pathname to preserve /apps/music/ path
        const basePath = window.location.pathname.replace(/\/$/, '');
        const url = `${window.location.origin}${basePath}/#/share/${this.state.shareToken}/`;
        navigator.clipboard.writeText(url).then(() => {
            const toast = document.querySelector('cl-toast');
            if (toast) toast.show({ severity: 'success', summary: 'Copied', detail: 'Link copied to clipboard!' });
        });
    }

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
    }

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
    }

    toggleSortMenu() {
        this.state.showSortMenu = !this.state.showSortMenu;
    }

    closeSortMenu() {
        this.state.showSortMenu = false;
    }

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
    }

    handleSongClick(song) {
        // Don't play unavailable songs when offline
        if (this.isUnavailableOffline(song)) {
            return;
        }
        player.addToQueue(song, true);
    }

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
    }

    handleSongContextMenu(song, e) {
        e.preventDefault();
        e.stopPropagation();
        showSongContextMenu(song, e.clientX, e.clientY);
    }

    async handlePlayAll() {
        if (!this.state.currentPlaylist) return;
        await player.clearQueue();
        await player.addByPlaylist(this.state.currentPlaylist.id, false);
    }

    async handleShuffleAll() {
        if (!this.state.currentPlaylist) return;
        await player.clearQueue();
        await player.addByPlaylist(this.state.currentPlaylist.id, true);
    }

    async handleStartRadio() {
        if (!this.state.currentPlaylist) return;
        await player.startScaFromPlaylist(this.state.currentPlaylist.id);
    }

    async handleRemoveSong(song, index, e) {
        e.stopPropagation();
        if (!this.state.currentPlaylist) return;
        try {
            // Duplicate-safe: address the exact row by its index so only the
            // clicked copy is removed, even when the same song repeats.
            await playlistsApi.removeSong(this.state.currentPlaylist.id, song.uuid, index);
            this.state.playlistSongs = this.state.playlistSongs.filter((_, i) => i !== index);
            this.state.totalCount = this.state.playlistSongs.length;
            this.state.playlistVersion++;  // Invalidate memoEach cache
        } catch (e) {
            console.error('Failed to remove song:', e);
        }
    }

    // Playlist song reordering
    async handlePlaylistMoveUp(index, e) {
        e.stopPropagation();
        if (index > 0) {
            await this.reorderPlaylistSongs(index, index - 1);
        }
    }

    async handlePlaylistMoveDown(index, e) {
        e.stopPropagation();
        if (index < this.state.playlistSongs.length - 1) {
            // reorderPlaylistSongs treats toIndex as a gap (insertIndex =
            // to-1 when moving down), so moving down one row needs gap
            // index+2 - (index, index+1) re-inserts in place (no-op)
            await this.reorderPlaylistSongs(index, index + 2);
        }
    }

    async reorderPlaylistSongs(fromIndex, toIndex) {
        if (!this.state.currentPlaylist) return;
        // The sparse array still has unloaded (null) rows while background
        // loading runs; building the full positions payload needs every
        // row. Ignore the reorder instead of throwing on null.uuid.
        if (this.state.playlistSongs.some(x => !x)) {
            console.warn('Reorder ignored: playlist songs still loading');
            return;
        }
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
    }

    async reorderPlaylistSongsBatch(indices, targetIndex) {
        if (!this.state.currentPlaylist) return;
        // The sparse array still has unloaded (null) rows while background
        // loading runs; building the full positions payload needs every
        // row. Ignore the reorder instead of throwing on null.uuid.
        if (this.state.playlistSongs.some(x => !x)) {
            console.warn('Reorder ignored: playlist songs still loading');
            return;
        }
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
    }

    toggleAddSongs() {
        this.state.showAddSongs = !this.state.showAddSongs;
        if (!this.state.showAddSongs) {
            this.state.searchQuery = '';
            this.state.searchResults = [];
        }
    }

    handleSearchInput(e) {
        this.state.searchQuery = e.target.value;
    }

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
    }

    handleSearchKeyDown(e) {
        if (e.key === 'Enter') {
            this.handleSearch();
        }
    }

    async handleAddSongToPlaylist(song, e) {
        e.stopPropagation();
        if (!this.state.currentPlaylist) return;
        try {
            await playlistsApi.addSong(this.state.currentPlaylist.id, song.uuid);
            // Duplicates are a first-class feature: always append the copy
            // just added, even if the song is already in the playlist.
            this.state.playlistSongs = [...this.state.playlistSongs, song];
            this.state.totalCount = this.state.playlistSongs.length;
            this.state.playlistVersion++;
        } catch (e) {
            console.error('Failed to add song:', e);
        }
    }

    isSongInPlaylist(song) {
        return this.state.playlistSongs.some(s => s.uuid === song.uuid);
    }

    // Render function for song list item
    renderSongItem(song, index) {
        const view = this.state.view;
        const playlistSongs = this.state.playlistSongs;
        const selectionMode = this.state.selectionMode;
        const isSelected = this.isSelected(index);
        const g = this._g;

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
                     draggable="${view !== 'shared' && !g.isTouchDevice()}"
                     on-click="${(e) => g.click(index, e)}"
                     on-contextmenu="${(e) => g.contextMenu(index, e)}"
                     on-touchstart-passive="${(e) => selectionMode ? g.rowTouchStart(index, e) : g.touchStart(index, e)}"
                     on-touchmove="${(e) => selectionMode ? g.handleTouchMove(e) : g.touchMove(e)}"
                     on-touchend="${(e) => selectionMode ? g.handleTouchEnd(e) : g.touchEnd(index, e)}"
                     on-dragstart="${(e) => g.dragStart(index, e)}"
                     on-dragend="${(e) => g.dragEnd(e)}"
                     on-dragover="${(e) => g.dragOver(index, e)}"
                     on-dragleave="${(e) => g.dragLeave(e)}"
                     on-drop="${(e) => g.drop(index, e)}">
                    ${when(view !== 'shared' && selectionMode, () => html`
                        <input type="checkbox" class="selection-checkbox" checked="${isSelected}" on-click="${(e) => this.toggleSelection(index, e)}">
                    `, () => when(view !== 'shared', html`
                        <span class="drag-handle" title="Drag to reorder"
                              on-touchstart="${(e) => g.handleTouchStart(index, e)}"
                              on-touchmove="${(e) => g.handleTouchMove(e)}"
                              on-touchend="${(e) => g.handleTouchEnd(e)}">⋮⋮</span>
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
                                    on-click="${(e) => this.handleRemoveSong(song, index, e)}"
                                    title="Remove">
                                ✕
                            </button>
                        </div>
                    `)}
                </div>
            `;
    }

    // Import methods
    openImportDialog() {
        this.state.showImportDialog = true;
        this.state.importMode = 'new';
        this.state.importTargetPlaylist = null;
        this.state.importNewName = '';
        this.state.importFile = null;
        this.state.importProgress = null;
        this.state.importError = null;
    }

    closeImportDialog() {
        this.state.showImportDialog = false;
        this.state.importProgress = null;
        this.state.importError = null;
    }

    handleImportModeChange(mode) {
        this.state.importMode = mode;
    }

    handleImportTargetChange(e) {
        this.state.importTargetPlaylist = e.target.value;
    }

    handleImportNameChange(e) {
        this.state.importNewName = e.target.value;
    }

    handleImportFileChange(e) {
        // Store file outside reactive state to avoid proxy issues with Blob methods
        this._importFile = e.target.files[0] || null;
        this.state.importFile = this._importFile ? this._importFile.name : null;
        this.state.importError = null;
    }

    parsePlaylistFile(content) {
        // Parse TSV file - extract UUID from first column of each line
        const lines = content.split('\n');
        const uuids = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Get everything before the first tab (or the whole line if no tab)
            const tabIndex = trimmed.indexOf('\t');
            const uuid = tabIndex >= 0 ? trimmed.substring(0, tabIndex) : trimmed;

            // Basic UUID validation (should be hex chars and dashes)
            if (uuid && /^[0-9a-f-]+$/i.test(uuid)) {
                uuids.push(uuid);
            }
        }

        return uuids;
    }

    async handleImport() {
        if (!this._importFile) {
            this.state.importError = 'Please select a file';
            return;
        }

        if (this.state.importMode === 'new' && !this.state.importNewName.trim()) {
            this.state.importError = 'Please enter a playlist name';
            return;
        }

        if (this.state.importMode === 'append' && !this.state.importTargetPlaylist) {
            this.state.importError = 'Please select a playlist';
            return;
        }

        try {
            // Read and parse file (use _importFile which is the actual File object)
            const content = await this._importFile.text();
            const uuids = this.parsePlaylistFile(content);

            if (uuids.length === 0) {
                this.state.importError = 'No valid UUIDs found in file';
                return;
            }

            let playlistId;

            if (this.state.importMode === 'new') {
                // Create new playlist
                const result = await playlistsApi.create(this.state.importNewName.trim());
                if (result.error) {
                    this.state.importError = result.error;
                    return;
                }
                playlistId = result.id;
            } else {
                playlistId = this.state.importTargetPlaylist;
            }

            // Add songs in batches
            this.state.importProgress = { completed: 0, total: uuids.length };

            await playlistsApi.addSongsBatch(playlistId, uuids, 500, (completed, total) => {
                this.state.importProgress = { completed, total };
            });

            // Done - close dialog and refresh
            this.state.showImportDialog = false;
            this.state.importProgress = null;
            this.loadPlaylists();

        } catch (e) {
            console.error('Import failed:', e);
            this.state.importError = e.message || 'Import failed';
        }
    }

    async _loadRemainingInBackground(playlistId, cursor, shareToken = null) {
        // Load remaining items in background with larger batches. In the
        // shared (anonymous) view the token-scoped endpoint is used -
        // getSongs requires a logged-in user.
        let currentCursor = cursor;
        let offset = this.state.playlistSongs.filter(s => s !== null).length;

        while (currentCursor) {
            try {
                const opts = { cursor: currentCursor, limit: 500 };  // Larger batches for background loading
                const result = shareToken
                    ? await playlistsApi.getSongsByToken(shareToken, opts)
                    : await playlistsApi.getSongs(playlistId, opts);
                if (result.error) break;

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

    template() {
        const { view, tab, myPlaylists, publicPlaylists, currentPlaylist, playlistSongs,
                isLoading, detailError, isAuthenticated, showCreateDialog, showShareDialog, shareToken,
                newPlaylistName, newPlaylistDesc, newPlaylistPublic, hasMore, totalCount,
                showAddSongs, searchQuery, searchResults, searchLoading,
                showImportDialog, importMode, importTargetPlaylist, importNewName,
                importProgress, importError,
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
                                <p>Please <a href="${profile.auth.loginUrl}">log in</a> to manage your playlists</p>
                            </div>
                        `, html`
                            <div class="create-section">
                                <cl-button severity="primary" icon="+" on-click="openCreateDialog">
                                    Create Playlist
                                </cl-button>
                                <cl-button severity="secondary" icon="📥" on-click="openImportDialog">
                                    Import
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

                    <!-- Import Dialog -->
                    ${when(showImportDialog, () => html`
                        <cl-dialog visible="true" header="Import Playlist"
                            on-change="${(e, val) => { if (!val) this.closeImportDialog(); }}">
                            <div class="dialog-form">
                                <div class="form-row">
                                    <label>Import Mode</label>
                                    <div class="import-mode-buttons">
                                        <button class="mode-btn ${importMode === 'new' ? 'active' : ''}"
                                                on-click="${() => this.handleImportModeChange('new')}">
                                            New Playlist
                                        </button>
                                        <button class="mode-btn ${importMode === 'append' ? 'active' : ''}"
                                                on-click="${() => this.handleImportModeChange('append')}">
                                            Add to Existing
                                        </button>
                                    </div>
                                </div>

                                ${when(importMode === 'new', html`
                                    <div class="form-row">
                                        <label>Playlist Name</label>
                                        <input type="text" x-model="importNewName"
                                               placeholder="Enter playlist name">
                                    </div>
                                `, () => html`
                                    <div class="form-row">
                                        <label>Select Playlist</label>
                                        <select on-change-stop="handleImportTargetChange" value="${importTargetPlaylist || ''}">
                                            <option value="">-- Select playlist --</option>
                                            ${each(myPlaylists, p => html`
                                                <option value="${p.id}">${p.name}</option>
                                            `)}
                                        </select>
                                    </div>
                                `)}

                                <div class="form-row">
                                    <label>Playlist File (mrepo/manifest format)</label>
                                    <input type="file" accept=".txt,.tsv,.manifest"
                                           on-change-stop="handleImportFileChange">
                                </div>

                                ${when(importError, html`
                                    <div class="import-error">${importError}</div>
                                `)}

                                ${when(importProgress, () => html`
                                    <div class="import-progress">
                                        <div class="progress-bar">
                                            <div class="progress-fill"
                                                 style="width: ${(importProgress.completed / importProgress.total) * 100}%">
                                            </div>
                                        </div>
                                        <div class="progress-text">
                                            Adding songs: ${importProgress.completed} / ${importProgress.total}
                                        </div>
                                    </div>
                                `)}
                            </div>
                            <div slot="footer">
                                <cl-button severity="secondary" on-click="closeImportDialog"
                                           disabled="${!!importProgress}">Cancel</cl-button>
                                <cl-button severity="primary" on-click="handleImport"
                                           loading="${!!importProgress}">Import</cl-button>
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
                            <cl-button severity="secondary" icon="🔗" on-click="handleShare"
                                       disabled="${shouldUseOffline()}" title="${shouldUseOffline() ? 'Requires online' : 'Share playlist'}">Share</cl-button>
                            ${when(this.state.aiEnabled, () => html`
                            <cl-button severity="secondary" icon="✨" on-click="showExtendDialog"
                                       disabled="${shouldUseOffline()}" title="${shouldUseOffline() ? 'Requires online' : 'Extend with AI'}">Extend AI</cl-button>
                            `)}
                            <cl-button severity="secondary" icon="✏️" on-click="showRenamePlaylistDialog"
                                       disabled="${shouldUseOffline()}" title="${shouldUseOffline() ? 'Requires online' : 'Rename playlist'}">Rename</cl-button>
                            <cl-button severity="secondary" icon="📋" on-click="showClonePlaylistDialog"
                                       disabled="${shouldUseOffline()}" title="${shouldUseOffline() ? 'Requires online' : 'Clone playlist'}">Clone</cl-button>
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
                                            <div class="add-song-controls">
                                                ${when(this.isSongInPlaylist(song),
                                                    html`<span class="added-badge">✓ In playlist</span>`
                                                )}
                                                <button class="add-song-btn"
                                                        on-click="${(e) => this.handleAddSongToPlaylist(song, e)}">
                                                    + Add
                                                </button>
                                            </div>
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
                            const win = this._win;

                            return html`
                                <div class="songs-container" ref="songsContainer"
                                     style="height: ${win.totalHeight}px; position: relative;">
                                    <div class="songs-list" style="position: absolute; top: 0; left: 0; right: 0; transform: translateY(${win.offsetY}px);">
                                        ${memoEach(playlistSongs.slice(win.visibleStart, win.visibleEnd), (song, idx) => {
                                            const actualIndex = win.visibleStart + idx;
                                            return this.renderSongItem(song, actualIndex);
                                        }, (song, idx) => {
                                            // Key by uuid AND playlist position: playlists support
                                            // duplicate songs, and a uuid-only key gives duplicate
                                            // rows the same identity (DOM reuse chaos: selection and
                                            // scroll jump around). The position (win.visibleStart +
                                            // idx) is scroll-stable, so plain scrolling still hits
                                            // the memo cache.
                                            //
                                            // Selection state is IN the key (mode + per-row selected
                                            // bit) instead of a global version bump: a toggle then
                                            // re-renders ONLY the toggled row. Tearing down every
                                            // visible row per tap also made Chrome's scroll anchoring
                                            // (Android) walk the view up by visible+buffer rows.
                                            const actualIndex = win.visibleStart + idx;
                                            const sel = this.state.selectionMode
                                                ? (this.state.selectedIndices.has(actualIndex) ? 's' : 'u')
                                                : 'n';
                                            return `${song?.uuid ?? 'loading'}-${actualIndex}-${this.state.playlistVersion ?? 0}-${sel}`;
                                        }, { trustKey: true })}
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
                `, () => html`
                    <!-- No playlist loaded yet: show the error, otherwise the load is
                         still in flight (or superseded by a newer one) so show loading
                         instead of a blank page. -->
                    ${when(detailError, () => html`
                        <div class="detail-error">${detailError}</div>
                    `, () => html`
                        <div class="loading"><cl-spinner></cl-spinner></div>
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

                <!-- AI Extend Dialog -->
                ${when(this.state.showExtendDialog, () => html`
                    <cl-dialog visible="true" header="Extend with AI"
                        on-change="${(e, val) => { if (!val) this.closeExtendDialog(); }}">
                        <div class="extend-dialog-content">
                            <p>Add similar songs to your playlist using AI analysis.</p>

                            <div class="extend-option">
                                <label for="extend-count">Number of songs to add:</label>
                                <input type="number" id="extend-count"
                                       min="1" max="50"
                                       x-model="extendCount">
                            </div>

                            <div class="extend-option">
                                <label for="extend-diversity">Diversity:</label>
                                <div class="diversity-slider">
                                    <span class="diversity-label">Similar</span>
                                    <input type="range" id="extend-diversity"
                                           min="0" max="1" step="0.1"
                                           x-model="extendDiversity">
                                    <span class="diversity-label">Diverse</span>
                                </div>
                                <span class="diversity-value">${Math.round(this.state.extendDiversity * 100)}%</span>
                            </div>

                            ${when(this.state.extendError, () => html`
                                <div class="extend-error">${this.state.extendError}</div>
                            `)}
                        </div>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="closeExtendDialog"
                                       disabled="${this.state.isExtending}">Cancel</cl-button>
                            <cl-button severity="primary" on-click="handleExtendPlaylist"
                                       disabled="${this.state.isExtending}">
                                ${this.state.isExtending ? 'Adding...' : 'Add Songs'}
                            </cl-button>
                        </div>
                    </cl-dialog>
                `)}

                <!-- Rename Playlist Dialog -->
                ${when(this.state.showRenameDialog, () => html`
                    <cl-dialog visible="true" header="Rename Playlist"
                        on-change="${(e, val) => { if (!val) this.closeRenameDialog(); }}">
                        <div class="dialog-form">
                            <div class="form-row">
                                <label>New Name</label>
                                <input type="text" x-model="renameNewName" autofocus>
                            </div>
                            ${when(this.state.renameError, () => html`
                                <div class="import-error">${this.state.renameError}</div>
                            `)}
                        </div>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="closeRenameDialog"
                                       disabled="${this.state.isRenaming}">Cancel</cl-button>
                            <cl-button severity="primary" on-click="handleRenamePlaylist"
                                       disabled="${this.state.isRenaming}">
                                ${this.state.isRenaming ? 'Renaming...' : 'Rename'}
                            </cl-button>
                        </div>
                    </cl-dialog>
                `)}

                <!-- Clone Playlist Dialog -->
                ${when(this.state.showCloneDialog, () => html`
                    <cl-dialog visible="true" header="Clone Playlist"
                        on-change="${(e, val) => { if (!val) this.closeCloneDialog(); }}">
                        <div class="dialog-form">
                            <p style="margin-top: 0; color: var(--text-secondary);">Create a copy of this playlist with a new name.</p>
                            <div class="form-row">
                                <label>New Playlist Name</label>
                                <input type="text" x-model="cloneNewName" autofocus>
                            </div>
                            ${when(this.state.cloneError, () => html`
                                <div class="import-error">${this.state.cloneError}</div>
                            `)}
                        </div>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="closeCloneDialog"
                                       disabled="${this.state.isCloning}">Cancel</cl-button>
                            <cl-button severity="primary" on-click="handleClonePlaylist"
                                       disabled="${this.state.isCloning}">
                                ${this.state.isCloning ? 'Cloning...' : 'Clone'}
                            </cl-button>
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
    }

    static styles = /*css*/`
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

        /* Detail load error (invalid share token, offline fetch, etc.) */
        .detail-error {
            text-align: center;
            padding: 3rem 1.5rem;
            color: var(--danger-300, #f5a5a5);
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

        .song-item.drag-over-below {
            border-bottom: 2px solid var(--primary-500, #0066cc);
            margin-bottom: -2px;
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

        /* AI Extend Dialog */
        .extend-dialog-content {
            min-width: 300px;
        }

        .extend-dialog-content p {
            margin: 0 0 1rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .extend-option {
            margin-bottom: 1rem;
        }

        .extend-option label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
        }

        .extend-option input[type="number"] {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .diversity-slider {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .diversity-slider input[type="range"] {
            flex: 1;
        }

        .diversity-label {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        .diversity-value {
            font-size: 0.875rem;
            color: var(--primary-400, #42a5f5);
            margin-left: 0.5rem;
        }

        .extend-error {
            padding: 0.75rem;
            background: var(--danger-100, #4a1515);
            border: 1px solid var(--danger-400, #dc3545);
            border-radius: 4px;
            color: var(--danger-300, #f5a5a5);
            font-size: 0.875rem;
            margin-top: 1rem;
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

        .add-song-controls {
            display: flex;
            align-items: center;
            gap: 8px;
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

        /* Import Dialog */
        .import-mode-buttons {
            display: flex;
            gap: 0.5rem;
        }

        .mode-btn {
            flex: 1;
            padding: 0.5rem 1rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            cursor: pointer;
            color: var(--text-primary, #e0e0e0);
            transition: all 0.2s;
        }

        .mode-btn:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .mode-btn.active {
            background: var(--selected-bg, #1e3a5f);
            border-color: var(--primary-400, #42a5f5);
        }

        .form-row select {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .form-row input[type="file"] {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .import-error {
            padding: 0.75rem;
            background: var(--danger-900, #450a0a);
            border: 1px solid var(--danger-500, #dc3545);
            border-radius: 4px;
            color: var(--danger-300, #fca5a5);
            font-size: 0.875rem;
            margin-top: 0.5rem;
        }

        .import-progress {
            margin-top: 1rem;
        }

        .import-progress .progress-bar {
            height: 8px;
            background: var(--surface-300, #404040);
            border-radius: 4px;
            overflow: hidden;
        }

        .import-progress .progress-fill {
            height: 100%;
            background: var(--primary-500, #2196f3);
            transition: width 0.2s;
        }

        .import-progress .progress-text {
            margin-top: 0.5rem;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            text-align: center;
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
}

export default defineComponent('playlists-page', PlaylistsPage);

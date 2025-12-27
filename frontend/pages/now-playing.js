/**
 * Now Playing Page
 *
 * Full player view with:
 * - Large album/song info display
 * - Progress bar (seekable when supported)
 * - Full playback controls
 * - Queue display
 * - Volume control
 */

import { defineComponent, html, when, each, memoEach, contain } from '../lib/framework.js';
import { debounce, rafThrottle } from '../lib/utils.js';
import { player, playerStore } from '../stores/player-store.js';
import { playlists as playlistsApi } from '../offline/offline-api.js';
import * as offlineApi from '../offline/offline-api.js';
import offlineStore from '../offline/offline-store.js';
import eqPresetsStore from '../stores/eq-presets-store.js';
import { showSongContextMenu, navigateToArtist, navigateToAlbum, navigateToCategory, navigateToGenre, navigateToFolder } from '../components/song-context-menu.js';
import '../components/scroll-to-top.js';
import '../componentlib/form/slider.js';
import '../componentlib/button/button.js';
import '../componentlib/overlay/dialog.js';

const FAVORITES_PLAYLIST_NAME = 'Favorites';

export default defineComponent('now-playing-page', {
    stores: { player: playerStore, offline: offlineStore, eqPresets: eqPresetsStore },

    data() {
        return {
            showSaveDialog: false,
            playlistName: '',
            isSaving: false,
            saveError: null,
            // Favorites & add to playlist
            userPlaylists: [],
            showAddToPlaylist: false,
            addingToPlaylist: false,
            // Windowed rendering for queue
            visibleStart: 0,
            visibleEnd: 100, // Start with larger default
            // Queue sorting
            isSorting: false,
            showSortMenu: false,
            // EQ popup
            showEQMenu: false,
            // Volume popup
            showVolumePopup: false,
            // Playback mode popup
            showPlaybackModeMenu: false,
            // Queue scroll tracking
            showJumpToCurrent: false,
            jumpDirection: 'down', // 'up' or 'down' - direction to scroll to reach current
            // Selection mode
            selectionMode: false,
            selectedIndices: new Set(),
            selectionVersion: 0,  // Incremented on selection changes to invalidate memoEach cache
            // Confirm dialog
            confirmDialog: { show: false, title: '', message: '', action: null }
        };
    },

    async mounted() {
        // Remove shell padding for full-height queue view
        this._shell = this.closest('cl-shell');
        if (this._shell) {
            this._shell.style.setProperty('--shell-content-padding', '0');
            this._shell.style.setProperty('--shell-content-padding-bottom', '0');
        }

        await this.loadPlaylists();
        // Load EQ presets for quick switching dropdown
        await eqPresetsStore.loadPresets();
        this._setupScrollListener();
        // Create debounced volume setter (50ms) for smoother slider interaction
        this._debouncedSetVolume = debounce((value) => {
            player.setVolume(value / 100);
        }, 50);

        // Track last queue interaction time
        this._lastQueueInteraction = 0;
        // Track last known queue index for song change detection
        this._lastQueueIndex = this.stores.player.queueIndex;
        // Non-reactive tracking for visibility (used in subscription to avoid recursion)
        this._isCurrentInView = true;

        // Initial scroll to current song (delay to ensure DOM is ready after conditional render)
        setTimeout(() => {
            this._scrollToCurrentSong(false);
        }, 50);

        // Watch for queue index changes to auto-scroll
        this._unsubscribeQueueIndex = playerStore.subscribe((state) => {
            const newIndex = state.queueIndex;
            if (newIndex !== this._lastQueueIndex) {
                const wasInView = this._isCurrentInView;
                const timeSinceInteraction = Date.now() - this._lastQueueInteraction;
                const shuffle = state.shuffle;
                this._lastQueueIndex = newIndex;

                if (wasInView && timeSinceInteraction > 3000) {
                    this._scrollToCurrentSong(!shuffle);
                }
            }
        });

        // Listen for temp queue exit to scroll to restored queue position
        this._onTempQueueExited = () => {
            // Small delay to let the queue re-render
            setTimeout(() => {
                this._scrollToCurrentSong(false);
            }, 100);
        };
        window.addEventListener('temp-queue-exited', this._onTempQueueExited);
    },

    unmounted() {
        // Restore shell padding
        if (this._shell) {
            this._shell.style.removeProperty('--shell-content-padding');
            this._shell.style.removeProperty('--shell-content-padding-bottom');
        }

        // Clean up scroll listener
        if (this._scrollHandler && this._scrollTarget) {
            if (this._scrollTarget === window) {
                window.removeEventListener('scroll', this._scrollHandler, true);
            } else {
                this._scrollTarget.removeEventListener('scroll', this._scrollHandler);
            }
        }

        // Clean up queue index subscription
        if (this._unsubscribeQueueIndex) {
            this._unsubscribeQueueIndex();
        }

        // Clean up temp queue exit listener
        if (this._onTempQueueExited) {
            window.removeEventListener('temp-queue-exited', this._onTempQueueExited);
        }
    },

    methods: {
        /**
         * Get visible queue items - filters out unavailable items when offline.
         * Returns items with their original queue indices for playback.
         * Memoized to avoid recalculating on every render.
         */
        getVisibleQueue() {
            const queue = this.stores.player.queue;
            const queueVersion = this.stores.player.queueVersion;
            const isOffline = this.stores.offline.workOfflineMode || !this.stores.offline.isOnline;

            // Cache key: queueVersion changes on queue modification
            // Note: queueIndex is NOT included - it doesn't affect queue content
            const cacheKey = `${queueVersion}-${isOffline}`;

            // Return cached result if inputs haven't changed
            if (this._visibleQueueKey === cacheKey && this._visibleQueueCache) {
                return this._visibleQueueCache;
            }

            // Create stable wrapper objects that persist across renders
            // This is critical for memoEach cache hits (it checks item === cachedItem)
            if (!this._wrapperCache) {
                this._wrapperCache = new Map();
            }

            // Clear wrappers for items no longer in queue
            const currentUuids = new Set(queue.map(item => item.uuid));
            for (const uuid of this._wrapperCache.keys()) {
                if (!currentUuids.has(uuid)) {
                    this._wrapperCache.delete(uuid);
                }
            }

            let result;
            if (!isOffline) {
                // Online - show all items with their indices
                result = queue.map((item, index) => {
                    let wrapper = this._wrapperCache.get(item.uuid);
                    if (!wrapper || wrapper.item !== item || wrapper.index !== index) {
                        wrapper = { item, index };
                        this._wrapperCache.set(item.uuid, wrapper);
                    }
                    return wrapper;
                });
            } else {
                // Offline - only show items with metadata (have title)
                result = queue
                    .map((item, index) => {
                        let wrapper = this._wrapperCache.get(item.uuid);
                        if (!wrapper || wrapper.item !== item || wrapper.index !== index) {
                            wrapper = { item, index };
                            this._wrapperCache.set(item.uuid, wrapper);
                        }
                        return wrapper;
                    })
                    .filter(({ item }) => item.title);
            }

            // Cache the result (store directly to avoid triggering re-render)
            // Use instance properties (not reactive state) for cache
            this._visibleQueueCache = result;
            this._visibleQueueKey = cacheKey;

            return result;
        },

        getDisplayTitle(song) {
            if (!song) return 'Unknown';
            if (song.title) return song.title;
            // Fallback to filename without extension
            const path = song.virtual_file || song.file || '';
            const filename = path.split('/').pop() || '';
            return filename.replace(/\.[^.]+$/, '') || 'Unknown';
        },

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
            this.state.selectionVersion++;  // Invalidate memoEach cache
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
            this.state.selectionVersion++;  // Invalidate memoEach cache
        },

        selectAll() {
            const queue = this.stores.player.queue;
            const newSet = new Set();
            for (let i = 0; i < queue.length; i++) {
                newSet.add(i);
            }
            this.state.selectedIndices = newSet;
            this.state.selectionVersion++;  // Invalidate memoEach cache
        },

        clearSelection() {
            this.state.selectedIndices = new Set();
            this._lastSelectedIndex = undefined;
            this.state.selectionVersion++;  // Invalidate memoEach cache
        },

        async handleDeleteSelected() {
            const indices = [...this.state.selectedIndices];
            if (indices.length === 0) return;

            await player.removeFromQueueBatch(indices);
            this.clearSelection();
            this.state.selectionMode = false;
        },

        async handleAddSelectedToPlaylist(playlistId) {
            const indices = [...this.state.selectedIndices];
            if (indices.length === 0) return;

            const queue = this.stores.player.queue;
            const songs = indices.map(i => queue[i]).filter(Boolean);
            const songUuids = songs.map(s => s.uuid);

            try {
                this.state.addingToPlaylist = true;
                await playlistsApi.addSongsBatch(playlistId, songUuids);
                this.state.showAddToPlaylist = false;
                this.clearSelection();
                this.state.selectionMode = false;
            } catch (e) {
                console.error('Failed to add songs to playlist:', e);
            } finally {
                this.state.addingToPlaylist = false;
            }
        },

        handlePlayPause() {
            player.togglePlayPause();
        },

        handlePrevious() {
            player.previous();
        },

        handleNext() {
            player.next();
        },

        handleSkip() {
            player.skip();
        },

        handleSeek(e) {
            const value = e.detail?.value ?? e.target?.value;
            if (value !== undefined) {
                player.seek(parseFloat(value));
            }
        },

        handleSeekWrapperClick(e) {
            // If the click was on the slider itself, let it handle it
            if (e.target.classList.contains('seek-slider')) return;

            // Calculate seek position from click on wrapper
            const wrapper = e.currentTarget;
            const rect = wrapper.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const duration = this.stores.player.duration;
            if (duration) {
                player.seek(percent * duration);
            }
        },

        handleVolumeChange(e) {
            const value = e.detail?.value ?? e.target?.value;
            if (value !== undefined) {
                this._debouncedSetVolume(parseFloat(value));
            }
        },

        handleToggleMute() {
            player.toggleMute();
        },

        handleToggleShuffle() {
            player.toggleShuffle();
        },

        handleCycleRepeat() {
            player.cycleRepeatMode();
        },

        handleQueueItemClick(index) {
            // Don't play unavailable songs when offline
            const queue = this.stores.player.queue;
            if (index >= 0 && index < queue.length) {
                const song = queue[index];
                if (this.isUnavailableOffline(song?.uuid)) {
                    return;
                }
            }
            player.playAtIndex(index);
        },

        /**
         * Check if a song is unavailable in offline mode.
         * Returns true if in offline mode and song is not cached.
         */
        isUnavailableOffline(uuid) {
            if (!uuid) return false;
            // Not in offline mode = nothing is unavailable
            if (this.stores.offline.isOnline && !this.stores.offline.workOfflineMode) {
                return false;
            }
            // In offline mode - check if song is cached
            return !this.stores.offline.offlineSongUuids.has(uuid);
        },

        handleQueueContextMenu(song, e) {
            e.preventDefault();
            e.stopPropagation();
            showSongContextMenu(song, e.clientX, e.clientY);
        },

        handleRemoveFromQueue(index, e) {
            e.stopPropagation();
            player.removeFromQueue(index);
        },

        formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        getRepeatIcon() {
            const mode = this.stores.player.repeatMode;
            switch (mode) {
                case 'one': return '🔂';
                case 'all': return '🔁';
                default: return '➡️';
            }
        },

        getRepeatTitle() {
            const mode = this.stores.player.repeatMode;
            switch (mode) {
                case 'one': return 'Repeat: One';
                case 'all': return 'Repeat: All';
                default: return 'Repeat: Off';
            }
        },

        /**
         * Get the current playback mode.
         * Returns: 'default' | 'shuffle' | 'repeat' | 'repeat-one'
         */
        getPlaybackMode() {
            const shuffle = this.stores.player.shuffle;
            const repeat = this.stores.player.repeatMode;

            if (shuffle) return 'shuffle';
            if (repeat === 'one') return 'repeat-one';
            if (repeat === 'all') return 'repeat';
            return 'default';
        },

        /**
         * Get icon for the current playback mode.
         */
        getPlaybackModeIcon() {
            switch (this.getPlaybackMode()) {
                case 'shuffle': return '🔀';
                case 'repeat': return '🔁';
                case 'repeat-one': return '🔂';
                default: return '➡️';
            }
        },

        /**
         * Get title for the current playback mode.
         */
        getPlaybackModeTitle() {
            switch (this.getPlaybackMode()) {
                case 'shuffle': return 'Shuffle';
                case 'repeat': return 'Repeat All';
                case 'repeat-one': return 'Repeat One';
                default: return 'Default';
            }
        },

        /**
         * Toggle playback mode menu visibility.
         */
        togglePlaybackModeMenu() {
            this.state.showPlaybackModeMenu = !this.state.showPlaybackModeMenu;
            // Close other menus
            this.state.showEQMenu = false;
            this.state.showVolumePopup = false;
        },

        /**
         * Close playback mode menu.
         */
        closePlaybackModeMenu() {
            this.state.showPlaybackModeMenu = false;
        },

        /**
         * Set a specific playback mode.
         */
        setPlaybackMode(mode) {
            switch (mode) {
                case 'default':
                    player.setShuffle(false);
                    player.setRepeatMode('none');
                    break;
                case 'shuffle':
                    player.setShuffle(true);
                    player.setRepeatMode('none');
                    break;
                case 'repeat':
                    player.setShuffle(false);
                    player.setRepeatMode('all');
                    break;
                case 'repeat-one':
                    player.setShuffle(false);
                    player.setRepeatMode('one');
                    break;
            }
            this.state.showPlaybackModeMenu = false;
        },

        handleClearQueue() {
            this.showConfirmDialog(
                'Clear Queue',
                'Clear the entire queue?',
                'clearQueue'
            );
        },

        async doClearQueue() {
            await player.clearQueue();
        },

        showConfirmDialog(title, message, action) {
            this.state.confirmDialog = { show: true, title, message, action };
        },

        handleConfirmDialogConfirm() {
            const { action } = this.state.confirmDialog;
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };

            if (action === 'clearQueue') {
                this.doClearQueue();
            }
        },

        handleConfirmDialogCancel() {
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };
        },

        handleShowSaveDialog() {
            this.state.showSaveDialog = true;
            this.state.playlistName = '';
            this.state.saveError = null;
        },

        handleCloseSaveDialog() {
            this.state.showSaveDialog = false;
        },

        handlePlaylistNameChange(e) {
            this.state.playlistName = e.target.value;
        },

        async handleSaveAsPlaylist() {
            const name = this.state.playlistName.trim();
            if (!name) {
                this.state.saveError = 'Please enter a playlist name';
                return;
            }

            this.state.isSaving = true;
            this.state.saveError = null;

            try {
                const result = await player.saveQueueAsPlaylist(name);
                this.state.showSaveDialog = false;
                const msg = result.queued
                    ? `Playlist "${result.name}" will be created when online.`
                    : `Playlist "${result.name}" created!`;
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'success', summary: 'Playlist Saved', detail: msg });
            } catch (e) {
                this.state.saveError = e.message || 'Failed to save playlist';
            } finally {
                this.state.isSaving = false;
            }
        },

        async handleStartRadio() {
            await player.startScaFromQueue();
        },

        async handleStopRadio() {
            await player.stopSca();
        },

        async handleToggleTempQueue() {
            await player.toggleTempQueueMode();
        },

        async loadPlaylists() {
            try {
                // Use offline-api which handles caching favorites automatically
                const result = await offlineApi.playlists.list();
                // Handle different response formats
                let playlistArray = [];
                if (Array.isArray(result)) {
                    playlistArray = result;
                } else if (result && Array.isArray(result.playlists)) {
                    playlistArray = result.playlists;
                } else if (result && Array.isArray(result.items)) {
                    playlistArray = result.items;
                }
                this.state.userPlaylists = playlistArray;

                // Find or create Favorites playlist
                let favorites = playlistArray.find(
                    p => p.name === FAVORITES_PLAYLIST_NAME
                );

                if (!favorites) {
                    // Create favorites playlist (requires online)
                    favorites = await playlistsApi.create(FAVORITES_PLAYLIST_NAME, 'My favorite songs');
                    this.state.userPlaylists = [favorites, ...this.state.userPlaylists];
                }

                // Favorites are now managed by offline store - no need to track locally
            } catch (e) {
                console.error('Failed to load playlists:', e);
            }
        },

        isFavorite() {
            const song = this.stores.player.currentSong;
            // Use offline store's cached favorites
            return song && offlineApi.isFavorite(song.uuid);
        },

        async toggleFavorite() {
            const song = this.stores.player.currentSong;
            if (!song) return;

            // Get favorites playlist ID, loading playlists if needed
            let favoritesPlaylistId = offlineApi.getFavoritesPlaylistId();
            if (!favoritesPlaylistId) {
                // Try loading playlists first
                await this.loadPlaylists();
                favoritesPlaylistId = offlineApi.getFavoritesPlaylistId();
            }

            if (!favoritesPlaylistId) {
                console.error('Could not determine favorites playlist');
                return;
            }

            try {
                if (this.isFavorite()) {
                    // Use offline-api which handles caching and queuing
                    await offlineApi.playlists.removeSong(favoritesPlaylistId, song.uuid);
                } else {
                    await offlineApi.playlists.addSong(favoritesPlaylistId, song.uuid);
                }
            } catch (e) {
                console.error('Failed to toggle favorite:', e);
            }
        },

        handleShowAddToPlaylist() {
            this.state.showAddToPlaylist = true;
        },

        handleCloseAddToPlaylist() {
            this.state.showAddToPlaylist = false;
        },

        async addToPlaylist(playlistId) {
            this.state.addingToPlaylist = true;
            try {
                // Selection mode: add all selected songs
                if (this.state.selectionMode && this.state.selectedIndices.size > 0) {
                    const indices = [...this.state.selectedIndices];
                    const queue = this.stores.player.queue;
                    const songUuids = indices.map(i => queue[i]?.uuid).filter(Boolean);

                    if (songUuids.length > 0) {
                        await offlineApi.playlists.addSongsBatch(playlistId, songUuids);
                    }

                    this.state.showAddToPlaylist = false;
                    this.clearSelection();
                    this.state.selectionMode = false;
                } else {
                    // Single song mode: add current song
                    const song = this.stores.player.currentSong;
                    if (!song) return;

                    await offlineApi.playlists.addSong(playlistId, song.uuid);
                    this.state.showAddToPlaylist = false;
                }
            } catch (e) {
                console.error('Failed to add to playlist:', e);
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'error', summary: 'Error', detail: 'Failed to add to playlist' });
            } finally {
                this.state.addingToPlaylist = false;
            }
        },

        // Jump-to navigation methods
        handleJumpToFolder() {
            const song = this.stores.player.currentSong;
            if (!song) return;
            // Use virtual_file (VFS path) if available, otherwise fall back to file
            const filePath = song.virtual_file || song.file;
            if (!filePath) return;
            // Extract folder path from file path (remove filename)
            const path = filePath.split('/').slice(0, -1).join('/') || '/';
            window.location.hash = `/browse/path/${encodeURIComponent(path.replace(/^\//, ''))}/`;
        },

        handleJumpToAlbum() {
            const song = this.stores.player.currentSong;
            if (!song?.album) return;
            // Navigate to hierarchy view filtered to artist + album
            // Use encodeURIComponent to ensure spaces are %20 not +
            let query = `album=${encodeURIComponent(song.album)}`;
            if (song.artist) query = `artist=${encodeURIComponent(song.artist)}&${query}`;
            window.location.hash = `/browse/?${query}`;
        },

        handleJumpToArtist() {
            const song = this.stores.player.currentSong;
            if (!song?.artist) return;
            // Navigate to hierarchy view filtered to artist
            // Use encodeURIComponent to ensure spaces are %20 not +
            window.location.hash = `/browse/?artist=${encodeURIComponent(song.artist)}`;
        },

        // Queue reordering
        handleMoveUp(index, e) {
            e.stopPropagation();
            if (index > 0) {
                player.reorderQueue(index, index - 1);
            }
        },

        handleMoveDown(index, e) {
            e.stopPropagation();
            const queue = this.stores.player.queue;
            if (index < queue.length - 1) {
                player.reorderQueue(index, index + 1);
            }
        },

        handleDragStart(index, e) {
            this._dragIndex = index;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
            e.currentTarget.classList.add('dragging');

            // Group drag: if dragging a selected item, prepare to move all selected
            if (this.state.selectionMode && this.state.selectedIndices.has(index)) {
                this._groupDrag = true;
                this._draggedIndices = [...this.state.selectedIndices].sort((a, b) => a - b);
                // Add visual feedback to all selected items
                this._draggedIndices.forEach(i => {
                    const item = this.querySelector(`.queue-item[data-index="${i}"]`);
                    if (item) item.classList.add('group-dragging');
                });
            } else {
                this._groupDrag = false;
                this._draggedIndices = [index];
            }
        },

        handleDragEnd(e) {
            e.currentTarget.classList.remove('dragging');
            // Clear all drag-over and group-dragging classes
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            this.querySelectorAll('.group-dragging').forEach(el => el.classList.remove('group-dragging'));
            this._dragIndex = null;
            this._groupDrag = false;
            this._draggedIndices = null;
        },

        handleDragOver(index, e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Handle drag-over state here instead of dragEnter/Leave for consistency
            if (this._dragIndex !== null && this._dragIndex !== index) {
                const queueItem = e.currentTarget;
                if (!queueItem.classList.contains('drag-over')) {
                    // Clear previous drag-over and set new one
                    this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                    queueItem.classList.add('drag-over');
                }
            }
        },

        handleDragEnter(index, e) {
            // Handled in dragOver for consistency
        },

        handleDragLeave(e) {
            // Only remove if leaving the container entirely
            const relatedTarget = e.relatedTarget;
            if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
                e.currentTarget.classList.remove('drag-over');
            }
        },

        handleDrop(index, e) {
            e.preventDefault();
            // Clear all drag-over and group-dragging classes
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            this.querySelectorAll('.group-dragging').forEach(el => el.classList.remove('group-dragging'));

            if (this._dragIndex !== null && this._dragIndex !== index) {
                this._trackQueueInteraction();  // Prevent jump-to-current after reorder

                if (this._groupDrag && this._draggedIndices && this._draggedIndices.length > 1) {
                    // Group drag: move all selected items
                    const sortedIndices = [...this._draggedIndices].sort((a, b) => a - b);

                    // Calculate where items will end up (same logic as reorderQueueBatch)
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

                    player.reorderQueueBatch(this._draggedIndices, index);

                    // Update selection to new positions
                    this.state.selectedIndices = newSet;
                    this.state.selectionVersion++;
                } else {
                    // Single item drag
                    player.reorderQueue(this._dragIndex, index);
                }
            }

            this._dragIndex = null;
            this._groupDrag = false;
            this._draggedIndices = null;
        },

        // Touch drag on whole item in selection mode (mobile)
        // Differs from handleHandleTouchStart: doesn't preventDefault immediately,
        // allows tap-to-select while still enabling drag-to-reorder
        handleSelectionTouchStart(index, e) {
            const touch = e.touches[0];
            this._selectionTouchStartX = touch.clientX;
            this._selectionTouchStartY = touch.clientY;
            this._selectionDragActive = false;
            this._touchDragIndex = index;
            this._touchDropIndex = null;

            // Group drag: if touching a selected item, prepare to move all selected
            if (this.state.selectedIndices.has(index)) {
                this._touchGroupDrag = true;
                this._touchDraggedIndices = [...this.state.selectedIndices].sort((a, b) => a - b);
            } else {
                this._touchGroupDrag = false;
                this._touchDraggedIndices = [index];
            }
        },

        // Touch drag on the drag handle (mobile)
        handleHandleTouchStart(index, e) {
            e.stopPropagation();
            e.preventDefault();
            this._touchDragIndex = index;
            this._touchDropIndex = null;
            this._selectionDragActive = true; // Mark as active drag

            // Group drag: if dragging a selected item, prepare to move all selected
            if (this.state.selectionMode && this.state.selectedIndices.has(index)) {
                this._touchGroupDrag = true;
                this._touchDraggedIndices = [...this.state.selectedIndices].sort((a, b) => a - b);
                // Add visual feedback to all selected items
                this._touchDraggedIndices.forEach(i => {
                    const item = this.querySelector(`.queue-item[data-index="${i}"]`);
                    if (item) item.classList.add('group-dragging');
                });
            } else {
                this._touchGroupDrag = false;
                this._touchDraggedIndices = [index];
            }

            // Add dragging class to the source item using data-index
            const sourceItem = this.querySelector(`.queue-item[data-index="${index}"]`);
            if (sourceItem) {
                sourceItem.classList.add('dragging');
            }
        },

        handleHandleTouchMove(e) {
            if (this._touchDragIndex === null || this._touchDragIndex === undefined) return;

            const touch = e.touches[0];

            // In selection mode, only activate drag after sufficient movement
            if (this.state.selectionMode && !this._selectionDragActive) {
                const dx = Math.abs(touch.clientX - this._selectionTouchStartX);
                const dy = Math.abs(touch.clientY - this._selectionTouchStartY);
                if (dx < 10 && dy < 10) return; // Not enough movement yet

                // Activate drag mode
                this._selectionDragActive = true;

                // Add dragging class to source item
                const sourceItem = this.querySelector(`.queue-item[data-index="${this._touchDragIndex}"]`);
                if (sourceItem) sourceItem.classList.add('dragging');

                // Add group-dragging class if group drag
                if (this._touchGroupDrag && this._touchDraggedIndices) {
                    this._touchDraggedIndices.forEach(i => {
                        const item = this.querySelector(`.queue-item[data-index="${i}"]`);
                        if (item) item.classList.add('group-dragging');
                    });
                }
            }

            e.stopPropagation();
            e.preventDefault();

            // Clear previous drag-over classes (query fresh from DOM)
            this.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

            // Reset drop index - will be set if over valid target
            this._touchDropIndex = null;

            // Find which item we're over
            const elemUnder = document.elementFromPoint(touch.clientX, touch.clientY);
            if (elemUnder) {
                const queueItem = elemUnder.closest('.queue-item');
                if (queueItem && queueItem.dataset.index !== undefined && !queueItem.classList.contains('dragging')) {
                    const itemIndex = parseInt(queueItem.dataset.index, 10);
                    if (itemIndex !== this._touchDragIndex) {
                        queueItem.classList.add('drag-over');
                        this._touchDropIndex = itemIndex;
                    }
                }
            }
        },

        handleHandleTouchEnd(e) {
            // In selection mode, if drag wasn't activated, let click handler handle selection
            const wasDragActive = this._selectionDragActive;
            if (this.state.selectionMode && !wasDragActive) {
                // Reset state without preventing default - click will handle selection
                this._touchDragIndex = null;
                this._touchDropIndex = null;
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

            // Perform the reorder if we have valid indices
            if (this._touchDragIndex !== null && this._touchDragIndex !== undefined &&
                this._touchDropIndex !== null && this._touchDropIndex !== undefined &&
                this._touchDragIndex !== this._touchDropIndex) {
                this._trackQueueInteraction();

                if (this._touchGroupDrag && this._touchDraggedIndices && this._touchDraggedIndices.length > 1) {
                    // Group drag: move all selected items
                    const sortedIndices = [...this._touchDraggedIndices].sort((a, b) => a - b);

                    // Calculate where items will end up (same logic as reorderQueueBatch)
                    let adjustedTarget = this._touchDropIndex;
                    for (const idx of sortedIndices) {
                        if (idx < this._touchDropIndex) adjustedTarget--;
                    }
                    adjustedTarget = Math.max(0, adjustedTarget);

                    // New positions: adjustedTarget, adjustedTarget+1, adjustedTarget+2, ...
                    const newSet = new Set();
                    for (let i = 0; i < sortedIndices.length; i++) {
                        newSet.add(adjustedTarget + i);
                    }

                    player.reorderQueueBatch(this._touchDraggedIndices, this._touchDropIndex);

                    // Update selection to new positions
                    this.state.selectedIndices = newSet;
                    this.state.selectionVersion++;
                } else {
                    // Single item drag
                    player.reorderQueue(this._touchDragIndex, this._touchDropIndex);
                }
            }

            this._touchDragIndex = null;
            this._touchDropIndex = null;
            this._touchGroupDrag = false;
            this._touchDraggedIndices = null;
            this._selectionDragActive = false;
        },

        // Touch long press for context menu (mobile)
        handleTouchStart(song, e) {
            // Clear any existing timer
            if (this._longPressTimer) {
                clearTimeout(this._longPressTimer);
            }

            const touch = e.touches[0];
            this._touchStartX = touch.clientX;
            this._touchStartY = touch.clientY;
            this._touchSong = song;

            this._longPressTimer = setTimeout(() => {
                // Show context menu at touch position
                showSongContextMenu(song, this._touchStartX, this._touchStartY);
                this._longPressTriggered = true;
            }, 500);
        },

        handleTouchMove(e) {
            if (!this._longPressTimer) return;

            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - this._touchStartX);
            const dy = Math.abs(touch.clientY - this._touchStartY);

            // Cancel if moved more than 10px
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
            // If long press was triggered, prevent the click
            if (this._longPressTriggered) {
                e.preventDefault();
                this._longPressTriggered = false;
            }
        },

        _setupScrollListener() {
            // Clean up previous listener
            if (this._scrollHandler && this._scrollTarget) {
                this._scrollTarget.removeEventListener('scroll', this._scrollHandler);
            }

            // Use rafThrottle to limit scroll handler to once per animation frame
            this._scrollHandler = rafThrottle(() => this._updateVisibleRange());

            // Try to get the scroll wrapper, fall back to window
            requestAnimationFrame(() => {
                const scrollWrapper = this.refs.queueScrollWrapper;
                if (scrollWrapper) {
                    this._scrollTarget = scrollWrapper;
                    scrollWrapper.addEventListener('scroll', this._scrollHandler);
                } else {
                    this._scrollTarget = window;
                    window.addEventListener('scroll', this._scrollHandler, true);
                }
                this._updateVisibleRange();
            });
        },

        _updateVisibleRange() {
            const container = this.refs.queueContainer;
            const scrollWrapper = this.refs.queueScrollWrapper;
            if (!container || !scrollWrapper) return;

            const itemHeight = 48; // Must match CSS
            const baseBuffer = 40; // Increased from 20 for smoother scrolling
            const velocityBuffer = 30; // Extra items in scroll direction
            const headerHeight = 48; // Height of sticky queue header
            const minVisibleItems = 50; // Minimum items to render

            // Get scroll position from the scroll wrapper
            const scrollTop = scrollWrapper.scrollTop;
            // Account for sticky header
            const scrollIntoContainer = Math.max(0, scrollTop - headerHeight);
            // Visible height is the scroll wrapper's client height minus header
            const visibleHeight = Math.max(500, scrollWrapper.clientHeight - headerHeight);

            // Track scroll velocity for predictive buffering
            const now = performance.now();
            const scrollY = scrollTop;
            let scrollDirection = 0; // -1 = up, 0 = stationary, 1 = down

            if (this._lastScrollY !== undefined && this._lastScrollTime !== undefined) {
                const timeDelta = now - this._lastScrollTime;
                if (timeDelta > 0 && timeDelta < 200) { // Only if recent scroll
                    const scrollDelta = scrollY - this._lastScrollY;
                    const velocity = Math.abs(scrollDelta / timeDelta);
                    // Only apply velocity buffer if scrolling fast (> 0.5px/ms)
                    if (velocity > 0.5) {
                        scrollDirection = scrollDelta > 0 ? 1 : -1;
                    }
                }
            }
            this._lastScrollY = scrollY;
            this._lastScrollTime = now;

            // Calculate buffer with velocity-based overscan
            const bufferAbove = baseBuffer + (scrollDirection < 0 ? velocityBuffer : 0);
            const bufferBelow = baseBuffer + (scrollDirection > 0 ? velocityBuffer : 0);

            const queueLength = this.getVisibleQueue().length;
            let startIndex = Math.max(0, Math.floor(scrollIntoContainer / itemHeight) - bufferAbove);
            let endIndex = Math.min(
                queueLength,
                Math.ceil((scrollIntoContainer + visibleHeight) / itemHeight) + bufferBelow
            );

            // Ensure minimum number of visible items
            if (endIndex - startIndex < minVisibleItems) {
                endIndex = Math.min(queueLength, startIndex + minVisibleItems);
            }

            if (startIndex !== this.state.visibleStart || endIndex !== this.state.visibleEnd) {
                this.state.visibleStart = startIndex;
                this.state.visibleEnd = endIndex;
            }

            // Check if current song is in view and update jump button visibility
            this._checkCurrentSongVisibility();
        },

        /**
         * Check if the current song is visible in the viewport.
         * Updates showJumpToCurrent state accordingly.
         */
        _checkCurrentSongVisibility() {
            const queueIndex = this.stores.player.queueIndex;
            const visibleQueue = this.getVisibleQueue();
            const scrollWrapper = this.refs.queueScrollWrapper;

            if (queueIndex < 0 || visibleQueue.length === 0 || !scrollWrapper) {
                this.state.showJumpToCurrent = false;
                this._isCurrentInView = true;
                return;
            }

            // Find the display index of the current song
            const displayIndex = visibleQueue.findIndex(({ index }) => index === queueIndex);
            if (displayIndex === -1) {
                this.state.showJumpToCurrent = false;
                this._isCurrentInView = true;
                return;
            }

            const itemHeight = 48;
            const headerHeight = 48;
            const scrollTop = scrollWrapper.scrollTop;
            const viewportHeight = scrollWrapper.clientHeight;

            // Calculate where the current item is relative to scroll position
            const itemTop = headerHeight + (displayIndex * itemHeight);
            const itemBottom = itemTop + itemHeight;

            // Check if item is in the visible scroll area
            const isInView = itemTop >= scrollTop && itemBottom <= (scrollTop + viewportHeight);

            // Update both instance variable (for subscription) and state (for UI)
            this._isCurrentInView = isInView;
            this.state.showJumpToCurrent = !isInView && visibleQueue.length > 0;

            // Determine scroll direction: is current song above or below visible area?
            if (!isInView) {
                this.state.jumpDirection = itemTop < scrollTop ? 'up' : 'down';
            }
        },

        /**
         * Scroll the queue to center the current song.
         * @param {boolean} smooth - Use smooth scrolling animation
         */
        _scrollToCurrentSong(smooth = true) {
            const queueIndex = this.stores.player.queueIndex;
            const visibleQueue = this.getVisibleQueue();
            const scrollWrapper = this.refs.queueScrollWrapper;
            if (queueIndex < 0 || visibleQueue.length === 0 || !scrollWrapper) return;

            // Find the display index of the current song
            const displayIndex = visibleQueue.findIndex(({ index }) => index === queueIndex);
            if (displayIndex === -1) return;

            const itemHeight = 48;
            const headerHeight = 48;
            const viewportHeight = scrollWrapper.clientHeight;

            // Calculate scroll position to center the item
            const itemOffset = headerHeight + (displayIndex * itemHeight);
            const centerOffset = (viewportHeight - itemHeight) / 2;
            const scrollTarget = itemOffset - centerOffset;

            scrollWrapper.scrollTo({
                top: Math.max(0, scrollTarget),
                behavior: smooth ? 'smooth' : 'instant'
            });

            // Update visibility tracking after scroll
            this._isCurrentInView = true;
            this.state.showJumpToCurrent = false;
        },

        /**
         * Handle jump to current button click.
         */
        handleJumpToCurrent() {
            // In shuffle mode, use instant jump
            const useSmooth = !this.stores.player.shuffle;
            this._scrollToCurrentSong(useSmooth);
        },

        /**
         * Track user interaction with the queue (prevents auto-scroll).
         */
        _trackQueueInteraction() {
            this._lastQueueInteraction = Date.now();
        },

        /**
         * Toggle EQ menu visibility.
         */
        toggleEQMenu() {
            this.state.showEQMenu = !this.state.showEQMenu;
            this.state.showSortMenu = false; // Close other menus
        },

        /**
         * Close EQ menu.
         */
        closeEQMenu() {
            this.state.showEQMenu = false;
        },

        /**
         * Toggle volume popup visibility.
         */
        toggleVolumePopup() {
            this.state.showVolumePopup = !this.state.showVolumePopup;
            this.state.showEQMenu = false; // Close other menus
        },

        /**
         * Close volume popup.
         */
        closeVolumePopup() {
            this.state.showVolumePopup = false;
        },

        toggleSortMenu() {
            this.state.showSortMenu = !this.state.showSortMenu;
        },

        closeSortMenu() {
            this.state.showSortMenu = false;
        },

        async handleSortQueue(sortBy, order = 'asc') {
            this.state.isSorting = true;
            this.state.showSortMenu = false;

            try {
                // Use player.sortQueue which handles both temp queue and normal modes
                await player.sortQueue(sortBy, order);
            } catch (e) {
                console.error('Failed to sort queue:', e);
            } finally {
                this.state.isSorting = false;
            }
        },

        handleEQChange(e) {
            const value = e.target.value;

            if (value === '__off__') {
                // Turn off EQ
                player.setEQEnabled(false);
            } else if (value === '__custom__' || value === '') {
                // Custom mode - just ensure EQ is enabled
                eqPresetsStore.setActivePreset(null);
                if (!this.stores.player.eqEnabled) {
                    player.setEQEnabled(true);
                }
            } else {
                // Select a preset
                eqPresetsStore.setActivePreset(value);

                // Apply the preset to the player
                const isPEQMode = localStorage.getItem('music-eq-advanced') === 'true';
                if (isPEQMode) {
                    const bands = eqPresetsStore.getActiveBands();
                    player.setParametricEQ(bands, this._calculateAutoPreamp(bands));
                }

                // Ensure EQ is enabled
                if (!this.stores.player.eqEnabled) {
                    player.setEQEnabled(true);
                }
            }
        },

        _calculateAutoPreamp(bands) {
            if (!bands || bands.length === 0) return 0;

            // Create temporary AudioContext if needed
            if (!this._tempAudioContext) {
                try {
                    this._tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                } catch (e) {
                    // Fallback to simple calculation if no AudioContext
                    const maxGain = bands.reduce((max, band) => {
                        if (['peaking', 'lowshelf', 'highshelf'].includes(band.type) && band.gain > 0) {
                            return Math.max(max, band.gain);
                        }
                        return max;
                    }, 0);
                    return maxGain > 0 ? -maxGain : 0;
                }
            }

            // Calculate combined frequency response and find peak
            const numPoints = 256;
            const minFreq = 20;
            const maxFreq = 20000;
            const logMin = Math.log10(minFreq);
            const logMax = Math.log10(maxFreq);

            // Generate log-spaced frequencies
            const frequencies = new Float32Array(numPoints);
            for (let i = 0; i < numPoints; i++) {
                const logFreq = logMin + (i / (numPoints - 1)) * (logMax - logMin);
                frequencies[i] = Math.pow(10, logFreq);
            }

            // Combined magnitude in dB
            const combinedMag = new Float32Array(numPoints).fill(0);

            for (const band of bands) {
                const filter = this._tempAudioContext.createBiquadFilter();
                filter.type = band.type;
                filter.frequency.value = band.frequency;
                filter.gain.value = band.gain;
                if (['peaking', 'notch', 'bandpass', 'allpass', 'lowpass', 'highpass'].includes(band.type)) {
                    filter.Q.value = band.q || 1.0;
                }

                const magResponse = new Float32Array(numPoints);
                const phaseResponse = new Float32Array(numPoints);
                filter.getFrequencyResponse(frequencies, magResponse, phaseResponse);

                for (let i = 0; i < numPoints; i++) {
                    combinedMag[i] += 20 * Math.log10(magResponse[i]);
                }
            }

            // Find peak of combined response
            let peakDb = 0;
            for (let i = 0; i < numPoints; i++) {
                if (combinedMag[i] > peakDb) {
                    peakDb = combinedMag[i];
                }
            }

            // Round to 0.1 dB precision
            return peakDb > 0 ? -Math.ceil(peakDb * 10) / 10 : 0;
        }
    },

    template() {
        const song = this.stores.player.currentSong;
        const isPlaying = this.stores.player.isPlaying;
        const isLoading = this.stores.player.isLoading;
        // NOTE: currentTime and duration are accessed ONLY inside contain() blocks
        // to prevent high-frequency updates from triggering template() re-runs
        const volume = this.stores.player.volume * 100;
        const muted = this.stores.player.muted;
        const shuffle = this.stores.player.shuffle;
        const scaEnabled = this.stores.player.scaEnabled;
        const queueIndex = this.stores.player.queueIndex;
        const eqEnabled = this.stores.player.eqEnabled;
        const seekable = song?.seekable !== false && song?.seekable !== 0;
        const { showSaveDialog, playlistName, isSaving, saveError, showEQMenu, showVolumePopup, showJumpToCurrent, jumpDirection } = this.state;

        // Get visible queue (filtered when offline)
        const visibleQueue = this.getVisibleQueue();
        const visibleQueueLength = visibleQueue.length;
        const itemHeight = 48;
        const { visibleStart, visibleEnd } = this.state;
        const windowedItems = visibleQueue.slice(visibleStart, visibleEnd);

        return html`
            <div class="now-playing">
                <!-- Empty state when no queue -->
                ${when(visibleQueueLength === 0, () => html`
                    <div class="empty-state">
                        <div class="empty-icon">${this.stores.player.tempQueueMode ? '♻️' : '🎵'}</div>
                        <h2>${this.stores.player.tempQueueMode ? 'Temp Queue Empty' : 'No Songs in Queue'}</h2>
                        <p>${this.stores.player.tempQueueMode
                            ? 'Browse your library to add songs, or exit temp queue to restore your synced queue'
                            : 'Browse your library or start a radio session to play music'}</p>
                        <div class="empty-actions">
                            ${when(this.stores.player.tempQueueMode, () => html`
                                <cl-button severity="warning" on-click="handleToggleTempQueue">
                                    Exit Temp Queue
                                </cl-button>
                            `)}
                            <cl-button severity="primary" on-click="${() => window.location.hash = '/browse/'}">
                                Browse Music
                            </cl-button>
                            ${when(!this.stores.player.tempQueueMode, () => html`
                                <cl-button severity="secondary" on-click="${() => window.location.hash = '/radio/'}">
                                    Start Radio
                                </cl-button>
                            `)}
                        </div>
                    </div>
                `)}

                <!-- Queue as main content -->
                ${when(visibleQueueLength > 0, () => html`
                    <!-- Scroll wrapper for queue -->
                    <div class="queue-scroll-wrapper" ref="queueScrollWrapper">
                        <!-- Queue Header -->
                        <div class="queue-header">
                            <h3>📋 ${this.stores.player.tempQueueMode ? 'Temp Queue' : 'Queue'} (${visibleQueueLength})</h3>
                            <div class="queue-actions">
                                <button class="queue-action-btn temp-queue ${this.stores.player.tempQueueMode ? 'active' : ''}"
                                        on-click="handleToggleTempQueue"
                                        title="${this.stores.player.tempQueueMode ? 'Exit temp queue (restore synced queue)' : 'Enter temp queue (local-only queue)'}">
                                    ♻️<span class="btn-label">${this.stores.player.tempQueueMode ? 'Exit Temp' : 'Temp'}</span>
                                </button>
                                ${when(scaEnabled,
                                    () => html`<button class="queue-action-btn stop-radio" on-click="handleStopRadio" title="Stop Radio">⏹<span class="btn-label">Stop Radio</span></button>`,
                                    () => html`<button class="queue-action-btn" on-click="handleStartRadio" title="Start Radio">📻<span class="btn-label">Radio</span></button>`
                                )}
                                <div class="sort-dropdown">
                                    <button class="queue-action-btn" on-click="toggleSortMenu" title="Sort Queue" disabled="${this.state.isSorting}">
                                        ${this.state.isSorting ? '⏳' : '↕️'}<span class="btn-label">Sort</span>
                                    </button>
                                    ${when(this.state.showSortMenu, () => html`
                                        <div class="sort-menu" on-click-outside-stop="closeSortMenu">
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('artist')}">Artist (A-Z)</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('album')}">Album (A-Z)</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('track')}">Track Order</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('title')}">Title (A-Z)</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('year')}">Year (Oldest)</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('year', 'desc')}">Year (Newest)</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('duration')}">Duration (Short)</button>
                                            <button class="sort-option" on-click="${() => this.handleSortQueue('random')}">🔀 Shuffle</button>
                                        </div>
                                    `)}
                                </div>
                                <button class="queue-action-btn" on-click="handleShowSaveDialog" title="Save as Playlist">💾<span class="btn-label">Save</span></button>
                                <button class="queue-action-btn clear" on-click="handleClearQueue" title="Clear Queue">🗑<span class="btn-label">Clear</span></button>
                                <button class="queue-action-btn select ${this.state.selectionMode ? 'active' : ''}" on-click="toggleSelectionMode" title="${this.state.selectionMode ? 'Exit selection mode' : 'Select multiple items'}">
                                    ☑<span class="btn-label">${this.state.selectionMode ? 'Done' : 'Select'}</span>
                                </button>
                            </div>
                        </div>

                        <!-- Queue List -->
                        <div class="queue-container" ref="queueContainer"
                             style="height: ${visibleQueueLength * itemHeight}px; position: relative;">
                        <div class="queue-list" style="position: absolute; top: ${visibleStart * itemHeight}px; left: 0; right: 0;">
                            ${memoEach(windowedItems, ({ item, index }, displayIdx) => {
                                const displayIndex = visibleStart + displayIdx;
                                const isSelected = this.isSelected(index);
                                const selectionMode = this.state.selectionMode;
                                return html`
                                <div class="queue-item ${index === queueIndex ? 'current' : ''} ${selectionMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''} ${this.isUnavailableOffline(item.uuid) ? 'unavailable' : ''}"
                                     data-index="${index}"
                                     draggable="${!this.isTouchDevice()}"
                                     on-click="${(e) => selectionMode ? this.toggleSelection(index, e) : this.handleQueueItemClick(index)}"
                                     on-contextmenu="${(e) => this.handleQueueContextMenu(item, e)}"
                                     on-touchstart="${(e) => selectionMode ? this.handleSelectionTouchStart(index, e) : this.handleTouchStart(item, e)}"
                                     on-touchmove="${(e) => selectionMode ? this.handleHandleTouchMove(e) : this.handleTouchMove(e)}"
                                     on-touchend="${(e) => selectionMode ? this.handleHandleTouchEnd(e) : this.handleTouchEnd(e)}"
                                     on-dragstart="${(e) => { if (!this.isTouchDevice()) { this._trackQueueInteraction(); this.handleDragStart(index, e); } }}"
                                     on-dragend="handleDragEnd"
                                     on-dragover="${(e) => this.handleDragOver(index, e)}"
                                     on-dragenter="${(e) => this.handleDragEnter(index, e)}"
                                     on-dragleave="handleDragLeave"
                                     on-drop="${(e) => this.handleDrop(index, e)}">
                                    ${when(selectionMode, () => html`
                                        <input type="checkbox" class="selection-checkbox" checked="${isSelected}" on-click="${(e) => this.toggleSelection(index, e)}">
                                    `, () => html`
                                        <span class="drag-handle" title="Drag to reorder"
                                              on-touchstart="${(e) => this.handleHandleTouchStart(index, e)}"
                                              on-touchmove="${(e) => this.handleHandleTouchMove(e)}"
                                              on-touchend="${(e) => this.handleHandleTouchEnd(e)}">⋮⋮</span>
                                    `)}
                                    <span class="queue-index">${displayIndex + 1}</span>
                                    <div class="queue-info">
                                        <div class="queue-title">${item.track_number ? html`<span class="track-number">${String(item.track_number).padStart(2, '0')}</span>` : ''}${this.getDisplayTitle(item)}</div>
                                        <div class="queue-meta">
                                            ${when(item.artist,
                                                () => html`<a class="meta-link" on-click="${(e) => { e.stopPropagation(); if (!selectionMode) navigateToArtist(item.artist); }}">${item.artist}</a>`,
                                                () => html`<span>Unknown</span>`
                                            )}
                                        </div>
                                    </div>
                                    <div class="queue-item-actions">
                                        <button class="queue-remove" on-click="${(e) => this.handleRemoveFromQueue(index, e)}" title="Remove">✕</button>
                                    </div>
                                </div>
                            `}, ({ item, index }) => `${item.uuid}-${this.state.selectionVersion}-${index === queueIndex}`)}
                        </div>
                    </div>

                        <!-- Jump to Current floating button (inside scroll wrapper for proper positioning) -->
                        ${when(showJumpToCurrent, () => html`
                            <button class="jump-to-current" on-click="handleJumpToCurrent" title="Jump to current song">
                                <svg viewBox="0 0 24 24" width="24" height="24">
                                    ${jumpDirection === 'up'
                                        ? html`<path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>`
                                        : html`<path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>`
                                    }
                                </svg>
                            </button>
                        `)}
                    </div>

                    <!-- Selection Action Bar -->
                    ${when(this.state.selectionMode && this.state.selectedIndices.size > 0, () => html`
                        <div class="selection-bar">
                            <span class="selection-count">${this.state.selectedIndices.size} selected</span>
                            <div class="selection-actions">
                                <button class="selection-btn" on-click="selectAll">All</button>
                                <button class="selection-btn" on-click="clearSelection">Clear</button>
                                <button class="selection-btn" on-click="${() => { this.state.showAddToPlaylist = true; }}">Add to Playlist</button>
                                <button class="selection-btn danger" on-click="handleDeleteSelected">Delete</button>
                            </div>
                        </div>
                    `)}

                    <!-- Bottom Control Bar -->
                    <div class="bottom-bar">
                        <!-- Row 1: Progress (isolated to prevent queue re-renders on time updates) -->
                        ${contain(() => {
                            const currentTime = this.stores.player.currentTime;
                            const duration = this.stores.player.duration;
                            return html`
                            <div class="progress-row">
                                <span class="time">${this.formatTime(currentTime)}</span>
                                ${when(seekable,
                                    () => html`<div class="seek-wrapper" on-click="${(e) => this.handleSeekWrapperClick(e)}">
                                        <input type="range" class="seek-slider" min="0" max="${duration || 100}" step="1" value="${currentTime}" on-input="handleSeek">
                                    </div>`,
                                    () => html`<div class="progress-bar"><div class="progress-fill" style="width: ${duration ? (currentTime / duration * 100) : 0}%"></div></div>`
                                )}
                                <span class="time">${this.formatTime(duration)}</span>
                            </div>`;
                        })}

                        <!-- Row 2: Controls -->
                        <div class="controls-row">
                            <div class="controls-left">
                                <!-- Playback Mode Dropdown -->
                                <div class="playback-mode-dropdown">
                                    <button class="ctrl-btn sm ${this.getPlaybackMode() !== 'default' ? 'active' : ''}"
                                            on-click="togglePlaybackModeMenu"
                                            title="Playback: ${this.getPlaybackModeTitle()}">
                                        <span class="icon">${this.getPlaybackModeIcon()}</span>
                                    </button>
                                    ${when(this.state.showPlaybackModeMenu, () => html`
                                        <div class="playback-mode-menu" on-click-outside-stop="closePlaybackModeMenu">
                                            <button class="mode-option ${this.getPlaybackMode() === 'default' ? 'active' : ''}"
                                                    on-click="${() => this.setPlaybackMode('default')}">
                                                <span class="mode-icon">➡️</span>
                                                <span class="mode-label">Default</span>
                                            </button>
                                            <button class="mode-option ${this.getPlaybackMode() === 'shuffle' ? 'active' : ''}"
                                                    on-click="${() => this.setPlaybackMode('shuffle')}">
                                                <span class="mode-icon">🔀</span>
                                                <span class="mode-label">Shuffle</span>
                                            </button>
                                            <button class="mode-option ${this.getPlaybackMode() === 'repeat' ? 'active' : ''}"
                                                    on-click="${() => this.setPlaybackMode('repeat')}">
                                                <span class="mode-icon">🔁</span>
                                                <span class="mode-label">Repeat All</span>
                                            </button>
                                            <button class="mode-option ${this.getPlaybackMode() === 'repeat-one' ? 'active' : ''}"
                                                    on-click="${() => this.setPlaybackMode('repeat-one')}">
                                                <span class="mode-icon">🔂</span>
                                                <span class="mode-label">Repeat One</span>
                                            </button>
                                        </div>
                                    `)}
                                </div>
                                <button class="ctrl-btn sm ${this.isFavorite() ? 'active' : ''}"
                                        on-click="toggleFavorite"
                                        title="${this.isFavorite() ? 'Remove from Favorites' : 'Add to Favorites'}">
                                    <span class="icon">${this.isFavorite() ? '❤️' : '🤍'}</span>
                                </button>
                            </div>

                            <div class="controls-center">
                                <button class="ctrl-btn" on-click="handlePrevious" title="Previous">
                                    <span class="icon">⏮</span>
                                </button>
                                <button class="ctrl-btn play-btn ${isLoading ? 'loading' : ''}" on-click="handlePlayPause" title="${isPlaying ? 'Pause' : 'Play'}">
                                    ${isLoading ? html`<span class="icon">⏳</span>` : (isPlaying ? html`<span class="pause-icon"></span>` : html`<span class="play-icon"></span>`)}
                                </button>
                                <button class="ctrl-btn" on-click="${() => scaEnabled ? player.skip() : player.next()}" title="${scaEnabled ? 'Skip' : 'Next'}">
                                    <span class="icon">⏭</span>
                                </button>
                            </div>

                            <div class="controls-right">
                                <!-- EQ Dropdown -->
                                <div class="eq-dropdown">
                                    <button class="ctrl-btn sm eq-btn ${eqEnabled ? 'eq-active' : ''}" on-click="toggleEQMenu" title="Equalizer">
                                        <span class="icon">🎛️</span>
                                    </button>
                                    ${when(showEQMenu, () => html`
                                        <div class="eq-menu" on-click-outside-stop="closeEQMenu">
                                            <button class="eq-option ${!eqEnabled ? 'active' : ''}" on-click="${() => { this.handleEQChange({ target: { value: '__off__' } }); this.closeEQMenu(); }}">
                                                Off
                                            </button>
                                            ${when(eqEnabled && !this.stores.eqPresets.activePresetUuid, () => html`
                                                <button class="eq-option active" on-click="${() => { this.handleEQChange({ target: { value: '' } }); this.closeEQMenu(); }}">
                                                    Unsaved
                                                </button>
                                            `)}
                                            ${each(this.stores.eqPresets.presets, preset => html`
                                                <button class="eq-option ${eqEnabled && this.stores.eqPresets.activePresetUuid === preset.uuid ? 'active' : ''}"
                                                        on-click="${() => { this.handleEQChange({ target: { value: preset.uuid } }); this.closeEQMenu(); }}">
                                                    ${preset.name}
                                                </button>
                                            `)}
                                        </div>
                                    `)}
                                </div>

                                <!-- Volume Dropdown -->
                                <div class="volume-dropdown">
                                    <button class="ctrl-btn sm volume-btn" on-click="toggleVolumePopup" title="Volume">
                                        ${muted ? '🔇' : (volume > 50 ? '🔊' : (volume > 0 ? '🔉' : '🔈'))}
                                    </button>
                                    ${when(showVolumePopup, () => html`
                                        <div class="volume-menu" on-click-outside-stop="closeVolumePopup">
                                            <div class="volume-header">
                                                <span>Volume</span>
                                                <button class="mute-btn" on-click="handleToggleMute" title="${muted ? 'Unmute' : 'Mute'}">
                                                    ${muted ? '🔇' : '🔊'}
                                                </button>
                                            </div>
                                            <input type="range"
                                                   class="volume-slider"
                                                   min="0"
                                                   max="100"
                                                   value="${muted ? 0 : volume}"
                                                   on-input="handleVolumeChange">
                                            <div class="volume-value">${Math.round(volume)}%</div>
                                        </div>
                                    `)}
                                </div>
                            </div>
                        </div>
                    </div>
                `)}

                <!-- Save as Playlist Dialog -->
                ${when(showSaveDialog, () => html`
                    <div class="dialog-overlay" on-click="handleCloseSaveDialog">
                        <div class="dialog" on-click="${(e) => e.stopPropagation()}">
                            <h3>Save Queue as Playlist</h3>
                            <input type="text" class="dialog-input" placeholder="Playlist name..." x-model="playlistName">
                            ${when(saveError, () => html`<div class="dialog-error">${saveError}</div>`)}
                            <div class="dialog-actions">
                                <cl-button severity="secondary" on-click="handleCloseSaveDialog">Cancel</cl-button>
                                <cl-button severity="primary" on-click="handleSaveAsPlaylist" loading="${isSaving}">Save</cl-button>
                            </div>
                        </div>
                    </div>
                `)}

                <!-- Add to Playlist Dialog -->
                ${when(this.state.showAddToPlaylist, () => html`
                    <div class="dialog-overlay" on-click="handleCloseAddToPlaylist">
                        <div class="dialog" on-click="${(e) => e.stopPropagation()}">
                            <h3>Add to Playlist</h3>
                            <div class="playlist-list">
                                ${each(this.state.userPlaylists, playlist => html`
                                    <button class="playlist-item" on-click="${() => this.addToPlaylist(playlist.id)}" disabled="${this.state.addingToPlaylist}">
                                        <span class="playlist-icon">${playlist.name === FAVORITES_PLAYLIST_NAME ? '❤️' : '📋'}</span>
                                        <span class="playlist-name">${playlist.name}</span>
                                    </button>
                                `)}
                            </div>
                            <div class="dialog-actions">
                                <cl-button severity="secondary" on-click="handleCloseAddToPlaylist">Cancel</cl-button>
                            </div>
                        </div>
                    </div>
                `)}

                ${when(this.state.confirmDialog.show, () => html`
                    <cl-dialog visible="true" header="${this.state.confirmDialog.title}" on-close="handleConfirmDialogCancel">
                        <p>${this.state.confirmDialog.message}</p>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                            <cl-button severity="danger" on-click="handleConfirmDialogConfirm">Clear</cl-button>
                        </div>
                    </cl-dialog>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            min-height: 0; /* Allow flex child to shrink */
        }

        .now-playing {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0; /* Allow flex child to shrink */
            background: var(--surface-50, #1a1a1a);
            overflow: hidden;
            position: relative;
        }

        /* Scroll wrapper contains header + queue list */
        .queue-scroll-wrapper {
            flex: 1;
            min-height: 0; /* Allow flex child to shrink */
            overflow-y: auto;
            overflow-x: hidden;
            position: relative;
        }

        /* Empty State */
        .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 2rem;
        }

        .empty-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
            opacity: 0.6;
        }

        .empty-state h2 {
            margin: 0 0 0.5rem;
            color: var(--text-primary, #e0e0e0);
            font-weight: 500;
        }

        .empty-state p {
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 2rem;
        }

        .empty-actions {
            display: flex;
            gap: 1rem;
            justify-content: center;
            flex-wrap: wrap;
        }

        /* Queue Header */
        .queue-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.75rem 1rem;
            background: var(--surface-100, #242424);
            border-bottom: 1px solid var(--surface-300, #404040);
            position: sticky;
            top: 0;
            z-index: 10;
        }

        .queue-header h3 {
            margin: 0;
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-secondary, #a0a0a0);
        }

        .queue-actions {
            display: flex;
            gap: 0.5rem;
        }

        .queue-action-btn {
            background: var(--surface-200, #2d2d2d);
            border: none;
            border-radius: 6px;
            padding: 0.375rem 0.5rem;
            font-size: 0.875rem;
            cursor: pointer;
            color: var(--text-primary, #e0e0e0);
            transition: all 0.15s;
        }

        .queue-action-btn:hover {
            background: var(--surface-300, #404040);
        }

        .queue-action-btn.clear:hover {
            background: var(--danger-500, #dc3545);
            color: white;
        }

        .queue-action-btn.stop-radio {
            background: var(--success-100, #1b4332);
            color: var(--success-500, #22c55e);
        }

        .queue-action-btn.stop-radio:hover {
            background: var(--danger-500, #dc3545);
            color: white;
        }

        .queue-action-btn.temp-queue.active {
            background: var(--warning-100, #422006);
            color: var(--warning-500, #f59e0b);
        }

        .queue-action-btn.temp-queue.active:hover {
            background: var(--warning-500, #f59e0b);
            color: black;
        }

        /* Button labels - hidden on mobile, shown on desktop */
        .btn-label {
            display: none;
            margin-left: 0.25rem;
        }

        @media (min-width: 768px) {
            .btn-label {
                display: inline;
            }
        }

        /* Sort Dropdown */
        .sort-dropdown {
            position: relative;
        }

        .sort-menu {
            position: absolute;
            top: 100%;
            right: 0;
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

        /* Queue Container - explicit height for virtual scroll */
        .queue-container {
            contain: layout style;
        }

        .queue-list {
            will-change: transform;
            contain: paint;
        }

        .queue-item {
            display: flex;
            align-items: center;
            padding: 0 1rem;
            height: 48px;
            box-sizing: border-box;
            gap: 0.75rem;
            cursor: pointer;
            transition: background 0.15s;
            contain: layout style;
        }

        .queue-item:hover {
            background: var(--surface-100, #242424);
        }

        .queue-item.current {
            background: var(--selected-bg, #1e3a5f);
            box-shadow: inset 3px 0 0 var(--primary-500, #0066cc);
        }

        .queue-item.unavailable {
            opacity: 0.5;
        }

        .queue-item.unavailable .queue-title {
            color: var(--text-muted, #707070);
        }

        .queue-index {
            font-size: 0.75rem;
            font-family: ui-monospace, monospace;
            color: var(--text-muted, #707070);
            min-width: 2rem;
            text-align: right;
        }

        .queue-info {
            flex: 1;
            overflow: hidden;
        }

        .queue-title {
            font-size: 0.875rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text-primary, #e0e0e0);
        }

        .queue-item.current .queue-title {
            font-weight: 600;
        }

        .track-number {
            color: var(--text-muted, #707070);
            font-size: 0.85em;
            margin-right: 0.5em;
            font-weight: 400;
        }

        .queue-meta {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
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

        /* Queue Item Actions */
        .queue-item-actions {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            opacity: 0;
            transition: opacity 0.15s;
        }

        .queue-item:hover .queue-item-actions {
            opacity: 1;
        }

        .queue-remove {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--text-muted, #707070);
            padding: 0.25rem 0.375rem;
            font-size: 0.875rem;
            opacity: 0;
            transition: all 0.15s;
            border-radius: 4px;
        }

        .queue-item:hover .queue-remove {
            opacity: 1;
        }

        .queue-remove:hover {
            color: var(--danger-500, #dc3545);
            background: var(--surface-200, #2d2d2d);
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

        .queue-item:hover .drag-handle {
            opacity: 1;
        }

        /* Drag states */
        .queue-item.dragging {
            opacity: 0.5;
            background: var(--surface-200, #2d2d2d);
        }

        .queue-item.drag-over {
            border-top: 2px solid var(--primary-500, #0066cc);
            margin-top: -2px;
        }

        /* Selection mode styles */
        .queue-item.selectable {
            cursor: pointer;
        }

        .queue-item.selected {
            background: var(--primary-900, #1e3a5f);
        }

        .queue-item.selected:hover {
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
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 1rem;
            background: var(--surface-200, #2d2d2d);
            border-top: 1px solid var(--surface-300, #404040);
            flex-shrink: 0;
        }

        .selection-count {
            font-weight: 600;
            color: var(--text-primary, #fff);
        }

        .selection-actions {
            display: flex;
            gap: 0.5rem;
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

        .queue-action-btn.select.active {
            background: var(--primary-600, #0052a3);
            color: white;
        }

        /* Group drag visual feedback */
        .queue-item.group-dragging {
            opacity: 0.7;
            background: var(--primary-800, #2a4a70);
        }

        /* Jump to Current floating button - matches scroll-to-top styling */
        .jump-to-current {
            position: sticky;
            bottom: 24px;
            margin-left: auto;
            margin-right: 24px;
            margin-top: -72px; /* Pull up so it doesn't add to scroll height */
            z-index: 50;
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--primary-500, #0066cc);
            border: none;
            color: white;
            border-radius: 50%;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            transition: background 0.2s ease, box-shadow 0.2s ease;
            flex-shrink: 0;
        }

        .jump-to-current:hover {
            background: var(--primary-400, #3399ff);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
        }

        .jump-to-current:active {
            background: var(--primary-600, #0052a3);
        }

        /* Bottom Control Bar */
        .bottom-bar {
            flex-shrink: 0;
            background: var(--surface-100, #242424);
            border-top: 1px solid var(--surface-300, #404040);
            padding: 0.75rem 1rem;
        }

        .progress-row {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            margin-bottom: 0.75rem;
        }

        .time {
            font-size: 0.75rem;
            font-family: ui-monospace, monospace;
            color: var(--text-secondary, #a0a0a0);
            min-width: 2.5rem;
            text-align: center;
        }

        .seek-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            height: 32px;
            cursor: pointer;
            padding: 0 4px;
            margin: 0 -4px;
        }

        .seek-slider {
            flex: 1;
            height: 4px;
            -webkit-appearance: none;
            appearance: none;
            background: var(--surface-300, #404040);
            border-radius: 2px;
            cursor: pointer;
        }

        .seek-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: var(--text-primary, #e0e0e0);
            cursor: pointer;
            transition: transform 0.1s;
        }

        .seek-slider:hover::-webkit-slider-thumb {
            transform: scale(1.15);
        }

        .progress-bar {
            flex: 1;
            height: 4px;
            background: var(--surface-300, #404040);
            border-radius: 2px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: var(--text-primary, #e0e0e0);
            transition: width 0.1s linear;
        }

        /* Controls Row */
        .controls-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
        }

        .controls-left,
        .controls-right {
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }

        .controls-center {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .ctrl-btn {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            color: var(--text-primary, #e0e0e0);
            cursor: pointer;
            font-size: 1rem;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
        }

        .ctrl-btn .icon {
            line-height: 1;
        }

        .ctrl-btn:hover {
            background: var(--surface-300, #404040);
            border-color: var(--surface-400, #505050);
        }

        .ctrl-btn:active {
            transform: scale(0.95);
        }

        .ctrl-btn.active {
            background: var(--primary-600, #0052a3);
            border-color: var(--primary-500, #0066cc);
            color: white;
        }

        .ctrl-btn.active:hover {
            background: var(--primary-500, #0066cc);
        }

        .play-btn {
            background: var(--primary-500, #0066cc);
            border-color: var(--primary-500, #0066cc);
            color: white;
            width: 52px;
            height: 52px;
        }

        .play-btn .icon {
            filter: brightness(0) invert(1);
        }

        /* CSS play triangle */
        .play-icon {
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 9px 0 9px 14px;
            border-color: transparent transparent transparent white;
            margin-left: 3px;
        }

        /* CSS pause bars */
        .pause-icon {
            display: flex;
            gap: 4px;
        }

        .pause-icon::before,
        .pause-icon::after {
            content: '';
            width: 5px;
            height: 16px;
            background: white;
            border-radius: 1px;
        }

        .play-btn:hover {
            background: var(--primary-400, #3399ff);
            border-color: var(--primary-400, #3399ff);
        }

        .play-btn.loading {
            animation: pulse 1s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }

        /* Playback Mode Dropdown */
        .playback-mode-dropdown {
            position: relative;
        }

        .playback-mode-menu {
            position: absolute;
            bottom: 100%;
            left: 0;
            margin-bottom: 0.5rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            min-width: 140px;
            z-index: 200;
            overflow: hidden;
        }

        .mode-option {
            display: flex;
            align-items: center;
            gap: 0.5rem;
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

        .mode-option:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .mode-option.active {
            background: var(--primary-600, #0052a3);
            color: white;
        }

        .mode-option:not(:last-child) {
            border-bottom: 1px solid var(--surface-300, #404040);
        }

        .mode-icon {
            font-size: 1rem;
        }

        .mode-label {
            flex: 1;
        }

        /* EQ Dropdown */
        .eq-dropdown {
            position: relative;
        }

        .eq-btn {
            color: var(--text-muted, #707070);
        }

        .eq-btn.eq-active {
            background: var(--primary-600, #0052a3);
            border-color: var(--primary-500, #0066cc);
            color: white;
        }

        .eq-btn.eq-active:hover {
            background: var(--primary-500, #0066cc);
        }

        .eq-menu {
            position: absolute;
            bottom: 100%;
            right: 0;
            margin-bottom: 0.5rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            min-width: 140px;
            max-height: 300px;
            overflow-y: auto;
            z-index: 200;
        }

        .eq-option {
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

        .eq-option:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .eq-option.active {
            background: var(--primary-600, #0052a3);
            color: white;
        }

        .eq-option:not(:last-child) {
            border-bottom: 1px solid var(--surface-300, #404040);
        }

        /* Volume Dropdown */
        .volume-dropdown {
            position: relative;
        }

        .volume-btn {
            font-size: 1rem;
        }

        .volume-menu {
            position: absolute;
            bottom: 100%;
            right: 0;
            margin-bottom: 0.5rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            padding: 1rem;
            min-width: 180px;
            z-index: 200;
        }

        .volume-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 0.75rem;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .mute-btn {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 1rem;
            padding: 0.25rem;
            opacity: 0.7;
            transition: opacity 0.15s;
        }

        .mute-btn:hover {
            opacity: 1;
        }

        .volume-slider {
            width: 100%;
            height: 6px;
            -webkit-appearance: none;
            appearance: none;
            background: var(--surface-300, #404040);
            border-radius: 3px;
            cursor: pointer;
        }

        .volume-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--primary-500, #0066cc);
            cursor: pointer;
            transition: transform 0.1s;
        }

        .volume-slider:hover::-webkit-slider-thumb {
            transform: scale(1.15);
        }

        .volume-value {
            text-align: center;
            font-size: 0.75rem;
            font-family: ui-monospace, monospace;
            color: var(--text-secondary, #a0a0a0);
            margin-top: 0.5rem;
        }

        /* Playlist List in Dialog */
        .playlist-list {
            max-height: 300px;
            overflow-y: auto;
            margin-bottom: 1rem;
        }

        .playlist-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            width: 100%;
            padding: 0.75rem 1rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            margin-bottom: 0.5rem;
            cursor: pointer;
            transition: all 0.15s ease;
            text-align: left;
            color: var(--text-primary, #e0e0e0);
        }

        .playlist-item:hover:not(:disabled) {
            background: var(--surface-200, #2d2d2d);
            border-color: var(--primary-500, #0066cc);
        }

        .playlist-item:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .playlist-icon {
            font-size: 1.25rem;
        }

        .playlist-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* Dialog */
        .dialog-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .dialog {
            background: var(--surface-50, #1a1a1a);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 12px;
            padding: 1.5rem;
            width: 90%;
            max-width: 400px;
        }

        .dialog h3 {
            margin: 0 0 1rem;
            font-size: 1.125rem;
            color: var(--text-primary, #e0e0e0);
        }

        .dialog-input {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            font-size: 1rem;
            margin-bottom: 0.5rem;
            box-sizing: border-box;
        }

        .dialog-input:focus {
            outline: none;
            border-color: var(--primary-500, #2196f3);
        }

        .dialog-error {
            color: var(--danger-500, #dc3545);
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
        }

        .dialog-actions {
            display: flex;
            justify-content: flex-end;
            gap: 0.5rem;
            margin-top: 1rem;
        }

        /* Mobile */
        @media (max-width: 767px) {
            .queue-item {
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

            .queue-item-actions {
                opacity: 1;
            }

            .ctrl-btn {
                width: 44px;
                height: 44px;
                font-size: 1.125rem;
            }

            .ctrl-btn.sm {
                width: 36px;
                height: 36px;
                font-size: 0.875rem;
            }

            .play-btn {
                width: 56px;
                height: 56px;
            }

            .play-icon {
                border-width: 10px 0 10px 16px;
            }

            .pause-icon::before,
            .pause-icon::after {
                width: 6px;
                height: 18px;
            }

            .jump-to-current {
                bottom: 16px;
                margin-right: 12px;
                margin-top: -56px;
                width: 40px;
                height: 40px;
            }

            .jump-to-current svg {
                width: 20px;
                height: 20px;
            }
        }
    `
});

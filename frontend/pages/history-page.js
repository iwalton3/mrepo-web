/**
 * History Page
 *
 * View playback history with filtering and batch actions:
 * - Chronological view (all plays, newest first)
 * - Grouped view (unique songs sorted by play count)
 * - Date filtering (presets + custom range)
 * - Skip filter toggle
 * - Batch add to queue/playlist
 */

import { defineComponent, html, when, each, memoEach, untracked, flushSync } from '../lib/framework.js';
import { rafThrottle, notify } from '../lib/utils.js';
import { history as historyApi, playlists as playlistsApi, auth, shouldUseOffline } from '../offline/offline-api.js';
import { player } from '../stores/player-store.js';
import { showSongContextMenu, navigateToArtist, navigateToAlbum } from '../components/song-context-menu.js';
import '../components/scroll-to-top.js';
import '../componentlib/button/button.js';
import '../componentlib/overlay/dialog.js';
import '../componentlib/misc/spinner.js';

export default defineComponent('history-page', {
    props: {
        params: {},
        query: {}
    },

    data() {
        return {
            // View mode
            viewMode: 'chronological',  // 'chronological' | 'grouped'

            // Data
            historyItems: untracked([]),
            totalCount: 0,
            isLoading: false,
            isAuthenticated: false,

            // Windowed rendering
            visibleStart: 0,
            visibleEnd: 50,

            // Filters
            datePreset: 'all',  // '7d', '30d', '90d', '1y', 'all', 'custom'
            customStartDate: '',
            customEndDate: '',
            hideSkipped: false,

            // Batch actions
            showQueueMenu: false,
            showPlaylistDialog: false,
            playlists: [],
            selectedPlaylistId: null,
            batchLimit: 20,
            batchInProgress: false,

            // Create new playlist
            createNewPlaylist: false,
            newPlaylistName: ''
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

        if (this.state.isAuthenticated) {
            await this.loadHistory();
            this.loadPlaylists();
        }
    },

    unmounted() {
        if (this._scrollHandler) {
            window.removeEventListener('scroll', this._scrollHandler, true);
        }
    },

    methods: {
        getDateRange() {
            const now = new Date();
            let startDate = null;
            let endDate = null;

            switch (this.state.datePreset) {
                case '7d':
                    startDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    break;
                case '30d':
                    startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    break;
                case '90d':
                    startDate = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    break;
                case '1y':
                    startDate = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    break;
                case 'custom':
                    startDate = this.state.customStartDate || null;
                    endDate = this.state.customEndDate || null;
                    break;
                // 'all' - no date filtering
            }

            return { startDate, endDate };
        },

        async loadHistory() {
            // History not available offline
            if (shouldUseOffline()) {
                this.state.historyItems = [];
                this.state.totalCount = 0;
                this.state.isLoading = false;
                return;
            }

            this.state.isLoading = true;
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;

            try {
                const { startDate, endDate } = this.getDateRange();
                const excludeSkipped = this.state.hideSkipped;
                let result;

                if (this.state.viewMode === 'grouped') {
                    result = await historyApi.grouped({
                        startDate, endDate, excludeSkipped,
                        limit: 100
                    });
                } else {
                    result = await historyApi.list({
                        startDate, endDate, excludeSkipped,
                        limit: 100
                    });
                }

                const totalCount = result.totalCount || result.items.length;
                const items = new Array(totalCount).fill(null);
                result.items.forEach((item, i) => { items[i] = item; });

                this.state.historyItems = items;
                this.state.totalCount = totalCount;

                this._setupScrollListener();

                if (result.hasMore) {
                    this._loadRemainingInBackground(100);
                }
            } catch (e) {
                console.error('Failed to load history:', e);
                notify('Failed to load history', 'error');
            } finally {
                this.state.isLoading = false;
            }
        },

        async loadPlaylists() {
            try {
                const result = await playlistsApi.list();
                this.state.playlists = result.items || [];
                if (this.state.playlists.length > 0 && !this.state.selectedPlaylistId) {
                    this.state.selectedPlaylistId = this.state.playlists[0].id;
                }
            } catch (e) {
                console.error('Failed to load playlists:', e);
            }
        },

        _setupScrollListener() {
            if (this._scrollHandler) {
                window.removeEventListener('scroll', this._scrollHandler, true);
            }

            this._scrollHandler = rafThrottle(() => this._updateVisibleRange());
            window.addEventListener('scroll', this._scrollHandler, true);

            requestAnimationFrame(() => this._updateVisibleRange());
        },

        _updateVisibleRange() {
            const container = this.refs.historyContainer;
            if (!container) return;

            const itemHeight = 52;
            const buffer = 40;

            const rect = container.getBoundingClientRect();
            const viewportTop = Math.max(0, -rect.top);
            const viewportBottom = viewportTop + window.innerHeight;

            let startIndex = Math.max(0, Math.floor(viewportTop / itemHeight) - buffer);
            let endIndex = Math.min(
                this.state.totalCount,
                Math.ceil(viewportBottom / itemHeight) + buffer
            );

            // Clamp to actual loaded items
            const loadedCount = this.state.historyItems.length;
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

        async _loadRemainingInBackground(currentOffset) {
            const { startDate, endDate } = this.getDateRange();
            const excludeSkipped = this.state.hideSkipped;
            let offset = currentOffset;

            while (offset < this.state.totalCount) {
                try {
                    let result;
                    if (this.state.viewMode === 'grouped') {
                        result = await historyApi.grouped({
                            startDate, endDate, excludeSkipped,
                            offset, limit: 500
                        });
                    } else {
                        result = await historyApi.list({
                            startDate, endDate, excludeSkipped,
                            offset, limit: 500
                        });
                    }

                    const items = [...this.state.historyItems];
                    result.items.forEach((item, i) => {
                        items[offset + i] = item;
                    });
                    this.state.historyItems = items;

                    offset += result.items.length;

                    if (!result.hasMore) break;
                } catch (e) {
                    console.error('Background loading failed:', e);
                    break;
                }
            }
        },

        setViewMode(mode) {
            if (mode !== this.state.viewMode) {
                this.state.viewMode = mode;
                this.loadHistory();
            }
        },

        handleDatePresetChange(e) {
            this.state.datePreset = e.target.value;
            if (this.state.datePreset !== 'custom') {
                this.loadHistory();
            }
        },

        handleStartDateChange(e) {
            this.state.customStartDate = e.target.value;
        },

        handleEndDateChange(e) {
            this.state.customEndDate = e.target.value;
        },

        applyCustomDates() {
            this.loadHistory();
        },

        toggleSkipFilter() {
            this.state.hideSkipped = !this.state.hideSkipped;
            this.loadHistory();
        },

        handleItemClick(item) {
            player.addToQueue(item, true);
        },

        handleItemContextMenu(item, e) {
            e.preventDefault();
            e.stopPropagation();
            showSongContextMenu(item, e.clientX, e.clientY);
        },

        toggleQueueMenu() {
            this.state.showQueueMenu = !this.state.showQueueMenu;
        },

        closeQueueMenu() {
            this.state.showQueueMenu = false;
        },

        async handleAddToQueue(limit) {
            this.state.showQueueMenu = false;
            this.state.batchInProgress = true;

            try {
                const { startDate, endDate } = this.getDateRange();
                const grouped = this.state.viewMode === 'grouped';
                const excludeSkipped = this.state.hideSkipped;

                const result = await historyApi.getUuids({
                    startDate, endDate, excludeSkipped, grouped,
                    limit: limit === 'all' ? 5000 : limit
                });

                if (result.uuids.length === 0) {
                    notify('No songs to add');
                    return;
                }

                // Get song details for each UUID
                const songs = this.state.historyItems.filter(
                    item => item && result.uuids.includes(item.uuid)
                );

                // If we don't have all songs loaded, just use UUIDs we do have
                const toAdd = songs.length > 0 ? songs : result.uuids.map(uuid => ({ uuid }));

                await player.addToQueue(toAdd.slice(0, limit === 'all' ? 5000 : limit), false);
                notify(`Added ${Math.min(toAdd.length, limit === 'all' ? 5000 : limit)} songs to queue`);
            } catch (e) {
                console.error('Failed to add to queue:', e);
                notify('Failed to add to queue', 'error');
            } finally {
                this.state.batchInProgress = false;
            }
        },

        openPlaylistDialog() {
            this.state.showPlaylistDialog = true;
            this.state.createNewPlaylist = false;
            this.state.newPlaylistName = '';
        },

        closePlaylistDialog() {
            this.state.showPlaylistDialog = false;
            this.state.createNewPlaylist = false;
            this.state.newPlaylistName = '';
        },

        toggleCreateNew() {
            this.state.createNewPlaylist = !this.state.createNewPlaylist;
        },

        handlePlaylistSelect(e) {
            this.state.selectedPlaylistId = e.target.value;
        },

        async handleAddToPlaylist(limit) {
            this.state.batchInProgress = true;

            try {
                const { startDate, endDate } = this.getDateRange();
                const grouped = this.state.viewMode === 'grouped';
                const excludeSkipped = this.state.hideSkipped;
                let playlistId = this.state.selectedPlaylistId;

                // Create new playlist if requested
                if (this.state.createNewPlaylist) {
                    const name = this.state.newPlaylistName.trim();
                    if (!name) {
                        notify('Please enter a playlist name');
                        this.state.batchInProgress = false;
                        return;
                    }

                    const createResult = await playlistsApi.create(name, '', false);
                    if (createResult.error) {
                        notify('Failed to create playlist', 'error');
                        this.state.batchInProgress = false;
                        return;
                    }
                    playlistId = createResult.id;

                    // Refresh playlists list
                    this.loadPlaylists();
                }

                if (!playlistId) {
                    notify('Please select a playlist');
                    this.state.batchInProgress = false;
                    return;
                }

                this.state.showPlaylistDialog = false;

                const result = await historyApi.getUuids({
                    startDate, endDate, excludeSkipped, grouped,
                    limit: limit === 'all' ? 5000 : limit
                });

                if (result.uuids.length === 0) {
                    notify('No songs to add');
                    return;
                }

                const uuids = result.uuids.slice(0, limit === 'all' ? 5000 : limit);

                // Batch add to playlist
                await playlistsApi.addSongsBatch(playlistId, uuids);

                const playlistName = this.state.createNewPlaylist
                    ? this.state.newPlaylistName
                    : this.state.playlists.find(p => p.id === playlistId)?.name || 'playlist';
                notify(`Added ${uuids.length} songs to ${playlistName}`);
            } catch (e) {
                console.error('Failed to add to playlist:', e);
                notify('Failed to add to playlist', 'error');
            } finally {
                this.state.batchInProgress = false;
                this.state.createNewPlaylist = false;
                this.state.newPlaylistName = '';
            }
        },

        formatDate(date) {
            if (!date) return '';
            const d = new Date(date);
            const now = new Date();
            const diff = now - d;

            // Less than 24 hours ago - show relative time
            if (diff < 24 * 60 * 60 * 1000) {
                const hours = Math.floor(diff / (60 * 60 * 1000));
                if (hours < 1) {
                    const mins = Math.floor(diff / (60 * 1000));
                    return mins < 1 ? 'Just now' : `${mins}m ago`;
                }
                return `${hours}h ago`;
            }

            // Less than 7 days ago
            if (diff < 7 * 24 * 60 * 60 * 1000) {
                const days = Math.floor(diff / (24 * 60 * 60 * 1000));
                return `${days}d ago`;
            }

            // Otherwise show date
            return d.toLocaleDateString();
        },

        formatDuration(seconds) {
            if (seconds == null) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${String(secs).padStart(2, '0')}`;
        },

        getDisplayTitle(song) {
            return song.title || song.filename || 'Unknown';
        },

        renderHistoryItem(item, index) {
            if (!item) {
                return html`
                    <div class="history-item loading-placeholder">
                        <span class="history-num">${index + 1}</span>
                        <div class="history-info">
                            <div class="song-title">Loading...</div>
                        </div>
                    </div>
                `;
            }

            if (this.state.viewMode === 'grouped') {
                return this.renderGroupedItem(item, index);
            }
            return this.renderChronologicalItem(item, index);
        },

        renderChronologicalItem(item, index) {
            return html`
                <div class="history-item"
                     on-click="${() => this.handleItemClick(item)}"
                     on-contextmenu="${(e) => this.handleItemContextMenu(item, e)}">
                    <span class="history-num">${index + 1}</span>
                    <div class="history-info">
                        <div class="song-title">${this.getDisplayTitle(item)}</div>
                        <div class="song-meta">
                            ${when(item.artist,
                                () => html`<a class="meta-link" on-click="${(e) => { e.stopPropagation(); navigateToArtist(item.artist); }}">${item.artist}</a>`,
                                () => html`<span>Unknown</span>`
                            )}
                            ${when(item.album, () => html`
                                <span> • </span>
                                <a class="meta-link" on-click="${(e) => { e.stopPropagation(); navigateToAlbum(item.artist, item.album); }}">${item.album}</a>
                            `)}
                        </div>
                    </div>
                    <div class="history-meta">
                        ${when(item.skipped && !this.state.hideSkipped, html`
                            <span class="skipped-badge">Skipped</span>
                        `)}
                        <span class="played-at">${this.formatDate(item.played_at)}</span>
                        <span class="duration">${this.formatDuration(item.play_duration_seconds || 0)}</span>
                    </div>
                </div>
            `;
        },

        renderGroupedItem(item, index) {
            return html`
                <div class="history-item grouped"
                     on-click="${() => this.handleItemClick(item)}"
                     on-contextmenu="${(e) => this.handleItemContextMenu(item, e)}">
                    <span class="play-count-badge">${item.play_count}</span>
                    <div class="history-info">
                        <div class="song-title">${this.getDisplayTitle(item)}</div>
                        <div class="song-meta">
                            ${when(item.artist,
                                () => html`<a class="meta-link" on-click="${(e) => { e.stopPropagation(); navigateToArtist(item.artist); }}">${item.artist}</a>`,
                                () => html`<span>Unknown</span>`
                            )}
                            ${when(item.album, () => html`
                                <span> • </span>
                                <a class="meta-link" on-click="${(e) => { e.stopPropagation(); navigateToAlbum(item.artist, item.album); }}">${item.album}</a>
                            `)}
                        </div>
                    </div>
                    <div class="history-meta">
                        <span class="last-played">Last: ${this.formatDate(item.last_played)}</span>
                    </div>
                </div>
            `;
        }
    },

    template() {
        const { viewMode, historyItems, totalCount, isLoading, isAuthenticated,
                visibleStart, visibleEnd, datePreset, customStartDate, customEndDate,
                hideSkipped, showQueueMenu, showPlaylistDialog, playlists,
                selectedPlaylistId, batchInProgress,
                createNewPlaylist, newPlaylistName } = this.state;

        return html`
            <div class="history-page">
                <h1>History</h1>

                ${when(!isAuthenticated, html`
                    <div class="auth-prompt">
                        <p>Please log in to view your history.</p>
                    </div>
                `, () => html`
                    ${when(!navigator.onLine, html`
                        <div class="offline-notice">
                            History requires an internet connection.
                        </div>
                    `, () => html`
                        <!-- Toolbar -->
                        <div class="history-toolbar">
                            <div class="view-toggle">
                                <button class="${viewMode === 'chronological' ? 'active' : ''}"
                                        on-click="${() => this.setViewMode('chronological')}">
                                    Chronological
                                </button>
                                <button class="${viewMode === 'grouped' ? 'active' : ''}"
                                        on-click="${() => this.setViewMode('grouped')}">
                                    By Song
                                </button>
                            </div>

                            <div class="date-filter">
                                <select value="${datePreset}" on-change="handleDatePresetChange">
                                    <option value="7d">Last 7 days</option>
                                    <option value="30d">Last 30 days</option>
                                    <option value="90d">Last 90 days</option>
                                    <option value="1y">Last year</option>
                                    <option value="all">All time</option>
                                    <option value="custom">Custom range</option>
                                </select>
                            </div>

                            <button class="skip-filter ${hideSkipped ? 'active' : ''}"
                                    on-click="toggleSkipFilter"
                                    title="${hideSkipped ? 'Show skipped songs' : 'Hide skipped songs'}">
                                ${hideSkipped ? 'Show Skipped' : 'Hide Skipped'}
                            </button>
                        </div>

                        ${when(datePreset === 'custom', html`
                            <div class="custom-dates">
                                <input type="date" value="${customStartDate}"
                                       on-change="handleStartDateChange">
                                <span>to</span>
                                <input type="date" value="${customEndDate}"
                                       on-change="handleEndDateChange">
                                <cl-button on-click="applyCustomDates">Apply</cl-button>
                            </div>
                        `)}

                        <!-- Stats -->
                        <div class="history-stats">
                            ${totalCount} ${viewMode === 'grouped' ? 'unique songs' : 'plays'}
                        </div>

                        <!-- Batch Actions -->
                        <div class="batch-actions">
                            <div class="batch-dropdown">
                                <cl-button severity="secondary" on-click="toggleQueueMenu"
                                           disabled="${batchInProgress}">
                                    Add to Queue
                                </cl-button>
                                ${when(showQueueMenu, html`
                                    <div class="batch-menu">
                                        <button on-click="${() => this.handleAddToQueue(20)}">Add 20</button>
                                        <button on-click="${() => this.handleAddToQueue(100)}">Add 100</button>
                                        <button on-click="${() => this.handleAddToQueue(1000)}">Add 1000</button>
                                        <button on-click="${() => this.handleAddToQueue('all')}">Add All</button>
                                    </div>
                                `)}
                            </div>

                            <cl-button severity="secondary" on-click="openPlaylistDialog"
                                       disabled="${batchInProgress}">
                                Add to Playlist
                            </cl-button>

                            ${when(batchInProgress, html`
                                <cl-spinner size="small"></cl-spinner>
                            `)}
                        </div>

                        <!-- History List -->
                        ${when(isLoading && historyItems.length === 0, html`
                            <div class="loading"><cl-spinner></cl-spinner></div>
                        `, () => html`
                            ${when(totalCount === 0, html`
                                <div class="empty">No play history found.</div>
                            `, () => {
                                const itemHeight = 52;
                                const visibleItems = historyItems.slice(visibleStart, visibleEnd);

                                return html`
                                    <div class="history-container" ref="historyContainer"
                                         style="height: ${totalCount * itemHeight}px; position: relative;">
                                        <div class="history-list"
                                             style="position: absolute; top: 0; left: 0; right: 0; transform: translateY(${visibleStart * itemHeight}px);">
                                            ${memoEach(visibleItems, (item, idx) => {
                                                const actualIndex = visibleStart + idx;
                                                return this.renderHistoryItem(item, actualIndex);
                                            }, (item, idx) => `${item?.uuid ?? 'loading'}-${visibleStart + idx}`, { trustKey: true })}
                                        </div>
                                    </div>
                                `;
                            })}
                        `)}

                        <!-- Playlist Dialog -->
                        ${when(showPlaylistDialog, () => html`
                            <cl-dialog visible="true" header="Add to Playlist"
                                       on-change="${(e, val) => { if (!val) this.closePlaylistDialog(); }}">
                                <div class="playlist-select-dialog">
                                    <div class="playlist-mode-toggle">
                                        <button class="${!createNewPlaylist ? 'active' : ''}"
                                                on-click="${() => { this.state.createNewPlaylist = false; }}">
                                            Existing Playlist
                                        </button>
                                        <button class="${createNewPlaylist ? 'active' : ''}"
                                                on-click="${() => { this.state.createNewPlaylist = true; }}">
                                            New Playlist
                                        </button>
                                    </div>

                                    ${when(createNewPlaylist, html`
                                        <div class="new-playlist-form">
                                            <label>Playlist Name</label>
                                            <input type="text" x-model="newPlaylistName"
                                                   placeholder="Enter playlist name">
                                        </div>
                                    `, () => html`
                                        <div class="existing-playlist-select">
                                            <label>Select a playlist:</label>
                                            <select value="${selectedPlaylistId}" on-change="handlePlaylistSelect">
                                                ${each(playlists, p => html`
                                                    <option value="${p.id}">${p.name}</option>
                                                `)}
                                            </select>
                                        </div>
                                    `)}

                                    <p>How many songs to add?</p>
                                    <div class="amount-buttons">
                                        <button on-click="${() => this.handleAddToPlaylist(20)}">20</button>
                                        <button on-click="${() => this.handleAddToPlaylist(100)}">100</button>
                                        <button on-click="${() => this.handleAddToPlaylist(1000)}">1000</button>
                                        <button on-click="${() => this.handleAddToPlaylist('all')}">All</button>
                                    </div>
                                </div>
                            </cl-dialog>
                        `)}
                    `)}
                `)}

                <scroll-to-top></scroll-to-top>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .history-page {
            padding: 1rem;
            max-width: 800px;
            margin: 0 auto;
        }

        h1 {
            margin: 0 0 1rem;
            font-size: 1.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .auth-prompt,
        .offline-notice {
            padding: 2rem;
            text-align: center;
            color: var(--text-secondary, #a0a0a0);
            background: var(--surface-100, #242424);
            border-radius: 8px;
        }

        /* Toolbar */
        .history-toolbar {
            display: flex;
            gap: 0.75rem;
            flex-wrap: wrap;
            margin-bottom: 1rem;
            align-items: center;
        }

        .view-toggle {
            display: flex;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            padding: 4px;
        }

        .view-toggle button {
            padding: 0.5rem 0.75rem;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.875rem;
            transition: background 0.2s, color 0.2s;
        }

        .view-toggle button:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .view-toggle button.active {
            background: var(--primary-600, #2563eb);
            color: white;
        }

        .date-filter select {
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
            cursor: pointer;
        }

        .skip-filter {
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
            cursor: pointer;
            transition: background 0.2s, color 0.2s;
        }

        .skip-filter:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .skip-filter.active {
            background: var(--primary-600, #2563eb);
            color: white;
            border-color: var(--primary-600, #2563eb);
        }

        .custom-dates {
            display: flex;
            gap: 0.5rem;
            align-items: center;
            margin-bottom: 1rem;
        }

        .custom-dates input[type="date"] {
            padding: 0.5rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
        }

        .custom-dates span {
            color: var(--text-secondary, #a0a0a0);
        }

        /* Stats */
        .history-stats {
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            margin-bottom: 1rem;
        }

        /* Batch Actions */
        .batch-actions {
            display: flex;
            gap: 0.75rem;
            margin-bottom: 1rem;
            align-items: center;
        }

        .batch-dropdown {
            position: relative;
        }

        .batch-menu {
            position: absolute;
            top: 100%;
            left: 0;
            z-index: 100;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            min-width: 150px;
            margin-top: 4px;
        }

        .batch-menu button {
            display: block;
            width: 100%;
            padding: 0.75rem 1rem;
            background: transparent;
            border: none;
            color: var(--text-primary, #e0e0e0);
            text-align: left;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .batch-menu button:hover {
            background: var(--surface-200, #2d2d2d);
        }

        /* History Items */
        .history-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0 0.75rem;
            height: 52px;
            cursor: pointer;
            border-radius: 6px;
            transition: background 0.15s;
        }

        .history-item:hover {
            background: var(--surface-100, #242424);
        }

        .history-item.loading-placeholder {
            opacity: 0.5;
        }

        .history-num {
            min-width: 2rem;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
            text-align: right;
        }

        .play-count-badge {
            background: var(--primary-600, #2563eb);
            color: white;
            border-radius: 12px;
            padding: 0.125rem 0.5rem;
            font-size: 0.75rem;
            font-weight: 600;
            min-width: 2rem;
            text-align: center;
        }

        .history-info {
            flex: 1;
            min-width: 0;
        }

        .song-title {
            font-size: 0.9375rem;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .song-meta {
            font-size: 0.8125rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .meta-link {
            color: var(--text-secondary, #a0a0a0);
            text-decoration: none;
            cursor: pointer;
        }

        .meta-link:hover {
            color: var(--primary-400, #60a5fa);
            text-decoration: underline;
        }

        .history-meta {
            display: flex;
            gap: 0.5rem;
            align-items: center;
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            flex-shrink: 0;
        }

        .played-at,
        .last-played {
            color: var(--text-tertiary, #808080);
        }

        .duration {
            color: var(--text-tertiary, #808080);
        }

        .skipped-badge {
            background: var(--warning-100, #fef3c7);
            color: var(--warning-800, #92400e);
            padding: 0.125rem 0.375rem;
            border-radius: 4px;
            font-size: 0.6875rem;
            font-weight: 500;
        }

        /* Loading & Empty States */
        .loading,
        .empty {
            padding: 3rem;
            text-align: center;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Playlist Dialog */
        .playlist-select-dialog {
            padding: 0.5rem 0;
        }

        .playlist-select-dialog p {
            margin: 0 0 0.75rem;
            color: var(--text-primary, #e0e0e0);
        }

        .playlist-mode-toggle {
            display: flex;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            padding: 4px;
            margin-bottom: 1rem;
        }

        .playlist-mode-toggle button {
            flex: 1;
            padding: 0.5rem 0.75rem;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.875rem;
            transition: background 0.2s, color 0.2s;
        }

        .playlist-mode-toggle button:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .playlist-mode-toggle button.active {
            background: var(--primary-600, #2563eb);
            color: white;
        }

        .new-playlist-form,
        .existing-playlist-select {
            margin-bottom: 1rem;
        }

        .new-playlist-form label,
        .existing-playlist-select label {
            display: block;
            margin-bottom: 0.5rem;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .new-playlist-form input {
            width: 100%;
            padding: 0.5rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
        }

        .playlist-select-dialog select {
            width: 100%;
            padding: 0.5rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
        }

        .amount-buttons {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
        }

        .amount-buttons button {
            flex: 1;
            min-width: 60px;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            color: var(--text-primary, #e0e0e0);
            cursor: pointer;
            font-size: 0.875rem;
            transition: background 0.2s;
        }

        .amount-buttons button:hover {
            background: var(--surface-200, #2d2d2d);
        }

        /* Responsive */
        @media (max-width: 600px) {
            .history-toolbar {
                flex-wrap: wrap;
                gap: 0.5rem;
            }

            .view-toggle {
                flex-shrink: 0;
            }

            .view-toggle button {
                white-space: nowrap;
            }

            .batch-actions {
                flex-wrap: wrap;
                gap: 0.5rem;
            }
        }
    `
});

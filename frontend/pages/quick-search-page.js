/**
 * Search Page
 *
 * Fast, sectioned search results showing:
 * - Matching artists
 * - Matching albums
 * - Matching songs
 * - Matching folders
 *
 * Results appear as you type with minimal latency.
 * Includes syntax help for advanced query operators.
 */

import { defineComponent, html, when, each, memoEach, untracked, flushSync } from '../lib/framework.js';
import { rafThrottle } from '../lib/utils.js';
import { songs } from '../offline/offline-api.js';
import { player } from '../stores/player-store.js';
import offlineStore from '../offline/offline-store.js';
import { searchOfflineSongs } from '../offline/offline-db.js';
import { showSongContextMenu, navigateToArtist, navigateToAlbum, navigateToFolder } from '../components/song-context-menu.js';
import '../componentlib/button/button.js';
import '../componentlib/misc/spinner.js';

export default defineComponent('quick-search-page', {
    props: {
        query: {}  // Query params from router (e.g., ?q=beatles)
    },

    stores: { offline: offlineStore },

    data() {
        return {
            searchQuery: '',  // The actual search text
            results: null,  // {artists, albums, songs, folders} for quick search
            advancedResults: untracked([]),  // Sparse array for virtual scroll - untracked for performance
            advancedTotalCount: 0,
            isLoading: false,
            searchPerformed: false,
            showHelp: false,
            advancedMode: false,  // true when showing full song results
            // Windowed rendering for advanced results
            visibleStart: 0,
            visibleEnd: 50,
            // Section limits for quick search (for load more functionality)
            artistsLimit: 10,
            albumsLimit: 10,
            songsLimit: 10,
            foldersLimit: 10
        };
    },

    unmounted() {
        if (this._scrollListener) {
            const mainContent = document.querySelector('div.router-wrapper');
            if (mainContent) {
                mainContent.removeEventListener('scroll', this._scrollListener);
            }
        }
    },

    mounted() {
        // Read query from URL if present
        const urlQuery = this.props.query?.q;
        if (urlQuery) {
            this.state.searchQuery = urlQuery;
            // Perform search automatically
            this.performAdvancedSearch();
        }

        // Focus search input on mount
        requestAnimationFrame(() => {
            const input = this.querySelector('.search-input');
            if (input) input.focus();
        });
    },

    propsChanged(prop, newValue, oldValue) {
        // Handle URL query changes (e.g., browser back/forward)
        if (prop === 'query' && newValue?.q !== oldValue?.q) {
            const urlQuery = newValue?.q || '';
            if (urlQuery !== this.state.searchQuery) {
                this.state.searchQuery = urlQuery;
                if (urlQuery) {
                    this.performAdvancedSearch();
                } else {
                    this.state.results = null;
                    this.state.advancedMode = false;
                    this.state.searchPerformed = false;
                }
            }
        }
    },

    methods: {
        getDisplayTitle(song) {
            if (!song) return 'Unknown';
            if (song.title) return song.title;
            // Fallback to filename without extension
            const path = song.virtual_file || song.file || '';
            const filename = path.split('/').pop() || '';
            return filename.replace(/\.[^.]+$/, '') || 'Unknown';
        },

        handleQueryChange(e) {
            this.state.searchQuery = e.target.value;
            // Reset to quick search mode when typing
            this.state.advancedMode = false;
            this._debouncedSearch();
        },

        handleKeyDown(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.performAdvancedSearch();
            }
        },

        _debouncedSearch() {
            // Debounce search to avoid excessive API calls
            if (this._searchTimeout) {
                clearTimeout(this._searchTimeout);
            }
            this._searchTimeout = setTimeout(() => this.performSearch(), 300);
        },

        _updateUrl(query) {
            // Update URL with search query for deeplinking
            const basePath = '#/search/';
            if (query) {
                window.history.replaceState(null, '', basePath + '?q=' + encodeURIComponent(query));
            } else {
                window.history.replaceState(null, '', basePath);
            }
        },

        async performSearch() {
            const query = this.state.searchQuery.trim();
            if (!query) {
                this.state.results = null;
                this.state.searchPerformed = false;
                this.state.advancedMode = false;
                return;
            }

            const isOffline = this.stores.offline.workOfflineMode || !this.stores.offline.isOnline;

            this.state.isLoading = true;
            this.state.searchPerformed = true;

            if (isOffline) {
                // Offline search - use local IndexedDB song metadata
                try {
                    const offlineSongs = await searchOfflineSongs(query);
                    const queryLower = query.toLowerCase();

                    // Compute matching artists from songs
                    const artistMap = new Map();
                    for (const song of offlineSongs) {
                        if (song.artist && song.artist.toLowerCase().includes(queryLower)) {
                            if (!artistMap.has(song.artist)) {
                                artistMap.set(song.artist, { name: song.artist, song_count: 0 });
                            }
                            artistMap.get(song.artist).song_count++;
                        }
                    }
                    const artists = [...artistMap.values()].sort((a, b) => b.song_count - a.song_count);

                    // Compute matching albums from songs
                    const albumMap = new Map();
                    for (const song of offlineSongs) {
                        if (song.album && song.album.toLowerCase().includes(queryLower)) {
                            const key = `${song.artist || ''}|${song.album}`;
                            if (!albumMap.has(key)) {
                                albumMap.set(key, { name: song.album, artist: song.artist || 'Unknown Artist', song_count: 0 });
                            }
                            albumMap.get(key).song_count++;
                        }
                    }
                    const albums = [...albumMap.values()].sort((a, b) => b.song_count - a.song_count);

                    this.state.results = {
                        artists: artists.slice(0, 10),
                        albums: albums.slice(0, 10),
                        songs: offlineSongs.slice(0, 50),
                        folders: [],  // Not supported offline
                        artistsHasMore: artists.length > 10,
                        albumsHasMore: albums.length > 10,
                        songsHasMore: offlineSongs.length > 50,
                        foldersHasMore: false
                    };
                    this._updateUrl(query);
                } catch (e) {
                    console.error('Offline search failed:', e);
                    this.state.results = {
                        artists: [], albums: [], songs: [], folders: [],
                        artistsHasMore: false, albumsHasMore: false,
                        songsHasMore: false, foldersHasMore: false
                    };
                } finally {
                    this.state.isLoading = false;
                }
                return;
            }

            // Online search
            // Use the max limit from all sections
            const maxLimit = Math.max(
                this.state.artistsLimit,
                this.state.albumsLimit,
                this.state.songsLimit,
                this.state.foldersLimit
            );

            try {
                const results = await songs.quickSearch(query, maxLimit);
                this.state.results = results;
                // Update URL for quick search deeplinking
                this._updateUrl(query);
            } catch (e) {
                console.error('Quick search failed:', e);
                this.state.results = {
                    artists: [], albums: [], songs: [], folders: [],
                    artistsHasMore: false, albumsHasMore: false,
                    songsHasMore: false, foldersHasMore: false
                };
            } finally {
                this.state.isLoading = false;
            }
        },

        // Load more handlers for each section
        async loadMoreArtists() {
            this.state.artistsLimit += 10;
            await this.performSearch();
        },

        async loadMoreAlbums() {
            this.state.albumsLimit += 10;
            await this.performSearch();
        },

        async loadMoreSongs() {
            this.state.songsLimit += 10;
            await this.performSearch();
        },

        async loadMoreFolders() {
            this.state.foldersLimit += 10;
            await this.performSearch();
        },

        async performAdvancedSearch() {
            const query = this.state.searchQuery.trim();
            if (!query) return;

            const isOffline = this.stores.offline.workOfflineMode || !this.stores.offline.isOnline;

            // Update URL
            this._updateUrl(query);

            this.state.isLoading = true;
            this.state.searchPerformed = true;
            this.state.advancedMode = true;
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;
            this._currentSearchQuery = query;

            if (isOffline) {
                // Offline advanced search - returns all results from IndexedDB
                try {
                    const offlineSongs = await searchOfflineSongs(query);
                    this.state.advancedResults = offlineSongs;
                    this.state.advancedTotalCount = offlineSongs.length;
                    this._setupAdvancedScrollListener();
                } catch (e) {
                    console.error('Offline advanced search failed:', e);
                    this.state.advancedResults = [];
                    this.state.advancedTotalCount = 0;
                } finally {
                    this.state.isLoading = false;
                }
                return;
            }

            // Online search
            try {
                const result = await songs.search(query, { limit: 200 });
                const totalCount = result.totalCount || result.items?.length || 0;

                // Create sparse array
                const items = new Array(totalCount).fill(null);
                (result.items || []).forEach((item, i) => {
                    items[i] = item;
                });

                this.state.advancedResults = items;
                this.state.advancedTotalCount = totalCount;

                // Setup scroll listener
                this._setupAdvancedScrollListener();

                // Background load remaining
                if (result.hasMore && result.nextCursor) {
                    this._loadAdvancedInBackground(query, result.nextCursor, result.items?.length || 0);
                }
            } catch (e) {
                console.error('Advanced search failed:', e);
                this.state.advancedResults = [];
                this.state.advancedTotalCount = 0;
            } finally {
                this.state.isLoading = false;
            }
        },

        _setupAdvancedScrollListener() {
            requestAnimationFrame(() => {
                const mainContent = document.querySelector('div.router-wrapper');
                if (!mainContent) return;

                if (this._scrollListener) {
                    mainContent.removeEventListener('scroll', this._scrollListener);
                }

                // Use rafThrottle to limit scroll handler to once per animation frame
                this._scrollListener = rafThrottle(() => this._updateAdvancedVisibleRange());
                mainContent.addEventListener('scroll', this._scrollListener, { passive: true });

                // Initial update
                this._updateAdvancedVisibleRange();
            });
        },

        _updateAdvancedVisibleRange() {
            const mainContent = document.querySelector('div.router-wrapper');
            if (!mainContent || !this.state.advancedMode) return;

            const spacer = this.querySelector('.songs-spacer');
            if (!spacer) return;

            const itemHeight = 52;
            const baseBuffer = 40; // Increased from 10 for smoother scrolling
            const velocityBuffer = 30; // Extra items in scroll direction

            // Use getBoundingClientRect for accurate positions relative to viewport
            const spacerRect = spacer.getBoundingClientRect();
            const containerRect = mainContent.getBoundingClientRect();

            // Calculate how far we've scrolled into the spacer
            const scrolledIntoSpacer = Math.max(0, containerRect.top - spacerRect.top);
            const viewportHeight = mainContent.clientHeight;

            // Track scroll velocity for predictive buffering
            const now = performance.now();
            let scrollDirection = 0; // -1 = up, 0 = stationary, 1 = down

            if (this._lastScrollPos !== undefined && this._lastScrollTime !== undefined) {
                const timeDelta = now - this._lastScrollTime;
                if (timeDelta > 0 && timeDelta < 200) {
                    const scrollDelta = scrolledIntoSpacer - this._lastScrollPos;
                    const velocity = Math.abs(scrollDelta / timeDelta);
                    if (velocity > 0.5) {
                        scrollDirection = scrollDelta > 0 ? 1 : -1;
                    }
                }
            }
            this._lastScrollPos = scrolledIntoSpacer;
            this._lastScrollTime = now;

            // Calculate buffer with velocity-based overscan
            const bufferAbove = baseBuffer + (scrollDirection < 0 ? velocityBuffer : 0);
            const bufferBelow = baseBuffer + (scrollDirection > 0 ? velocityBuffer : 0);

            const startIndex = Math.max(0, Math.floor(scrolledIntoSpacer / itemHeight) - bufferAbove);
            const endIndex = Math.min(
                this.state.advancedTotalCount,
                Math.ceil((scrolledIntoSpacer + viewportHeight) / itemHeight) + bufferBelow
            );

            if (startIndex !== this.state.visibleStart || endIndex !== this.state.visibleEnd) {
                this.state.visibleStart = startIndex;
                this.state.visibleEnd = endIndex;
            }
        },

        async _loadAdvancedInBackground(query, cursor, offset) {
            let currentCursor = cursor;
            let currentOffset = offset;

            while (currentCursor && this._currentSearchQuery === query) {
                try {
                    const result = await songs.search(query, {
                        cursor: currentCursor,
                        limit: 500
                    });

                    if (this._currentSearchQuery !== query) break;

                    const items = [...this.state.advancedResults];
                    (result.items || []).forEach((item, i) => {
                        items[currentOffset + i] = item;
                    });
                    this.state.advancedResults = items;

                    currentOffset += result.items?.length || 0;
                    currentCursor = result.nextCursor;
                } catch (e) {
                    console.error('Background loading failed:', e);
                    break;
                }
            }
        },

        toggleHelp() {
            this.state.showHelp = !this.state.showHelp;
        },

        insertExample(example) {
            this.state.searchQuery = example;
            this.state.showHelp = false;
            this.performAdvancedSearch();
        },

        handleArtistClick(artist) {
            navigateToArtist(artist.name);
        },

        handleAlbumClick(album) {
            navigateToAlbum(album.artist, album.name);
        },

        handleSongClick(song) {
            player.addToQueue(song, true);
        },

        handleSongContextMenu(song, e) {
            e.preventDefault();
            e.stopPropagation();
            showSongContextMenu(song, e.clientX, e.clientY);
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

        handleFolderClick(folder) {
            // Navigate to VFS browse
            const encodedPath = encodeURIComponent(folder.path.replace(/^\//, ''));
            window.location.hash = `/browse/path/${encodedPath}/`;
        },

        handleAddSongToQueue(song, e) {
            e.stopPropagation();
            player.addToQueue(song);
        },

        handlePlayArtist(artist, e) {
            e.stopPropagation();
            navigateToArtist(artist.name);
        },

        handlePlayAlbum(album, e) {
            e.stopPropagation();
            navigateToAlbum(album.artist, album.name);
        },

        hasResults() {
            const r = this.state.results;
            if (!r) return false;
            return r.artists.length > 0 || r.albums.length > 0 ||
                   r.songs.length > 0 || r.folders.length > 0;
        },

        // Artist queue/radio actions
        async handleQueueArtist(artist, e) {
            e.stopPropagation();
            try {
                await player.addByFilter({ artist: artist.name });
            } catch (err) {
                console.error('Failed to queue artist:', err);
            }
        },

        async handleRadioArtist(artist, e) {
            e.stopPropagation();
            try {
                await player.startRadio(null, `a:eq:${artist.name}`);
            } catch (err) {
                console.error('Failed to start artist radio:', err);
            }
        },

        // Album queue/radio actions
        async handleQueueAlbum(album, e) {
            e.stopPropagation();
            try {
                await player.addByFilter({ artist: album.artist, album: album.name });
            } catch (err) {
                console.error('Failed to queue album:', err);
            }
        },

        async handleRadioAlbum(album, e) {
            e.stopPropagation();
            try {
                await player.startRadio(null, `a:eq:${album.artist} AND al:eq:${album.name}`);
            } catch (err) {
                console.error('Failed to start album radio:', err);
            }
        },

        // Advanced search result actions
        async handleQueueAllResults() {
            const loadedSongs = this.state.advancedResults.filter(s => s !== null);
            if (loadedSongs.length === 0) return;

            try {
                await player.addToQueue(loadedSongs);
            } catch (err) {
                console.error('Failed to queue all results:', err);
            }
        },

        async handleRadioFromSearch() {
            const query = this.state.searchQuery.trim();
            if (!query) return;

            try {
                await player.startRadio(null, query);
            } catch (err) {
                console.error('Failed to start radio from search:', err);
            }
        },

        async handleRadioFromSong(song, e) {
            e.stopPropagation();
            try {
                await player.startRadio(song.uuid);
            } catch (err) {
                console.error('Failed to start radio from song:', err);
            }
        }
    },

    template() {
        const { searchQuery, results, advancedResults, isLoading, searchPerformed, showHelp, advancedMode } = this.state;

        return html`
            <div class="quick-search-page">
                ${when(this.stores.offline.workOfflineMode || !this.stores.offline.isOnline, () => html`
                    <div class="offline-notice">
                        📴 Searching downloaded songs only (${this.stores.offline.offlineSongUuids.size} available)
                    </div>
                `)}

                <!-- Search Input -->
                <div class="search-header">
                    <div class="search-box">
                        <span class="search-icon">🔍</span>
                        <input type="text"
                               class="search-input"
                               placeholder="Search..."
                               x-model="searchQuery"
                               on-input="${() => this._debouncedSearch()}"
                               on-keydown="handleKeyDown">
                        ${when(isLoading, html`
                            <cl-spinner size="small" class="search-spinner"></cl-spinner>
                        `)}
                        <cl-button severity="primary" size="small" on-click="performAdvancedSearch">
                            Search
                        </cl-button>
                    </div>
                    <button class="help-toggle" on-click="toggleHelp">
                        ${showHelp ? '✕ Close' : '? Syntax'}
                    </button>
                </div>

                <!-- Help Panel -->
                ${when(showHelp, html`
                    <div class="help-panel">
                        <h4>Quick Search</h4>
                        <p>Just type to search across artists, albums, songs, and folders. Press Enter or click Search for full results.</p>
                        <p class="help-note">All text searches are case-insensitive.</p>

                        <h4>Advanced Query Syntax</h4>
                        <p>Use <code>field:value</code> (contains) or <code>field:op:value</code> syntax:</p>

                        <div class="help-section">
                            <strong>Fields:</strong>
                            <code>c</code> (category), <code>g</code> (genre), <code>a</code> (artist),
                            <code>aa</code> (album artist), <code>l</code> (album), <code>n</code> (title),
                            <code>t</code> (tag), <code>p</code> (path), <code>f</code> (filename),
                            <code>u</code> (uuid), <code>year</code>, <code>bpm</code>, <code>dur</code>,
                            <code>track</code>, <code>disc</code>
                        </div>

                        <div class="help-section">
                            <strong>Operators:</strong>
                            <code>eq</code> (equals), <code>ne</code> (not equals),
                            <code>mt</code> (contains, default), <code>nm</code> (not contains),
                            <code>gt</code>, <code>lt</code>, <code>gte</code>, <code>lte</code> (numeric comparison)
                        </div>

                        <h4>Examples</h4>
                        <div class="examples">
                            <button class="example-btn" on-click="${() => this.insertExample('a:Beatles')}">a:Beatles</button>
                            <button class="example-btn" on-click="${() => this.insertExample('g:eq:Rock')}">g:eq:Rock</button>
                            <button class="example-btn" on-click="${() => this.insertExample('year:gte:1980')}">year:gte:1980</button>
                            <button class="example-btn" on-click="${() => this.insertExample('p:\"/Music/Jazz/\"')}">p:"/Music/Jazz/"</button>
                        </div>

                        <h4>Boolean Operators</h4>
                        <p>Combine conditions with <code>AND</code>, <code>OR</code>, <code>NOT</code>:</p>
                        <div class="examples">
                            <button class="example-btn" on-click="${() => this.insertExample('g:eq:Rock AND a:Beatles')}">g:eq:Rock AND a:Beatles</button>
                            <button class="example-btn" on-click="${() => this.insertExample('g:eq:Jazz OR g:eq:Blues')}">g:eq:Jazz OR g:eq:Blues</button>
                        </div>

                        <h4>Grouping</h4>
                        <p>Use parentheses for complex queries:</p>
                        <div class="examples">
                            <button class="example-btn" on-click="${() => this.insertExample('(g:eq:Rock OR g:eq:Metal) a:Iron')}">(g:eq:Rock OR g:eq:Metal) a:Iron</button>
                        </div>
                    </div>
                `)}

                <!-- Results -->
                ${when(!searchPerformed && !showHelp, html`
                    <div class="search-prompt">
                        <div class="prompt-icon">🎵</div>
                        <h3>Search</h3>
                        <p>Start typing to search your music library</p>
                        <p class="hint">Press Enter for full results with advanced syntax</p>
                    </div>
                `)}

                ${when(searchPerformed && advancedMode && advancedResults.length === 0 && !isLoading, html`
                    <div class="no-results">
                        <div class="no-results-icon">🔍</div>
                        <h3>No Results</h3>
                        <p>No matches found for "${searchQuery}"</p>
                    </div>
                `)}

                ${when(searchPerformed && !advancedMode && !this.hasResults() && !isLoading, html`
                    <div class="no-results">
                        <div class="no-results-icon">🔍</div>
                        <h3>No Results</h3>
                        <p>No matches found for "${searchQuery}"</p>
                    </div>
                `)}

                <!-- Advanced Mode Results (full song list with windowed rendering) -->
                ${when(advancedMode && this.state.advancedTotalCount > 0, () => {
                    const itemHeight = 52;
                    const { visibleStart, visibleEnd, advancedTotalCount } = this.state;
                    const visibleItems = advancedResults.slice(visibleStart, visibleEnd);

                    return html`
                        <div class="advanced-results">
                            <div class="results-header">
                                <span class="results-count">${advancedTotalCount} songs found</span>
                                <div class="results-actions">
                                    <button class="results-action-btn" title="Queue All Results"
                                            on-click="handleQueueAllResults">
                                        + Queue All
                                    </button>
                                    <button class="results-action-btn" title="Start Radio from Search"
                                            on-click="handleRadioFromSearch">
                                        📻 Radio
                                    </button>
                                    <button class="back-to-quick" on-click="${() => { this.state.advancedMode = false; }}">
                                        ← Back
                                    </button>
                                </div>
                            </div>
                            <div class="songs-spacer"
                                 style="height: ${advancedTotalCount * itemHeight}px; position: relative;">
                                <div class="songs-list"
                                     style="position: absolute; top: ${visibleStart * itemHeight}px; left: 0; right: 0;">
                                    ${memoEach(visibleItems, (song, idx) => {
                                        if (!song) {
                                            return html`<div class="song-item loading-item">
                                                <div class="song-icon">⏳</div>
                                                <div class="song-info">
                                                    <div class="song-title">Loading...</div>
                                                </div>
                                            </div>`;
                                        }
                                        return html`
                                            <div class="song-item"
                                                 on-click="${() => this.handleSongClick(song)}"
                                                 on-contextmenu="${(e) => this.handleSongContextMenu(song, e)}"
                                                 on-touchstart="${(e) => this.handleTouchStart(song, e)}"
                                                 on-touchmove="handleTouchMove"
                                                 on-touchend="handleTouchEnd">
                                                <div class="song-icon">🎵</div>
                                                <div class="song-info">
                                                    <div class="song-title">${this.getDisplayTitle(song)}</div>
                                                    <div class="song-meta">
                                                        ${song.artist || 'Unknown Artist'}
                                                        ${when(song.album, () => html` • ${song.album}`)}
                                                    </div>
                                                </div>
                                                <button class="add-btn"
                                                        on-click="${(e) => this.handleAddSongToQueue(song, e)}"
                                                        title="Add to Queue">
                                                    +
                                                </button>
                                                <button class="radio-btn"
                                                        on-click="${(e) => this.handleRadioFromSong(song, e)}"
                                                        title="Start Radio">
                                                    📻
                                                </button>
                                            </div>
                                        `;
                                    }, (song, idx) => song?.uuid ?? `loading-${idx}`, { trustKey: true })}
                                </div>
                            </div>
                        </div>
                    `;
                })}

                <!-- Quick Search Results (sectioned) -->
                ${when(!advancedMode && results && this.hasResults(), () => html`
                    <div class="results-sections">
                        <!-- Artists Section -->
                        ${when(results.artists.length > 0, () => html`
                            <div class="results-section">
                                <h3 class="section-title">Artists</h3>
                                <div class="section-items artists-grid">
                                    ${each(results.artists.slice(0, this.state.artistsLimit), artist => html`
                                        <div class="artist-card" on-click="${() => this.handleArtistClick(artist)}">
                                            <div class="artist-avatar">👤</div>
                                            <div class="artist-info">
                                                <div class="artist-name">${artist.name}</div>
                                                <div class="artist-count">${artist.song_count} songs</div>
                                            </div>
                                            <div class="card-actions">
                                                <button class="action-btn" title="Queue All"
                                                        on-click="${(e) => this.handleQueueArtist(artist, e)}">+</button>
                                                <button class="action-btn" title="Start Radio"
                                                        on-click="${(e) => this.handleRadioArtist(artist, e)}">📻</button>
                                            </div>
                                        </div>
                                    `)}
                                </div>
                                ${when(results.artistsHasMore || results.artists.length > this.state.artistsLimit, () => html`
                                    <button class="load-more-btn" on-click="loadMoreArtists">
                                        Load More Artists
                                    </button>
                                `)}
                            </div>
                        `)}

                        <!-- Albums Section -->
                        ${when(results.albums.length > 0, () => html`
                            <div class="results-section">
                                <h3 class="section-title">Albums</h3>
                                <div class="section-items albums-grid">
                                    ${each(results.albums.slice(0, this.state.albumsLimit), album => html`
                                        <div class="album-card" on-click="${() => this.handleAlbumClick(album)}">
                                            <div class="album-art">💿</div>
                                            <div class="album-info">
                                                <div class="album-name">${album.name}</div>
                                                <div class="album-artist">${album.artist || 'Unknown Artist'}</div>
                                                <div class="album-count">${album.song_count} songs</div>
                                            </div>
                                            <div class="card-actions">
                                                <button class="action-btn" title="Queue All"
                                                        on-click="${(e) => this.handleQueueAlbum(album, e)}">+</button>
                                                <button class="action-btn" title="Start Radio"
                                                        on-click="${(e) => this.handleRadioAlbum(album, e)}">📻</button>
                                            </div>
                                        </div>
                                    `)}
                                </div>
                                ${when(results.albumsHasMore || results.albums.length > this.state.albumsLimit, () => html`
                                    <button class="load-more-btn" on-click="loadMoreAlbums">
                                        Load More Albums
                                    </button>
                                `)}
                            </div>
                        `)}

                        <!-- Songs Section -->
                        ${when(results.songs.length > 0, () => html`
                            <div class="results-section">
                                <h3 class="section-title">Songs</h3>
                                <div class="section-items songs-list">
                                    ${each(results.songs.slice(0, this.state.songsLimit), song => html`
                                        <div class="song-item"
                                             on-click="${() => this.handleSongClick(song)}"
                                             on-contextmenu="${(e) => this.handleSongContextMenu(song, e)}"
                                             on-touchstart="${(e) => this.handleTouchStart(song, e)}"
                                             on-touchmove="handleTouchMove"
                                             on-touchend="handleTouchEnd">
                                            <div class="song-icon">🎵</div>
                                            <div class="song-info">
                                                <div class="song-title">${this.getDisplayTitle(song)}</div>
                                                <div class="song-meta">
                                                    ${song.artist || 'Unknown Artist'}
                                                    ${when(song.album, () => html` • ${song.album}`)}
                                                </div>
                                            </div>
                                            <button class="add-btn"
                                                    on-click="${(e) => this.handleAddSongToQueue(song, e)}"
                                                    title="Add to Queue">
                                                +
                                            </button>
                                        </div>
                                    `)}
                                </div>
                                ${when(results.songsHasMore || results.songs.length > this.state.songsLimit, () => html`
                                    <button class="load-more-btn" on-click="loadMoreSongs">
                                        Load More Songs
                                    </button>
                                `)}
                            </div>
                        `)}

                        <!-- Folders Section -->
                        ${when(results.folders.length > 0, () => html`
                            <div class="results-section">
                                <h3 class="section-title">Folders</h3>
                                <div class="section-items folders-list">
                                    ${each(results.folders.slice(0, this.state.foldersLimit), folder => html`
                                        <div class="folder-item" on-click="${() => this.handleFolderClick(folder)}">
                                            <div class="folder-icon">📁</div>
                                            <div class="folder-info">
                                                <div class="folder-name">${folder.name}</div>
                                                <div class="folder-path">${folder.path}</div>
                                            </div>
                                            <div class="folder-count">${folder.song_count} songs</div>
                                        </div>
                                    `)}
                                </div>
                                ${when(results.foldersHasMore || results.folders.length > this.state.foldersLimit, () => html`
                                    <button class="load-more-btn" on-click="loadMoreFolders">
                                        Load More Folders
                                    </button>
                                `)}
                            </div>
                        `)}
                    </div>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .quick-search-page {
            padding: 1rem;
            max-width: 900px;
            margin: 0 auto;
        }

        .offline-notice {
            background: var(--info-100, #1e3a5f);
            color: var(--info-400, #60a5fa);
            padding: 0.5rem 1rem;
            margin-bottom: 1rem;
            text-align: center;
            font-size: 0.875rem;
            border-radius: 8px;
        }

        /* Search Header */
        .search-header {
            margin-bottom: 1.5rem;
        }

        .search-box {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem 1rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 12px;
            margin-bottom: 0.5rem;
        }

        .search-box:focus-within {
            border-color: var(--primary-500, #0066cc);
            box-shadow: 0 0 0 3px var(--selected-bg, #1e3a5f);
        }

        .search-icon {
            font-size: 1.25rem;
            opacity: 0.6;
        }

        .search-input {
            flex: 1;
            background: none;
            border: none;
            font-size: 1.125rem;
            color: var(--text-primary, #e0e0e0);
            outline: none;
        }

        .search-input::placeholder {
            color: var(--text-muted, #707070);
        }

        .search-spinner {
            flex-shrink: 0;
        }

        .help-toggle {
            background: none;
            border: none;
            color: var(--primary-400, #42a5f5);
            cursor: pointer;
            font-size: 0.875rem;
            padding: 0.25rem 0.5rem;
        }

        .help-toggle:hover {
            text-decoration: underline;
        }

        /* Help Panel */
        .help-panel {
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            padding: 1rem 1.5rem;
            margin-bottom: 1.5rem;
        }

        .help-panel h4 {
            margin: 0 0 0.5rem;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.9375rem;
        }

        .help-panel h4:not(:first-child) {
            margin-top: 1rem;
        }

        .help-panel p {
            margin: 0 0 0.5rem;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .help-note {
            font-size: 0.75rem;
            font-style: italic;
            margin: 0 0 1rem;
        }

        .help-panel p code {
            background: var(--surface-200, #2d2d2d);
            padding: 0.125rem 0.375rem;
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.8125rem;
        }

        .help-list {
            margin: 0;
            padding-left: 1.25rem;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .help-list li {
            margin-bottom: 0.25rem;
        }

        .help-list strong {
            color: var(--text-primary, #e0e0e0);
        }

        .help-section {
            margin: 0.5rem 0;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .help-section strong {
            color: var(--text-primary, #e0e0e0);
            display: block;
            margin-bottom: 0.25rem;
        }

        .help-section code {
            background: var(--surface-200, #2d2d2d);
            padding: 0.125rem 0.375rem;
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.8125rem;
        }

        .examples {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-top: 0.5rem;
        }

        .example-btn {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            padding: 0.375rem 0.75rem;
            color: var(--primary-400, #42a5f5);
            cursor: pointer;
            font-family: monospace;
            font-size: 0.8125rem;
            transition: background 0.15s;
        }

        .example-btn:hover {
            background: var(--surface-300, #404040);
        }

        /* Advanced Results */
        .advanced-results {
            background: var(--surface-50, #1a1a1a);
            border-radius: 12px;
            padding: 1rem;
        }

        .results-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--surface-300, #404040);
            flex-wrap: wrap;
            gap: 0.5rem;
        }

        .results-actions {
            display: flex;
            gap: 0.5rem;
            align-items: center;
        }

        .results-action-btn {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            padding: 0.375rem 0.75rem;
            color: var(--text-primary, #e0e0e0);
            cursor: pointer;
            font-size: 0.8125rem;
            transition: background 0.15s;
            white-space: nowrap;
        }

        .results-action-btn:hover {
            background: var(--primary-500, #0066cc);
            border-color: var(--primary-500, #0066cc);
        }

        .songs-spacer {
            width: 100%;
            /* CSS containment hints for scroll performance */
            contain: layout style;
        }

        .loading-item {
            opacity: 0.5;
        }

        .results-count {
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .back-to-quick {
            background: none;
            border: none;
            color: var(--primary-400, #42a5f5);
            cursor: pointer;
            font-size: 0.875rem;
            padding: 0.25rem 0.5rem;
        }

        .back-to-quick:hover {
            text-decoration: underline;
        }

        .hint {
            font-size: 0.875rem;
            margin-top: 1rem !important;
            color: var(--text-muted, #707070) !important;
        }

        /* Prompts */
        .search-prompt,
        .no-results {
            text-align: center;
            padding: 4rem 2rem;
        }

        .prompt-icon,
        .no-results-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            opacity: 0.6;
        }

        .search-prompt h3,
        .no-results h3 {
            margin: 0 0 0.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .search-prompt p,
        .no-results p {
            margin: 0;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Results Sections */
        .results-sections {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
        }

        .results-section {
            background: var(--surface-50, #1a1a1a);
            border-radius: 12px;
            padding: 1rem;
        }

        .section-title {
            font-size: 0.875rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 0.75rem;
        }

        /* Artists Grid */
        .artists-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 0.75rem;
        }

        .load-more-btn {
            display: block;
            width: 100%;
            padding: 0.75rem;
            margin-top: 0.5rem;
            background: var(--surface-secondary, #2a2a2a);
            border: 1px solid var(--border-color, #3a3a3a);
            border-radius: 6px;
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.875rem;
            transition: all 0.15s ease;
        }

        .load-more-btn:hover {
            background: var(--surface-hover, #3a3a3a);
            color: var(--text-primary, #e0e0e0);
        }

        .artist-card {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s, transform 0.15s;
        }

        .artist-card:hover {
            background: var(--surface-200, #2d2d2d);
            transform: translateY(-2px);
        }

        .artist-avatar {
            width: 48px;
            height: 48px;
            background: linear-gradient(135deg, var(--primary-400, #3399ff), var(--primary-600, #0052a3));
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
        }

        .artist-info {
            flex: 1;
            overflow: hidden;
        }

        .artist-name {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .artist-count {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        /* Card Actions (Artist/Album) */
        .card-actions {
            display: flex;
            gap: 0.25rem;
            margin-left: auto;
            opacity: 0;
            transition: opacity 0.15s;
        }

        .artist-card:hover .card-actions,
        .album-card:hover .card-actions {
            opacity: 1;
        }

        .action-btn {
            background: var(--surface-200, #2d2d2d);
            border: none;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            cursor: pointer;
            font-size: 0.875rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-primary, #e0e0e0);
            transition: background 0.15s;
        }

        .action-btn:hover {
            background: var(--primary-500, #0066cc);
        }

        /* Albums Grid */
        .albums-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 0.75rem;
        }

        .album-card {
            display: flex;
            flex-direction: column;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s, transform 0.15s;
            position: relative;
        }

        .album-card .card-actions {
            position: absolute;
            top: 0.5rem;
            right: 0.5rem;
        }

        .album-card:hover {
            background: var(--surface-200, #2d2d2d);
            transform: translateY(-2px);
        }

        .album-art {
            width: 100%;
            aspect-ratio: 1;
            background: linear-gradient(135deg, var(--surface-300, #404040), var(--surface-200, #2d2d2d));
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
        }

        .album-info {
            overflow: hidden;
        }

        .album-name {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .album-artist {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .album-count {
            font-size: 0.625rem;
            color: var(--text-muted, #707070);
            margin-top: 0.25rem;
        }

        /* Songs List */
        .songs-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
            /* Hint browser this element transforms during scroll */
            will-change: transform;
            /* Contain paint to this element */
            contain: paint;
        }

        .song-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.15s;
            height: 52px;
            box-sizing: border-box;
            /* Strict containment for individual items */
            contain: layout style;
        }

        .song-item:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .song-icon {
            font-size: 1.25rem;
            opacity: 0.7;
        }

        .song-info {
            flex: 1;
            overflow: hidden;
        }

        .song-title {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .song-meta {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .add-btn,
        .radio-btn {
            background: var(--surface-200, #2d2d2d);
            border: none;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            cursor: pointer;
            font-size: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.15s, background 0.15s;
            color: var(--text-primary, #e0e0e0);
        }

        .radio-btn {
            font-size: 0.875rem;
        }

        .song-item:hover .add-btn,
        .song-item:hover .radio-btn {
            opacity: 1;
        }

        .add-btn:hover,
        .radio-btn:hover {
            background: var(--primary-500, #0066cc);
        }

        /* Folders List */
        .folders-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .folder-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.15s;
        }

        .folder-item:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .folder-icon {
            font-size: 1.5rem;
        }

        .folder-info {
            flex: 1;
            overflow: hidden;
        }

        .folder-name {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .folder-path {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .folder-count {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
        }

        /* Mobile */
        @media (max-width: 767px) {
            .song-item {
                user-select: none;
                -webkit-user-select: none;
            }

            .quick-search-page {
                padding: 0.5rem;
            }

            .search-box {
                gap: 0.5rem;
                padding: 0.5rem 0.75rem;
            }

            .search-input {
                font-size: 1rem;
                min-width: 0;
            }

            .search-input::placeholder {
                font-size: 0.875rem;
            }

            .artists-grid {
                grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            }

            .albums-grid {
                grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            }

            .add-btn,
            .radio-btn,
            .card-actions {
                opacity: 1;
            }
        }
    `
});

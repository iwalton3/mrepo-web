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

import { defineComponent, html, when, each, memoEach, untracked, Component } from 'vdx/framework.js';
import { getRouter } from 'vdx/router.js';
import { createWindowing } from 'vdx/windowing.js';
import { songs, ai } from '../offline/offline-api.js';
import { player } from '../stores/player-store.js';
import offlineStore from '../offline/offline-store.js';
import { searchOfflineSongs } from '../offline/offline-db.js';
import { showSongContextMenu, navigateToArtist, navigateToAlbum, navigateToFolder } from '../components/song-context-menu.js';
import 'vdxui/button/button.js';
import 'vdxui/misc/spinner.js';

export class QuickSearchPage extends Component {
    static props = {
        query: {}  // Query params from router (e.g., ?q=beatles)
    }

    static stores = { offline: offlineStore }

    constructor(props) {
        super(props);

        // Windowing controller owns the visible-range state and scroll/resize
        // plumbing. Created in data() so its state exists for the first render.
        // Advanced results scroll inside the app's .router-wrapper; the window
        // position is measured against the songs spacer. itemHeight is 54
        // (52px item + 2px gap). overscan matches the old velocity buffer.
        this._win = createWindowing(this, {
            itemHeight: 54,
            buffer: 40,
            overscan: 30,
            count: () => this.state.advancedResults.length,
            scrollContainer: 'div.router-wrapper',
            measureElement: () => this.refs.songsSpacer
        });

        this.state = {
            searchQuery: '',  // The actual search text
            results: null,  // {artists, albums, songs, folders} for quick search
            advancedResults: untracked([]),  // Sparse array for virtual scroll - untracked for performance
            advancedTotalCount: 0,
            isLoading: false,
            searchPerformed: false,
            showHelp: false,
            advancedMode: false,  // true when showing full song results
            // Similar mode for CLAP similarity search
            similarMode: false,
            similarSongUuid: null,
            similarSong: null,  // The source song for "similar to" header
            // Section limits for quick search (for load more functionality)
            artistsLimit: 10,
            albumsLimit: 10,
            songsLimit: 10,
            foldersLimit: 10
        };
    }

    unmounted() {
        this._win.destroy();
    }

    mounted() {
        // Check for similar mode first
        const similarUuid = this.props.query?.similar;
        if (similarUuid) {
            this.performSimilarSearch(similarUuid);
            return;  // Don't focus input in similar mode
        }

        // Read query from URL if present
        const urlQuery = this.props.query?.q;
        if (urlQuery) {
            this.state.searchQuery = urlQuery;
            // Perform search automatically
            this.performAdvancedSearch();
        }

        // Focus search input on mount
        this.nextRender().then(() => {
            const input = this.querySelector('.search-input');
            if (input) input.focus();
        });
    }

    propsChanged(prop, newValue, oldValue) {
        // Handle URL query changes (e.g., browser back/forward)
        if (prop === 'query') {
            // Check for similar mode
            const newSimilar = newValue?.similar;
            const oldSimilar = oldValue?.similar;
            if (newSimilar !== oldSimilar) {
                if (newSimilar) {
                    this.performSimilarSearch(newSimilar);
                    return;
                }

                // Exiting similar mode (e.g. browser back out of similar-songs).
                // The CLAP results + advanced view are now stale relative to the
                // URL, so fully reset result-mode state and (re)load whatever the
                // current URL describes. Without this, the URL says ?q=beatles
                // while the page still shows the similar-songs list.
                this.state.similarMode = false;
                this.state.similarSong = null;
                this.state.similarSongUuid = null;
                this.state.advancedMode = false;
                this.state.advancedResults = [];
                this.state.advancedTotalCount = 0;
                this.state.results = null;
                this.state.searchPerformed = false;
                // Invalidate any in-flight similar search so a late CLAP response
                // can't repopulate the list we just cleared (request-ID guard).
                this._similarSearchId = (this._similarSearchId || 0) + 1;

                const urlQuery = newValue?.q || '';
                this.state.searchQuery = urlQuery;
                if (urlQuery) {
                    // _updateUrl inside performAdvancedSearch is a no-op here: the
                    // URL already carries this q, so it won't re-fire propsChanged.
                    this.performAdvancedSearch();
                }
                return;
            }

            // Handle regular query changes
            if (newValue?.q !== oldValue?.q) {
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
        }
    }

    getDisplayTitle(song) {
        if (!song) return 'Unknown';
        if (song.title) return song.title;
        // Fallback to filename without extension
        const path = song.virtual_file || song.file || '';
        const filename = path.split('/').pop() || '';
        return filename.replace(/\.[^.]+$/, '') || 'Unknown';
    }

    handleQueryChange(e) {
        this.state.searchQuery = e.target.value;
        // Reset to quick search mode when typing
        this.state.advancedMode = false;
        this._debouncedSearch();
    }

    handleKeyDown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.performAdvancedSearch();
        }
    }

    _debouncedSearch() {
        // Debounce search to avoid excessive API calls
        if (this._searchTimeout) {
            clearTimeout(this._searchTimeout);
        }
        this._searchTimeout = setTimeout(() => this.performSearch(), 300);
    }

    _updateUrl(query) {
        // Update URL with search query for deeplinking.
        // Write through the router (never raw history.replaceState) so that
        // in hash mode the replace fires a hashchange -> router re-delivers
        // props, keeping router.currentRoute/props.query in sync with the
        // address bar. A raw replaceState fires no hashchange and silently
        // desyncs them (see state-management-audit A5).
        const router = getRouter();
        if (!router) return;

        const nextQ = query || '';
        const currentQ = router.currentRoute.state.query?.q || '';
        // Skip the write when the URL already carries this query. This keeps
        // the propsChanged loop airtight: replace -> hashchange ->
        // propsChanged; if the query is unchanged we must NOT replace again,
        // otherwise an identical write could re-enter propsChanged.
        if (nextQ === currentQ) return;

        if (nextQ) {
            router.replace('/search/', { q: nextQ });
        } else {
            router.replace('/search/');
        }
    }

    async performSearch() {
        const query = this.state.searchQuery.trim();
        if (!query) {
            this.state.results = null;
            this.state.searchPerformed = false;
            this.state.advancedMode = false;
            return;
        }

        // Don't run quick search if advanced mode is active
        if (this.state.advancedMode) return;

        // Track request ID to avoid interfering with advanced search
        this._quickSearchId = (this._quickSearchId || 0) + 1;
        const thisSearchId = this._quickSearchId;

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

                // Only apply if still current and not in advanced mode
                // (a slower earlier query must not clobber newer results)
                if (this._quickSearchId === thisSearchId && !this.state.advancedMode) {
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
                }
            } catch (e) {
                if (this._quickSearchId === thisSearchId && !this.state.advancedMode) {
                    console.error('Offline search failed:', e);
                    this.state.results = {
                        artists: [], albums: [], songs: [], folders: [],
                        artistsHasMore: false, albumsHasMore: false,
                        songsHasMore: false, foldersHasMore: false
                    };
                }
            } finally {
                // Only clear loading if this is still current and not in advanced mode
                if (this._quickSearchId === thisSearchId && !this.state.advancedMode) {
                    this.state.isLoading = false;
                }
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
            // Only apply if still current and not in advanced mode
            if (this._quickSearchId === thisSearchId && !this.state.advancedMode) {
                this.state.results = results;
                this._updateUrl(query);
            }
        } catch (e) {
            if (this._quickSearchId === thisSearchId && !this.state.advancedMode) {
                console.error('Quick search failed:', e);
                this.state.results = {
                    artists: [], albums: [], songs: [], folders: [],
                    artistsHasMore: false, albumsHasMore: false,
                    songsHasMore: false, foldersHasMore: false
                };
            }
        } finally {
            // Only clear loading if this is still current and not in advanced mode
            if (this._quickSearchId === thisSearchId && !this.state.advancedMode) {
                this.state.isLoading = false;
            }
        }
    }

    // Load more handlers for each section
    async loadMoreArtists() {
        this.state.artistsLimit += 10;
        await this.performSearch();
    }

    async loadMoreAlbums() {
        this.state.albumsLimit += 10;
        await this.performSearch();
    }

    async loadMoreSongs() {
        this.state.songsLimit += 10;
        await this.performSearch();
    }

    async loadMoreFolders() {
        this.state.foldersLimit += 10;
        await this.performSearch();
    }

    async performAdvancedSearch() {
        const query = this.state.searchQuery.trim();
        if (!query) {
            // Clear any prior results so stale advanced output doesn't linger
            this.state.results = null;
            this.state.advancedResults = [];
            this.state.advancedTotalCount = 0;
            this.state.advancedMode = false;
            this.state.searchPerformed = false;
            this.state.isLoading = false;
            return;
        }

        // Cancel any pending quick search debounce
        if (this._searchTimeout) {
            clearTimeout(this._searchTimeout);
            this._searchTimeout = null;
        }

        // Track request ID to handle race conditions with quick search
        this._advancedSearchId = (this._advancedSearchId || 0) + 1;
        const thisSearchId = this._advancedSearchId;

        const isOffline = this.stores.offline.workOfflineMode || !this.stores.offline.isOnline;

        // Update URL
        this._updateUrl(query);

        this.state.isLoading = true;
        this.state.searchPerformed = true;
        this.state.advancedMode = true;
        this._currentSearchQuery = query;

        if (isOffline) {
            // Offline advanced search - returns all results from IndexedDB
            try {
                const offlineSongs = await searchOfflineSongs(query);
                // Only apply if this is still the current search
                if (this._advancedSearchId !== thisSearchId) return;
                this.state.advancedResults = offlineSongs;
                this.state.advancedTotalCount = offlineSongs.length;
                requestAnimationFrame(() => this._win.refresh());
            } catch (e) {
                if (this._advancedSearchId === thisSearchId) {
                    console.error('Offline advanced search failed:', e);
                    this.state.advancedResults = [];
                    this.state.advancedTotalCount = 0;
                }
            } finally {
                if (this._advancedSearchId === thisSearchId) {
                    this.state.isLoading = false;
                }
            }
            return;
        }

        // Online search
        try {
            const result = await songs.search(query, { limit: 200 });
            // Only apply if this is still the current search
            if (this._advancedSearchId !== thisSearchId) return;

            const totalCount = result.totalCount || result.items?.length || 0;

            // Create sparse array
            const items = new Array(totalCount).fill(null);
            (result.items || []).forEach((item, i) => {
                items[i] = item;
            });

            this.state.advancedResults = items;
            this.state.advancedTotalCount = totalCount;

            // Recompute the window once the new results have rendered
            requestAnimationFrame(() => this._win.refresh());

            // Background load remaining
            if (result.hasMore && result.nextCursor) {
                this._loadAdvancedInBackground(query, result.nextCursor, result.items?.length || 0, thisSearchId);
            }
        } catch (e) {
            if (this._advancedSearchId === thisSearchId) {
                console.error('Advanced search failed:', e);
                this.state.advancedResults = [];
                this.state.advancedTotalCount = 0;
            }
        } finally {
            if (this._advancedSearchId === thisSearchId) {
                this.state.isLoading = false;
            }
        }
    }

    async performSimilarSearch(uuid) {
        // Similar search mode - uses CLAP similarity API
        // Track a request ID so rapid ?similar= navigations don't let an
        // older (slower) lookup overwrite the newer one's results.
        this._similarSearchId = (this._similarSearchId || 0) + 1;
        const thisSearchId = this._similarSearchId;

        this.state.similarMode = true;
        this.state.similarSongUuid = uuid;
        this.state.advancedMode = true;
        this.state.isLoading = true;
        this.state.searchPerformed = true;

        try {
            // Fetch the source song info for the header
            const sourceSong = await songs.get(uuid);
            if (this._similarSearchId !== thisSearchId) return;
            this.state.similarSong = sourceSong;

            // Search for similar songs via the AI adapter (normalized -> { items })
            const result = await ai.findSimilar(uuid, 200);
            if (this._similarSearchId !== thisSearchId) return;

            if (result.error) {
                console.error('Similar search failed:', result.error);
                this.state.advancedResults = [];
                this.state.advancedTotalCount = 0;
                return;
            }

            const similarSongs = result.items || [];
            this.state.advancedResults = similarSongs;
            this.state.advancedTotalCount = similarSongs.length;

            // Recompute the window once the new results have rendered
            requestAnimationFrame(() => this._win.refresh());
        } catch (e) {
            if (this._similarSearchId === thisSearchId) {
                console.error('Similar search failed:', e);
                this.state.advancedResults = [];
                this.state.advancedTotalCount = 0;
            }
        } finally {
            if (this._similarSearchId === thisSearchId) {
                this.state.isLoading = false;
            }
        }
    }

    backToQuickSearch() {
        // Leave advanced mode and ensure the sectioned quick-search results
        // are populated. If the search was started via Enter / URL ?q= /
        // example button, performAdvancedSearch ran but performSearch never
        // did, so this.state.results is still null and the template would
        // otherwise show a false "No Results".
        this.state.advancedMode = false;
        if (!this.hasResults() && this.state.searchQuery.trim()) {
            this.performSearch();
        }
    }

    exitSimilarMode() {
        this.state.similarMode = false;
        this.state.similarSong = null;
        this.state.similarSongUuid = null;
        this.state.advancedMode = false;
        this.state.advancedResults = [];
        this.state.advancedTotalCount = 0;
        this.state.searchPerformed = false;
        // Route the URL change through the router (not raw replaceState) so
        // router.currentRoute drops the stale ?similar= and stays in sync.
        // The resulting hashchange -> propsChanged just re-applies this same
        // reset, so it's idempotent (no double load).
        const router = getRouter();
        if (router) {
            router.replace('/search/');
        } else {
            window.location.hash = '/search/';
        }
    }

    async _loadAdvancedInBackground(query, cursor, offset, searchId) {
        let currentCursor = cursor;
        let currentOffset = offset;

        // Guard on the request ID, not the query text: re-running the same
        // query starts a fresh search with a new (reallocated) results array,
        // so an old background loop must stop rather than fill the new array.
        while (currentCursor && this._advancedSearchId === searchId) {
            try {
                const result = await songs.search(query, {
                    cursor: currentCursor,
                    limit: 500
                });

                if (this._advancedSearchId !== searchId) break;

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
    }

    toggleHelp() {
        this.state.showHelp = !this.state.showHelp;
    }

    insertExample(example) {
        this.state.searchQuery = example;
        this.state.showHelp = false;
        this.performAdvancedSearch();
    }

    handleArtistClick(artist) {
        navigateToArtist(artist.name);
    }

    handleAlbumClick(album) {
        navigateToAlbum(album.artist, album.name);
    }

    handleSongClick(song) {
        player.addToQueue(song, true);
    }

    handleSongContextMenu(song, e) {
        e.preventDefault();
        e.stopPropagation();
        showSongContextMenu(song, e.clientX, e.clientY);
    }

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
    }

    handleTouchMove(e) {
        if (!this._longPressTimer) return;

        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - this._touchStartX);
        const dy = Math.abs(touch.clientY - this._touchStartY);

        if (dx > 10 || dy > 10) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
    }

    handleTouchEnd(e) {
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
        if (this._longPressTriggered) {
            e.preventDefault();
            this._longPressTriggered = false;
        }
    }

    handleFolderClick(folder) {
        // Navigate to VFS browse
        const encodedPath = encodeURIComponent(folder.path.replace(/^\//, ''));
        window.location.hash = `/browse/path/${encodedPath}/`;
    }

    handleAddSongToQueue(song, e) {
        e.stopPropagation();
        player.addToQueue(song);
    }

    handlePlayArtist(artist, e) {
        e.stopPropagation();
        navigateToArtist(artist.name);
    }

    handlePlayAlbum(album, e) {
        e.stopPropagation();
        navigateToAlbum(album.artist, album.name);
    }

    hasResults() {
        const r = this.state.results;
        if (!r) return false;
        return r.artists.length > 0 || r.albums.length > 0 ||
               r.songs.length > 0 || r.folders.length > 0;
    }

    // Artist queue/radio actions
    async handleQueueArtist(artist, e) {
        e.stopPropagation();
        try {
            await player.addByFilter({ artist: artist.name });
        } catch (err) {
            console.error('Failed to queue artist:', err);
        }
    }

    async handleRadioArtist(artist, e) {
        e.stopPropagation();
        try {
            await player.startRadio(null, `a:eq:${artist.name}`);
        } catch (err) {
            console.error('Failed to start artist radio:', err);
        }
    }

    // Album queue/radio actions
    async handleQueueAlbum(album, e) {
        e.stopPropagation();
        try {
            await player.addByFilter({ artist: album.artist, album: album.name });
        } catch (err) {
            console.error('Failed to queue album:', err);
        }
    }

    async handleRadioAlbum(album, e) {
        e.stopPropagation();
        try {
            await player.startRadio(null, `a:eq:${album.artist} AND al:eq:${album.name}`);
        } catch (err) {
            console.error('Failed to start album radio:', err);
        }
    }

    // Advanced search result actions
    async handleQueueAllResults() {
        const loadedSongs = this.state.advancedResults.filter(s => s !== null);
        if (loadedSongs.length === 0) return;

        try {
            await player.addToQueue(loadedSongs);
        } catch (err) {
            console.error('Failed to queue all results:', err);
        }
    }

    async handleRadioFromSearch() {
        const query = this.state.searchQuery.trim();
        if (!query) return;

        try {
            await player.startRadio(null, query);
        } catch (err) {
            console.error('Failed to start radio from search:', err);
        }
    }

    async handleRadioFromSong(song, e) {
        e.stopPropagation();
        try {
            await player.startRadio(song.uuid);
        } catch (err) {
            console.error('Failed to start radio from song:', err);
        }
    }

    template() {
        const { searchQuery, results, advancedResults, isLoading, searchPerformed, showHelp, advancedMode,
                similarMode, similarSong } = this.state;

        return html`
            <div class="quick-search-page">
                ${when(this.stores.offline.workOfflineMode || !this.stores.offline.isOnline, () => html`
                    <div class="offline-notice">
                        📴 Searching downloaded songs only (${this.stores.offline.offlineSongUuids.size} available)
                    </div>
                `)}

                <!-- Similar Mode Header -->
                ${when(similarMode && similarSong, () => html`
                    <div class="similar-header">
                        <div class="similar-info">
                            <span class="similar-label">Songs similar to:</span>
                            <span class="similar-song-title">${similarSong.title || 'Unknown'}</span>
                            <span class="similar-song-artist">${similarSong.artist || 'Unknown Artist'}</span>
                        </div>
                        <cl-button severity="secondary" on-click="exitSimilarMode">
                            ✕ Exit
                        </cl-button>
                    </div>
                `)}

                <!-- Search Input -->
                ${when(!similarMode, () => html`
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
                        <cl-button severity="primary" on-click="performAdvancedSearch">
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
                            <code>t</code> (tag), <code>in</code> (playlist), <code>p</code> (path), <code>f</code> (filename),
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

                        <h4>Playlist Search</h4>
                        <p>Use <code>in:name</code> to find songs in a playlist:</p>
                        <div class="examples">
                            <button class="example-btn" on-click="${() => this.insertExample('in:eq:Favorites')}">in:eq:Favorites</button>
                            <button class="example-btn" on-click="${() => this.insertExample('in:Rock')}">in:Rock</button>
                        </div>

                        <h4>AI Search</h4>
                        <p>Use <code>ai:"prompt"</code> for semantic search, or <code>ai(query)</code> for similarity search:</p>
                        <div class="examples">
                            <button class="example-btn" on-click="${() => this.insertExample('ai:\"upbeat electronic music\"')}">ai:"upbeat electronic music"</button>
                            <button class="example-btn" on-click="${() => this.insertExample('c:j-pop AND ai:\"happy anime song\"')}">c:j-pop AND ai:"happy anime song"</button>
                            <button class="example-btn" on-click="${() => this.insertExample('ai(a:Beatles)')}">ai(a:Beatles)</button>
                        </div>

                        <h4>Compound AI Search</h4>
                        <p>Use <code>+</code> to blend prompts and <code>-</code> to exclude concepts at the embedding level:</p>
                        <div class="examples">
                            <button class="example-btn" on-click="${() => this.insertExample('ai:dreamy +ai:piano')}">ai:dreamy +ai:piano</button>
                            <button class="example-btn" on-click="${() => this.insertExample('ai:japanese pop -ai:rock')}">ai:japanese pop -ai:rock</button>
                            <button class="example-btn" on-click="${() => this.insertExample('ai:melancholic +ai:acoustic -ai:electronic')}">ai:melancholic +ai:acoustic -ai:electronic</button>
                        </div>
                        <p class="help-note">Note: <code>-</code> requires a space before it (to allow terms like "j-pop", "lo-fi").</p>
                    </div>
                `)}
                `)}

                <!-- Results -->
                ${when(!searchPerformed && !showHelp && !similarMode, html`
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
                    const win = this._win;
                    const { advancedTotalCount } = this.state;

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
                                    <button class="back-to-quick" on-click="backToQuickSearch">
                                        ← Back
                                    </button>
                                </div>
                            </div>
                            <div class="songs-spacer" ref="songsSpacer"
                                 style="height: ${win.totalHeight}px; position: relative;">
                                <div class="songs-list"
                                     style="position: absolute; top: ${win.offsetY}px; left: 0; right: 0;">
                                    ${memoEach(advancedResults.slice(win.visibleStart, win.visibleEnd), (song, idx) => {
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
                                                 on-touchstart-passive="${(e) => this.handleTouchStart(song, e)}"
                                                 on-touchmove-passive="handleTouchMove"
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
                                             on-touchstart-passive="${(e) => this.handleTouchStart(song, e)}"
                                             on-touchmove-passive="handleTouchMove"
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
    }

    static styles = /*css*/`
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

        /* Similar Mode Header */
        .similar-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem;
            background: var(--surface-100, #242424);
            border-radius: 12px;
            margin-bottom: 1.5rem;
            gap: 1rem;
        }

        .similar-info {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 0.5rem;
        }

        .similar-label {
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .similar-song-title {
            font-weight: 600;
            color: var(--text-primary, #e0e0e0);
        }

        .similar-song-artist {
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .similar-song-artist::before {
            content: '—';
            margin-right: 0.5rem;
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
}

export default defineComponent('quick-search-page', QuickSearchPage);

/**
 * Browse Page
 *
 * Library browser with:
 * - Hierarchical view: Category → Genre → Artist → Album → Song
 * - Genres view: All genres directly (no category filter)
 * - Artists view: All artists directly (no category/genre filter)
 * - File path view: Browse by original file paths
 * - Virtual scrolling for large lists
 */

import { defineComponent, html, when, each, memoEach, untracked, flushSync } from '../lib/framework.js';
import { getRouter } from '../lib/router.js';
import { rafThrottle } from '../lib/utils.js';
import { browse, playlists, songs as songsApi } from '../offline/offline-api.js';
import { player } from '../stores/player-store.js';
import offlineStore, { setDownloadProgress, computeOfflineFilterSets, formatBytes } from '../offline/offline-store.js';
import { downloadSong, canCacheOffline, downloadFolder, downloadByFilter, deleteOfflineFolderDownload } from '../offline/offline-audio.js';
import { showSongContextMenu } from '../components/song-context-menu.js';
import '../components/scroll-to-top.js';
import '../componentlib/data/virtual-list.js';
import '../componentlib/button/button.js';
import '../componentlib/overlay/dialog.js';
import '../componentlib/misc/spinner.js';

export default defineComponent('browse-page', {
    props: {
        params: {},  // URL params (path)
        query: {}    // Query string params (for hierarchy navigation)
    },

    stores: { offline: offlineStore },

    data() {
        return {
            viewMode: 'hierarchy',  // 'hierarchy' or 'filepath'

            // Hierarchy navigation
            level: 'category',      // category, genre, artist, album, songs
            currentCategory: null,
            currentGenre: null,
            currentArtist: null,
            currentAlbum: null,

            // Data - items marked untracked for virtual scroll performance
            items: untracked([]),
            cursor: null,
            hasMore: true,
            isLoading: false,
            totalCount: 0,

            // Windowed rendering
            visibleStart: 0,
            visibleEnd: 50,

            // Breadcrumb
            breadcrumbs: [],

            // File path mode
            currentPath: '/',

            // Quick filter
            filterText: '',
            filterLoading: false,
            sortBy: 'name',  // 'name' or 'count'

            // Multi-select mode
            selectionMode: false,
            selectedSongs: [],  // Full song objects (so selection survives navigation)
            showPlaylistPicker: false,
            userPlaylists: [],
            addingToPlaylist: false,
            addingAllToPlaylist: false,  // True when adding all songs (not just selection)

            // Offline download state
            isDownloadingSelection: false,
            isDownloadingAll: false,
            isDeletingFolder: false,

            // Confirm dialog
            confirmDialog: { show: false, title: '', message: '', action: null, confirmLabel: 'Confirm' },
            pendingDeleteFolder: null
        };
    },

    async mounted() {
        // Initialize from URL params if present (only once)
        if (this._initialized) return;
        this._initialized = true;
        // Single reconciliation entry point — reads BOTH params and query and
        // computes/applies the target view (see _reconcileRoute).
        this._reconcileRoute();
        this._setupInfiniteScroll();
    },

    unmounted() {
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }
        if (this._scrollHandler) {
            window.removeEventListener('scroll', this._scrollHandler, true);
        }
        if (this._reloadTimeout) {
            clearTimeout(this._reloadTimeout);
        }
    },

    propsChanged(prop) {
        // The router delivers route props via a batched setProps: by the time
        // EITHER propsChanged('params') or propsChanged('query') fires, BOTH
        // this.props.params and this.props.query already hold the new route.
        // So both signals funnel into a single reconciler that reads both and
        // is idempotent — whichever fires first applies, the second no-ops.
        // This replaces the old split params/query handlers that clobbered each
        // other (A2/A3).
        if (prop === 'params' || prop === 'query') {
            this._reconcileRoute();
        }
    },

    methods: {
        // ── Route reconciliation ─────────────────────────────────────────────
        // A single source of truth that maps (params, query) → a target view
        // and applies it exactly once. This closes A2/A3 (split handlers racing)
        // and, together with _routeEpoch, A7 (cross-mode stale applies).

        // Compute the target view descriptor from the current route props.
        // NOTE (A6): the router already URL-decodes params once (matchRoute →
        // safeDecodeURIComponent). We use params.encodedPath / params.path
        // verbatim — a second decodeURIComponent() here corrupted names with
        // literal %xx and threw URIError on names like "100% Hits".
        _computeTargetFromProps() {
            const params = this.props.params || {};
            const query = this.props.query || {};

            if (params.encodedPath) {
                return { mode: 'filepath', path: '/' + params.encodedPath };
            }
            if (params.path) {
                return { mode: 'filepath', path: '/' + params.path };
            }

            // Bare /browse/ — the query decides the view. ?view=… encodes the
            // genres/artists/files "roots" so they survive reload and are
            // distinguishable from a fresh bare /browse/ (categories root).
            if (query.view === 'files') {
                return { mode: 'filepath', path: '/' };
            }
            if (query.view === 'genres') {
                return { mode: 'genres' };
            }
            if (query.view === 'artists') {
                return { mode: 'artists' };
            }

            return {
                mode: 'hierarchy',
                category: query.category || null,
                genre: query.genre || null,
                artist: query.artist || null,
                album: query.album || null
            };
        },

        // Serialize a target to a stable key so reconciliation is idempotent.
        _serializeTarget(t) {
            if (t.mode === 'filepath') return 'filepath|' + t.path;
            if (t.mode === 'genres') return 'genres';
            if (t.mode === 'artists') return 'artists';
            return 'hierarchy|' + [t.category, t.genre, t.artist, t.album].join('|');
        },

        // Derive the hierarchy drill level from which filters are set.
        _deriveHierarchyLevel(t) {
            if (t.album) return 'songs';
            if (t.artist) return 'album';
            if (t.genre) return 'artist';
            if (t.category) return 'genre';
            return 'category';
        },

        // Reconcile the live view against the route props. Idempotent: if the
        // computed target already matches what we applied last, do nothing —
        // this is how the URL "echo" of our own in-page navigations no-ops
        // (replaces the scattered dedupe guards).
        _reconcileRoute() {
            const target = this._computeTargetFromProps();
            if (this._serializeTarget(target) === this._appliedRoute) return;
            this._applyTarget(target);
        },

        // Apply a target: set state, reset list state, bump the route epoch (so
        // in-flight loads from the previous target are discarded), record the
        // applied-route snapshot, and kick off the correct loader. Callers that
        // originate a navigation (tabs, drills) call this AND update the URL;
        // the resulting propsChanged then reconciles to a no-op.
        _applyTarget(target) {
            this._appliedRoute = this._serializeTarget(target);
            this._routeEpoch = (this._routeEpoch || 0) + 1;

            // Reset shared list state for the fresh view.
            this.state.filterText = '';
            this.state.items = [];
            this.state.cursor = null;
            this.state.hasMore = true;
            this.state.totalCount = 0;  // reset so a stale count doesn't suppress the empty state
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;

            if (target.mode === 'filepath') {
                this.state.viewMode = 'filepath';
                this.state.currentPath = target.path;
                this.loadFilePath();
                return;
            }

            if (target.mode === 'genres') {
                this.state.viewMode = 'genres';
                this.state.level = 'genre';
                this.state.currentCategory = null;
                this.state.currentGenre = null;
                this.state.currentArtist = null;
                this.state.currentAlbum = null;
                this.loadAllGenres();
                return;
            }

            if (target.mode === 'artists') {
                this.state.viewMode = 'artists';
                this.state.level = 'artists';
                this.state.currentCategory = null;
                this.state.currentGenre = null;
                this.state.currentArtist = null;
                this.state.currentAlbum = null;
                this.loadArtists();
                return;
            }

            // Hierarchy
            this.state.viewMode = 'hierarchy';
            this.state.currentCategory = target.category;
            this.state.currentGenre = target.genre;
            this.state.currentArtist = target.artist;
            this.state.currentAlbum = target.album;
            this.state.level = this._deriveHierarchyLevel(target);
            this.loadItems();
        },

        // Convert [All X] special values to null for API calls
        _apiValue(val, allName) {
            if (val === allName) return null;
            return val;
        },

        // Build a filter object for songs/queue/playlist APIs that translates
        // hierarchy aggregator names ([All Genres], [All Artists], [All Albums])
        // into null. Without this, those literal strings get passed to the
        // backend (songs_by_filter / queue_add_by_filter), which matches them
        // as exact values and returns 0 songs — silent no-op. The browse APIs
        // (album_songs etc.) understand the placeholders directly, but the
        // songs/queue paths don't, so we translate here.
        _apiFilters(overrides = {}) {
            const cat = 'category' in overrides ? overrides.category : this.state.currentCategory;
            const gen = 'genre'    in overrides ? overrides.genre    : this.state.currentGenre;
            const art = 'artist'   in overrides ? overrides.artist   : this.state.currentArtist;
            const alb = 'album'    in overrides ? overrides.album    : this.state.currentAlbum;
            return {
                category: cat,
                genre:  gen === '[All Genres]'  ? null : gen,
                artist: art === '[All Artists]' ? null : art,
                album:  alb === '[All Albums]'  ? null : alb
            };
        },

        async loadItems() {
            // Capture current hierarchy state - if it changes during async load, discard results
            const { level, currentCategory, currentGenre, currentArtist, currentAlbum, cursor, sortBy } = this.state;
            const loadKey = `${level}|${currentCategory}|${currentGenre}|${currentArtist}|${currentAlbum}`;

            // Track which request is latest (allow concurrent requests, discard stale ones)
            this._hierarchyRequestId = (this._hierarchyRequestId || 0) + 1;
            const thisRequestId = this._hierarchyRequestId;
            // Capture the route epoch too: a view-mode switch (e.g. to genres/
            // filepath) calls a DIFFERENT loader, so _hierarchyRequestId alone
            // wouldn't invalidate an in-flight loadItems. Re-check epoch after
            // the await so a stale hierarchy response can't land in another view
            // (A7).
            const epoch = this._routeEpoch;

            this.state.isLoading = true;

            try {
                let result;
                const sort = sortBy === 'count' ? 'song_count' : 'name';

                // Convert special [All X] values to null for API calls
                const apiGenre = this._apiValue(currentGenre, '[All Genres]');
                const apiArtist = this._apiValue(currentArtist, '[All Artists]');
                // Note: [Unknown Artist], [All Albums], [Unknown Album] are handled by the API directly

                switch (level) {
                    case 'category':
                        result = await browse.categories({ sort });
                        break;

                    case 'genre':
                        result = await browse.genres({ category: currentCategory, sort });
                        break;

                    case 'artist':
                        result = await browse.artists({
                            category: currentCategory,
                            genre: apiGenre,
                            cursor,
                            limit: 1000,
                            sort
                        });
                        break;

                    case 'album':
                        result = await browse.albums({
                            artist: apiArtist,
                            category: currentCategory,
                            genre: apiGenre,
                            cursor,
                            limit: 1000,
                            sort
                        });
                        break;

                    case 'songs':
                        result = await browse.albumSongs(currentAlbum, {
                            artist: apiArtist,
                            category: currentCategory,
                            genre: apiGenre,
                            cursor,
                            limit: 1000
                        });
                        break;
                }

                // Discard if hierarchy changed, the view mode changed, or a
                // newer request started
                const currentKey = `${this.state.level}|${this.state.currentCategory}|${this.state.currentGenre}|${this.state.currentArtist}|${this.state.currentAlbum}`;
                if (currentKey !== loadKey || this._hierarchyRequestId !== thisRequestId || this._routeEpoch !== epoch) {
                    return;
                }

                // Apply results
                this.state.items = cursor ? [...this.state.items, ...result.items] : result.items;
                if (result.nextCursor !== undefined) this.state.cursor = result.nextCursor;
                this.state.hasMore = result.hasMore || false;
                if (result.totalCount !== undefined) this.state.totalCount = result.totalCount;

                this._updateBreadcrumbs();
                // Re-setup infinite scroll after items load
                this._setupInfiniteScroll();
                // Setup scroll listener for windowed rendering
                this._setupScrollListener();
            } catch (e) {
                if (this._hierarchyRequestId === thisRequestId && this._routeEpoch === epoch) {
                    console.error('Failed to load items:', e);
                }
            } finally {
                if (this._hierarchyRequestId === thisRequestId && this._routeEpoch === epoch) {
                    this.state.isLoading = false;
                }
            }
        },

        async loadAllGenres() {
            // Supersede any in-flight genres load rather than no-opping when
            // isLoading is true — a tab click during another mode's in-flight
            // load previously left stale items on screen.
            this._genresRequestId = (this._genresRequestId || 0) + 1;
            const thisRequestId = this._genresRequestId;
            const epoch = this._routeEpoch;
            this.state.isLoading = true;

            try {
                // Load all genres (no minSongs filter - there are fewer genres)
                const result = await browse.genres({
                    minSongs: 0,
                    sort: this.state.sortBy === 'count' ? 'song_count' : 'name'
                });

                // Discard if a newer genres load started or the view changed
                if (this._genresRequestId !== thisRequestId || this._routeEpoch !== epoch) {
                    return;
                }

                this.state.items = result.items;
                this.state.totalCount = result.totalCount;
                this.state.hasMore = false;  // All genres loaded at once
                this.state.filterLoading = false;
                this.state.breadcrumbs = [{ label: 'All Genres', level: 'genre' }];
                this._setupScrollListener();
            } catch (e) {
                if (this._genresRequestId === thisRequestId && this._routeEpoch === epoch) {
                    console.error('Failed to load genres:', e);
                }
            } finally {
                if (this._genresRequestId === thisRequestId && this._routeEpoch === epoch) {
                    this.state.isLoading = false;
                }
            }
        },

        async loadArtists() {
            this._artistsRequestId = (this._artistsRequestId || 0) + 1;
            const thisRequestId = this._artistsRequestId;
            const epoch = this._routeEpoch;

            this.state.isLoading = true;
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;

            try {
                // Load artists with 100+ songs (popular artists only)
                const minSongs = 100;
                const sort = this.state.sortBy === 'count' ? 'song_count' : 'name';
                const result = await browse.artists({
                    cursor: null,
                    limit: 200,
                    minSongs,
                    sort
                });

                if (this._artistsRequestId !== thisRequestId || this._routeEpoch !== epoch) return;

                const totalCount = result.totalCount || result.items.length;

                // Create sparse array for windowed rendering
                const items = new Array(totalCount).fill(null);
                result.items.forEach((item, i) => {
                    items[i] = item;
                });

                this.state.items = items;
                this.state.totalCount = totalCount;
                this.state.cursor = result.nextCursor;
                this.state.hasMore = result.hasMore;
                this.state.breadcrumbs = [{ label: 'Artists', level: 'artists' }];

                // Setup scroll listener for windowed rendering
                this._setupScrollListener();

                // Start background loading of all remaining artists
                if (result.hasMore) {
                    this._loadArtistsInBackground(result.nextCursor, result.items.length, minSongs, sort, thisRequestId);
                }
            } catch (e) {
                if (this._artistsRequestId === thisRequestId && this._routeEpoch === epoch) {
                    console.error('Failed to load artists:', e);
                }
            } finally {
                if (this._artistsRequestId === thisRequestId && this._routeEpoch === epoch) {
                    this.state.isLoading = false;
                }
            }
        },

        async loadFilePath(append = false) {
            // Capture path at start - if it changes during async load, discard results
            const loadingPath = this.state.currentPath;

            // Don't block on isLoading - allow new requests to proceed
            // Just increment a counter to track which request is latest
            this._loadRequestId = (this._loadRequestId || 0) + 1;
            const thisRequestId = this._loadRequestId;
            // Capture the route epoch: switching to a non-filepath view calls a
            // different loader, so _loadRequestId alone wouldn't discard this
            // in-flight response (A7).
            const epoch = this._routeEpoch;

            this.state.isLoading = true;
            this.state.visibleStart = 0;
            this.state.visibleEnd = 50;

            try {
                const sort = this.state.sortBy === 'count' ? 'song_count' : 'name';
                const result = await browse.path(loadingPath, { limit: 200, sort });

                // Discard if path changed, the view mode changed, or a newer request started
                if (this.state.currentPath !== loadingPath || this._loadRequestId !== thisRequestId || this._routeEpoch !== epoch) {
                    return;
                }

                const totalCount = result.totalCount || result.items.length;

                // Create sparse array
                const items = new Array(totalCount).fill(null);
                result.items.forEach((item, i) => {
                    items[i] = item;
                });

                this.state.items = items;
                this.state.totalCount = totalCount;
                this.state.cursor = result.nextCursor;
                this.state.hasMore = result.hasMore;
                this._updateFilePathBreadcrumbs();

                // Setup scroll listener for windowed rendering
                this._setupScrollListener();

                // Start background loading
                if (result.hasMore) {
                    this._loadRemainingInBackground(result.nextCursor, result.items.length, sort);
                }
            } catch (e) {
                // Only log if this is still the current request
                if (this._loadRequestId === thisRequestId && this._routeEpoch === epoch) {
                    console.error('Failed to load path:', e);
                }
            } finally {
                // Only clear loading if this is still the current request
                if (this._loadRequestId === thisRequestId && this._routeEpoch === epoch) {
                    this.state.isLoading = false;
                }
            }
        },

        async loadMore() {
            if (!this.state.hasMore || this.state.isLoading) return;

            // filepath mode uses background loading, not loadMore
            if (this.state.viewMode === 'filepath') {
                return;
            }

            await this.loadItems();
        },

        _setupInfiniteScroll() {
            // Legacy - kept for hierarchy mode which doesn't use windowed rendering
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const sentinel = this.refs.sentinel;
                    if (!sentinel) return;

                    if (this._intersectionObserver) {
                        this._intersectionObserver.disconnect();
                    }

                    const margin = Math.round(window.innerHeight / 3);
                    this._intersectionObserver = new IntersectionObserver(
                        (entries) => {
                            if (entries[0].isIntersecting && this.state.hasMore && !this.state.isLoading) {
                                this.loadMore();
                            }
                        },
                        { threshold: 0, rootMargin: `${margin}px` }
                    );

                    this._intersectionObserver.observe(sentinel);
                });
            });
        },

        _setupScrollListener() {
            if (this._scrollHandler) {
                window.removeEventListener('scroll', this._scrollHandler, true);
            }

            // Use rafThrottle to limit scroll handler to once per animation frame (~16ms at 60fps)
            this._scrollHandler = rafThrottle(() => this._updateVisibleRange());
            window.addEventListener('scroll', this._scrollHandler, true);

            requestAnimationFrame(() => this._updateVisibleRange());
        },

        _updateVisibleRange() {
            const container = this.refs.itemsContainer;
            if (!container) return;

            const itemHeight = 52; // Must match CSS
            const baseBuffer = 40; // Increased from 20 for smoother scrolling
            const velocityBuffer = 30; // Extra items in scroll direction

            const rect = container.getBoundingClientRect();
            const viewportTop = Math.max(0, -rect.top);
            const viewportBottom = viewportTop + window.innerHeight;

            // Track scroll velocity for predictive buffering
            const now = performance.now();
            const scrollY = viewportTop;
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

            // Use totalCount if available, otherwise fall back to items.length
            const itemCount = this.state.totalCount || this.state.items.length;

            let startIndex = Math.max(0, Math.floor(viewportTop / itemHeight) - bufferAbove);
            let endIndex = Math.min(
                itemCount,
                Math.ceil(viewportBottom / itemHeight) + bufferBelow
            );

            // Ensure valid range - only constrain based on actual loaded items
            // Using totalCount here can cause jumps if it's stale during loadMore()
            const loadedCount = this.state.items.length;
            if (loadedCount > 0) {
                startIndex = Math.min(startIndex, loadedCount - 1);
                endIndex = Math.min(endIndex, loadedCount);
            }
            endIndex = Math.max(endIndex, startIndex + 1);

            // Bottom locking: ensure visibleStart doesn't cause content to extend past container
            // This prevents scroll position from jumping when reaching the end
            const renderCount = endIndex - startIndex;
            const maxVisibleStart = Math.max(0, loadedCount - renderCount);
            startIndex = Math.min(startIndex, maxVisibleStart);

            if (startIndex !== this.state.visibleStart || endIndex !== this.state.visibleEnd) {
                // Use flushSync to ensure translateY and item slice update atomically
                // Prevents visual desync between position and content in RAF-throttled handler
                flushSync(() => {
                    this.state.visibleStart = startIndex;
                    this.state.visibleEnd = endIndex;
                });
            }

            // Trigger loading more items when approaching end of loaded items
            // This replaces the sentinel-based approach for virtual scroll mode
            const loadThreshold = 50; // Load more when within 50 items of end
            if (this.state.hasMore && !this.state.isLoading && endIndex >= loadedCount - loadThreshold) {
                this.loadMore();
            }
        },

        async _loadRemainingInBackground(cursor, offset, sort) {
            // Capture path/request id at entry. If the user navigates while we're
            // paginating, bail — otherwise the cursor (issued for the old path) is
            // used against the new path and stale rows clobber the new sparse array.
            const loadingPath = this.state.currentPath;
            const thisRequestId = this._loadRequestId;
            const epoch = this._routeEpoch;
            this._backgroundLoadingActive = true;
            let currentCursor = cursor;
            let currentOffset = offset;

            try {
                while (currentCursor) {
                    if (this.state.currentPath !== loadingPath || this._loadRequestId !== thisRequestId || this._routeEpoch !== epoch) return;

                    let result;
                    try {
                        result = await browse.path(loadingPath, {
                            cursor: currentCursor,
                            limit: 500,
                            sort
                        });
                    } catch (e) {
                        console.error('Background loading failed:', e);
                        return;
                    }

                    if (this.state.currentPath !== loadingPath || this._loadRequestId !== thisRequestId || this._routeEpoch !== epoch) return;

                    const items = [...this.state.items];
                    result.items.forEach((item, i) => {
                        items[currentOffset + i] = item;
                    });
                    this.state.items = items;
                    this.state.hasMore = result.hasMore;

                    currentOffset += result.items.length;
                    currentCursor = result.nextCursor;
                }
            } finally {
                if (this._loadRequestId === thisRequestId) {
                    this._backgroundLoadingActive = false;
                }
            }
        },

        async _loadArtistsInBackground(cursor, offset, minSongs, sort, requestId) {
            const epoch = this._routeEpoch;
            this._backgroundLoadingActive = true;
            let currentCursor = cursor;
            let currentOffset = offset;

            try {
                while (currentCursor) {
                    if (this._artistsRequestId !== requestId || this._routeEpoch !== epoch) return;

                    let result;
                    try {
                        result = await browse.artists({
                            cursor: currentCursor,
                            limit: 500,
                            minSongs,
                            sort
                        });
                    } catch (e) {
                        console.error('Artists background loading failed:', e);
                        return;
                    }

                    if (this._artistsRequestId !== requestId || this._routeEpoch !== epoch) return;

                    const items = [...this.state.items];
                    result.items.forEach((item, i) => {
                        items[currentOffset + i] = item;
                    });
                    this.state.items = items;
                    this.state.hasMore = result.hasMore;

                    currentOffset += result.items.length;
                    currentCursor = result.nextCursor;
                }
            } finally {
                if (this._artistsRequestId === requestId) {
                    this._backgroundLoadingActive = false;
                    this.state.filterLoading = false;
                }
            }
        },

        _updateBreadcrumbs() {
            const crumbs = [{ label: 'Categories', level: 'category' }];
            const { level, currentCategory, currentGenre, currentArtist, currentAlbum } = this.state;

            if (level !== 'category' && currentCategory) {
                crumbs.push({ label: currentCategory, level: 'genre' });
            }
            if (['artist', 'album', 'songs'].includes(level) && currentGenre) {
                crumbs.push({ label: currentGenre, level: 'artist' });
            }
            if (['album', 'songs'].includes(level) && currentArtist) {
                crumbs.push({ label: currentArtist, level: 'album' });
            }
            if (level === 'songs' && currentAlbum) {
                crumbs.push({ label: currentAlbum, level: 'songs' });
            }

            this.state.breadcrumbs = crumbs;
        },

        _updateFilePathBreadcrumbs() {
            const parts = this.state.currentPath.split('/').filter(p => p);
            const crumbs = [{ label: 'Root', path: '/' }];

            let path = '';
            for (const part of parts) {
                path += '/' + part;
                crumbs.push({ label: part, path });
            }

            this.state.breadcrumbs = crumbs;
        },

        handleItemClick(item) {
            if (this.state.viewMode === 'filepath') {
                this._handleFilePathClick(item);
                return;
            }

            const { level } = this.state;

            // Build the next hierarchy target by drilling one level from the
            // current filters. _applyTarget derives the new level, loads, and
            // records the applied-route snapshot; _updateHierarchyUrl then
            // echoes it into the URL (the resulting propsChanged no-ops).
            const target = {
                mode: 'hierarchy',
                category: this.state.currentCategory,
                genre: this.state.currentGenre,
                artist: this.state.currentArtist,
                album: this.state.currentAlbum
            };

            switch (level) {
                case 'category':
                    target.category = item.name;
                    break;
                case 'genre':
                    // Store actual name including [All Genres] for URL deep linking.
                    // (From the standalone Genres tab currentCategory is null, so
                    // this naturally drills into a category-less genre.)
                    target.genre = item.name;
                    break;
                case 'artist':
                    // Store actual name including [All Artists] for URL deep linking
                    target.artist = item.name;
                    break;
                case 'artists':
                    // Artist clicked from the Artists tab - show their albums
                    target.category = null;
                    target.genre = null;
                    target.artist = item.display_name || item.name;
                    target.album = null;
                    break;
                case 'album':
                    // Store actual name including [All Albums], [Unknown Album] for URL deep linking
                    target.album = item.name;
                    break;
                case 'songs':
                    // Play the song
                    player.addToQueue(item, true);
                    return;
            }

            this._applyTarget(target);
            this._updateHierarchyUrl();
        },

        _handleFilePathClick(item) {
            if (item.type === 'directory') {
                // Navigate using router - propsChanged will handle loading
                const newPath = this.state.currentPath.replace(/\/$/, '') + '/' + item.name;
                this._navigateToFilePath(newPath);
            } else {
                // It's a song - play directly if item has uuid
                if (item.uuid) {
                    player.addToQueue(item, true);
                } else {
                    console.warn('VFS file item missing uuid:', item);
                }
            }
        },

        _navigateToFilePath(newPath) {
            // Use router.navigate() so reconciliation handles loading.
            // Encode once → the router decodes once (matchRoute) → the page uses
            // the raw value (A6: no second decode).
            const router = getRouter();
            const encodedPath = encodeURIComponent(newPath.replace(/^\//, ''));
            if (encodedPath) {
                router.navigate(`/browse/path/${encodedPath}/`);
            } else {
                // Filepath root: a bare /browse/ would be read as the hierarchy
                // (categories) root, so mark the files view explicitly.
                this._updateViewUrl('files');
            }
        },

        _updateHierarchyUrl() {
            // Navigate through the router (not raw history.pushState) so the
            // router's currentRoute.query stays authoritative. Otherwise back/
            // forward navigation compares the new URL against a stale
            // currentRoute and never fires propsChanged, leaving the previous
            // level's items on screen. The post-navigation propsChanged is a
            // no-op here because _applyTarget already recorded _appliedRoute to
            // match this URL (see _reconcileRoute), so this does not double-load.
            const { currentCategory, currentGenre, currentArtist, currentAlbum } = this.state;
            const router = getRouter();
            router.navigate('/browse/', {
                category: currentCategory || null,
                genre: currentGenre || null,
                artist: currentArtist || null,
                album: currentAlbum || null
            });
        },

        // Update the URL for a "root" view (genres/artists/files) using an
        // explicit ?view= marker. Encoding the tab in the URL (rather than a
        // transient flag) keeps a genres/artists/files view distinguishable
        // from a bare /browse/ (categories root) — so the URL echo of a tab
        // click reconciles to a no-op instead of snapping back to Categories
        // (A3), and the view survives reload / back-forward.
        _updateViewUrl(view) {
            const router = getRouter();
            router.navigate('/browse/', { view });
        },

        handleBreadcrumbClick(crumb) {
            const { viewMode } = this.state;

            if (viewMode === 'filepath') {
                // Navigate using router - reconciliation will handle loading
                this._navigateToFilePath(crumb.path);
                return;
            }

            // Genres/Artists views only have their single root crumb; clicking
            // it just reloads that view (don't fall through to the hierarchy
            // reset, which would drop us to Categories).
            if (viewMode === 'genres') {
                this._applyTarget({ mode: 'genres' });
                this._updateViewUrl('genres');
                return;
            }
            if (viewMode === 'artists') {
                this._applyTarget({ mode: 'artists' });
                this._updateViewUrl('artists');
                return;
            }

            const targetLevel = crumb.level;
            const target = {
                mode: 'hierarchy',
                category: this.state.currentCategory,
                genre: this.state.currentGenre,
                artist: this.state.currentArtist,
                album: this.state.currentAlbum
            };

            // Reset lower levels
            if (targetLevel === 'category') {
                target.category = target.genre = target.artist = target.album = null;
            } else if (targetLevel === 'genre') {
                target.genre = target.artist = target.album = null;
            } else if (targetLevel === 'artist') {
                target.artist = target.album = null;
            } else if (targetLevel === 'album') {
                target.album = null;
            }

            this._applyTarget(target);
            this._updateHierarchyUrl();
        },

        handleViewModeChange(mode) {
            // Set state AND update the URL. _applyTarget records _appliedRoute so
            // the URL echo reconciles to a no-op; the ?view= marker keeps the
            // genres/artists/files roots distinguishable from a bare /browse/.
            if (mode === 'hierarchy') {
                this._applyTarget({ mode: 'hierarchy', category: null, genre: null, artist: null, album: null });
                this._updateHierarchyUrl();  // all-null query → bare /browse/
            } else if (mode === 'genres') {
                this._applyTarget({ mode: 'genres' });
                this._updateViewUrl('genres');
            } else if (mode === 'artists') {
                this._applyTarget({ mode: 'artists' });
                this._updateViewUrl('artists');
            } else {
                // Filepath root
                this._applyTarget({ mode: 'filepath', path: '/' });
                this._updateViewUrl('files');
            }
        },

        async handlePlayAll() {
            const { viewMode, currentPath } = this.state;

            this.state.isLoading = true;
            try {
                await player.clearQueue();
                if (viewMode === 'filepath') {
                    await player.addByPath(currentPath);
                } else {
                    await player.addByFilter(this._apiFilters());
                }
            } catch (e) {
                console.error('Failed to play all:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async handleShuffleAll() {
            const { viewMode, currentPath } = this.state;

            this.state.isLoading = true;
            try {
                // Enable shuffle first (await: it persists play_mode, and we
                // clear/refill the queue right after — don't race the writes)
                await player.setShuffle(true);
                await player.clearQueue();
                if (viewMode === 'filepath') {
                    await player.addByPath(currentPath);
                } else {
                    await player.addByFilter(this._apiFilters());
                }
            } catch (e) {
                console.error('Failed to shuffle all:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async handleAddAllToQueue() {
            const { viewMode, currentPath } = this.state;

            this.state.isLoading = true;
            try {
                if (viewMode === 'filepath') {
                    await player.addByPath(currentPath);
                } else {
                    await player.addByFilter(this._apiFilters());
                }
            } catch (e) {
                console.error('Failed to add all to queue:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async handleStartRadio() {
            const { viewMode, currentPath } = this.state;

            let filter = null;
            if (viewMode === 'filepath') {
                filter = `p:mt:${currentPath}`;
            } else {
                const { category, genre, artist, album } = this._apiFilters();
                const parts = [];
                if (category) parts.push(`c:eq:${category}`);
                if (genre)    parts.push(`g:eq:${genre}`);
                if (artist)   parts.push(`a:eq:${artist}`);
                if (album)    parts.push(`l:eq:${album}`);
                if (parts.length > 0) filter = parts.join(' AND ');
            }

            player.startRadio(null, filter);
        },

        async handleAddAllToPlaylist() {
            // Set flag to indicate we're adding all songs, not just selection.
            // Bypass openPlaylistPicker (which clears the flag for the selection-bar entry).
            this.state.addingAllToPlaylist = true;
            await this._showPlaylistPicker();
        },

        handleAddToQueue(item, e) {
            e.stopPropagation();
            player.addToQueue(item);
        },

        async handleAddFolderToQueue(item, e) {
            e.stopPropagation();
            this.state.isLoading = true;
            try {
                const { viewMode, level, currentPath } = this.state;

                if (viewMode === 'filepath') {
                    // Add songs from this directory
                    const path = currentPath === '/' ? '/' + item.name : currentPath + '/' + item.name;
                    await player.addByPath(path);
                } else {
                    // Override the level we're clicking into; deeper levels are
                    // null in state already so _apiFilters fills them correctly.
                    const overrides = {};
                    if (level === 'category')   overrides.category = item.name;
                    else if (level === 'genre') overrides.genre    = item.name;
                    else if (level === 'artist') overrides.artist  = item.name;
                    else if (level === 'album') overrides.album    = item.name;
                    await player.addByFilter(this._apiFilters(overrides));
                }
            } catch (e) {
                console.error('Failed to add folder to queue:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        handleFilterChange(e) {
            const newValue = e.target.value;
            this.state.filterText = newValue;

            // For artists/genres views, trigger loading all items when filter starts
            const viewMode = this.state.viewMode;
            if (newValue.length > 0 && (viewMode === 'artists' || viewMode === 'genres')) {
                this._ensureAllItemsLoaded();
            }
        },

        _ensureAllItemsLoaded() {
            // Check if we still have items to load
            if (!this.state.hasMore && !this._backgroundLoadingActive) {
                // All items already loaded
                this.state.filterLoading = false;
                return;
            }

            // Show loading indicator while background loading completes
            this.state.filterLoading = true;
        },

        handleClearFilter() {
            this.state.filterText = '';
            this.state.filterLoading = false;
        },

        toggleSort() {
            this.state.sortBy = this.state.sortBy === 'name' ? 'count' : 'name';
            // Reload from backend with new sort order
            this._reloadForSort();
        },

        _reloadForSort() {
            const { viewMode } = this.state;
            if (viewMode === 'artists') {
                this.loadArtists();
            } else if (viewMode === 'genres') {
                this.loadAllGenres();
            } else if (viewMode === 'filepath') {
                this.loadFilePath();
            }
            // For hierarchy mode, sorting is per-level so we reload current items
            else if (viewMode === 'hierarchy') {
                this.state.items = [];
                this.state.cursor = null;
                this.loadItems();
            }
        },

        getFilteredItems() {
            const filter = this.state.filterText.toLowerCase().trim();
            // Filter out null items (sparse array placeholders)
            // Sorting is done on the backend
            let items = this.state.items.filter(item => item != null);

            // Apply offline filter first when in offline mode
            if (this.isOfflineMode()) {
                items = this.filterForOffline(items, this.state.level);
            }

            if (!filter) return items;

            // Apply text filter only (sorting handled by backend)
            return items.filter(item => {
                let name = '';
                if (this.state.viewMode === 'filepath') {
                    name = item.name || '';
                } else {
                    name = item.name || item.title || '';
                }
                return name.toLowerCase().includes(filter);
            });
        },

        getItemIcon(item) {
            if (!item) return '📄';
            if (this.state.viewMode === 'filepath') {
                return item.type === 'directory' ? '📁' : '🎵';
            }

            switch (this.state.level) {
                case 'category': return '📂';
                case 'genre': return '🎼';
                case 'artist': return '👤';
                case 'artists': return '🎤';
                case 'album': return '💿';
                case 'songs': return '🎵';
                default: return '📄';
            }
        },

        getItemSubtitle(item) {
            if (!item) return '';
            if (this.state.viewMode === 'filepath') {
                if (item.type === 'directory' && item.song_count !== undefined) {
                    return `${item.song_count} song${item.song_count !== 1 ? 's' : ''}`;
                }
                return item.type === 'directory' ? 'Folder' : '';
            }

            if (item.song_count !== undefined) {
                return `${item.song_count} song${item.song_count !== 1 ? 's' : ''}`;
            }

            if (this.state.level === 'songs') {
                return item.artist || '';
            }

            return '';
        },

        getDisplayTitle(item) {
            if (!item) return 'Unknown';
            if (item.title) return item.title;
            if (item.name) return item.name;
            // Fallback to filename without extension
            const path = item.virtual_file || item.file || '';
            const filename = path.split('/').pop() || '';
            return filename.replace(/\.[^.]+$/, '') || 'Unknown';
        },

        handleItemContextMenu(item, e) {
            e.preventDefault();
            e.stopPropagation();

            // Song - pass directly
            if (item.uuid) {
                showSongContextMenu(item, e.clientX, e.clientY);
                return;
            }

            // Folder - build path or filters
            if (item.type === 'directory' || item.name) {
                const { viewMode, currentPath, currentCategory, currentGenre, currentArtist } = this.state;

                if (viewMode === 'filepath') {
                    // VFS path mode - build full path
                    const normalizedPath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
                    const folderPath = normalizedPath + item.name;
                    showSongContextMenu(item, e.clientX, e.clientY, {
                        isFolder: true,
                        path: folderPath
                    });
                } else {
                    // Hierarchy mode - build filters for next level
                    const filters = { category: currentCategory };
                    if (currentGenre) filters.genre = currentGenre;
                    if (currentArtist) filters.artist = currentArtist;

                    // The folder name becomes the next level filter
                    const level = this.state.level;
                    if (level === 'category') {
                        filters.category = item.name;
                    } else if (level === 'genre') {
                        filters.genre = item.name;
                    } else if (level === 'artist') {
                        filters.artist = item.name;
                    } else if (level === 'album') {
                        filters.album = item.name;
                    }

                    showSongContextMenu(item, e.clientX, e.clientY, {
                        isFolder: true,
                        filters
                    });
                }
            }
        },

        // Touch long press for context menu (mobile)
        handleTouchStart(item, e) {
            // Support both songs and folders
            if (!item.uuid && !item.name) return;

            if (this._longPressTimer) {
                clearTimeout(this._longPressTimer);
            }

            const touch = e.touches[0];
            this._touchStartX = touch.clientX;
            this._touchStartY = touch.clientY;

            this._longPressTimer = setTimeout(() => {
                // For songs, show directly; for folders, build options
                if (item.uuid) {
                    showSongContextMenu(item, this._touchStartX, this._touchStartY);
                } else {
                    // Reuse the same folder logic from handleItemContextMenu
                    const { viewMode, currentPath, currentCategory, currentGenre, currentArtist, level } = this.state;

                    if (viewMode === 'filepath') {
                        const normalizedPath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
                        const folderPath = normalizedPath + item.name;
                        showSongContextMenu(item, this._touchStartX, this._touchStartY, {
                            isFolder: true,
                            path: folderPath
                        });
                    } else {
                        const filters = { category: currentCategory };
                        if (currentGenre) filters.genre = currentGenre;
                        if (currentArtist) filters.artist = currentArtist;

                        if (level === 'category') filters.category = item.name;
                        else if (level === 'genre') filters.genre = item.name;
                        else if (level === 'artist') filters.artist = item.name;
                        else if (level === 'album') filters.album = item.name;

                        showSongContextMenu(item, this._touchStartX, this._touchStartY, {
                            isFolder: true,
                            filters
                        });
                    }
                }
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

        // Multi-select methods
        toggleSelectionMode() {
            this.state.selectionMode = !this.state.selectionMode;
            if (!this.state.selectionMode) {
                this.state.selectedSongs = [];
            }
        },

        isSelected(item) {
            if (!item) return false;
            return this.state.selectedSongs.some(s => s.uuid === item.uuid);
        },

        toggleSelection(item, e) {
            e.stopPropagation();
            if (this.isSelected(item)) {
                this.state.selectedSongs = this.state.selectedSongs.filter(s => s.uuid !== item.uuid);
            } else {
                // Store the full song so navigating away doesn't strand it.
                this.state.selectedSongs = [...this.state.selectedSongs, item];
            }
        },

        async selectAll() {
            // If everything is loaded (or the user has narrowed the view with a
            // text filter), select what's visible. Otherwise fetch the full set
            // — sparse-array placeholders would silently drop unloaded songs.
            const hasFilter = this.state.filterText.trim().length > 0;
            const allLoaded = !this.state.hasMore
                && !this._backgroundLoadingActive
                && !this.state.items.some(i => i == null);

            if (hasFilter || allLoaded) {
                this.state.selectedSongs = this.getFilteredItems().filter(item => item && item.uuid);
                return;
            }

            try {
                this.state.selectedSongs = await this._getAllSongsFromView();
            } catch (e) {
                console.error('selectAll: failed to fetch full song list, falling back to loaded items:', e);
                this.state.selectedSongs = this.getFilteredItems().filter(item => item && item.uuid);
            }
        },

        clearSelection() {
            this.state.selectedSongs = [];
        },

        async handleAddSelectedToQueue() {
            const songs = this.state.selectedSongs;
            if (songs.length === 0) return;

            await player.addToQueue(songs, false);
            this.clearSelection();
        },

        async openPlaylistPicker() {
            // Direct entry from the selection bar — make sure a stale flag from
            // a prior "Add All" session doesn't redirect us into the all-songs path.
            this.state.addingAllToPlaylist = false;
            await this._showPlaylistPicker();
        },

        async _showPlaylistPicker() {
            // Load playlists if not already loaded
            if (this.state.userPlaylists.length === 0) {
                try {
                    const result = await playlists.list();
                    this.state.userPlaylists = result.items || [];
                } catch (e) {
                    console.error('Failed to load playlists:', e);
                }
            }
            this.state.showPlaylistPicker = true;
        },

        closePlaylistPicker() {
            this.state.showPlaylistPicker = false;
            this.state.addingAllToPlaylist = false;
        },

        async addSelectedToPlaylist(playlistId) {
            const wasAddingAll = this.state.addingAllToPlaylist;
            this.state.addingToPlaylist = true;
            try {
                let songs;

                if (wasAddingAll) {
                    // Adding all songs from current view (full objects)
                    songs = await this._getAllSongsFromView();
                } else {
                    // Adding selected songs only (already full objects)
                    if (this.state.selectedSongs.length === 0) return;
                    songs = this.state.selectedSongs;
                }

                if (songs.length === 0) {
                    const toast = document.querySelector('cl-toast');
                    if (toast) toast.show({ severity: 'info', summary: 'Info', detail: 'No songs to add' });
                    return;
                }

                const uuids = songs.map(s => s.uuid).filter(u => u);
                // Pass full song objects so metadata can be cached for offline use
                await playlists.addSongsBatch(playlistId, uuids, songs);
                this.state.showPlaylistPicker = false;
                this.state.selectionMode = false;
                this.state.selectedSongs = [];
            } catch (e) {
                console.error('Failed to add songs to playlist:', e);
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'error', summary: 'Error', detail: 'Failed to add songs to playlist' });
            } finally {
                this.state.addingToPlaylist = false;
                this.state.addingAllToPlaylist = false;
            }
        },

        /**
         * Get all songs from the current view.
         * Used for adding all songs to a playlist (returns full song objects for metadata caching).
         */
        async _getAllSongsFromView() {
            const { viewMode, currentPath } = this.state;
            const allSongs = [];
            let cursor = null;

            if (viewMode === 'filepath') {
                // Fetch all songs by path
                do {
                    const result = await songsApi.byPath(currentPath, { cursor, limit: 500 });
                    const songs = result.items || result.songs || [];
                    allSongs.push(...songs);
                    cursor = result.nextCursor || null;
                } while (cursor);
            } else {
                // Fetch all songs by filter (translates [All Genres]/[All Artists] to null)
                const filters = this._apiFilters();
                do {
                    const result = await songsApi.byFilter({ ...filters, cursor, limit: 500 });
                    const songs = result.items || result.songs || [];
                    allSongs.push(...songs);
                    cursor = result.nextCursor || null;
                } while (cursor);
            }

            return allSongs.filter(s => s && s.uuid);
        },

        // Offline mode helpers
        isOfflineMode() {
            const { isOnline, workOfflineMode } = this.stores.offline;
            return !isOnline || workOfflineMode;
        },

        // Filter items for offline mode - only show downloaded content
        filterForOffline(items, level) {
            if (!this.isOfflineMode()) return items;

            const {
                offlineSongUuids, offlineArtists, offlineAlbums, offlineGenres,
                offlineCategories, offlinePaths,
                hasUnknownArtist, hasUnknownAlbum, hasUnknownGenre
            } = this.stores.offline;

            // Special aggregate categories
            const ALL_ITEMS = new Set(['[All Genres]', '[All Artists]', '[All Albums]']);
            const UNKNOWN_ITEMS = {
                '[Unknown Artist]': hasUnknownArtist,
                '[Unknown Genre]': hasUnknownGenre,
                '[Unknown Album]': hasUnknownAlbum
            };

            return items.filter(item => {
                if (!item) return false;

                // Songs - check if downloaded
                if (item.uuid) {
                    return offlineSongUuids.has(item.uuid);
                }

                const name = item.name || '';

                // Handle special "All" categories - show if we have ANY downloaded content
                if (ALL_ITEMS.has(name)) {
                    return offlineSongUuids.size > 0;
                }

                // Handle "Unknown" categories
                if (UNKNOWN_ITEMS[name] !== undefined) {
                    return UNKNOWN_ITEMS[name];
                }

                // Directories in filepath mode
                if (this.state.viewMode === 'filepath') {
                    const path = item.path || (this.state.currentPath === '/' ? '/' + name : this.state.currentPath + '/' + name);
                    return offlinePaths.has(path);
                }

                // Categories/Artists/Albums/Genres - check computed sets
                switch (level) {
                    case 'category':
                        return offlineCategories.has(name);
                    case 'genre':
                        return offlineGenres.has(name);
                    case 'artist':
                    case 'artists':
                        return offlineArtists.has(name);
                    case 'album':
                        return offlineAlbums.has(name);
                    default:
                        return true;
                }
            });
        },

        // Download selected songs
        async downloadSelected() {
            const songs = this.state.selectedSongs.filter(item => item && item.uuid);

            // Filter out already offline songs first
            const notOffline = songs.filter(s =>
                !this.stores.offline.offlineSongUuids.has(s.uuid)
            );

            if (notOffline.length === 0) {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'info', summary: 'Info', detail: 'All selected songs are already downloaded' });
                return;
            }

            // VFS items have type='file' instead of actual extension - fetch full metadata for those
            const needsMetadata = notOffline.filter(s => (!s.type || s.type === 'file') && s.uuid);
            let metadataMap = new Map();

            if (needsMetadata.length > 0) {
                try {
                    const uuids = needsMetadata.map(s => s.uuid);
                    const fullSongs = await songsApi.getBulk(uuids);
                    metadataMap = new Map(fullSongs.map(s => [s.uuid, s]));
                } catch (e) {
                    console.error('[Browse] Failed to fetch song metadata:', e);
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

            // Build downloadSource from current path (for filepath/VFS mode)
            const downloadSource = this.state.currentPath
                ? { type: 'browse', path: this.state.currentPath }
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
                await downloadSong(song, null, null, downloadSource);
            }

            setDownloadProgress(null);
            await computeOfflineFilterSets();
            this.state.isDownloadingSelection = false;
            this.state.selectionMode = false;
            this.state.selectedSongs = [];
        },

        // Download all songs in current view
        async handleDownloadAll() {
            this.state.isDownloadingAll = true;

            // Use folder download for filepath mode
            if (this.state.viewMode === 'filepath') {
                const folderName = this.state.currentPath === '/'
                    ? 'All Music'
                    : this.state.currentPath.split('/').filter(p => p).pop() || this.state.currentPath;

                await downloadFolder(this.state.currentPath, folderName);

                await computeOfflineFilterSets();
                this.state.isDownloadingAll = false;
                return;
            }

            // For hierarchy mode, use downloadByFilter to get ALL songs matching current filters
            const { currentCategory, currentGenre, currentArtist, currentAlbum } = this.state;
            const filters = {
                category: currentCategory,
                genre: currentGenre,
                artist: currentArtist,
                album: currentAlbum
            };

            // Build display name
            const displayName = currentAlbum || currentArtist || currentGenre || currentCategory || 'All Songs';

            await downloadByFilter(filters, displayName);

            await computeOfflineFilterSets();
            this.state.isDownloadingAll = false;
        },

        // Cancel the current download
        handleCancelDownload() {
            // Import cancel functions from offline-audio if needed
            if (this.state.viewMode === 'filepath') {
                // Cancel folder download
                import('../offline/offline-audio.js').then(mod => mod.cancelFolderDownload?.());
            } else {
                // Cancel filter download
                import('../offline/offline-audio.js').then(mod => mod.cancelFilterDownload?.());
            }
        },

        // Refresh folder by re-downloading
        async handleRefreshCurrentFolder() {
            const folder = this.getCurrentDownloadedFolder();
            if (!folder) return;

            // Re-download using same method as original
            this.state.isDownloadingAll = true;
            if (folder.type === 'path') {
                await downloadFolder(folder.path, folder.name);
            } else if (folder.type === 'filter') {
                await downloadByFilter(folder.filters, folder.name);
            }
            await computeOfflineFilterSets();
            this.state.isDownloadingAll = false;
        },

        // Get the current download folder/hierarchy record if it exists
        getCurrentDownloadedFolder() {
            const folders = this.stores.offline.offlineFolders;
            if (!folders || folders.length === 0) return null;

            if (this.state.viewMode === 'filepath') {
                const folderId = 'path:' + this.state.currentPath;
                return folders.find(f => f.id === folderId) || null;
            } else {
                const filters = {
                    category: this.state.currentCategory,
                    genre: this.state.currentGenre,
                    artist: this.state.currentArtist,
                    album: this.state.currentAlbum
                };
                const filterId = 'filter:' + JSON.stringify(filters);
                return folders.find(f => f.id === filterId) || null;
            }
        },

        handleDeleteCurrentFolder() {
            const folder = this.getCurrentDownloadedFolder();
            if (!folder) return;

            // Store folder info in state for the confirm handler
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

            this.state.isDeletingFolder = true;
            try {
                await deleteOfflineFolderDownload(folder.id);
                await computeOfflineFilterSets();
            } catch (e) {
                console.error('Failed to delete offline folder:', e);
            }
            this.state.isDeletingFolder = false;
            this.state.pendingDeleteFolder = null;
        },

        showConfirmDialog(title, message, action, confirmLabel = 'Confirm') {
            this.state.confirmDialog = { show: true, title, message, action, confirmLabel };
        },

        handleConfirmDialogConfirm() {
            const { action } = this.state.confirmDialog;
            this.state.confirmDialog = { show: false, title: '', message: '', action: null, confirmLabel: 'Confirm' };

            // Dispatch to appropriate method based on action
            if (action === 'deleteFolder') {
                this.doDeleteFolder();
            }
        },

        handleConfirmDialogCancel() {
            this.state.confirmDialog = { show: false, title: '', message: '', action: null, confirmLabel: 'Confirm' };
            this.state.pendingDeleteFolder = null;
        },

        exitSelectionMode() {
            this.state.selectionMode = false;
            this.state.selectedSongs = [];
        }
    },

    template() {
        const { viewMode, items, isLoading, breadcrumbs, level } = this.state;

        return html`
            <div class="browse-page">
                ${when(this.stores.offline.workOfflineMode || !this.stores.offline.isOnline, () => html`
                    <div class="offline-mode-banner">
                        📴 Offline Mode - Showing ${this.stores.offline.offlineSongUuids.size} downloaded songs
                    </div>
                `)}

                <!-- View Mode Tabs -->
                <div class="view-tabs">
                    <button class="tab ${viewMode === 'hierarchy' ? 'active' : ''}"
                            on-click="${() => this.handleViewModeChange('hierarchy')}">
                        📊 Categories
                    </button>
                    <button class="tab ${viewMode === 'genres' ? 'active' : ''}"
                            on-click="${() => this.handleViewModeChange('genres')}">
                        🎼 Genres
                    </button>
                    <button class="tab ${viewMode === 'artists' ? 'active' : ''}"
                            on-click="${() => this.handleViewModeChange('artists')}">
                        🎤 Artists
                    </button>
                    <button class="tab ${viewMode === 'filepath' ? 'active' : ''}"
                            on-click="${() => this.handleViewModeChange('filepath')}">
                        📁 Files
                    </button>
                </div>

                <!-- Breadcrumbs -->
                <nav class="breadcrumbs">
                    ${each(breadcrumbs, (crumb, index) => html`
                        <span class="crumb-item">
                            ${index > 0 ? html`<span class="crumb-sep">/</span>` : ''}
                            <button class="crumb-btn" on-click="${() => this.handleBreadcrumbClick(crumb)}">
                                ${crumb.label}
                            </button>
                        </span>
                    `)}
                </nav>

                <!-- Actions (available at all levels) -->
                ${when(items.length > 0, html`
                    <div class="actions">
                        <cl-button severity="primary" icon="▶️" on-click="handlePlayAll" loading="${isLoading}">
                            Play All
                        </cl-button>
                        <cl-button severity="secondary" icon="🔀" on-click="handleShuffleAll" loading="${isLoading}">
                            Shuffle
                        </cl-button>
                        <cl-button severity="secondary" icon="➕" on-click="handleAddAllToQueue" loading="${isLoading}">
                            Add All
                        </cl-button>
                        <cl-button severity="secondary" icon="📻" on-click="handleStartRadio">
                            Radio
                        </cl-button>
                        <cl-button severity="secondary" icon="📋" on-click="handleAddAllToPlaylist" loading="${isLoading}">
                            Playlist
                        </cl-button>
                        ${when(this.getCurrentDownloadedFolder(), () => {
                            const folder = this.getCurrentDownloadedFolder();
                            return html`
                                <cl-button severity="success" size="small" disabled>
                                    ✓ Offline (${formatBytes(folder.totalSize)})
                                </cl-button>
                                <cl-button severity="secondary" size="small" on-click="handleRefreshCurrentFolder"
                                           disabled="${!this.stores.offline.isOnline}" title="Sync - download new songs">🔄</cl-button>
                                <cl-button severity="danger" size="small" on-click="handleDeleteCurrentFolder"
                                           disabled="${this.state.isDeletingFolder}" title="Remove offline">🗑</cl-button>
                            `;
                        }, () => html`
                            ${when(this.stores.offline.downloadProgress, () => {
                                const progress = this.stores.offline.downloadProgress;
                                const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
                                return html`
                                    <div class="download-btn-progress">
                                        <div class="progress-bar-inline">
                                            <div class="progress-fill" style="width: ${percent}%"></div>
                                        </div>
                                        <span class="progress-text">${progress.current}/${progress.total}</span>
                                        <button class="cancel-btn" on-click="handleCancelDownload" title="Cancel">✕</button>
                                    </div>
                                `;
                            }, () => when(this.stores.offline.isOnline, () => html`
                                <cl-button severity="secondary" icon="⬇" on-click="handleDownloadAll"
                                           loading="${this.state.isDownloadingAll}">
                                    Download
                                </cl-button>
                            `))}
                        `)}
                    </div>
                `)}

                <!-- Quick Filter -->
                <div class="filter-bar">
                    <div class="filter-input-wrapper">
                        <input type="text"
                               class="filter-input"
                               placeholder="Filter..."
                               value="${this.state.filterText}"
                               on-input="handleFilterChange">
                        ${when(this.state.filterLoading, html`
                            <cl-spinner size="small" class="filter-spinner"></cl-spinner>
                        `, html`
                            ${when(this.state.filterText, html`
                                <button class="filter-clear" on-click="handleClearFilter" title="Clear filter">✕</button>
                            `)}
                        `)}
                    </div>
                    <button class="sort-toggle ${this.state.sortBy === 'count' ? 'active' : ''}"
                            on-click="toggleSort"
                            title="${this.state.sortBy === 'name' ? 'Sort by song count' : 'Sort alphabetically'}">
                        ${this.state.sortBy === 'name' ? 'A-Z' : '#'}
                    </button>
                    <button class="select-toggle ${this.state.selectionMode ? 'active' : ''}"
                            on-click="toggleSelectionMode"
                            title="${this.state.selectionMode ? 'Exit selection mode' : 'Select songs'}">
                        ☑
                    </button>
                </div>

                <!-- Content Area - stable scroll container -->
                <div class="browse-content">
                    ${when(isLoading && items.length === 0, html`
                        <div class="loading-spinner">
                            <cl-spinner></cl-spinner>
                            <p>Loading...</p>
                        </div>
                    `, html`
                        ${when(this.state.totalCount === 0 && items.length === 0, html`
                            <div class="empty">
                                <p>No items found</p>
                            </div>
                        `, () => {
                            const filterText = this.state.filterText;
                            const isOfflineMode = this.isOfflineMode();
                            // Use windowed rendering for large lists (sorting is done on backend)
                            // Disable windowed mode when filtering or in offline mode (filtered list breaks positioning)
                            const itemCount = this.state.totalCount || items.length;
                            const useWindowed = !filterText && !isOfflineMode && itemCount > 50;

                            // For windowed mode
                            if (useWindowed) {
                                const itemHeight = 52;
                                // NOTE: We inline the slice directly in memoEach to allow
                                // the optimizer to correctly track dependencies.
                                // Using a local variable would break reactivity after optimization.

                                return html`
                                    <div class="items-container" ref="itemsContainer"
                                         style="height: ${itemCount * itemHeight}px; position: relative;">
                                        <div class="items-list" style="transform: translateY(${this.state.visibleStart * itemHeight}px);">
                                            ${memoEach(this.state.items.slice(this.state.visibleStart, this.state.visibleEnd), (item, idx) => {
                                                if (!item) {
                                                    return html`
                                                        <div class="item loading-placeholder">
                                                            <span class="item-icon">📁</span>
                                                            <div class="item-info">
                                                                <div class="item-name">Loading...</div>
                                                            </div>
                                                        </div>
                                                    `;
                                                }
                                                return html`
                                                    <div class="item ${this.state.selectionMode && item.uuid ? 'selectable' : ''} ${this.isSelected(item) ? 'selected' : ''}"
                                                         on-click="${() => this.state.selectionMode && item.uuid ? this.toggleSelection(item, event) : this.handleItemClick(item)}"
                                                         on-contextmenu="${(e) => this.handleItemContextMenu(item, e)}"
                                                         on-touchstart="${(e) => this.handleTouchStart(item, e)}"
                                                         on-touchmove="handleTouchMove"
                                                         on-touchend="handleTouchEnd">
                                                        ${when(this.state.selectionMode && item.uuid, () => html`
                                                            <input type="checkbox"
                                                                   class="select-checkbox"
                                                                   checked="${this.isSelected(item)}"
                                                                   on-click="${(e) => this.toggleSelection(item, e)}">
                                                        `)}
                                                        <span class="item-icon">${this.getItemIcon(item)}</span>
                                                        <div class="item-info">
                                                            <div class="item-name">${item.uuid && item.track_number ? html`<span class="track-number">${String(item.track_number).padStart(2, '0')}</span>` : ''}${this.getDisplayTitle(item)}</div>
                                                            <div class="item-subtitle">${this.getItemSubtitle(item)}</div>
                                                        </div>
                                                        ${when(item && item.uuid, () => html`
                                                            <button class="item-action"
                                                                    on-click="${(e) => this.handleAddToQueue(item, e)}"
                                                                    title="Add to Queue">
                                                                +
                                                            </button>
                                                        `, () => html`
                                                            <button class="item-action"
                                                                    on-click="${(e) => this.handleAddFolderToQueue(item, e)}"
                                                                    title="Add All to Queue">
                                                                +
                                                            </button>
                                                        `)}
                                                    </div>
                                                `;
                                            }, (item, idx) => item?.uuid ?? item?.path ?? item?.name ?? `loading-${idx}`, { trustKey: true })}
                                        </div>
                                    </div>
                                `;
                            }

                            // For hierarchy mode or when filter is active
                            const filteredItems = this.getFilteredItems();
                            return html`
                            ${when(filteredItems.length === 0 && filterText, html`
                                <div class="empty">
                                    <p>No matches for "${filterText}"</p>
                                </div>
                            `, html`
                            <div class="items-list">
                                ${each(filteredItems, item => html`
                                    <div class="item ${this.state.selectionMode && item.uuid ? 'selectable' : ''} ${this.isSelected(item) ? 'selected' : ''}"
                                         on-click="${() => this.state.selectionMode && item.uuid ? this.toggleSelection(item, event) : this.handleItemClick(item)}"
                                         on-contextmenu="${(e) => this.handleItemContextMenu(item, e)}"
                                         on-touchstart="${(e) => this.handleTouchStart(item, e)}"
                                         on-touchmove="handleTouchMove"
                                         on-touchend="handleTouchEnd">
                                        ${when(this.state.selectionMode && item.uuid, () => html`
                                            <input type="checkbox"
                                                   class="select-checkbox"
                                                   checked="${this.isSelected(item)}"
                                                   on-click="${(e) => this.toggleSelection(item, e)}">
                                        `)}
                                        <span class="item-icon">${this.getItemIcon(item)}</span>
                                        <div class="item-info">
                                            <div class="item-name">${item.uuid && item.track_number ? html`<span class="track-number">${String(item.track_number).padStart(2, '0')}</span>` : ''}${this.getDisplayTitle(item)}</div>
                                            <div class="item-subtitle">${this.getItemSubtitle(item)}</div>
                                        </div>
                                        ${when(level === 'songs' || item.uuid, () => html`
                                            <button class="item-action"
                                                    on-click="${(e) => this.handleAddToQueue(item, e)}"
                                                    title="Add to Queue">
                                                +
                                            </button>
                                        `, () => html`
                                            <button class="item-action"
                                                    on-click="${(e) => this.handleAddFolderToQueue(item, e)}"
                                                    title="Add All to Queue">
                                                +
                                            </button>
                                        `)}
                                    </div>
                                `, item => item.uuid || `${level}-${item.type}-${item.name}`)}
                            </div>

                            ${when(this.state.hasMore && !filterText, html`
                                <div class="load-more-sentinel" ref="sentinel">
                                    ${when(isLoading, html`
                                        <cl-spinner size="small"></cl-spinner>
                                    `)}
                                </div>
                            `)}
                            `)}
                        `})}
                    `)}
                </div>

                <!-- Selection Action Bar -->
                ${when(this.state.selectionMode && this.state.selectedSongs.length > 0, () => html`
                    <div class="selection-bar">
                        <span class="selection-count">${this.state.selectedSongs.length}</span>
                        <div class="selection-actions">
                            <button class="selection-btn" on-click="selectAll">All</button>
                            <button class="selection-btn" on-click="clearSelection">None</button>
                            <button class="selection-btn" on-click="handleAddSelectedToQueue">Queue</button>
                            <button class="selection-btn" on-click="downloadSelected"
                                    disabled="${this.state.isDownloadingSelection}">
                                ${this.state.isDownloadingSelection ? '...' : 'DL'}
                            </button>
                            <button class="selection-btn primary" on-click="openPlaylistPicker">
                                Playlist
                            </button>
                        </div>
                    </div>
                `)}

                <!-- Playlist Picker Dialog -->
                ${when(this.state.showPlaylistPicker, () => html`
                    <cl-dialog visible="true" header="Add to Playlist"
                        on-change="${(e, val) => { if (!val) this.closePlaylistPicker(); }}">
                        <div class="playlist-picker">
                            ${when(this.state.userPlaylists.length === 0, html`
                                <p class="empty-playlists">No playlists found. Create one first!</p>
                            `, () => html`
                                <div class="playlist-list">
                                    ${each(this.state.userPlaylists, playlist => html`
                                        <button class="playlist-option"
                                                on-click="${() => this.addSelectedToPlaylist(playlist.id)}"
                                                disabled="${this.state.addingToPlaylist}">
                                            <span class="playlist-icon">📋</span>
                                            <span class="playlist-name">${playlist.name}</span>
                                            <span class="playlist-count">${playlist.song_count} songs</span>
                                        </button>
                                    `)}
                                </div>
                            `)}
                        </div>
                        <div slot="footer">
                            <cl-button severity="secondary" on-click="closePlaylistPicker">Cancel</cl-button>
                        </div>
                    </cl-dialog>
                `)}

                <scroll-to-top></scroll-to-top>

                ${when(this.state.confirmDialog.show, () => html`
                    <cl-dialog visible="true" header="${this.state.confirmDialog.title}" on-close="handleConfirmDialogCancel">
                        <p>${this.state.confirmDialog.message}</p>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                            <cl-button severity="danger" on-click="handleConfirmDialogConfirm">${this.state.confirmDialog.confirmLabel}</cl-button>
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

        .browse-page {
            padding: 1rem;
            max-width: 800px;
            margin: 0 auto;
        }

        .browse-content {
            position: relative;
        }

        .offline-mode-banner {
            background: var(--warning-100, #422006);
            color: var(--warning-500, #fcd34d);
            padding: 0.5rem 1rem;
            margin-bottom: 1rem;
            text-align: center;
            font-size: 0.875rem;
            border-radius: 8px;
        }

        /* View Tabs */
        .view-tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .tab {
            flex: 1 1 auto;
            min-width: 0;
            padding: 0.5rem 0.75rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.8125rem;
            color: var(--text-primary, #e0e0e0);
            transition: background 0.2s;
            white-space: nowrap;
        }

        .tab:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .tab.active {
            background: var(--selected-bg, #1e3a5f);
            border-color: var(--primary-400, #42a5f5);
            color: var(--primary-300, #64b5f6);
        }

        /* Breadcrumbs */
        .breadcrumbs {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.25rem;
            margin-bottom: 1rem;
            padding: 0.5rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
        }

        .crumb-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--primary-400, #42a5f5);
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
        }

        .crumb-btn:hover {
            background: var(--surface-200, #2d2d2d);
        }

        .crumb-sep {
            color: var(--text-muted, #707070);
            margin: 0 0.25rem;
        }

        /* Actions */
        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .actions cl-button {
            /* Fixed height to prevent jumping when loading spinner appears */
            height: 38px;
        }

        /* Inline Download Progress (in actions bar) */
        .download-btn-progress {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            min-width: 120px;
            padding: 0 0.5rem;
        }

        .progress-bar-inline {
            flex: 1;
            height: 4px;
            background: var(--surface-300, #404040);
            border-radius: 2px;
            overflow: hidden;
        }

        .progress-bar-inline .progress-fill {
            height: 100%;
            background: var(--primary-500, #2196f3);
            border-radius: 2px;
            transition: width 0.2s;
        }

        .download-btn-progress .progress-text {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
        }

        .download-btn-progress .cancel-btn {
            padding: 0.25rem;
            border: none;
            background: transparent;
            color: var(--text-muted, #707070);
            cursor: pointer;
            font-size: 0.875rem;
        }

        .download-btn-progress .cancel-btn:hover {
            color: var(--danger-500, #ef4444);
        }

        /* Offline Badge */
        .offline-badge {
            color: var(--success-500, #22c55e);
            font-size: 0.8rem;
            white-space: nowrap;
        }

        /* Filter Bar */
        .filter-bar {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .filter-input-wrapper {
            flex: 1;
            position: relative;
        }

        .filter-input {
            width: 100%;
            padding: 0.5rem 2rem 0.5rem 0.75rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
            box-sizing: border-box;
        }

        .filter-input:focus {
            outline: none;
            border-color: var(--primary-500, #2196f3);
        }

        .filter-input::placeholder {
            color: var(--text-muted, #707070);
        }

        .filter-clear {
            position: absolute;
            right: 0.5rem;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-muted, #707070);
            cursor: pointer;
            font-size: 0.875rem;
            padding: 0.25rem;
        }

        .filter-clear:hover {
            color: var(--text-primary, #e0e0e0);
        }

        .filter-spinner {
            position: absolute;
            right: 0.5rem;
            top: 50%;
            transform: translateY(-50%);
        }

        /* Loading */
        .loading-spinner {
            text-align: center;
            padding: 3rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Empty */
        .empty {
            text-align: center;
            padding: 3rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Items Container - spacer for windowed rendering */
        .items-container {
            border-radius: 8px;
            background: var(--surface-50, #1a1a1a);
            /* CSS containment hints for scroll performance */
            contain: layout style;
        }

        .items-list {
            display: flex;
            flex-direction: column;
            /* Match componentlib virtual-list positioning */
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            /* Hint browser this element transforms during scroll */
            will-change: transform;
        }

        .item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0 1rem;
            height: 52px;  /* Must match itemHeight in JS */
            box-sizing: border-box;
            background: var(--surface-50, #1a1a1a);
            cursor: pointer;
            transition: background 0.2s;
            /* Strict containment for individual items */
            contain: layout style;
        }

        .item.loading-placeholder {
            opacity: 0.5;
        }

        .item.loading-placeholder .item-name {
            color: var(--text-muted, #707070);
            font-style: italic;
        }

        .item:hover {
            background: var(--surface-100, #242424);
        }

        .item-icon {
            font-size: 1.5rem;
            flex-shrink: 0;
        }

        .item-info {
            flex: 1;
            overflow: hidden;
        }

        .item-name {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .track-number {
            color: var(--text-muted, #707070);
            font-size: 0.85em;
            margin-right: 0.5em;
            font-weight: 400;
        }

        .item-subtitle {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .item-action {
            background: var(--surface-200, #2d2d2d);
            border: none;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            cursor: pointer;
            font-size: 1.25rem;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.2s, background 0.2s;
            color: var(--text-primary, #e0e0e0);
        }

        .item:hover .item-action {
            opacity: 1;
        }

        .item-action:hover {
            background: var(--selected-bg, #1e3a5f);
        }

        /* Infinite scroll sentinel */
        .load-more-sentinel {
            text-align: center;
            padding: 1rem;
            min-height: 50px;
        }

        /* Sort & Selection Toggles */
        .sort-toggle,
        .select-toggle {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            padding: 0.375rem 0.625rem;
            cursor: pointer;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
            font-weight: 500;
            transition: all 0.15s;
        }

        .sort-toggle:hover,
        .select-toggle:hover {
            background: var(--surface-300, #404040);
            color: var(--text-primary, #e0e0e0);
        }

        .sort-toggle.active,
        .select-toggle.active {
            background: var(--primary-600, #0052a3);
            border-color: var(--primary-500, #0066cc);
            color: white;
        }

        .select-checkbox {
            width: 18px;
            height: 18px;
            cursor: pointer;
            accent-color: var(--primary-500, #0066cc);
        }

        .item.selectable {
            cursor: pointer;
        }

        .item.selected {
            background: var(--selected-bg, #1e3a5f);
        }

        .selection-bar {
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            gap: 1rem;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            z-index: 100;
        }

        .selection-count {
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
        }

        .selection-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            justify-content: center;
        }

        .selection-btn {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            padding: 0.375rem 0.75rem;
            cursor: pointer;
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
            transition: all 0.15s;
            white-space: nowrap;
        }

        .selection-btn:hover {
            background: var(--surface-300, #404040);
        }

        .selection-btn.primary {
            background: var(--primary-500, #0066cc);
            border-color: var(--primary-500, #0066cc);
            color: white;
        }

        .selection-btn.primary:hover {
            background: var(--primary-400, #3399ff);
        }

        /* Playlist Picker */
        .playlist-picker {
            min-width: 280px;
        }

        .empty-playlists {
            text-align: center;
            color: var(--text-secondary, #a0a0a0);
            padding: 1rem;
        }

        .playlist-list {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
            max-height: 300px;
            overflow-y: auto;
        }

        .playlist-option {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.15s;
            text-align: left;
            color: var(--text-primary, #e0e0e0);
        }

        .playlist-option:hover:not(:disabled) {
            background: var(--surface-200, #2d2d2d);
            border-color: var(--primary-500, #0066cc);
        }

        .playlist-option:disabled {
            opacity: 0.5;
            cursor: wait;
        }

        .playlist-option .playlist-icon {
            font-size: 1.25rem;
        }

        .playlist-option .playlist-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .playlist-option .playlist-count {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        /* Mobile */
        @media (max-width: 767px) {
            .item {
                user-select: none;
                -webkit-user-select: none;
            }

            .browse-page {
                padding: 0.5rem;
            }

            .item-action {
                opacity: 1;
            }

            .move-btn {
                display: none;
            }

            .selection-bar {
                left: 0.5rem;
                right: 0.5rem;
                transform: none;
                bottom: 70px;
            }

            /* Selection mode on mobile - hide checkbox but show selection via border */
            .select-checkbox {
                display: none;
            }

            .item.selectable {
                border-left: 3px solid transparent;
            }

            .item.selected {
                border-left: 3px solid var(--primary-500, #2196f3);
                background: var(--selected-bg, #1e3a5f);
            }
        }
    `
});

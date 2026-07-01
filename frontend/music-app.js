/**
 * Music Player Application
 *
 * Main application shell with responsive layout and routing.
 */

import { defineComponent, html, when, each } from './lib/framework.js';
import { enableRouting } from './lib/router.js';
import { auth, playlists as playlistsApi } from './offline/offline-api.js';
import { player, playerStore } from './stores/player-store.js';
import { initializeOfflineStore } from './offline/offline-store.js';
import './componentlib/layout/shell.js';
import './componentlib/overlay/toast.js';

// Import pages (lazy loaded)
const loadNowPlaying = () => import('./pages/now-playing.js');
const loadVisualizer = () => import('./pages/visualizer-page.js');
const loadBrowse = () => import('./pages/browse-page.js');
const loadSearch = () => import('./pages/quick-search-page.js');
const loadPlaylists = () => import('./pages/playlists-page.js');
const loadRadio = () => import('./pages/radio-page.js');
const loadHistory = () => import('./pages/history-page.js');
const loadSettings = () => import('./pages/settings-page.js');
const loadEQ = () => import('./pages/eq-page.js');
const loadLoopSong = () => import('./pages/loopsong-page.js');
const loadLogin = () => import('./pages/login-page.js');
const loadAdmin = () => import('./pages/admin-page.js');
const loadNotFound = () => import('./pages/not-found-page.js');

// Import mini player
import './components/mini-player.js';

export default defineComponent('music-app', {
    stores: { player: playerStore },

    data() {
        return {
            user: null,
            authenticated: false,
            isAdmin: false,
            menuItems: [
                {
                    key: 'now-playing',
                    label: 'Now Playing',
                    icon: '▶️',
                    route: '/'
                },
                {
                    key: 'visualizer',
                    label: 'Visualizer',
                    icon: '🌈',
                    route: '/visualizer/'
                },
                {
                    key: 'browse',
                    label: 'Browse',
                    icon: '📁',
                    route: '/browse/'
                },
                {
                    key: 'search',
                    label: 'Search',
                    icon: '🔍',
                    route: '/search/'
                },
                {
                    key: 'radio',
                    label: 'Radio',
                    icon: '📻',
                    route: '/radio/'
                },
                {
                    key: 'playlists',
                    label: 'Playlists',
                    icon: '📋',
                    route: '/playlists/'
                },
                {
                    key: 'history',
                    label: 'History',
                    icon: '🕐',
                    route: '/history/'
                },
                {
                    key: 'eq',
                    label: 'Equalizer',
                    icon: '🎛️',
                    route: '/eq/'
                },
                {
                    key: 'settings',
                    label: 'Settings',
                    icon: '⚙️',
                    route: '/settings/'
                }
            ],
            activeItem: 'now-playing'
        };
    },

    async mounted() {
        // Always use dark mode for music app
        document.body.classList.add('dark');

        // Initialize offline store first (loads cached favorites, etc.)
        // This must complete before other components try to check favorites.
        // It reads local IndexedDB, so it's fast and safe to await.
        try {
            await initializeOfflineStore();
        } catch (e) {
            console.error('Failed to initialize offline store:', e);
        }

        // Setup routing immediately so a page always renders. This must NOT be
        // gated behind auth.checkUser() (a network call with no timeout) - a hung
        // connection would otherwise leave the outlet permanently blank.
        this._setupRouting();

        // Set initial active item based on hash
        this._updateActiveFromHash();
        window.addEventListener('hashchange', () => this._updateActiveFromHash());

        // Check authentication AFTER routing is live. This only populates the
        // user badge/admin menu and warms the playlist/favorites cache - pages
        // don't need it to render.
        try {
            const result = await auth.checkUser();
            if (!this._isMounted) return;
            this.state.authenticated = result.authenticated;
            this.state.user = result.user;
            // capabilities can be 'admin', 'admin,user', or array ['admin', 'user']
            const caps = result.capabilities;
            this.state.isAdmin = Array.isArray(caps)
                ? caps.includes('admin')
                : (caps && caps.includes('admin'));

            // If setup is required (no users exist), redirect to login/setup
            if (result.setupRequired) {
                window.location.hash = '/login/';
            }

            // Add admin menu item if user is admin (insert before Settings)
            if (this.state.isAdmin) {
                const items = [...this.state.menuItems];
                const settingsIndex = items.findIndex(i => i.key === 'settings');
                items.splice(settingsIndex, 0, {
                    key: 'admin',
                    label: 'Admin',
                    icon: '🔧',
                    route: '/admin/'
                });
                this.state.menuItems = items;
            }

            // If authenticated, cache favorites by loading playlists
            // This ensures favorites are available for offline use
            if (result.authenticated) {
                playlistsApi.list().catch(e => {
                    // Ignore errors - will use cached data if available
                    console.warn('Failed to refresh playlists cache:', e);
                });
            }
        } catch (e) {
            console.error('Failed to check auth:', e);
        }
    },

    methods: {
        _setupRouting() {
            const outlet = this.querySelector('router-outlet');
            if (!outlet) {
                console.error('music-app: <router-outlet> not found - routing not initialized, app will render blank. Check the template markup.');
                return;
            }

            enableRouting(outlet, {
                // Main routes
                '/': {
                    component: 'now-playing-page',
                    load: loadNowPlaying
                },
                '/visualizer/': {
                    component: 'visualizer-page',
                    load: loadVisualizer
                },
                '/browse/': {
                    component: 'browse-page',
                    load: loadBrowse
                },
                // Specific route MUST be registered before the greedy wildcard,
                // otherwise the insertion-order pattern loop in _findRoute matches
                // '/browse/:path*/' first and this route becomes unreachable.
                '/browse/path/:encodedPath/': {
                    component: 'browse-page',
                    load: loadBrowse
                },
                '/browse/:path*/': {
                    component: 'browse-page',
                    load: loadBrowse
                },
                '/search/': {
                    component: 'quick-search-page',
                    load: loadSearch
                },
                '/radio/': {
                    component: 'radio-page',
                    load: loadRadio
                },
                '/playlists/': {
                    component: 'playlists-page',
                    load: loadPlaylists
                },
                '/playlists/:id/': {
                    component: 'playlists-page',
                    load: loadPlaylists
                },
                '/share/:token/': {
                    component: 'playlists-page',
                    load: loadPlaylists
                },
                '/history/': {
                    component: 'history-page',
                    load: loadHistory
                },
                '/settings/': {
                    component: 'settings-page',
                    load: loadSettings
                },
                '/eq/': {
                    component: 'eq-page',
                    load: loadEQ
                },
                '/login/': {
                    component: 'login-page',
                    load: loadLogin
                },
                '/admin/': {
                    component: 'admin-page',
                    load: loadAdmin
                },
                '/loopsong/:uuid/': {
                    component: 'loopsong-page',
                    load: loadLoopSong
                },

                // Backward-compatibility redirects from /music/* to /*
                '/music/': { redirect: '/' },
                '/music/visualizer/': { redirect: '/visualizer/' },
                '/music/browse/': { redirect: '/browse/' },
                // Specific redirect before the greedy wildcard (same reason as above).
                '/music/browse/path/:encodedPath/': { redirect: '/browse/path/$1/' },
                '/music/browse/:path*/': { redirect: '/browse/$1/' },
                '/music/search/': { redirect: '/search/' },
                '/music/radio/': { redirect: '/radio/' },
                '/music/playlists/': { redirect: '/playlists/' },
                '/music/playlists/:id/': { redirect: '/playlists/$1/' },
                '/music/share/:token/': { redirect: '/share/$1/' },
                '/music/history/': { redirect: '/history/' },
                '/music/settings/': { redirect: '/settings/' },
                '/music/eq/': { redirect: '/eq/' },
                '/music/loopsong/:uuid/': { redirect: '/loopsong/$1/' },

                // Catch-all: unmatched routes fall back to this via _findRoute
                // instead of silently rendering the root (Now Playing) page.
                '/404': {
                    component: 'not-found-page',
                    load: loadNotFound
                }
            });
        },

        _updateActiveFromHash() {
            const hash = window.location.hash || '#/';
            // Sort by route length descending to match most specific route first
            const sortedItems = [...this.state.menuItems].sort(
                (a, b) => b.route.length - a.route.length
            );
            for (const item of sortedItems) {
                if (hash.startsWith('#' + item.route)) {
                    this.state.activeItem = item.key;
                    break;
                }
            }
        },

        handleActiveItemChange(e) {
            const key = e.detail?.value;
            if (!key) return;

            // Find the menu item by key and navigate to its route
            const item = this.state.menuItems.find(m => m.key === key);
            if (item?.route) {
                window.location.hash = item.route;
                this.state.activeItem = key;
            }
        },

        formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    },

    template() {
        const currentSong = this.stores.player.currentSong;

        return html`
            <cl-shell
                title="Music"
                subtitle="${currentSong ? currentSong.title : ''}"
                menuItems="${this.state.menuItems}"
                activeItem="${this.state.activeItem}"
                sidebarWidth="240px"
                on-change="handleActiveItemChange">

                <div slot="topbar" class="topbar-content">
                    ${when(this.state.authenticated,
                        html`<span class="user-badge">${this.state.user}</span>`,
                        html`<a href="#/login/" class="login-link">Login</a>`
                    )}
                </div>

                <div slot="sidebarFooter">
                    <mini-player></mini-player>
                </div>

                <div class="router-wrapper">
                    <router-outlet></router-outlet>
                </div>
            </cl-shell>

            <cl-toast position="top-right"></cl-toast>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            height: 100%;
            width: 100%;
            background: var(--shell-bg, #0d0d0d);
            color: var(--text-primary, #e0e0e0);
        }

        .topbar-content {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .user-badge {
            background: var(--surface-300, #404040);
            color: var(--text-primary, #e0e0e0);
            padding: 0.25rem 0.75rem;
            border-radius: 1rem;
            font-size: 0.875rem;
        }

        .login-link {
            color: var(--primary-400, #42a5f5);
            text-decoration: none;
        }

        .login-link:hover {
            text-decoration: underline;
        }

        .sidebar-footer {
            padding: 0.5rem;
            border-top: 1px solid var(--surface-300, #404040);
            background: var(--sidebar-bg, #1a1a1a);
        }

        .router-wrapper {
            height: 100%;
            overflow: auto;
            background: var(--shell-bg, #0d0d0d);
        }

        @media (max-width: 767px) {
            .sidebar-footer {
                padding: 0.25rem;
            }
        }
    `
});

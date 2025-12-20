/**
 * Song Context Menu Component
 *
 * Right-click / long-press context menu for songs.
 * Provides quick actions: Add to Queue, Play Next, Add to Playlist.
 * Also provides navigation: Go to Album, Artist, Folder, Category.
 */

import { defineComponent, html, when, each } from '../lib/framework.js';
import { playlists as playlistsApi, songs as songsApi, isFavorite, getFavoritesPlaylistId } from '../offline/offline-api.js';
import { player } from '../stores/player-store.js';
import offlineStore, { computeOfflineFilterSets } from '../offline/offline-store.js';
import { downloadSong, deleteSong, canCacheOffline } from '../offline/offline-audio.js';
import { showSongInfoModal } from './song-info-modal.js';

// Singleton instance for the context menu
let menuInstance = null;

export function showSongContextMenu(item, x, y, options = {}) {
    if (!menuInstance) {
        menuInstance = document.createElement('song-context-menu');
        document.body.appendChild(menuInstance);
    }
    menuInstance.show(item, x, y, options);
}

export function hideSongContextMenu() {
    if (menuInstance) {
        menuInstance.hide();
    }
}

// Navigation helper functions (exported for use by other components)
export function navigateToArtist(artist) {
    if (!artist) return;
    window.location.hash = `/browse/?artist=${encodeURIComponent(artist)}`;
}

export function navigateToAlbum(artist, album) {
    if (!album) return;
    let query = `album=${encodeURIComponent(album)}`;
    if (artist) query = `artist=${encodeURIComponent(artist)}&${query}`;
    window.location.hash = `/browse/?${query}`;
}

export function navigateToCategory(category) {
    if (!category) return;
    window.location.hash = `/browse/?category=${encodeURIComponent(category)}`;
}

export function navigateToGenre(genre) {
    if (!genre) return;
    // Navigate to genre without category filter - show all songs in genre across all categories
    window.location.hash = `/browse/?genre=${encodeURIComponent(genre)}`;
}

export function navigateToFolder(song) {
    const filePath = song.virtual_file || song.file;
    if (!filePath) return;
    const path = filePath.split('/').slice(0, -1).join('/') || '/';
    window.location.hash = `/browse/path/${encodeURIComponent(path.replace(/^\//, ''))}/`;
}

export default defineComponent('song-context-menu', {
    stores: { offline: offlineStore },

    data() {
        return {
            isVisible: false,
            song: null,
            x: 0,
            y: 0,
            playlists: [],
            playlistsLoaded: false,
            showPlaylistSubmenu: false,
            submenuX: 0,
            submenuY: 0,
            isDownloading: false,
            // Folder support
            isFolder: false,
            folderPath: null,
            folderFilters: null,
            isAddingToQueue: false
        };
    },

    mounted() {
        // Close on click outside - use capture to intercept before other handlers
        this._handleOutsideClick = (e) => {
            if (this.state.isVisible && !this.contains(e.target)) {
                // Stop the click from reaching other elements to prevent unintended actions
                e.stopPropagation();
                this.hide();
            }
        };
        document.addEventListener('click', this._handleOutsideClick, true);
        document.addEventListener('contextmenu', this._handleOutsideClick, true);

        // Close on escape
        this._handleEscape = (e) => {
            if (e.key === 'Escape' && this.state.isVisible) {
                this.hide();
            }
        };
        document.addEventListener('keydown', this._handleEscape);

        // Close on scroll (but not when scrolling inside the menu)
        this._handleScroll = (e) => {
            if (this.state.isVisible && !this.contains(e.target)) {
                this.hide();
            }
        };
        window.addEventListener('scroll', this._handleScroll, true);
    },

    unmounted() {
        document.removeEventListener('click', this._handleOutsideClick, true);
        document.removeEventListener('contextmenu', this._handleOutsideClick, true);
        document.removeEventListener('keydown', this._handleEscape);
        window.removeEventListener('scroll', this._handleScroll, true);
    },

    methods: {
        show(item, x, y, options = {}) {
            this.state.song = item;
            this.state.showPlaylistSubmenu = false;

            // Folder support
            this.state.isFolder = options.isFolder || false;
            this.state.folderPath = options.path || null;
            this.state.folderFilters = options.filters || null;

            // Set initial position
            this.state.x = x;
            this.state.y = y;
            this.state.isVisible = true;

            // Load playlists if not already loaded
            if (!this.state.playlistsLoaded) {
                this.loadPlaylists();
            }

            // Adjust position after render to stay within viewport
            requestAnimationFrame(() => {
                const menu = this.querySelector('.context-menu');
                if (!menu) return;

                const rect = menu.getBoundingClientRect();
                const padding = 8;

                let adjustedX = x;
                let adjustedY = y;

                // Adjust horizontal position
                if (x + rect.width > window.innerWidth - padding) {
                    adjustedX = window.innerWidth - rect.width - padding;
                }

                // Adjust vertical position - prefer showing above if near bottom
                if (y + rect.height > window.innerHeight - padding) {
                    // Try positioning above the click point
                    const aboveY = y - rect.height;
                    if (aboveY >= padding) {
                        adjustedY = aboveY;
                    } else {
                        // Not enough room above, just clamp to bottom
                        adjustedY = window.innerHeight - rect.height - padding;
                    }
                }

                this.state.x = Math.max(padding, adjustedX);
                this.state.y = Math.max(padding, adjustedY);
            });
        },

        hide() {
            this.state.isVisible = false;
            this.state.showPlaylistSubmenu = false;
        },

        async loadPlaylists() {
            try {
                const result = await playlistsApi.list();
                this.state.playlists = result.items || [];
                this.state.playlistsLoaded = true;
            } catch (e) {
                console.error('Failed to load playlists:', e);
            }
        },

        handleAddToQueue() {
            if (this.state.song) {
                player.addToQueue(this.state.song, false);
            }
            this.hide();
        },

        handlePlayNext() {
            if (this.state.song) {
                // Add to queue at current position + 1
                player.addToQueue(this.state.song, false);
                // TODO: Implement "play next" positioning in player-store
            }
            this.hide();
        },

        handlePlayNow() {
            if (this.state.song) {
                player.addToQueue(this.state.song, true);
            }
            this.hide();
        },

        togglePlaylistSubmenu(e) {
            e.stopPropagation();

            if (this.state.showPlaylistSubmenu) {
                this.state.showPlaylistSubmenu = false;
                return;
            }

            // Get the menu item position to anchor the submenu
            const menuItem = this.refs.playlistMenuItem;
            if (!menuItem) return;

            const itemRect = menuItem.getBoundingClientRect();
            const padding = 8;

            // Initially position to the right of the menu item
            let submenuX = itemRect.right + 4;
            let submenuY = itemRect.top;

            this.state.submenuX = submenuX;
            this.state.submenuY = submenuY;
            this.state.showPlaylistSubmenu = true;

            // After render, check if it overflows and adjust
            requestAnimationFrame(() => {
                const submenu = this.refs.playlistSubmenu;
                if (!submenu) return;

                const submenuRect = submenu.getBoundingClientRect();

                // Adjust horizontal - if overflows right, show to the left
                if (submenuX + submenuRect.width > window.innerWidth - padding) {
                    submenuX = itemRect.left - submenuRect.width - 4;
                }

                // Adjust vertical - if overflows bottom, move up
                if (submenuY + submenuRect.height > window.innerHeight - padding) {
                    submenuY = window.innerHeight - submenuRect.height - padding;
                }

                // Ensure it doesn't go off the top
                submenuY = Math.max(padding, submenuY);
                submenuX = Math.max(padding, submenuX);

                this.state.submenuX = submenuX;
                this.state.submenuY = submenuY;
            });
        },

        async handleAddToPlaylist(playlist, e) {
            e.stopPropagation();
            if (!this.state.song || !playlist) return;

            try {
                await playlistsApi.addSong(playlist.id, this.state.song.uuid);
                // Could show a toast notification here
            } catch (e) {
                console.error('Failed to add to playlist:', e);
            }
            this.hide();
        },

        isSongFavorite() {
            // Access store through this.stores to ensure reactivity
            const favoriteSongs = this.stores.offline.favoriteSongs;
            return this.state.song && favoriteSongs.has(this.state.song.uuid);
        },

        async handleToggleFavorite() {
            const song = this.state.song;
            if (!song) return;

            const favoritesPlaylistId = getFavoritesPlaylistId();
            if (!favoritesPlaylistId) {
                console.error('Could not determine favorites playlist');
                this.hide();
                return;
            }

            try {
                if (this.isSongFavorite()) {
                    await playlistsApi.removeSong(favoritesPlaylistId, song.uuid);
                } else {
                    await playlistsApi.addSong(favoritesPlaylistId, song.uuid);
                }
            } catch (e) {
                console.error('Failed to toggle favorite:', e);
            }
            this.hide();
        },

        // Navigation handlers
        handleGoToArtist() {
            const song = this.state.song;
            if (song?.artist) {
                navigateToArtist(song.artist);
            }
            this.hide();
        },

        handleGoToAlbum() {
            const song = this.state.song;
            if (song?.album) {
                navigateToAlbum(song.artist, song.album);
            }
            this.hide();
        },

        handleGoToCategory() {
            const song = this.state.song;
            if (song?.category) {
                navigateToCategory(song.category);
            }
            this.hide();
        },

        handleGoToGenre() {
            const song = this.state.song;
            if (song?.genre) {
                navigateToGenre(song.genre);
            }
            this.hide();
        },

        handleGoToFolder() {
            const song = this.state.song;
            if (song) {
                navigateToFolder(song);
            }
            this.hide();
        },

        handleGoToAlbumArtist() {
            const song = this.state.song;
            if (song?.album_artist) {
                navigateToArtist(song.album_artist);
            }
            this.hide();
        },

        handleGoToComposer() {
            const song = this.state.song;
            if (song?.composer) {
                navigateToArtist(song.composer);
            }
            this.hide();
        },

        // Folder action handlers
        async handleFolderPlayNow() {
            this.state.isAddingToQueue = true;
            try {
                // Clear queue first for "Play All" behavior
                await player.clearQueue();
                if (this.state.folderPath) {
                    await player.addByPath(this.state.folderPath);
                } else if (this.state.folderFilters) {
                    await player.addByFilter(this.state.folderFilters);
                }
            } catch (e) {
                console.error('Failed to play folder:', e);
            }
            this.state.isAddingToQueue = false;
            this.hide();
        },

        async handleFolderAddToQueue() {
            this.state.isAddingToQueue = true;
            try {
                if (this.state.folderPath) {
                    await player.addByPath(this.state.folderPath);
                } else if (this.state.folderFilters) {
                    await player.addByFilter(this.state.folderFilters);
                }
            } catch (e) {
                console.error('Failed to add folder to queue:', e);
            }
            this.state.isAddingToQueue = false;
            this.hide();
        },

        async handleFolderAddToPlaylist(playlist, e) {
            e.stopPropagation();
            if (!playlist) return;

            try {
                // Fetch all song UUIDs for this folder/filter
                const uuids = await this._getFolderSongUuids();
                if (uuids.length > 0) {
                    await playlistsApi.addSongsBatch(playlist.id, uuids);
                }
            } catch (e) {
                console.error('Failed to add folder to playlist:', e);
            }
            this.hide();
        },

        async _getFolderSongUuids() {
            // Import songs API dynamically to avoid circular dependency
            const { songs: songsApi } = await import('../offline/offline-api.js');
            const allSongs = [];
            let cursor = null;

            if (this.state.folderPath) {
                do {
                    const result = await songsApi.byPath(this.state.folderPath, { cursor, limit: 500 });
                    const songs = result.items || [];
                    allSongs.push(...songs);
                    cursor = result.nextCursor || null;
                } while (cursor);
            } else if (this.state.folderFilters) {
                do {
                    const result = await songsApi.byFilter({ ...this.state.folderFilters, cursor, limit: 500 });
                    const songs = result.items || [];
                    allSongs.push(...songs);
                    cursor = result.nextCursor || null;
                } while (cursor);
            }

            return allSongs.map(s => s.uuid).filter(uuid => uuid);
        },

        // Offline download methods
        isSongOffline() {
            return this.state.song && this.stores.offline.offlineSongUuids.has(this.state.song.uuid);
        },

        canDownloadSong() {
            return this.state.song && canCacheOffline(this.state.song.type);
        },

        async handleDownloadOffline() {
            let song = this.state.song;
            if (!song) return;

            this.state.isDownloading = true;

            try {
                // VFS items have type='file' - fetch full metadata first
                if (!song.type || song.type === 'file') {
                    const fullSong = await songsApi.get(song.uuid);
                    if (fullSong) {
                        song = fullSong;
                    }
                }

                // Check if song is actually downloadable
                if (!canCacheOffline(song.type)) {
                    console.warn('Song requires transcoding, cannot download offline');
                    this.state.isDownloading = false;
                    this.hide();
                    return;
                }

                // Build download source from browsing context
                let downloadSource = null;
                if (this.state.folderPath) {
                    // Browsing by file path
                    downloadSource = { type: 'browse', path: this.state.folderPath };
                } else if (this.state.folderFilters) {
                    // Browsing by hierarchy filter
                    const filters = this.state.folderFilters;
                    const parts = [];
                    if (filters.category) parts.push(filters.category);
                    if (filters.genre) parts.push(filters.genre);
                    if (filters.artist) parts.push(filters.artist);
                    if (filters.album) parts.push(filters.album);
                    downloadSource = { type: 'browse', path: parts.join(' / ') || 'Browse' };
                } else {
                    // Use song's file path as context
                    const filepath = song.virtual_file || song.file || '';
                    const path = filepath.split('/').slice(0, -1).join('/') || '/';
                    downloadSource = { type: 'browse', path };
                }

                await downloadSong(song, null, null, downloadSource);
                // Refresh filter sets so the song appears in offline browsing
                await computeOfflineFilterSets();
            } catch (e) {
                console.error('Failed to download song:', e);
            }
            this.state.isDownloading = false;
            this.hide();
        },

        async handleRemoveDownload() {
            const song = this.state.song;
            if (!song) return;

            try {
                await deleteSong(song.uuid);
                // Refresh filter sets
                await computeOfflineFilterSets();
            } catch (e) {
                console.error('Failed to remove download:', e);
            }
            this.hide();
        },

        handleShowInfo() {
            const song = this.state.song;
            if (song) {
                this.hide();
                showSongInfoModal(song);
            }
        }
    },

    template() {
        const { isVisible, song, x, y, playlists, showPlaylistSubmenu, isFolder, isAddingToQueue } = this.state;

        if (!isVisible || !song) {
            return html`<div class="context-menu hidden"></div>`;
        }

        // For folders, use item name as title
        const displayTitle = isFolder ? (song.name || 'Folder') : song.title;
        const displaySubtitle = isFolder ? 'Folder' : (song.artist || 'Unknown');
        const hasFolder = !isFolder && (song.virtual_file || song.file);

        return html`
            <div class="context-menu" style="left: ${x}px; top: ${y}px;">
                <div class="menu-header">
                    <div class="song-title">${displayTitle}</div>
                    <div class="song-artist">${displaySubtitle}</div>
                </div>

                <hr class="separator">

                ${when(isFolder, () => html`
                    <!-- Folder-specific menu items -->
                    <button class="menu-item" on-click="handleFolderPlayNow" disabled="${isAddingToQueue}">
                        <span class="icon">▶</span>
                        <span class="label">${isAddingToQueue ? 'Loading...' : 'Play All'}</span>
                    </button>

                    <button class="menu-item" on-click="handleFolderAddToQueue" disabled="${isAddingToQueue}">
                        <span class="icon">+</span>
                        <span class="label">Add All to Queue</span>
                    </button>

                    <hr class="separator">

                    <div class="menu-item-with-submenu" ref="playlistMenuItem">
                        <button class="menu-item has-submenu" on-click="togglePlaylistSubmenu">
                            <span class="icon">♪</span>
                            <span class="label">Add All to Playlist</span>
                            <span class="arrow">▶</span>
                        </button>
                    </div>

                    ${when(showPlaylistSubmenu, () => html`
                        <div class="submenu" ref="playlistSubmenu" style="left: ${this.state.submenuX}px; top: ${this.state.submenuY}px;">
                            ${when(playlists.length === 0, html`
                                <div class="submenu-empty">No playlists</div>
                            `)}
                            ${each(playlists, (pl) => html`
                                <button class="submenu-item" on-click="${(e) => this.handleFolderAddToPlaylist(pl, e)}">
                                    ${pl.name}
                                </button>
                            `)}
                        </div>
                    `)}
                `, () => html`
                    <!-- Song-specific menu items -->
                    <button class="menu-item" on-click="handlePlayNow">
                        <span class="icon">▶</span>
                        <span class="label">Play Now</span>
                    </button>

                    <button class="menu-item" on-click="handleAddToQueue">
                        <span class="icon">+</span>
                        <span class="label">Add to Queue</span>
                    </button>

                    ${when(this.isSongFavorite(),
                        html`<button class="menu-item" on-click="handleToggleFavorite">
                            <span class="icon">🤍</span>
                            <span class="label">Remove Favorite</span>
                        </button>`,
                        html`<button class="menu-item" on-click="handleToggleFavorite">
                            <span class="icon">❤️</span>
                            <span class="label">Add to Favorites</span>
                        </button>`
                    )}

                    ${when(this.isSongOffline(),
                        html`<button class="menu-item" on-click="handleRemoveDownload">
                            <span class="icon">🗑</span>
                            <span class="label">Remove Download</span>
                        </button>`,
                        () => when(this.canDownloadSong(),
                            html`<button class="menu-item" on-click="handleDownloadOffline" disabled="${this.state.isDownloading}">
                                <span class="icon">⬇</span>
                                <span class="label">${this.state.isDownloading ? 'Downloading...' : 'Download for Offline'}</span>
                            </button>`,
                            html`<button class="menu-item disabled" disabled title="Requires server transcoding">
                                <span class="icon">⬇</span>
                                <span class="label">Cannot Download</span>
                            </button>`
                        )
                    )}

                    <hr class="separator">

                    <div class="menu-item-with-submenu" ref="playlistMenuItem">
                        <button class="menu-item has-submenu" on-click="togglePlaylistSubmenu">
                            <span class="icon">♪</span>
                            <span class="label">Add to Playlist</span>
                            <span class="arrow">▶</span>
                        </button>
                    </div>

                    ${when(showPlaylistSubmenu, () => html`
                        <div class="submenu" ref="playlistSubmenu" style="left: ${this.state.submenuX}px; top: ${this.state.submenuY}px;">
                            ${when(playlists.length === 0, html`
                                <div class="submenu-empty">No playlists</div>
                            `)}
                            ${each(playlists, (pl) => html`
                                <button class="submenu-item" on-click="${(e) => this.handleAddToPlaylist(pl, e)}">
                                    ${pl.name}
                                </button>
                            `)}
                        </div>
                    `)}

                    <hr class="separator">

                    ${when(song.artist, html`
                        <button class="menu-item" on-click="handleGoToArtist">
                            <span class="icon">👤</span>
                            <span class="label">Go to Artist</span>
                        </button>
                    `)}

                    ${when(song.album_artist && song.album_artist !== song.artist, html`
                        <button class="menu-item" on-click="handleGoToAlbumArtist">
                            <span class="icon">👥</span>
                            <span class="label">Go to Album Artist</span>
                        </button>
                    `)}

                    ${when(song.composer, html`
                        <button class="menu-item" on-click="handleGoToComposer">
                            <span class="icon">✍️</span>
                            <span class="label">Go to Composer</span>
                        </button>
                    `)}

                    ${when(song.album, html`
                        <button class="menu-item" on-click="handleGoToAlbum">
                            <span class="icon">💿</span>
                            <span class="label">Go to Album</span>
                        </button>
                    `)}

                    ${when(song.genre, html`
                        <button class="menu-item" on-click="handleGoToGenre">
                            <span class="icon">🎼</span>
                            <span class="label">Go to Genre</span>
                        </button>
                    `)}

                    ${when(song.category, html`
                        <button class="menu-item" on-click="handleGoToCategory">
                            <span class="icon">📂</span>
                            <span class="label">Go to Category</span>
                        </button>
                    `)}

                    ${when(hasFolder, html`
                        <button class="menu-item" on-click="handleGoToFolder">
                            <span class="icon">📁</span>
                            <span class="label">Go to Folder</span>
                        </button>
                    `)}

                    <hr class="separator">

                    <button class="menu-item" on-click="handleShowInfo">
                        <span class="icon">ℹ️</span>
                        <span class="label">Info...</span>
                    </button>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            position: fixed;
            top: 0;
            left: 0;
            z-index: 999999;
            pointer-events: none;
        }

        .context-menu {
            pointer-events: auto;
            position: fixed;
            min-width: 200px;
            background: var(--surface-100, #1e1e1e);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            padding: 4px 0;
            overflow: visible;
        }

        .context-menu.hidden {
            display: none;
        }

        .menu-header {
            padding: 8px 12px;
            border-bottom: none;
        }

        .song-title {
            font-weight: 600;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 180px;
        }

        .song-artist {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 180px;
        }

        .separator {
            margin: 4px 0;
            border: none;
            border-top: 1px solid var(--surface-300, #404040);
        }

        .menu-item {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            padding: 8px 12px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
            text-align: left;
            transition: background 0.15s;
        }

        .menu-item:hover:not(:disabled) {
            background: var(--surface-200, #2a2a2a);
        }

        .menu-item:disabled,
        .menu-item.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .menu-item .icon {
            width: 18px;
            text-align: center;
            opacity: 0.7;
        }

        .menu-item .label {
            flex: 1;
        }

        .menu-item .arrow {
            font-size: 0.625rem;
            opacity: 0.5;
        }

        .menu-item-with-submenu {
            position: relative;
        }

        .submenu {
            position: fixed;
            background: var(--surface-100, #1e1e1e);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            min-width: 150px;
            max-width: 250px;
            max-height: 300px;
            overflow-y: auto;
            z-index: 1000000;
        }

        .submenu-empty {
            padding: 8px 12px;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.75rem;
            font-style: italic;
        }

        .submenu-item {
            display: block;
            width: 100%;
            padding: 8px 12px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 0.8125rem;
            color: var(--text-primary, #e0e0e0);
            text-align: left;
            transition: background 0.15s;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .submenu-item:hover {
            background: var(--surface-200, #2a2a2a);
        }

        .submenu-item:first-child {
            border-radius: 5px 5px 0 0;
        }

        .submenu-item:last-child {
            border-radius: 0 0 5px 5px;
        }

        .submenu-item:only-child {
            border-radius: 5px;
        }
    `
});

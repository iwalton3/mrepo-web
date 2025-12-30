/**
 * Radio Page
 *
 * SCA-powered radio mode:
 * - Start radio from category, genre, artist, or random
 * - Display current song and upcoming queue
 * - Skip and filter controls
 */

import { defineComponent, html, when, each, contain } from '../lib/framework.js';
import { browse } from '../offline/offline-api.js';
import { player, playerStore } from '../stores/player-store.js';
import offlineStore from '../offline/offline-store.js';
import '../componentlib/button/button.js';
import '../componentlib/selection/dropdown.js';
import '../componentlib/misc/spinner.js';

export default defineComponent('radio-page', {
    stores: { player: playerStore, offline: offlineStore },

    data() {
        return {
            categories: [],
            genres: [],
            selectedCategory: '',
            selectedGenre: '',
            customFilter: '',
            isLoading: false,
            showAdvanced: false
        };
    },

    async mounted() {
        await this.loadCategories();
    },

    methods: {
        async loadCategories() {
            try {
                const result = await browse.categories();
                this.state.categories = result.items;
            } catch (e) {
                console.error('Failed to load categories:', e);
            }
        },

        async loadGenres() {
            if (!this.state.selectedCategory) {
                this.state.genres = [];
                return;
            }

            try {
                const result = await browse.genres({ category: this.state.selectedCategory });
                this.state.genres = result.items;
            } catch (e) {
                console.error('Failed to load genres:', e);
            }
        },

        handleCategoryChange(e) {
            this.state.selectedCategory = e.detail?.value || e.target?.value || '';
            this.state.selectedGenre = '';
            this.loadGenres();
        },

        handleGenreChange(e) {
            this.state.selectedGenre = e.detail?.value || e.target?.value || '';
        },

        handleFilterChange(e) {
            this.state.customFilter = e.target.value;
        },

        toggleAdvanced() {
            this.state.showAdvanced = !this.state.showAdvanced;
        },

        buildFilter() {
            const { selectedCategory, selectedGenre, customFilter } = this.state;
            const parts = [];

            if (selectedCategory) {
                parts.push(`c:eq:${selectedCategory}`);
            }
            if (selectedGenre) {
                parts.push(`g:eq:${selectedGenre}`);
            }
            if (customFilter.trim()) {
                parts.push(customFilter.trim());
            }

            return parts.length > 0 ? parts.join(' AND ') : null;
        },

        async startRadio() {
            this.state.isLoading = true;
            const filter = this.buildFilter();

            try {
                await player.startRadio(null, filter);
            } catch (e) {
                console.error('Failed to start radio:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async startRandomRadio() {
            this.state.isLoading = true;
            try {
                await player.startRadio(null, null);
            } catch (e) {
                console.error('Failed to start radio:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        stopRadio() {
            player.stopRadio();
            player.stop();
        },

        handleSkip() {
            player.skip();
        },

        formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        getProgressPercent() {
            const { currentTime, duration } = this.stores.player;
            if (!duration) return 0;
            return (currentTime / duration) * 100;
        }
    },

    template() {
        const { categories, genres, selectedCategory, selectedGenre, showAdvanced, isLoading, customFilter } = this.state;
        const scaEnabled = this.stores.player.scaEnabled;
        const currentSong = this.stores.player.currentSong;
        const queue = this.stores.player.queue;
        const isPlaying = this.stores.player.isPlaying;
        const error = this.stores.player.error;

        return html`
            <div class="radio-page">
                ${when(this.stores.offline.workOfflineMode || !this.stores.offline.isOnline, () => html`
                    <div class="offline-warning">
                        <span class="warning-icon">⚠️</span>
                        <span>Radio requires network connection. ${this.stores.offline.workOfflineMode
                            ? 'Disable "Work Offline" in Settings to use radio.'
                            : 'Connect to the internet to use radio.'}</span>
                    </div>
                `)}

                ${when(error && !(this.stores.offline.workOfflineMode || !this.stores.offline.isOnline), () => html`
                    <div class="error-message">${error}</div>
                `)}

                ${when(!scaEnabled, () => html`
                    <!-- Radio Setup -->
                    <div class="radio-setup">
                        <div class="setup-header">
                            <div class="radio-icon">📻</div>
                            <h1>Start Radio</h1>
                            <p>Let the Song Continuity Algorithm create a continuous mix based on your selection</p>
                        </div>

                        <!-- Quick Start -->
                        <div class="quick-start">
                            <cl-button severity="primary" icon="🎲" on-click="startRandomRadio"
                                       loading="${isLoading}"
                                       disabled="${this.stores.offline.workOfflineMode || !this.stores.offline.isOnline}">
                                Random Radio
                            </cl-button>
                        </div>

                        <div class="divider">or filter by</div>

                        <!-- Category/Genre Selection -->
                        <div class="filter-section">
                            <div class="filter-row">
                                <label>Category</label>
                                <select class="filter-select" value="${selectedCategory}"
                                        on-change="handleCategoryChange">
                                    <option value="">All Categories</option>
                                    ${each(categories, cat => html`
                                        <option value="${cat.name}">${cat.name} (${cat.song_count})</option>
                                    `)}
                                </select>
                            </div>

                            ${when(selectedCategory, () => html`
                                <div class="filter-row">
                                    <label>Genre</label>
                                    <select class="filter-select" value="${selectedGenre}"
                                            on-change="handleGenreChange">
                                        <option value="">All Genres</option>
                                        ${each(genres, genre => html`
                                            <option value="${genre.name}">${genre.name} (${genre.song_count})</option>
                                        `)}
                                    </select>
                                </div>
                            `)}

                            <!-- Advanced Filter -->
                            <button class="advanced-toggle" on-click="toggleAdvanced">
                                ${showAdvanced ? '▼ Hide Advanced' : '▶ Advanced Filter'}
                            </button>

                            ${when(showAdvanced, () => html`
                                <div class="filter-row">
                                    <label>Custom Filter</label>
                                    <input type="text"
                                           class="filter-input"
                                           placeholder="e.g., a:mt:Beatles AND year:gte:1965"
                                           x-model="customFilter">
                                    <small>Uses the same syntax as search</small>
                                </div>
                            `)}

                            <cl-button severity="primary" icon="📻" on-click="startRadio"
                                       loading="${isLoading}"
                                       disabled="${this.stores.offline.workOfflineMode || !this.stores.offline.isOnline}">
                                Start Filtered Radio
                            </cl-button>
                        </div>
                    </div>
                `, html`
                    <!-- Radio Playing -->
                    <div class="radio-playing">
                        <div class="radio-header">
                            <span class="radio-badge">📻 Radio Mode</span>
                            <cl-button severity="danger" outlined="true" on-click="stopRadio">
                                Stop Radio
                            </cl-button>
                        </div>

                        ${when(currentSong, () => html`
                            <!-- Now Playing -->
                            <div class="now-playing">
                                <div class="album-art">
                                    <div class="art-placeholder ${isPlaying ? 'playing' : ''}">
                                        🎵
                                    </div>
                                </div>

                                <div class="song-info">
                                    <h2 class="song-title">${currentSong.title}</h2>
                                    <p class="song-artist">${currentSong.artist || 'Unknown Artist'}</p>
                                    <p class="song-album">${currentSong.album || ''}</p>
                                </div>

                                <!-- Progress (isolated to prevent re-renders on time updates) -->
                                ${contain(() => html`
                                    <div class="progress-section">
                                        <div class="progress-bar">
                                            <div class="progress-fill" style="width: ${this.getProgressPercent()}%"></div>
                                        </div>
                                        <div class="time-display">
                                            ${this.formatTime(this.stores.player.currentTime)}
                                            /
                                            ${this.formatTime(this.stores.player.duration)}
                                        </div>
                                    </div>
                                `)}

                                <!-- Controls -->
                                <div class="radio-controls">
                                    <cl-button severity="primary" icon="${isPlaying ? '⏸' : '▶'}"
                                               on-click="${() => player.togglePlayPause()}">
                                        ${isPlaying ? 'Pause' : 'Play'}
                                    </cl-button>
                                    <cl-button severity="secondary" icon="⏭" on-click="handleSkip">
                                        Skip
                                    </cl-button>
                                </div>
                            </div>
                        `)}

                        <!-- Up Next -->
                        ${when(queue.length > 0, () => html`
                            <div class="up-next">
                                <h3>Up Next</h3>
                                <div class="queue-list">
                                    ${each(queue.slice(0, 10), (song, index) => html`
                                        <div class="queue-item">
                                            <span class="queue-num">${index + 1}</span>
                                            <div class="queue-info">
                                                <div class="queue-title">${song.title}</div>
                                                <div class="queue-artist">${song.artist || 'Unknown'}</div>
                                            </div>
                                        </div>
                                    `)}
                                </div>
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

        .radio-page {
            padding: 1rem;
            max-width: 600px;
            margin: 0 auto;
        }

        .offline-warning {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 1rem;
            margin-bottom: 1rem;
            background: var(--warning-100, #451a03);
            border: 1px solid var(--warning-500, #f59e0b);
            border-radius: 8px;
            color: var(--warning-500, #f59e0b);
        }

        .warning-icon {
            font-size: 1.25rem;
        }

        .error-message {
            padding: 1rem;
            margin-bottom: 1rem;
            background: var(--danger-100, #450a0a);
            border: 1px solid var(--danger-500, #ef4444);
            border-radius: 8px;
            color: var(--danger-500, #ef4444);
        }

        /* Setup */
        .radio-setup {
            text-align: center;
        }

        .setup-header {
            margin-bottom: 2rem;
        }

        .radio-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
        }

        .setup-header h1 {
            margin: 0 0 0.5rem;
        }

        .setup-header h1 {
            color: var(--text-primary, #e0e0e0);
        }

        .setup-header p {
            color: var(--text-secondary, #a0a0a0);
            margin: 0;
        }

        .quick-start {
            margin-bottom: 1.5rem;
        }

        .divider {
            color: var(--text-muted, #707070);
            font-size: 0.875rem;
            margin: 1.5rem 0;
            position: relative;
        }

        .divider::before,
        .divider::after {
            content: '';
            position: absolute;
            top: 50%;
            width: 40%;
            height: 1px;
            background: var(--surface-300, #404040);
        }

        .divider::before {
            left: 0;
        }

        .divider::after {
            right: 0;
        }

        /* Filters */
        .filter-section {
            text-align: left;
            background: var(--surface-100, #242424);
            border-radius: 12px;
            padding: 1.5rem;
        }

        .filter-row {
            margin-bottom: 1rem;
        }

        .filter-row label {
            display: block;
            font-weight: 500;
            margin-bottom: 0.25rem;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
        }

        .filter-select,
        .filter-input {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            font-size: 1rem;
            background: var(--surface-50, #1a1a1a);
            color: var(--text-primary, #e0e0e0);
        }

        .filter-row small {
            display: block;
            margin-top: 0.25rem;
            color: var(--text-muted, #707070);
            font-size: 0.75rem;
        }

        .advanced-toggle {
            background: none;
            border: none;
            color: var(--primary-400, #42a5f5);
            cursor: pointer;
            font-size: 0.875rem;
            padding: 0.5rem 0;
            margin-bottom: 1rem;
        }

        .advanced-toggle:hover {
            text-decoration: underline;
        }

        /* Radio Playing */
        .radio-playing {
            animation: fadeIn 0.3s;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .radio-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 2rem;
        }

        .radio-badge {
            background: var(--success-100, #1b4332);
            color: var(--success-500, #22c55e);
            padding: 0.5rem 1rem;
            border-radius: 2rem;
            font-weight: 500;
        }

        /* Now Playing */
        .now-playing {
            text-align: center;
            margin-bottom: 2rem;
        }

        .album-art {
            width: 180px;
            height: 180px;
            margin: 0 auto 1.5rem;
        }

        .art-placeholder {
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, var(--primary-400, #3399ff) 0%, var(--primary-600, #0052a3) 100%);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 4rem;
            color: white;
        }

        .art-placeholder.playing {
            animation: pulse-art 2s ease-in-out infinite;
        }

        @keyframes pulse-art {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.02); }
        }

        .song-title {
            font-size: 1.25rem;
            font-weight: 700;
            margin: 0 0 0.25rem;
            color: var(--text-primary, #e0e0e0);
        }

        .song-artist {
            font-size: 1rem;
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 0.25rem;
        }

        .song-album {
            font-size: 0.875rem;
            color: var(--text-muted, #707070);
            margin: 0;
        }

        /* Progress */
        .progress-section {
            margin: 1.5rem 0;
        }

        .progress-bar {
            height: 4px;
            background: var(--surface-300, #404040);
            border-radius: 2px;
            overflow: hidden;
            margin-bottom: 0.5rem;
        }

        .progress-fill {
            height: 100%;
            background: var(--primary-500, #2196f3);
            transition: width 0.1s linear;
        }

        .time-display {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Controls */
        .radio-controls {
            display: flex;
            gap: 0.5rem;
            justify-content: center;
        }

        /* Up Next */
        .up-next {
            background: var(--surface-100, #242424);
            border-radius: 12px;
            padding: 1rem;
        }

        .up-next h3 {
            margin: 0 0 0.75rem;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .queue-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .queue-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.5rem;
            background: var(--surface-50, #1a1a1a);
            border-radius: 8px;
        }

        .queue-num {
            width: 1.5rem;
            text-align: center;
            color: var(--text-muted, #707070);
            font-size: 0.75rem;
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

        .queue-artist {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* Mobile */
        @media (max-width: 767px) {
            .radio-page {
                padding: 0.5rem;
            }

            .album-art {
                width: 140px;
                height: 140px;
            }
        }
    `
});

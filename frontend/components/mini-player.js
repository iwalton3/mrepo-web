/**
 * Mini Player Component
 *
 * Persistent compact player shown in the sidebar footer.
 * Displays current song info with basic controls.
 */

import { defineComponent, html, when } from '../lib/framework.js';
import { debounce } from '../lib/utils.js';
import { player, playerStore } from '../stores/player-store.js';

export default defineComponent('mini-player', {
    stores: { player: playerStore },

    data() {
        return {
            showVolumePopup: false
        };
    },

    mounted() {
        // Create debounced volume setter (50ms) for smoother slider interaction
        this._debouncedSetVolume = debounce((value) => {
            player.setVolume(value / 100);
        }, 50);
    },

    methods: {
        handlePlayPause() {
            player.togglePlayPause();
        },

        handlePrevious() {
            player.previous();
        },

        handleNext() {
            player.next();
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
            // Clamp to 100% to handle edge cases during song transitions
            return Math.min(100, (currentTime / duration) * 100);
        },

        handleSeek(e) {
            const song = this.stores.player.currentSong;
            const duration = this.stores.player.duration;
            if (!song || !duration || song.seekable === false || song.seekable === 0) return;

            const rect = e.currentTarget.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            player.seek(percent * duration);
        },

        isSeekable() {
            const song = this.stores.player.currentSong;
            return song && song.seekable !== false && song.seekable !== 0;
        },

        handleVolumeChange(e) {
            const value = parseFloat(e.target.value);
            this._debouncedSetVolume(value);
        },

        handleToggleMute() {
            player.toggleMute();
        },

        getVolumeIcon() {
            const { volume, muted } = this.stores.player;
            if (muted || volume === 0) return '🔇';
            if (volume > 0.5) return '🔊';
            return '🔉';
        },

        handlePlayerMouseEnter() {
            this.state.showVolumePopup = true;
        },

        handlePlayerMouseLeave() {
            this.state.showVolumePopup = false;
        }
    },

    template() {
        const song = this.stores.player.currentSong;
        const isPlaying = this.stores.player.isPlaying;
        const isLoading = this.stores.player.isLoading;
        const scaEnabled = this.stores.player.scaEnabled;

        if (!song) {
            return html`
                <div class="mini-player empty">
                    <div class="empty-message">No song playing</div>
                </div>
            `;
        }

        return html`
            <div class="mini-player">
                <div class="progress-bar ${this.isSeekable() ? 'seekable' : ''}"
                     on-click="handleSeek"
                     title="${this.isSeekable() ? 'Click to seek' : ''}">
                    <div class="progress-fill" style="width: ${this.getProgressPercent()}%"></div>
                </div>

                <div class="song-info">
                    <div class="title" title="${song.title}">${song.title}</div>
                    <div class="artist" title="${song.artist}">${song.artist || 'Unknown'}</div>
                </div>

                <!-- Controls section -->
                <div class="controls">
                    <button class="ctrl-btn" on-click="handlePrevious" title="Previous">
                        <span class="icon">⏮</span>
                    </button>
                    <button class="ctrl-btn play-btn ${isLoading ? 'loading' : ''}"
                            on-click="handlePlayPause"
                            title="${isPlaying ? 'Pause' : 'Play'}">
                        ${isLoading ? html`<span class="icon">⏳</span>` : (isPlaying ? html`<span class="pause-icon"></span>` : html`<span class="play-icon"></span>`)}
                    </button>
                    <button class="ctrl-btn" on-click="handleNext" title="Next">
                        <span class="icon">⏭</span>
                    </button>
                </div>

                ${when(scaEnabled, html`
                    <div class="radio-indicator" title="Radio Mode">📻</div>
                `)}

                <!-- Volume/time area - hover here to show volume slider -->
                <div class="volume-time-wrapper"
                     on-mouseenter="handlePlayerMouseEnter"
                     on-mouseleave="handlePlayerMouseLeave">
                    <div class="time-display">
                        ${this.formatTime(this.stores.player.currentTime)}
                        /
                        ${this.formatTime(this.stores.player.duration)}
                    </div>

                    <!-- Volume slider appears on hover -->
                    ${when(this.state.showVolumePopup, html`
                        <div class="volume-section">
                            <button class="volume-btn" on-click="handleToggleMute"
                                    title="${this.stores.player.muted ? 'Unmute' : 'Mute'}">
                                ${this.getVolumeIcon()}
                            </button>
                            <input type="range"
                                   class="volume-slider"
                                   min="0"
                                   max="100"
                                   value="${this.stores.player.muted ? 0 : Math.round(this.stores.player.volume * 100)}"
                                   on-input="handleVolumeChange">
                            <span class="volume-value">${Math.round(this.stores.player.volume * 100)}%</span>
                        </div>
                    `)}
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .mini-player {
            position: relative;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            padding: 0.5rem;
            min-height: 80px;
        }

        .mini-player.empty {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .empty-message {
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .progress-bar {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: var(--surface-300, #404040);
            border-radius: 8px 8px 0 0;
            overflow: visible;
            transition: height 0.15s ease, top 0.15s ease;
        }

        .progress-bar.seekable {
            cursor: pointer;
        }

        /* Larger transparent hit area for seeking */
        .progress-bar.seekable::after {
            content: '';
            position: absolute;
            top: -4px;
            left: 0;
            right: 0;
            height: 16px;
        }

        .progress-bar.seekable:hover {
            height: 10px;
            top: -3px;
        }

        .progress-bar.seekable:hover .progress-fill {
            background: var(--primary-400, #3399ff);
            height: 10px;
        }

        .progress-fill {
            height: 3px;
            background: var(--primary-500, #0066cc);
            transition: width 0.1s linear, height 0.15s ease;
            border-radius: 8px 0 0 0;
        }

        .song-info {
            margin-bottom: 0.5rem;
            margin-top: 0.25rem;
            overflow: hidden;
        }

        .title {
            font-weight: 600;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .artist {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .controls {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.375rem;
            margin-bottom: 0.25rem;
        }

        .ctrl-btn {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            cursor: pointer;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
        }

        /* Make prev/next emoji icons white */
        .ctrl-btn .icon {
            line-height: 1;
            filter: brightness(0) invert(1);
        }

        .ctrl-btn:hover {
            background: var(--surface-300, #404040);
            border-color: var(--surface-400, #505050);
        }

        .ctrl-btn:active {
            transform: scale(0.95);
        }

        .play-btn {
            width: 38px;
            height: 38px;
            background: var(--primary-500, #0066cc);
            border-color: var(--primary-500, #0066cc);
        }

        .play-btn .icon {
            filter: brightness(0) invert(1);
        }

        /* CSS play triangle */
        .play-icon {
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 7px 0 7px 12px;
            border-color: transparent transparent transparent white;
            margin-left: 3px;
        }

        /* CSS pause bars */
        .pause-icon {
            display: flex;
            gap: 3px;
        }

        .pause-icon::before,
        .pause-icon::after {
            content: '';
            width: 4px;
            height: 14px;
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
            50% { opacity: 0.5; }
        }

        .radio-indicator {
            position: absolute;
            top: 0.5rem;
            right: 0.5rem;
            font-size: 0.75rem;
        }

        .volume-time-wrapper {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
        }

        .time-display {
            font-size: 0.75rem;
            font-family: ui-monospace, monospace;
            color: var(--text-secondary, #a0a0a0);
            text-align: center;
        }

        /* Volume section - shows under time on hover */
        .volume-section {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            margin-bottom: 0.25rem;
            padding: 0 0.25rem;
        }

        .volume-btn {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 0.875rem;
            padding: 0.25rem;
            opacity: 0.7;
            transition: opacity 0.15s;
        }

        .volume-btn:hover {
            opacity: 1;
        }

        .volume-slider {
            flex: 1;
            max-width: 80px;
            height: 4px;
            -webkit-appearance: none;
            appearance: none;
            background: var(--surface-300, #404040);
            border-radius: 2px;
            cursor: pointer;
        }

        .volume-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            transition: transform 0.1s;
        }

        .volume-slider:hover::-webkit-slider-thumb {
            transform: scale(1.15);
            background: var(--text-primary, #e0e0e0);
        }

        .volume-value {
            font-size: 0.625rem;
            font-family: ui-monospace, monospace;
            color: var(--text-secondary, #a0a0a0);
            min-width: 2rem;
        }
    `
});

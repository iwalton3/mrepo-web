/**
 * Song Info Modal Component
 *
 * Displays full metadata for a song with copyable fields and deeplinks.
 * Useful on mobile where song titles often get cut off.
 */

import { defineComponent, html, when, each } from '../lib/framework.js';
import { navigateToArtist, navigateToAlbum, navigateToCategory, navigateToGenre, navigateToFolder } from './song-context-menu.js';
import { songs as songsApi } from '../offline/offline-api.js';

// Singleton instance
let modalInstance = null;

export function showSongInfoModal(song) {
    if (!modalInstance) {
        modalInstance = document.createElement('song-info-modal');
        document.body.appendChild(modalInstance);
    }
    modalInstance.show(song);
}

export function hideSongInfoModal() {
    if (modalInstance) {
        modalInstance.hide();
    }
}

/**
 * Format duration from seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

export default defineComponent('song-info-modal', {
    data() {
        return {
            isVisible: false,
            song: null,
            copiedField: null,
            isLoading: false
        };
    },

    mounted() {
        // Close on escape
        this._handleEscape = (e) => {
            if (e.key === 'Escape' && this.state.isVisible) {
                this.hide();
            }
        };
        document.addEventListener('keydown', this._handleEscape);
    },

    unmounted() {
        document.removeEventListener('keydown', this._handleEscape);
    },

    methods: {
        async show(song) {
            this.state.song = song;
            this.state.isVisible = true;
            this.state.copiedField = null;
            this.state.isLoading = false;
            // Prevent body scroll
            document.body.style.overflow = 'hidden';

            // VFS items have type='file' or no type - fetch full metadata
            if (song.uuid && (!song.type || song.type === 'file')) {
                this.state.isLoading = true;
                try {
                    const fullSong = await songsApi.get(song.uuid);
                    if (fullSong && this.state.isVisible) {
                        this.state.song = fullSong;
                    }
                } catch (e) {
                    console.error('Failed to fetch song metadata:', e);
                }
                this.state.isLoading = false;
            }
        },

        hide() {
            this.state.isVisible = false;
            document.body.style.overflow = '';
        },

        handleMaskClick(e) {
            if (e.target === e.currentTarget) {
                this.hide();
            }
        },

        async copyToClipboard(field, value, e) {
            e?.stopPropagation();
            if (!value) return;

            try {
                await navigator.clipboard.writeText(String(value));
                this.state.copiedField = field;
                setTimeout(() => {
                    if (this.state.copiedField === field) {
                        this.state.copiedField = null;
                    }
                }, 1500);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        },

        async copyAllMetadata() {
            const song = this.state.song;
            if (!song) return;

            const lines = [];
            if (song.title) lines.push(`Title: ${song.title}`);
            if (song.artist) lines.push(`Artist: ${song.artist}`);
            if (song.album_artist && song.album_artist !== song.artist) {
                lines.push(`Album Artist: ${song.album_artist}`);
            }
            if (song.album) lines.push(`Album: ${song.album}`);
            if (song.track_number) {
                const track = song.disc_number
                    ? `${song.disc_number}-${song.track_number}`
                    : String(song.track_number);
                lines.push(`Track: ${track}`);
            }
            if (song.year) lines.push(`Year: ${song.year}`);
            if (song.genre) lines.push(`Genre: ${song.genre}`);
            if (song.category) lines.push(`Category: ${song.category}`);
            if (song.composer) lines.push(`Composer: ${song.composer}`);
            if (song.duration_seconds) lines.push(`Duration: ${formatDuration(song.duration_seconds)}`);
            if (song.type) lines.push(`Format: ${song.type}`);
            const filepath = song.virtual_file || song.file || song.filepath;
            if (filepath) lines.push(`File: ${filepath}`);
            if (song.uuid) lines.push(`UUID: ${song.uuid}`);

            try {
                await navigator.clipboard.writeText(lines.join('\n'));
                this.state.copiedField = 'all';
                setTimeout(() => {
                    if (this.state.copiedField === 'all') {
                        this.state.copiedField = null;
                    }
                }, 1500);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        },

        // Navigation handlers
        handleGoToArtist() {
            const song = this.state.song;
            if (song?.artist) {
                this.hide();
                navigateToArtist(song.artist);
            }
        },

        handleGoToAlbumArtist() {
            const song = this.state.song;
            if (song?.album_artist) {
                this.hide();
                navigateToArtist(song.album_artist);
            }
        },

        handleGoToAlbum() {
            const song = this.state.song;
            if (song?.album) {
                this.hide();
                navigateToAlbum(song.artist, song.album);
            }
        },

        handleGoToGenre() {
            const song = this.state.song;
            if (song?.genre) {
                this.hide();
                navigateToGenre(song.genre);
            }
        },

        handleGoToCategory() {
            const song = this.state.song;
            if (song?.category) {
                this.hide();
                navigateToCategory(song.category);
            }
        },

        handleGoToFolder() {
            const song = this.state.song;
            if (song) {
                this.hide();
                navigateToFolder(song);
            }
        },

        getMetadataFields() {
            const song = this.state.song;
            if (!song) return [];

            const fields = [];
            const filepath = song.virtual_file || song.file || song.filepath;

            // Title
            if (song.title) {
                fields.push({
                    key: 'title',
                    label: 'Title',
                    value: song.title,
                    copyable: true
                });
            }

            // Artist with navigation
            if (song.artist) {
                fields.push({
                    key: 'artist',
                    label: 'Artist',
                    value: song.artist,
                    copyable: true,
                    navigable: true,
                    onNavigate: () => this.handleGoToArtist()
                });
            }

            // Album Artist (if different from artist)
            if (song.album_artist && song.album_artist !== song.artist) {
                fields.push({
                    key: 'album_artist',
                    label: 'Album Artist',
                    value: song.album_artist,
                    copyable: true,
                    navigable: true,
                    onNavigate: () => this.handleGoToAlbumArtist()
                });
            }

            // Album with navigation
            if (song.album) {
                fields.push({
                    key: 'album',
                    label: 'Album',
                    value: song.album,
                    copyable: true,
                    navigable: true,
                    onNavigate: () => this.handleGoToAlbum()
                });
            }

            // Track number (with disc if available)
            if (song.track_number) {
                const trackValue = song.disc_number
                    ? `${song.disc_number}-${song.track_number}`
                    : String(song.track_number);
                fields.push({
                    key: 'track',
                    label: 'Track',
                    value: trackValue,
                    copyable: true
                });
            }

            // Year
            if (song.year) {
                fields.push({
                    key: 'year',
                    label: 'Year',
                    value: String(song.year),
                    copyable: true
                });
            }

            // Genre with navigation
            if (song.genre) {
                fields.push({
                    key: 'genre',
                    label: 'Genre',
                    value: song.genre,
                    copyable: true,
                    navigable: true,
                    onNavigate: () => this.handleGoToGenre()
                });
            }

            // Category with navigation
            if (song.category) {
                fields.push({
                    key: 'category',
                    label: 'Category',
                    value: song.category,
                    copyable: true,
                    navigable: true,
                    onNavigate: () => this.handleGoToCategory()
                });
            }

            // Composer
            if (song.composer) {
                fields.push({
                    key: 'composer',
                    label: 'Composer',
                    value: song.composer,
                    copyable: true
                });
            }

            // Duration
            if (song.duration_seconds) {
                fields.push({
                    key: 'duration',
                    label: 'Duration',
                    value: formatDuration(song.duration_seconds),
                    copyable: true
                });
            }

            // Format/Type
            if (song.type) {
                fields.push({
                    key: 'type',
                    label: 'Format',
                    value: song.type.toUpperCase(),
                    copyable: true
                });
            }

            // File path with folder navigation
            if (filepath) {
                fields.push({
                    key: 'file',
                    label: 'File',
                    value: filepath,
                    copyable: true,
                    navigable: true,
                    navigateLabel: 'Go to Folder',
                    onNavigate: () => this.handleGoToFolder()
                });
            }

            // UUID (for debugging/reference)
            if (song.uuid) {
                fields.push({
                    key: 'uuid',
                    label: 'UUID',
                    value: song.uuid,
                    copyable: true,
                    mono: true
                });

                // Permalink for loop mode
                const baseUrl = window.location.origin + window.location.pathname;
                const permalink = `${baseUrl}#/loopsong/${song.uuid}/`;
                fields.push({
                    key: 'permalink',
                    label: 'Permalink',
                    value: permalink,
                    copyable: true,
                    mono: true
                });
            }

            return fields;
        }
    },

    template() {
        const { isVisible, song, copiedField, isLoading } = this.state;

        if (!isVisible || !song) {
            return html`<div class="modal-wrapper hidden"></div>`;
        }

        const fields = this.getMetadataFields();

        return html`
            <div class="modal-mask" on-click="handleMaskClick">
                <div class="modal-dialog">
                    <div class="modal-header">
                        <span class="modal-title">Song Info</span>
                        <button class="close-btn" on-click="hide" aria-label="Close">×</button>
                    </div>

                    <div class="modal-content">
                        ${when(isLoading, html`
                            <div class="loading-state">
                                <div class="loading-spinner"></div>
                                <div class="loading-text">Loading metadata...</div>
                            </div>
                        `, () => html`
                            ${each(fields, field => html`
                                <div class="field-row ${field.mono ? 'mono' : ''}">
                                    <div class="field-label">${field.label}</div>
                                    <div class="field-value-wrapper">
                                        <div class="field-value ${field.copyable ? 'copyable' : ''}"
                                             on-click="${(e) => field.copyable && this.copyToClipboard(field.key, field.value, e)}"
                                             title="${field.copyable ? 'Click to copy' : ''}">
                                            ${field.value}
                                            ${when(copiedField === field.key, html`
                                                <span class="copied-badge">Copied!</span>
                                            `)}
                                        </div>
                                        ${when(field.navigable, html`
                                            <button class="nav-btn" on-click="${field.onNavigate}" title="${field.navigateLabel || `Go to ${field.label}`}">
                                                →
                                            </button>
                                        `)}
                                    </div>
                                </div>
                            `)}
                        `)}
                    </div>

                    <div class="modal-footer">
                        <button class="copy-all-btn ${copiedField === 'all' ? 'copied' : ''}" on-click="copyAllMetadata" disabled="${isLoading}">
                            ${copiedField === 'all' ? 'Copied!' : 'Copy All'}
                        </button>
                        <button class="close-dialog-btn" on-click="hide">Close</button>
                    </div>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            position: fixed;
            top: 0;
            left: 0;
            z-index: 999998;
        }

        .modal-wrapper.hidden {
            display: none;
        }

        .modal-mask {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
        }

        .modal-dialog {
            background: var(--surface-100, #1e1e1e);
            border: 1px solid var(--surface-300, #404040);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            max-width: 500px;
            width: 100%;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            animation: modalShow 0.2s ease-out;
        }

        @keyframes modalShow {
            from {
                opacity: 0;
                transform: scale(0.95);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        .modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid var(--surface-300, #404040);
        }

        .modal-title {
            font-size: 1.125rem;
            font-weight: 600;
            color: var(--text-primary, #e0e0e0);
        }

        .close-btn {
            background: none;
            border: none;
            font-size: 24px;
            line-height: 1;
            cursor: pointer;
            color: var(--text-secondary, #a0a0a0);
            padding: 4px 8px;
            border-radius: 4px;
            transition: all 0.15s;
        }

        .close-btn:hover {
            background: var(--surface-200, #2a2a2a);
            color: var(--text-primary, #e0e0e0);
        }

        .modal-content {
            padding: 16px 20px;
            overflow-y: auto;
            flex: 1;
        }

        .loading-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px 20px;
            gap: 12px;
        }

        .loading-spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--surface-300, #404040);
            border-top-color: var(--primary-500, #3b82f6);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .loading-text {
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .field-row {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 10px 0;
            border-bottom: 1px solid var(--surface-200, #2a2a2a);
        }

        .field-row:last-child {
            border-bottom: none;
        }

        .field-label {
            font-size: 0.75rem;
            font-weight: 500;
            color: var(--text-secondary, #a0a0a0);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .field-value-wrapper {
            display: flex;
            align-items: flex-start;
            gap: 8px;
        }

        .field-value {
            flex: 1;
            font-size: 0.9375rem;
            color: var(--text-primary, #e0e0e0);
            word-break: break-word;
            line-height: 1.4;
            position: relative;
        }

        .field-value.copyable {
            cursor: pointer;
            padding: 6px 8px;
            margin: -6px -8px;
            border-radius: 4px;
            transition: background 0.15s;
        }

        .field-value.copyable:hover {
            background: var(--surface-200, #2a2a2a);
        }

        .field-value.copyable:active {
            background: var(--surface-300, #404040);
        }

        .field-row.mono .field-value {
            font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
            font-size: 0.8125rem;
        }

        .copied-badge {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            background: var(--primary-500, #3b82f6);
            color: white;
            font-size: 0.6875rem;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 500;
            animation: badgeFade 0.2s ease-out;
        }

        @keyframes badgeFade {
            from { opacity: 0; transform: translateY(-50%) scale(0.9); }
            to { opacity: 1; transform: translateY(-50%) scale(1); }
        }

        .nav-btn {
            flex-shrink: 0;
            background: var(--surface-200, #2a2a2a);
            border: 1px solid var(--surface-300, #404040);
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
        }

        .nav-btn:hover {
            background: var(--surface-300, #404040);
            color: var(--text-primary, #e0e0e0);
        }

        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding: 12px 20px;
            border-top: 1px solid var(--surface-300, #404040);
        }

        .copy-all-btn,
        .close-dialog-btn {
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
        }

        .copy-all-btn {
            background: var(--surface-200, #2a2a2a);
            border: 1px solid var(--surface-300, #404040);
            color: var(--text-primary, #e0e0e0);
        }

        .copy-all-btn:hover:not(:disabled) {
            background: var(--surface-300, #404040);
        }

        .copy-all-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .copy-all-btn.copied {
            background: var(--primary-500, #3b82f6);
            border-color: var(--primary-500, #3b82f6);
            color: white;
        }

        .close-dialog-btn {
            background: var(--primary-500, #3b82f6);
            border: none;
            color: white;
        }

        .close-dialog-btn:hover {
            background: var(--primary-600, #2563eb);
        }

        /* Mobile adjustments */
        @media (max-width: 480px) {
            .modal-dialog {
                max-height: 90vh;
            }

            .modal-content {
                padding: 12px 16px;
            }

            .modal-header,
            .modal-footer {
                padding: 12px 16px;
            }

            .field-value {
                font-size: 0.875rem;
            }
        }
    `
});

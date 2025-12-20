/**
 * playlist-download-btn.js - Download/delete button for offline playlists
 *
 * Shows download button if not offline, progress during download,
 * or storage info with delete option if downloaded.
 */

import { defineComponent, html, when, raw } from '../lib/framework.js';
import offlineStore, { formatBytes } from '../offline/offline-store.js';
import {
    downloadPlaylist,
    deleteOfflinePlaylist,
    cancelDownload,
    isPlaylistOffline,
    getPlaylistStorageSize
} from '../offline/offline-audio.js';
import '../componentlib/button/button.js';
import '../componentlib/overlay/dialog.js';

export default defineComponent('playlist-download-btn', {
    props: {
        playlistId: null,
        playlistName: '',
        variant: 'compact'  // 'compact' (icon) or 'full' (button with text)
    },

    stores: { offline: offlineStore },

    data() {
        return {
            isOffline: false,
            storageSize: 0,
            isLoading: true,
            isDeleting: false,
            downloadError: null,
            confirmDialog: { show: false, title: '', message: '', action: null }
        };
    },

    async mounted() {
        await this.checkOfflineStatus();
    },

    propsChanged(prop) {
        if (prop === 'playlistId') {
            this.checkOfflineStatus();
        }
    },

    methods: {
        async checkOfflineStatus() {
            if (!this.props.playlistId) {
                this.state.isLoading = false;
                return;
            }

            this.state.isLoading = true;
            try {
                this.state.isOffline = await isPlaylistOffline(this.props.playlistId);
                if (this.state.isOffline) {
                    this.state.storageSize = await getPlaylistStorageSize(this.props.playlistId);
                }
            } catch (e) {
                console.error('Failed to check offline status:', e);
            }
            this.state.isLoading = false;
        },

        async handleDownload() {
            this.state.downloadError = null;

            const result = await downloadPlaylist(this.props.playlistId);

            if (result.success) {
                this.state.isOffline = true;
                this.state.storageSize = result.totalSize;

                if (result.errors && result.errors.length > 0) {
                    console.warn('Some songs failed to download:', result.errors);
                }

                // Refresh status to get accurate storage size
                await this.checkOfflineStatus();
            } else if (result.reason !== 'cancelled') {
                this.state.downloadError = result.error || result.reason;
            }
        },

        handleCancel() {
            cancelDownload();
        },

        handleDelete() {
            this.showConfirmDialog(
                'Remove Offline Playlist',
                `Remove "${this.props.playlistName}" from offline storage?`,
                'deletePlaylist'
            );
        },

        async doDeletePlaylist() {
            this.state.isDeleting = true;
            try {
                await deleteOfflinePlaylist(this.props.playlistId);
                this.state.isOffline = false;
                this.state.storageSize = 0;
            } catch (e) {
                console.error('Failed to delete offline playlist:', e);
            }
            this.state.isDeleting = false;
        },

        showConfirmDialog(title, message, action) {
            this.state.confirmDialog = { show: true, title, message, action };
        },

        handleConfirmDialogConfirm() {
            const { action } = this.state.confirmDialog;
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };

            if (action === 'deletePlaylist') {
                this.doDeletePlaylist();
            }
        },

        handleConfirmDialogCancel() {
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };
        },

        isDownloading() {
            const progress = this.stores.offline.downloadProgress;
            return progress && progress.playlistId === this.props.playlistId;
        },

        getProgress() {
            const progress = this.stores.offline.downloadProgress;
            if (progress && progress.playlistId === this.props.playlistId) {
                return progress;
            }
            return null;
        }
    },

    template() {
        const { isOffline, storageSize, isLoading, isDeleting, downloadError, confirmDialog } = this.state;
        const { variant } = this.props;
        const progress = this.getProgress();
        const isDownloading = !!progress;
        const isFull = variant === 'full';

        let content = html``;

        if (isLoading) {
            // Compact variant shows nothing while loading
            if (isFull) {
                content = html`<div class="download-btn loading full">...</div>`;
            }
        } else if (isDownloading) {
            // Downloading state
            const percent = progress.total > 0
                ? Math.round((progress.current / progress.total) * 100)
                : 0;

            content = html`
                <div class="download-btn downloading ${isFull ? 'full' : ''}">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${percent}%"></div>
                    </div>
                    <div class="progress-info">
                        <span class="progress-text">${progress.current}/${progress.total}</span>
                        <span class="progress-song">${progress.currentSongName}</span>
                    </div>
                    <button class="cancel-btn" on-click="handleCancel" title="Cancel download">
                        ✕
                    </button>
                </div>
            `;
        } else if (isOffline) {
            // Already offline
            if (isFull) {
                content = html`
                    <div class="download-btn offline full">
                        <cl-button severity="success" size="small">
                            ✓ Offline (${formatBytes(storageSize)})
                        </cl-button>
                        <cl-button severity="secondary" size="small"
                                   on-click="handleDownload"
                                   title="Sync playlist - download new songs">
                            🔄 Sync
                        </cl-button>
                        <cl-button severity="danger" size="small"
                                   on-click="handleDelete"
                                   disabled="${isDeleting}">
                            ${isDeleting ? 'Removing...' : '🗑 Remove'}
                        </cl-button>
                    </div>
                `;
            } else {
                // Compact variant - indicator only
                content = html`
                    <div class="download-btn offline">
                        <span class="offline-badge" title="Available offline (${formatBytes(storageSize)})">✓</span>
                    </div>
                `;
            }
        } else if (isFull) {
            // Not offline - show download button (full variant only)
            content = html`
                <div class="download-btn full">
                    <cl-button severity="secondary" size="small" on-click="handleDownload">
                        ⬇ Download Offline
                    </cl-button>
                    ${when(downloadError, html`
                        <span class="error-msg" title="${downloadError}">!</span>
                    `)}
                </div>
            `;
        }

        return html`
            ${content}
            ${when(confirmDialog.show, () => html`
                <cl-dialog visible="true" header="${confirmDialog.title}" on-close="handleConfirmDialogCancel">
                    <p>${confirmDialog.message}</p>
                    <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                        <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                        <cl-button severity="danger" on-click="handleConfirmDialogConfirm">Remove</cl-button>
                    </div>
                </cl-dialog>
            `)}
        `;
    },

    styles: /*css*/`
        :host {
            display: inline-block;
        }

        :host([variant="full"]) {
            display: contents;
        }

        .download-btn {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.75rem;
        }

        .download-btn.full {
            display: contents;
        }

        .download-btn.full.downloading,
        .download-btn.full.loading {
            display: flex;
        }

        .download-btn.loading {
            color: var(--text-muted, #707070);
        }

        /* Downloading state */
        .download-btn.downloading {
            flex-direction: column;
            align-items: stretch;
            gap: 0.25rem;
            min-width: 140px;
            width: 140px;
            position: relative;
        }

        .progress-bar {
            height: 4px;
            background: var(--surface-300, #404040);
            border-radius: 2px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: var(--primary-500, #2196f3);
            transition: width 0.2s;
        }

        .progress-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 0.5rem;
            height: 1rem;
        }

        .progress-text {
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.7rem;
            font-variant-numeric: tabular-nums;
            min-width: 4.5em;
            flex-shrink: 0;
        }

        .progress-song {
            color: var(--text-muted, #707070);
            font-size: 0.65rem;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
            min-width: 0;
        }

        .cancel-btn {
            padding: 0.125rem 0.25rem;
            border: none;
            background: transparent;
            color: var(--text-muted, #707070);
            cursor: pointer;
            font-size: 0.75rem;
            position: absolute;
            right: -0.25rem;
            top: -0.25rem;
        }

        .cancel-btn:hover {
            color: var(--danger-500, #ef4444);
        }

        /* Offline state */
        .download-btn.offline {
            gap: 0.5rem;
        }

        .offline-badge {
            color: var(--success-500, #22c55e);
            font-weight: 500;
        }

        /* Error state */
        .error-msg {
            color: var(--danger-500, #ef4444);
            font-size: 0.7rem;
        }

        /* Full variant */
        .download-btn.full {
            gap: 0.5rem;
        }

        .download-btn.full.downloading {
            min-width: 200px;
            width: 200px;
        }
    `
});

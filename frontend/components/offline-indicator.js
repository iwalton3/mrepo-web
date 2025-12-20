/**
 * offline-indicator.js - Shows offline availability status for a song
 *
 * Displays an icon indicating whether a song is available offline:
 * - Downloaded (checkmark)
 * - Not available (cloud with x)
 * - Currently downloading (spinner)
 */

import { defineComponent, html, when } from '../lib/framework.js';
import offlineStore, { shouldShowOfflineWarnings } from '../offline/offline-store.js';
import { isAvailableOffline } from '../offline/offline-audio.js';

export default defineComponent('offline-indicator', {
    props: {
        songUuid: null
    },

    stores: { offline: offlineStore },

    data() {
        return {
            isOffline: false,
            isChecking: true
        };
    },

    async mounted() {
        await this.checkStatus();
    },

    propsChanged(prop) {
        if (prop === 'songUuid') {
            this.checkStatus();
        }
    },

    methods: {
        async checkStatus() {
            if (!this.props.songUuid) {
                this.state.isChecking = false;
                return;
            }

            this.state.isChecking = true;
            try {
                this.state.isOffline = await isAvailableOffline(this.props.songUuid);
            } catch (e) {
                console.error('Failed to check offline status:', e);
            }
            this.state.isChecking = false;
        },

        isDownloading() {
            const progress = this.stores.offline.downloadProgress;
            if (!progress) return false;
            return progress.currentSongUuid === this.props.songUuid;
        }
    },

    template() {
        const { isOffline, isChecking } = this.state;
        const isDownloading = this.isDownloading();

        // Show in work-offline mode, when actually offline, or when song has offline status
        const showIndicator = shouldShowOfflineWarnings() || isOffline || isDownloading;

        if (!showIndicator && !isDownloading) {
            return html``;
        }

        if (isChecking) {
            return html`<span class="offline-indicator checking">...</span>`;
        }

        if (isDownloading) {
            return html`
                <span class="offline-indicator downloading" title="Downloading...">
                    <span class="spinner"></span>
                </span>
            `;
        }

        if (isOffline) {
            return html`
                <span class="offline-indicator available" title="Available offline">
                    <span class="icon">✓</span>
                </span>
            `;
        }

        // Show unavailable indicator when in offline mode (work-offline or actually offline)
        if (shouldShowOfflineWarnings()) {
            return html`
                <span class="offline-indicator unavailable" title="Not available offline">
                    <span class="icon">☁</span>
                </span>
            `;
        }

        return html``;
    },

    styles: /*css*/`
        :host {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .offline-indicator {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            font-size: 0.75rem;
        }

        .offline-indicator.checking {
            color: var(--text-muted, #707070);
        }

        .offline-indicator.available {
            color: var(--success-500, #22c55e);
        }

        .offline-indicator.unavailable {
            color: var(--text-muted, #707070);
            opacity: 0.6;
        }

        .offline-indicator.downloading {
            color: var(--primary-500, #2196f3);
        }

        .icon {
            line-height: 1;
        }

        .spinner {
            width: 12px;
            height: 12px;
            border: 2px solid var(--surface-300, #404040);
            border-top-color: var(--primary-500, #2196f3);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    `
});

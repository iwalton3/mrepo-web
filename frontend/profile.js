/**
 * profile.js - Per-deployment configuration surface.
 *
 * Holds the deployment-specific bits (endpoints AND feature adapters) that
 * differ between the public (mrepo) build and the private (swapi) build, so the
 * rest of the app code can stay byte-identical across both. Imported via the
 * "#profile" import-map entry declared in index.html.
 *
 * This is the public (mrepo/password-auth) profile. Its counterpart in the
 * vdx-web frontend is the same shape with private wiring; keep the two in
 * deliberate, reviewed divergence - this is the ONLY app file that is meant to
 * differ.
 */

import { apiCall } from './api/music-api.js';

const config = window.MREPO_CONFIG || {};
const STREAM_BASE = config.streamBase || '/stream/';
const BASE_PATH = config.basePath || '';
const API_BASE = config.apiBase || '/api/';

/**
 * Normalize an AI-search backend result to { items: [...] } while preserving
 * any status fields (error, added, ...) the call sites also read. The public
 * (ai_*) backend returns song lists under `results` (similar) or `songs`
 * (generate/extend); collapse those onto `items`.
 */
function normalizeAiResult(r) {
    return { ...r, items: r.items || r.results || r.songs || [] };
}

export const profile = {
    endpoints: {
        /**
         * Transport endpoint for backend RPC calls.
         */
        apiBase: API_BASE,

        /**
         * Stream URL for a song by UUID and optional file extension.
         */
        audioUrl(uuid, fileExt) {
            if (fileExt) {
                const ext = fileExt.toLowerCase().replace(/^\./, '');
                return `${STREAM_BASE}${uuid}.${ext}`;
            }
            return `${STREAM_BASE}${uuid}`;
        },

        /**
         * Base path for app-relative static assets (e.g. vendored libraries).
         */
        basePath: BASE_PATH
    },

    /**
     * Radio/AI adapter capability gate. When present, the player store polls
     * AI-radio status (sca.status), offers the AI-radio toggle, and populates
     * the radio queue with sca.populateQueueAi. Set to null on deployments
     * whose backend lacks the sca_status / sca_populate_queue_ai /
     * sca_set_ai_preference surface, so the store degrades to plain
     * sca.populateQueue. This (mrepo/public) backend wires them via its
     * embedding AI service.
     */
    radio: {
        available: true
    },

    /**
     * AI-search adapter. Normalized surface consumed by now-playing,
     * playlists, quick-search, settings and song-context-menu. Wired to the
     * public backend's ai_* methods; the private build wires the same surface
     * to clap_*. Song-list results are normalized to { items }.
     *
     * status().available gates the AI UI. On this (public) build AI search is
     * OPTIONAL - the backend's ai_status probe reports whether the embedding
     * service is configured and healthy; a failure or unconfigured service
     * degrades to available=false and the AI UI stays hidden.
     */
    ai: {
        async status() {
            try {
                const s = await apiCall('ai_status');
                return { available: !!(s && s.enabled && s.status === 'ok') };
            } catch {
                return { available: false };
            }
        },
        async findSimilar(uuid, limit = 20) {
            return normalizeAiResult(await apiCall('ai_search_similar', { uuid, k: limit }));
        },
        async generatePlaylist(seedUuids, { size = 20, diversity = 0.2 } = {}) {
            return normalizeAiResult(await apiCall('ai_generate_playlist', {
                seed_uuids: seedUuids,
                size,
                diversity
            }));
        },
        async extendQueue(count = 10, diversity = 0.2) {
            return normalizeAiResult(await apiCall('ai_extend_queue', { count, diversity }));
        },
        async extendPlaylist(playlistId, count = 10, diversity = 0.2) {
            return apiCall('ai_extend_playlist', {
                playlist_id: playlistId,
                count,
                diversity
            });
        }
    },

    /**
     * Auth adapter. This (public) build has an in-app password login plus an
     * admin panel, so hasAdmin is true, register/changePassword are wired to
     * the backend, and extraRoutes contributes the /login/ and /admin/ routes
     * (whose lazy imports of the public-only page files live HERE so the shared
     * music-app never statically references them - the private build's
     * extraRoutes is null and never imports those files).
     */
    auth: {
        loginUrl: '#/login/',
        hasAdmin: true,
        supportsLogout: true,
        supportsRegister: true,
        supportsChangePassword: true,
        register(username, password) {
            return apiCall('auth_register', { username, password });
        },
        changePassword(currentPassword, newPassword) {
            return apiCall('auth_change_password', {
                current_password: currentPassword,
                new_password: newPassword
            });
        },
        extraRoutes: {
            '/login/': {
                component: 'login-page',
                load: () => import('./pages/login-page.js')
            },
            '/admin/': {
                component: 'admin-page',
                load: () => import('./pages/admin-page.js')
            }
        }
    },

    /**
     * VFS (Virtual File System) folder-management adapter. Null on this
     * (mrepo/public) deployment: the public backend has no vfs_* surface, so
     * the browse-page VFS UI (folder move / mappings dialogs) stays absent and
     * music-api strips the include_vfs song param. When a deployment's backend
     * grows VFS support, wire an object with { listMappings, moveFolder,
     * removeMapping } here to light it up - the shared vfs-folder-manager
     * component and browse-page hooks are already present and gated on this.
     */
    vfs: null,

    /**
     * Admin API - user management + library scanner (admin only). Public-only;
     * consumed by the public-only admin-page.js. Kept behind the profile seam
     * so music-api stays byte-identical across builds.
     */
    admin: {
        async listUsers() {
            return apiCall('users_list');
        },
        async createUser(username, password, capabilities = 'user') {
            return apiCall('users_create', { username, password, capabilities });
        },
        async updateUser(userId, { username, password, capabilities } = {}) {
            return apiCall('users_update', { user_id: userId, username, password, capabilities });
        },
        async deleteUser(userId) {
            return apiCall('users_delete', { user_id: userId });
        },
        async startScan(paths = null, force = false) {
            return apiCall('admin_start_scan', { paths, force });
        },
        async getScanStatus() {
            return apiCall('admin_scan_status');
        },
        async cancelScan() {
            return apiCall('admin_cancel_scan');
        },
        async getStats() {
            return apiCall('admin_get_stats');
        },
        async relocatePaths(oldPrefix, newPrefix, dryRun = true) {
            return apiCall('admin_relocate_paths', {
                old_prefix: oldPrefix,
                new_prefix: newPrefix,
                dry_run: dryRun
            });
        },
        async findMissing(limit = 100) {
            return apiCall('admin_find_missing', { limit });
        },
        async removeMissing() {
            return apiCall('admin_remove_missing');
        }
    },

    /**
     * AI Admin API - AI service management (admin only). Public-only; consumed
     * by the public-only admin-page.js.
     */
    aiAdmin: {
        async status() {
            return apiCall('admin_ai_status');
        },
        async startAnalysis(force = false) {
            return apiCall('admin_ai_start_analysis', { force });
        },
        async cancelAnalysis(jobId = null) {
            return apiCall('admin_ai_cancel_analysis', { job_id: jobId });
        },
        async clearEmbeddings() {
            return apiCall('admin_ai_clear_embeddings');
        }
    }
};

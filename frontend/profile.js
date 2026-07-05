/**
 * profile.js - Per-deployment configuration surface.
 *
 * Holds the deployment-specific bits (currently endpoints) that differ between
 * the public (mrepo) build and the private build, so the rest of the app code
 * can stay byte-identical across both. Imported via the "#profile" import-map
 * entry declared in index.html.
 */

const config = window.MREPO_CONFIG || {};
const STREAM_BASE = config.streamBase || '/stream/';
const BASE_PATH = config.basePath || '';

export const profile = {
    endpoints: {
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
     * VFS (Virtual File System) folder-management adapter. Null on this
     * (mrepo/public) deployment: the public backend has no vfs_* surface, so
     * the browse-page VFS UI (folder move / mappings dialogs) stays absent.
     * When a deployment's backend grows VFS support, wire an object with
     * { listMappings, moveFolder, removeMapping } here to light it up - the
     * shared vfs-folder-manager component and browse-page hooks are already
     * present and gated on this value.
     */
    vfs: null
};

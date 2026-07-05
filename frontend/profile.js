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
    }
};

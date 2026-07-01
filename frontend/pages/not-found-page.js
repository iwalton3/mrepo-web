/**
 * Not Found (404) Page
 *
 * Rendered when the router can't match the current URL. Registered under the
 * '/404' route key in music-app.js and reached via _findRoute's fallback.
 */

import { defineComponent, html } from '../lib/framework.js';
import { getRouter } from '../lib/router.js';

// Resolve the path the user tried to reach. Prefer the router's current route
// (already normalized); fall back to the raw hash. Returned as a plain string
// and rendered as escaped text content only - never as markup.
function getAttemptedPath() {
    try {
        const router = getRouter();
        const path = router?.currentRoute?.state?.path;
        if (path) return path;
    } catch (e) {
        // Ignore and fall through to the hash below.
    }
    return window.location.hash || '#/';
}

export default defineComponent('not-found-page', {
    data() {
        return {
            attemptedPath: getAttemptedPath()
        };
    },

    template() {
        return html`
            <div class="not-found-page">
                <div class="not-found-card">
                    <div class="not-found-icon">🔍</div>
                    <h1>Page not found</h1>
                    <p class="not-found-path">${this.state.attemptedPath}</p>
                    <p class="not-found-hint">
                        The page you were looking for doesn't exist or has moved.
                    </p>
                    <a href="#/" class="not-found-home">Back to Now Playing</a>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .not-found-page {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 60vh;
            padding: 1rem;
        }

        .not-found-card {
            text-align: center;
            max-width: 480px;
            padding: 2rem;
            background: var(--surface-100, #242424);
            border: 1px solid var(--surface-200, #2d2d2d);
            border-radius: 8px;
        }

        .not-found-icon {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
        }

        h1 {
            margin: 0 0 1rem;
            color: var(--text-primary, #e0e0e0);
        }

        .not-found-path {
            font-family: monospace;
            word-break: break-all;
            padding: 0.5rem 0.75rem;
            margin: 0 0 1rem;
            background: var(--surface-200, #2d2d2d);
            border-radius: 4px;
            color: var(--text-secondary, #a0a0a0);
        }

        .not-found-hint {
            margin: 0 0 1.5rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .not-found-home {
            display: inline-block;
            padding: 0.5rem 1rem;
            background: var(--primary-500, #2196f3);
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
        }

        .not-found-home:hover {
            background: var(--primary-400, #42a5f5);
        }
    `
});

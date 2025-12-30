/**
 * sw.js - Service Worker for Music Player PWA
 *
 * Caches all app assets from cache-manifest.json for offline support.
 * Uses cache-first strategy for static assets.
 *
 * Cache invalidation strategy:
 * - Each manifest version gets its own cache (music-static-v{version})
 * - New cache is fully populated before activation
 * - Old caches are cleaned up after activation
 * - Clients are notified to reload after update
 */

const CACHE_PREFIX = 'music-static-v';
const MANIFEST_URL = './cache-manifest.json';

// Track current cache name and version
let currentCacheName = null;
let currentVersion = null;
let isOfflineMode = false;
let retryIntervalId = null;
const RETRY_INTERVAL_MS = 30000; // Check every 30 seconds when offline

/**
 * Fetch and parse the cache manifest
 * Uses cache-busting timestamp to ensure Firefox doesn't serve stale manifest
 * Includes timeout to prevent hanging when server is unresponsive
 */
async function fetchManifest(timeoutMs = 10000) {
    try {
        // Add cache-busting timestamp to ensure we get fresh manifest
        // Firefox can be aggressive about caching even with cache: 'no-store'
        const cacheBuster = `?_=${Date.now()}`;

        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(MANIFEST_URL + cacheBuster, {
                cache: 'no-store',
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Manifest fetch failed: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[SW] Manifest fetch timed out after', timeoutMs, 'ms');
        } else {
            console.error('[SW] Failed to fetch manifest:', error);
        }
        return null;
    }
}

/**
 * Start periodic retry when in offline mode
 */
function startRetryInterval() {
    if (retryIntervalId) return; // Already running

    console.log('[SW] Starting periodic connectivity check');
    retryIntervalId = setInterval(tryReconnect, RETRY_INTERVAL_MS);
}

/**
 * Stop periodic retry (when back online)
 */
function stopRetryInterval() {
    if (retryIntervalId) {
        console.log('[SW] Stopping periodic connectivity check');
        clearInterval(retryIntervalId);
        retryIntervalId = null;
    }
}

/**
 * Try to reconnect to server and switch back to online mode
 */
async function tryReconnect() {
    if (!isOfflineMode) {
        stopRetryInterval();
        return;
    }

    console.log('[SW] Checking if server is back online...');
    const manifest = await fetchManifest(5000); // Shorter timeout for retry

    if (manifest) {
        console.log('[SW] Server is back online!');
        isOfflineMode = false;
        stopRetryInterval();

        // Notify clients we're back online
        await postMessageToClients({
            type: 'cache-status',
            status: 'online',
            version: manifest.version,
            message: 'Server connection restored'
        });

        // Check if we need to update the cache
        await updateCacheIfNeeded();
    }
}

/**
 * Find the current active cache and its version
 */
async function findCurrentCache() {
    const cacheNames = await caches.keys();
    const musicCaches = cacheNames.filter(name => name.startsWith(CACHE_PREFIX));

    for (const cacheName of musicCaches) {
        try {
            const cache = await caches.open(cacheName);
            const response = await cache.match(MANIFEST_URL);
            if (response) {
                const manifest = await response.json();
                return { cacheName, version: manifest.version };
            }
        } catch (error) {
            // Cache exists but manifest is missing/corrupt - will be cleaned up
        }
    }
    return { cacheName: null, version: null };
}

/**
 * Post a message to all clients
 */
async function postMessageToClients(message) {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
        client.postMessage(message);
    }
}

/**
 * Cache all files from manifest into a NEW versioned cache
 * Returns the new cache name on success, null on failure
 */
async function cacheManifestFiles(manifest) {
    const newCacheName = CACHE_PREFIX + manifest.version;
    const cache = await caches.open(newCacheName);
    const total = manifest.files.length;
    let current = 0;

    console.log(`[SW] Caching ${total} files for version ${manifest.version}`);

    // Notify clients that caching has started
    await postMessageToClients({
        type: 'cache-status',
        status: 'caching',
        progress: { current: 0, total },
        version: manifest.version
    });

    // Cache files in batches to avoid overwhelming the network
    const batchSize = 5;
    const errors = [];

    for (let i = 0; i < manifest.files.length; i += batchSize) {
        const batch = manifest.files.slice(i, i + batchSize);

        await Promise.all(batch.map(async (file) => {
            try {
                // Add cache-busting timestamp to ensure Firefox doesn't serve stale files
                const cacheBuster = `?_=${Date.now()}`;
                const response = await fetch(file + cacheBuster, { cache: 'no-store' });
                if (response.ok) {
                    // Store with the original path (without cache-buster) for proper matching
                    await cache.put(file, response.clone());
                    // Also store with the original URL (without cache-buster)
                    const originalUrl = new URL(file, self.location.href).href;
                    await cache.put(originalUrl, response.clone());
                } else {
                    errors.push({ file, status: response.status });
                }
            } catch (error) {
                errors.push({ file, error: error.message });
            }
            current++;
        }));

        // Update progress
        await postMessageToClients({
            type: 'cache-status',
            status: 'caching',
            progress: { current, total },
            version: manifest.version
        });
    }

    // Also cache the manifest itself (critical for version detection)
    try {
        const cacheBuster = `?_=${Date.now()}`;
        const manifestResponse = await fetch(MANIFEST_URL + cacheBuster, { cache: 'no-store' });
        if (manifestResponse.ok) {
            // Store with original path for proper matching
            await cache.put(MANIFEST_URL, manifestResponse);
        }
    } catch (error) {
        console.error('[SW] Failed to cache manifest:', error);
        errors.push({ file: MANIFEST_URL, error: error.message });
    }

    if (errors.length > 0) {
        console.warn('[SW] Some files failed to cache:', errors);
        // Delete the incomplete cache
        await caches.delete(newCacheName);
        await postMessageToClients({
            type: 'cache-status',
            status: 'error',
            version: manifest.version,
            errors
        });
        return null;
    }

    console.log(`[SW] Successfully cached version ${manifest.version}`);
    return newCacheName;
}

/**
 * Verify that critical files are in a cache
 */
async function verifyCacheIntegrity(cacheName, manifest) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const cachedUrls = new Set(keys.map(req => new URL(req.url).pathname));

    // Check if all manifest files are cached
    let missingCount = 0;
    for (const file of manifest.files) {
        if (!cachedUrls.has(file)) {
            missingCount++;
        }
    }

    return missingCount === 0;
}

/**
 * Clean up old versioned caches, keeping only the current one
 */
async function cleanupOldCaches(keepCacheName) {
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter(name =>
        name.startsWith(CACHE_PREFIX) && name !== keepCacheName
    );

    for (const cacheName of oldCaches) {
        console.log(`[SW] Deleting old cache: ${cacheName}`);
        await caches.delete(cacheName);
    }
}

/**
 * Check if cache needs updating and update if necessary
 * Returns true if an update was performed
 */
async function updateCacheIfNeeded() {
    // Fetch fresh manifest (bypass all caches)
    const manifest = await fetchManifest();

    // Find current cached version first (needed for offline fallback)
    const { cacheName: existingCacheName, version: existingVersion } = await findCurrentCache();

    if (!manifest) {
        // Server unavailable - check if we have an existing cache to use offline
        if (existingCacheName) {
            console.log('[SW] Server unavailable, using existing cache for offline mode:', existingVersion);
            currentCacheName = existingCacheName;
            currentVersion = existingVersion;
            isOfflineMode = true;
            startRetryInterval();
            await postMessageToClients({
                type: 'cache-status',
                status: 'offline',
                version: existingVersion,
                message: 'Server unavailable - using cached version'
            });
            return false;
        }

        // No existing cache and can't reach server - this is a real error
        await postMessageToClients({
            type: 'cache-status',
            status: 'error',
            error: 'Failed to fetch manifest and no cached version available'
        });
        return false;
    }

    // Server is reachable - ensure we're not in offline mode
    if (isOfflineMode) {
        isOfflineMode = false;
        stopRetryInterval();
    }

    // If versions match, verify integrity
    if (existingVersion === manifest.version && existingCacheName) {
        const isComplete = await verifyCacheIntegrity(existingCacheName, manifest);
        if (isComplete) {
            currentCacheName = existingCacheName;
            currentVersion = existingVersion;
            await postMessageToClients({
                type: 'cache-status',
                status: 'ready',
                version: existingVersion
            });
            return false;
        }
        // Cache incomplete - delete and re-cache
        console.log(`[SW] Cache incomplete for version ${existingVersion}, re-caching...`);
        await caches.delete(existingCacheName);
    }

    // Cache new version (creates new versioned cache)
    const newCacheName = await cacheManifestFiles(manifest);

    if (newCacheName) {
        // Success - update current cache reference
        const hadPreviousVersion = existingVersion && existingVersion !== manifest.version;

        // NOTE: Don't update currentCacheName here! Running pages should continue
        // using their original version for lazy-loaded modules. The switch to the
        // new version happens on navigation (page reload).
        // Only set currentCacheName if we didn't have one before (first install).
        if (!currentCacheName) {
            currentCacheName = newCacheName;
            currentVersion = manifest.version;
        }

        // Notify clients
        await postMessageToClients({
            type: 'cache-status',
            status: 'ready',
            version: manifest.version,
            updated: hadPreviousVersion,
            previousVersion: hadPreviousVersion ? existingVersion : undefined
        });

        // If this was an upgrade, suggest reload
        if (hadPreviousVersion) {
            await postMessageToClients({
                type: 'update-available',
                version: manifest.version,
                previousVersion: existingVersion
            });
        }

        return hadPreviousVersion;
    }

    return false;
}

// =============================================================================
// Service Worker Lifecycle Events
// =============================================================================

/**
 * Install event - precache all files before activating
 * This ensures the cache is ready when the app opens offline.
 */
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        (async () => {
            // Precache all files during install
            // This ensures new cache is fully ready before activation
            await updateCacheIfNeeded();

            // Skip waiting to activate immediately
            // Safe because we use versioned caches - old cache still works until cleanup
            self.skipWaiting();
            console.log('[SW] Install complete, skipping wait');
        })()
    );
});

/**
 * Activate event - claim clients and clean up
 */
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        (async () => {
            // Initialize current cache reference if not set during install
            if (!currentCacheName) {
                const { cacheName, version } = await findCurrentCache();
                currentCacheName = cacheName;
                currentVersion = version;
            }

            // Clean up any orphaned old caches
            if (currentCacheName) {
                await cleanupOldCaches(currentCacheName);
            }

            // Claim all clients
            await self.clients.claim();
            console.log('[SW] Activated and claimed clients');
        })()
    );
});

/**
 * Fetch event - cache-first for static assets
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only handle GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip API calls - let the app handle offline logic
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // Skip audio streams - handled by offline-audio.js via IndexedDB
    if (url.pathname.startsWith('/stream/')) {
        return;
    }

    // Skip cross-origin requests (except for specific CDNs if needed)
    if (url.origin !== self.location.origin) {
        return;
    }

    // Cache-first strategy for same-origin requests
    event.respondWith(
        (async () => {
            // Get current cache (or find it if not known)
            let cacheName = currentCacheName;
            if (!cacheName) {
                const found = await findCurrentCache();
                cacheName = found.cacheName;
                currentCacheName = cacheName;
                currentVersion = found.version;
            }

            // For navigation requests (page reload), switch to latest cached version
            // Safe because the page is reloading and won't need old lazy-loaded modules
            if (event.request.mode === 'navigate') {
                const found = await findCurrentCache();
                if (found.cacheName) {
                    cacheName = found.cacheName;
                    currentCacheName = found.cacheName;
                    currentVersion = found.version;
                    // Clean up any older caches
                    cleanupOldCaches(found.cacheName);
                }
            }

            // If we have a cache, try it first
            if (cacheName) {
                const cache = await caches.open(cacheName);

                // Try matching by request first
                let cachedResponse = await cache.match(event.request);

                // If no match, try matching by pathname
                if (!cachedResponse) {
                    cachedResponse = await cache.match(url.pathname);
                }

                // If still no match, try matching by full URL string
                if (!cachedResponse) {
                    cachedResponse = await cache.match(url.href);
                }

                if (cachedResponse) {
                    return cachedResponse;
                }
            }

            // Fall back to network (bypass browser HTTP cache to get fresh files)
            try {
                const networkResponse = await fetch(event.request, { cache: 'no-store' });

                // Cache successful responses for known static files (into current cache if available)
                if (networkResponse.ok && cacheName) {
                    const pathname = url.pathname;
                    if (pathname.endsWith('.js') ||
                        pathname.endsWith('.html') ||
                        pathname.endsWith('.css') ||
                        pathname.endsWith('.json') ||
                        pathname.endsWith('.svg') ||
                        pathname.endsWith('.png') ||
                        pathname.endsWith('.jpg') ||
                        pathname.endsWith('.woff') ||
                        pathname.endsWith('.woff2')) {
                        const cache = await caches.open(cacheName);
                        cache.put(event.request, networkResponse.clone());
                    }
                }

                return networkResponse;
            } catch (error) {
                console.error('[SW] Network error for:', url.pathname, error.message);

                // Network failed and not in cache
                // For navigation requests, return cached index.html
                if (event.request.mode === 'navigate' && cacheName) {
                    const cache = await caches.open(cacheName);
                    const indexResponse = await cache.match('/index.html');
                    if (indexResponse) {
                        return indexResponse;
                    }
                }

                // Return error response
                console.error('[SW] Returning 503 for:', url.pathname);
                return new Response('Offline - resource not cached: ' + url.pathname, {
                    status: 503,
                    statusText: 'Service Unavailable'
                });
            }
        })()
    );
});

/**
 * Message event - handle commands from clients
 */
self.addEventListener('message', (event) => {
    const { type, data } = event.data || {};

    switch (type) {
        case 'check-cache':
            // Client is asking for current cache status
            event.waitUntil(
                (async () => {
                    // Find current cache if not known
                    if (!currentCacheName) {
                        const found = await findCurrentCache();
                        currentCacheName = found.cacheName;
                        currentVersion = found.version;
                    }

                    if (!currentCacheName) {
                        event.source.postMessage({
                            type: 'cache-status',
                            status: 'checking',
                            version: null,
                            fileCount: 0
                        });
                        return;
                    }

                    const cache = await caches.open(currentCacheName);
                    const keys = await cache.keys();

                    // Quick check: if we have very few entries, cache is incomplete
                    if (keys.length < 10) {
                        event.source.postMessage({
                            type: 'cache-status',
                            status: 'incomplete',
                            version: currentVersion,
                            fileCount: keys.length
                        });
                        return;
                    }

                    event.source.postMessage({
                        type: 'cache-status',
                        status: 'ready',
                        version: currentVersion,
                        fileCount: keys.length
                    });
                })()
            );
            break;

        case 'update-cache':
            // Client is requesting a cache update
            event.waitUntil(updateCacheIfNeeded());
            break;

        case 'clear-cache':
            // Client is requesting cache clear (clears all versioned caches)
            event.waitUntil(
                (async () => {
                    const cacheNames = await caches.keys();
                    for (const name of cacheNames) {
                        if (name.startsWith(CACHE_PREFIX)) {
                            await caches.delete(name);
                        }
                    }
                    currentCacheName = null;
                    currentVersion = null;
                    event.source.postMessage({
                        type: 'cache-status',
                        status: 'checking'
                    });
                })()
            );
            break;

        case 'debug-cache':
            // Dump cache contents for debugging
            event.waitUntil(
                (async () => {
                    const cacheNames = await caches.keys();
                    const musicCaches = cacheNames.filter(n => n.startsWith(CACHE_PREFIX));

                    const result = {
                        type: 'cache-debug',
                        currentCacheName,
                        currentVersion,
                        allCaches: []
                    };

                    for (const name of musicCaches) {
                        const cache = await caches.open(name);
                        const keys = await cache.keys();
                        result.allCaches.push({
                            name,
                            count: keys.length,
                            urls: keys.map(req => req.url)
                        });
                    }

                    event.source.postMessage(result);
                })()
            );
            break;

        case 'skip-waiting':
            // Force the waiting SW to activate (for manual update control)
            self.skipWaiting();
            break;
    }
});

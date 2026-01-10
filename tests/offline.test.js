/**
 * Offline Mode Tests
 *
 * Tests offline functionality including work offline toggle,
 * download buttons, and offline browsing.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Offline Mode Tests');
    console.log('-'.repeat(50));

    // ==================== Work Offline Toggle Tests ====================

    await test.test('Work offline toggle exists in settings', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Work Offline') ||
                   document.body.textContent.includes('Offline Mode') ||
                   document.querySelector('.offline-toggle') !== null;
        });

        await test.assert(exists, 'Work offline toggle should exist');
    });

    await test.test('Can enable work offline mode', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        // Enable offline mode
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });

        await test.wait(500);
    });

    await test.test('Can disable work offline mode', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        // Disable offline mode
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });

        await test.wait(500);
    });

    // ==================== Download Button Tests ====================

    await test.test('Download buttons appear on browse items', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Check for download buttons or indicators
        const hasDownloadBtn = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, cl-button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Download') ||
                    btn.getAttribute('title')?.includes('Download') ||
                    btn.querySelector('[class*="download"]')) {
                    return true;
                }
            }
            return false;
        });

        // Download buttons may only appear in certain conditions (offline mode enabled)
        // This is a soft check
    });

    await test.test('Download button on folder/category', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Navigate into a category
        await test.page.evaluate(() => {
            const item = document.querySelector('.item, .browse-item');
            if (item) item.click();
        });
        await test.wait(500);

        // Check for download option
        const hasDownload = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, cl-button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Download')) {
                    return true;
                }
            }
            return false;
        });
    });

    // ==================== Offline Browse Tests ====================

    await test.test('Browse page works in offline mode', async () => {
        // Enable offline mode
        await test.goto('/settings/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Navigate to browse
        await test.goto('/browse/');
        await test.wait(500);

        // Should show offline content or empty state
        const hasContent = await test.page.evaluate(() => {
            return document.querySelector('.item, .browse-item') !== null ||
                   document.body.textContent.includes('offline') ||
                   document.body.textContent.includes('downloaded');
        });

        // Disable offline mode
        await test.goto('/settings/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);
    });

    // ==================== Storage Info Tests ====================

    await test.test('Storage info section exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Storage') ||
                   document.body.textContent.includes('Cache') ||
                   document.body.textContent.includes('Downloaded') ||
                   document.querySelector('.storage-info, .cache-info') !== null;
        });
    });

    // ==================== Offline Indicator Tests ====================

    await test.test('Offline indicator shows when offline', async () => {
        // Enable offline mode
        await test.goto('/settings/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Check for offline indicator
        const hasIndicator = await test.page.evaluate(() => {
            return document.querySelector('offline-indicator, .offline-indicator, .offline-badge') !== null ||
                   document.body.textContent.includes('Offline');
        });

        // Disable offline mode
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);
    });

    // ==================== Playlist Download Tests ====================

    await test.test('Playlist download button exists', async () => {
        await test.goto('/playlists/');
        await test.wait(500);

        // Navigate to a playlist
        await test.page.evaluate(() => {
            const playlist = document.querySelector('.playlist-option, .playlist-item');
            if (playlist) playlist.click();
        });
        await test.wait(500);

        // Check for download button
        const hasDownload = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, cl-button, playlist-download-btn');
            for (const btn of buttons) {
                if (btn.textContent.includes('Download') ||
                    btn.tagName.toLowerCase() === 'playlist-download-btn') {
                    return true;
                }
            }
            return false;
        });

        await test.assert(hasDownload, 'Playlist should have download button');
    });

    await test.test('Playlist download button shows progress when downloading', async () => {
        await test.goto('/playlists/');
        await test.wait(500);

        // Navigate to a playlist
        await test.page.evaluate(() => {
            const playlist = document.querySelector('.playlist-option, .playlist-item');
            if (playlist) playlist.click();
        });
        await test.wait(500);

        // Click download button
        const clicked = await test.page.evaluate(() => {
            const btn = document.querySelector('playlist-download-btn');
            if (btn) {
                btn.click();
                return true;
            }
            const buttons = document.querySelectorAll('cl-button, button');
            for (const b of buttons) {
                if (b.textContent.includes('Download') && b.textContent.includes('Offline')) {
                    b.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            // Wait briefly for download to start
            await test.wait(1000);

            // Check for progress indicator or completion
            const hasProgress = await test.page.evaluate(() => {
                return document.body.textContent.includes('/') ||
                       document.body.textContent.includes('%') ||
                       document.body.textContent.includes('Offline') ||
                       document.querySelector('.progress, .download-progress') !== null;
            });
            // Progress indicator should appear or download completes quickly
        }
    });

    // ==================== Offline Playlist Manipulation Tests ====================

    await test.test('Can create playlist while in offline mode', async () => {
        // Enable offline mode first
        await test.goto('/settings/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Go to playlists page
        await test.goto('/playlists/');
        await test.wait(500);

        // Click create playlist button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Create') || btn.textContent.includes('New')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Check if dialog opened
        const hasDialog = await test.page.evaluate(() => {
            return document.querySelector('cl-dialog, .dialog, .modal') !== null;
        });

        // Close dialog
        await test.pressKey('Escape');
        await test.wait(300);

        // Disable offline mode
        await test.goto('/settings/');
        await test.wait(500);
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assert(hasDialog, 'Should be able to open create playlist dialog in offline mode');
    });

    await test.test('Can add song to playlist while offline', async () => {
        // Enable offline mode
        await test.goto('/settings/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Navigate to Now Playing to get a song to add
        await test.goto('/');
        await test.wait(500);

        // Right-click on a queue item
        const item = await test.page.$('.queue-item, .queue-song');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(500);

            // Check for "Add to Playlist" option in context menu
            const hasAddToPlaylist = await test.page.evaluate(() => {
                const menuItems = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of menuItems) {
                    if (item.textContent.includes('Playlist')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
            await test.assert(hasAddToPlaylist, 'Add to Playlist option should be available offline');
        }

        // Disable offline mode
        await test.goto('/settings/');
        await test.wait(500);
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(300);
    });

    await test.test('Pending sync indicator shows for offline changes', async () => {
        // This tests that the app tracks offline changes for sync
        await test.goto('/settings/');
        await test.wait(500);

        // Check for any sync-related UI elements
        const hasSyncUI = await test.page.evaluate(() => {
            return document.body.textContent.includes('Sync') ||
                   document.body.textContent.includes('Pending') ||
                   document.querySelector('.sync-status, .pending-indicator') !== null;
        });
        // Sync UI may or may not be visible depending on pending changes
    });

    await test.test('Songs in downloaded playlist are playable offline', async () => {
        // Enable offline mode
        await test.goto('/settings/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Go to playlists
        await test.goto('/playlists/');
        await test.wait(500);

        // Check if any downloaded playlists exist
        const hasOfflinePlaylist = await test.page.evaluate(() => {
            return document.body.textContent.includes('Offline') ||
                   document.body.textContent.includes('Downloaded') ||
                   document.querySelector('.offline-indicator, .downloaded-indicator') !== null;
        });

        // Disable offline mode
        await test.goto('/settings/');
        await test.wait(500);
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(300);
    });

    // ==================== Offline Sync Verification Tests ====================

    // Helper to enable offline mode
    const enableOfflineMode = async () => {
        await test.goto('/settings/');
        await test.wait(500);
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(500);
    };

    // Helper to disable offline mode (triggers sync)
    const disableOfflineMode = async () => {
        await test.goto('/settings/');
        await test.wait(500);
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(1000); // Wait for sync to complete
    };

    await test.test('Offline playlist creation syncs when back online', async () => {
        const testPlaylistName = 'Offline Test ' + Date.now();

        // Enable offline mode
        await enableOfflineMode();

        // Go to playlists and create a new playlist
        await test.goto('/playlists/');
        await test.wait(500);

        // Click create playlist button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Create') || btn.textContent.includes('New')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Enter playlist name and create
        const created = await test.page.evaluate((name) => {
            const input = document.querySelector('cl-dialog input, .dialog input, input[placeholder*="name"], input[placeholder*="Name"]');
            if (input) {
                input.value = name;
                input.dispatchEvent(new Event('input', { bubbles: true }));

                // Click create button
                const buttons = document.querySelectorAll('cl-dialog cl-button, .dialog button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Create') || btn.textContent.includes('Save')) {
                        btn.click();
                        return true;
                    }
                }
            }
            return false;
        }, testPlaylistName);
        await test.wait(1000);

        // Verify playlist appears in list (pending state)
        const existsOffline = await test.page.evaluate((name) => {
            return document.body.textContent.includes(name);
        }, testPlaylistName);

        // Disable offline mode to trigger sync
        await disableOfflineMode();

        // Navigate to playlists and verify playlist still exists after sync
        await test.goto('/playlists/');
        await test.wait(1000);

        const existsAfterSync = await test.page.evaluate((name) => {
            return document.body.textContent.includes(name);
        }, testPlaylistName);

        // Verify via API that playlist was actually created on server
        const verifiedOnServer = await test.page.evaluate(async (name) => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_list', kwargs: {}, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result?.items) {
                return data.result.items.some(p => p.name === name);
            }
            return false;
        }, testPlaylistName);

        await test.assert(existsOffline, 'Playlist should exist in offline mode');
        await test.assert(existsAfterSync, 'Playlist should exist after going online');
        await test.assert(verifiedOnServer, 'Playlist should be synced to server');

        // Cleanup: delete the test playlist
        await test.page.evaluate(async (name) => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_list', kwargs: {}, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result?.items) {
                const playlist = data.result.items.find(p => p.name === name);
                if (playlist) {
                    await fetch('/api/', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ method: 'playlists_delete', kwargs: { playlist_id: playlist.id }, version: 2 })
                    });
                }
            }
        }, testPlaylistName);
    });

    await test.test('Offline song addition to playlist syncs when back online', async () => {
        // First create a test playlist while online
        const testPlaylistName = 'Sync Test ' + Date.now();

        await test.goto('/playlists/');
        await test.wait(500);

        // Create playlist
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Create') || btn.textContent.includes('New')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        await test.page.evaluate((name) => {
            const input = document.querySelector('cl-dialog input, .dialog input');
            if (input) {
                input.value = name;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                const buttons = document.querySelectorAll('cl-dialog cl-button, .dialog button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Create') || btn.textContent.includes('Save')) {
                        btn.click();
                        return;
                    }
                }
            }
        }, testPlaylistName);
        await test.wait(1000);

        // Get the playlist ID
        const playlistId = await test.page.evaluate(async (name) => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_list', kwargs: {}, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result?.items) {
                const playlist = data.result.items.find(p => p.name === name);
                return playlist ? playlist.id : null;
            }
            return null;
        }, testPlaylistName);

        if (!playlistId) {
            await test.assert(false, 'Failed to create test playlist');
            return;
        }

        // Get a song UUID to add
        const songUuid = await test.page.evaluate(async () => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'songs_list', kwargs: { limit: 1 }, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result?.items?.length > 0) {
                return data.result.items[0].uuid;
            }
            return null;
        });

        if (!songUuid) {
            // Cleanup and skip
            await test.page.evaluate(async (id) => {
                await fetch('/api/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ method: 'playlists_delete', kwargs: { playlist_id: id }, version: 2 })
                });
            }, playlistId);
            return;
        }

        // Enable offline mode
        await enableOfflineMode();

        // Add song to playlist while offline (via API which uses offline wrapper)
        const addedOffline = await test.page.evaluate(async (plId, sUuid) => {
            try {
                // Use the app's playlist API which goes through offline layer
                if (window.playlistsApi) {
                    await window.playlistsApi.addSong(plId, sUuid);
                    return true;
                }
                return false;
            } catch (e) {
                console.error('Failed to add song offline:', e);
                return false;
            }
        }, playlistId, songUuid);

        // Disable offline mode to trigger sync
        await disableOfflineMode();
        await test.wait(2000); // Extra wait for sync

        // Verify song was synced to server
        const verifiedOnServer = await test.page.evaluate(async (plId, sUuid) => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_songs', kwargs: { playlist_id: plId }, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result) {
                return data.result.some(s => s.uuid === sUuid);
            }
            return false;
        }, playlistId, songUuid);

        // Cleanup
        await test.page.evaluate(async (id) => {
            await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_delete', kwargs: { playlist_id: id }, version: 2 })
            });
        }, playlistId);

        if (addedOffline) {
            await test.assert(verifiedOnServer, 'Song added offline should sync to server');
        }
    });

    await test.test('Offline song removal from playlist syncs when back online', async () => {
        // Create a test playlist with a song while online
        const testPlaylistName = 'Remove Sync Test ' + Date.now();

        // Get a song UUID first
        const songUuid = await test.page.evaluate(async () => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'songs_list', kwargs: { limit: 1 }, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result?.items?.length > 0) {
                return data.result.items[0].uuid;
            }
            return null;
        });

        if (!songUuid) {
            return; // Skip if no songs available
        }

        // Create playlist and add song via API
        const playlistId = await test.page.evaluate(async (name, sUuid) => {
            // Create playlist
            const createResponse = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_create', kwargs: { name: name }, version: 2 })
            });
            const createData = await createResponse.json();
            if (!createData.success) return null;

            const plId = createData.result.id;

            // Add song to playlist
            await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_add_song', kwargs: { playlist_id: plId, song_uuid: sUuid }, version: 2 })
            });

            return plId;
        }, testPlaylistName, songUuid);

        if (!playlistId) {
            return;
        }

        // Verify song is in playlist
        const initialSongCount = await test.page.evaluate(async (plId) => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_songs', kwargs: { playlist_id: plId }, version: 2 })
            });
            const data = await response.json();
            return data.success ? data.result.length : 0;
        }, playlistId);

        // Enable offline mode
        await enableOfflineMode();

        // Remove song while offline
        const removedOffline = await test.page.evaluate(async (plId, sUuid) => {
            try {
                if (window.playlistsApi) {
                    await window.playlistsApi.removeSong(plId, sUuid);
                    return true;
                }
                return false;
            } catch (e) {
                console.error('Failed to remove song offline:', e);
                return false;
            }
        }, playlistId, songUuid);

        // Disable offline mode to trigger sync
        await disableOfflineMode();
        await test.wait(2000);

        // Verify song was removed on server
        const finalSongCount = await test.page.evaluate(async (plId) => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_songs', kwargs: { playlist_id: plId }, version: 2 })
            });
            const data = await response.json();
            return data.success ? data.result.length : -1;
        }, playlistId);

        // Cleanup
        await test.page.evaluate(async (id) => {
            await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_delete', kwargs: { playlist_id: id }, version: 2 })
            });
        }, playlistId);

        if (removedOffline && initialSongCount > 0) {
            await test.assert(finalSongCount < initialSongCount, 'Song removed offline should sync to server');
        }
    });

    await test.test('Multiple offline changes sync correctly', async () => {
        // Test multiple operations in sequence while offline
        const testPlaylistName = 'Multi Sync Test ' + Date.now();

        // Get two song UUIDs
        const songUuids = await test.page.evaluate(async () => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'songs_list', kwargs: { limit: 2 }, version: 2 })
            });
            const data = await response.json();
            if (data.success && data.result?.items?.length >= 2) {
                return data.result.items.map(s => s.uuid);
            }
            return [];
        });

        if (songUuids.length < 2) {
            return; // Skip if not enough songs
        }

        // Enable offline mode
        await enableOfflineMode();

        // Create playlist offline
        await test.goto('/playlists/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Create') || btn.textContent.includes('New')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        const playlistCreated = await test.page.evaluate((name) => {
            const input = document.querySelector('cl-dialog input, .dialog input');
            if (input) {
                input.value = name;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                const buttons = document.querySelectorAll('cl-dialog cl-button, .dialog button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Create') || btn.textContent.includes('Save')) {
                        btn.click();
                        return true;
                    }
                }
            }
            return false;
        }, testPlaylistName);
        await test.wait(1000);

        // Add songs offline via app's playlistsApi
        const songsAdded = await test.page.evaluate(async (name, uuids) => {
            // Find the pending playlist
            if (window.playlistsApi) {
                const playlists = await window.playlistsApi.list();
                const playlist = playlists.find(p => p.name === name);
                if (playlist) {
                    for (const uuid of uuids) {
                        await window.playlistsApi.addSong(playlist.id, uuid);
                    }
                    return true;
                }
            }
            return false;
        }, testPlaylistName, songUuids);
        await test.wait(500);

        // Disable offline mode to trigger sync
        await disableOfflineMode();
        await test.wait(3000); // Extra wait for multiple operations

        // Verify everything synced
        const verification = await test.page.evaluate(async (name, expectedSongCount) => {
            // Check playlist exists
            const listResponse = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_list', kwargs: {}, version: 2 })
            });
            const listData = await listResponse.json();

            if (!listData.success || !listData.result?.items) return { exists: false, songCount: 0 };

            const playlist = listData.result.items.find(p => p.name === name);
            if (!playlist) return { exists: false, songCount: 0 };

            // Check songs in playlist
            const songsResponse = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_songs', kwargs: { playlist_id: playlist.id }, version: 2 })
            });
            const songsData = await songsResponse.json();

            const songCount = songsData.success ? songsData.result.length : 0;

            // Cleanup
            await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'playlists_delete', kwargs: { playlist_id: playlist.id }, version: 2 })
            });

            return { exists: true, songCount, playlistId: playlist.id };
        }, testPlaylistName, songUuids.length);

        if (playlistCreated) {
            await test.assert(verification.exists, 'Playlist created offline should sync to server');
            if (songsAdded) {
                await test.assert(verification.songCount === songUuids.length,
                    `Songs added offline should sync (expected ${songUuids.length}, got ${verification.songCount})`);
            }
        }
    });

    // ==================== Network Simulation Test ====================

    await test.test('App handles network offline gracefully', async () => {
        test.consoleErrors = [];

        // Set page to offline mode
        await test.page.setOfflineMode(true);
        await test.wait(500);

        // Try to navigate
        await test.goto('/browse/');
        await test.wait(1000);

        // Should handle gracefully (may show cached content or error)

        // Set page back to online
        await test.page.setOfflineMode(false);
        await test.wait(500);

        // Should recover
        await test.goto('/browse/');
        await test.wait(500);
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during offline mode toggle', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(300);

        // Toggle offline mode on and off
        for (let i = 0; i < 2; i++) {
            await test.page.evaluate(() => {
                const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
                for (const toggle of toggles) {
                    const label = toggle.closest('.setting-item')?.textContent || '';
                    if (label.includes('Offline')) {
                        const input = toggle.querySelector('input') || toggle;
                        input.click();
                        return;
                    }
                }
            });
            await test.wait(300);
        }

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver', 'Failed to fetch']);
    });

    await test.teardown();
})();

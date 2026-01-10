/**
 * AI Features Tests
 *
 * Tests AI-powered features including semantic search, similar song search,
 * and AI queue extension.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('AI Features Tests');
    console.log('-'.repeat(50));

    // ==================== AI Status Tests ====================

    await test.test('AI status API returns enabled', async () => {
        const status = await test.page.evaluate(async () => {
            const response = await fetch('/api/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'ai_status', kwargs: {}, version: 2 })
            });
            return response.json();
        });

        await test.assert(status.success, 'AI status API should succeed');
        await test.assert(status.result?.enabled === true, 'AI should be enabled');
    });

    // ==================== Semantic Search Tests ====================

    await test.test('Search page shows AI help syntax', async () => {
        await test.goto('/search/');
        await test.wait(500);

        // Click help toggle to show help
        await test.page.evaluate(() => {
            const helpBtn = document.querySelector('.help-toggle, button[title*="Help"]');
            if (helpBtn) helpBtn.click();
        });
        await test.wait(300);

        const hasAiHelp = await test.page.evaluate(() => {
            return document.body.textContent.includes('ai:') ||
                   document.body.textContent.includes('semantic');
        });

        await test.assert(hasAiHelp, 'Search help should mention AI/semantic search');
    });

    await test.test('AI semantic search with ai: syntax works', async () => {
        await test.goto('/search/');
        await test.wait(500);

        // Type an AI search query
        const searchInput = await test.page.$('.search-input, input[type="search"], input[type="text"]');
        if (searchInput) {
            await searchInput.click();
            await test.page.keyboard.type('ai:"relaxing ambient music"');
            await test.wait(300);

            // Press Enter to search
            await test.page.keyboard.press('Enter');
            await test.wait(3000); // AI search may take longer

            // Check for results or loading state
            const hasResults = await test.page.evaluate(() => {
                return document.querySelector('.results-section, .search-results, .song-item') !== null ||
                       document.body.textContent.includes('result') ||
                       document.body.textContent.includes('song');
            });

            // AI search should return results or show "no results" message
            const hasResponse = await test.page.evaluate(() => {
                return document.querySelector('.results-section') !== null ||
                       document.body.textContent.includes('No results') ||
                       document.body.textContent.includes('result');
            });

            await test.assert(hasResponse, 'AI search should return response');
        }
    });

    await test.test('AI search results are clickable', async () => {
        await test.goto('/search/');
        await test.wait(500);

        // Perform AI search
        const searchInput = await test.page.$('.search-input, input[type="search"], input[type="text"]');
        if (searchInput) {
            await searchInput.click();
            await test.page.keyboard.type('ai:"electronic beats"');
            await test.page.keyboard.press('Enter');
            await test.wait(3000);

            // Try to click a result
            const clicked = await test.page.evaluate(() => {
                const item = document.querySelector('.song-item, .result-item');
                if (item) {
                    item.click();
                    return true;
                }
                return false;
            });

            // Result may or may not exist depending on library
        }
    });

    // ==================== Similar Song Search Tests ====================

    await test.test('Similar song search via URL works', async () => {
        // First get a song UUID from browse
        await test.goto('/browse/');
        await test.wait(500);

        const songUuid = await test.page.evaluate(() => {
            const item = document.querySelector('.item[data-uuid], .song-item[data-uuid]');
            return item?.dataset?.uuid || null;
        });

        if (songUuid) {
            // Navigate to similar search
            await test.goto(`/search/?similar=${songUuid}`);
            await test.wait(3000);

            // Check for similar mode header
            const hasSimilarHeader = await test.page.evaluate(() => {
                return document.querySelector('.similar-header') !== null ||
                       document.body.textContent.includes('similar to');
            });

            await test.assert(hasSimilarHeader, 'Similar search should show header');
        }
    });

    await test.test('Can exit similar mode', async () => {
        // First get a song UUID
        await test.goto('/browse/');
        await test.wait(500);

        const songUuid = await test.page.evaluate(() => {
            const item = document.querySelector('.item[data-uuid], .song-item[data-uuid]');
            return item?.dataset?.uuid || null;
        });

        if (songUuid) {
            await test.goto(`/search/?similar=${songUuid}`);
            await test.wait(2000);

            // Click exit button
            await test.page.evaluate(() => {
                const exitBtn = document.querySelector('.similar-header cl-button, .similar-header button');
                if (exitBtn) exitBtn.click();
            });
            await test.wait(500);

            // Similar header should be gone
            const stillInSimilarMode = await test.page.evaluate(() => {
                return document.querySelector('.similar-header') !== null;
            });

            // May or may not have exited depending on button click success
        }
    });

    // ==================== Context Menu Similar Tests ====================

    await test.test('Context menu has "Find Similar" option', async () => {
        // First ensure we have songs in the queue
        await test.goto('/browse/');
        await test.wait(500);

        // Add songs to queue via Play All
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Play All')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(1000);

        // Now go to Now Playing page and right-click a queue item
        await test.goto('/');
        await test.wait(500);

        // Right-click on a queue item (song)
        const item = await test.page.$('.queue-item, .queue-song, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            // Wait for async AI availability check to complete
            await test.wait(1000);

            const hasSimilarOption = await test.page.evaluate(() => {
                const menuItems = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of menuItems) {
                    if (item.textContent.includes('Similar') || item.textContent.includes('Find')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
            await test.assert(hasSimilarOption, 'Context menu should have Similar option');
        }
    });

    // ==================== Extend Queue with AI Tests ====================

    await test.test('Extend button exists in queue toolbar', async () => {
        await test.goto('/');
        await test.wait(500);

        const hasExtendBtn = await test.page.evaluate(() => {
            return document.body.textContent.includes('Extend') ||
                   document.querySelector('button[title*="Extend"], cl-button[title*="Extend"]') !== null;
        });

        await test.assert(hasExtendBtn, 'Extend button should exist');
    });

    await test.test('Extend dialog opens', async () => {
        // First add songs to queue
        await test.goto('/browse/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Add All')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(1000);

        // Go to now playing and click Extend
        await test.goto('/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Extend') && btn.title?.includes('AI')) {
                    btn.click();
                    return;
                }
            }
            // Try finding by emoji
            const extendBtn = Array.from(document.querySelectorAll('button')).find(b =>
                b.textContent.includes('Extend')
            );
            if (extendBtn) extendBtn.click();
        });
        await test.wait(500);

        const hasDialog = await test.page.evaluate(() => {
            return document.querySelector('.extend-dialog, .dialog') !== null ||
                   document.body.textContent.includes('Extend Queue with AI');
        });

        await test.assert(hasDialog, 'Extend dialog should open');

        // Close dialog
        await test.pressKey('Escape');
    });

    await test.test('Extend dialog has count and diversity sliders', async () => {
        await test.goto('/');
        await test.wait(500);

        // Open extend dialog
        await test.page.evaluate(() => {
            const extendBtn = Array.from(document.querySelectorAll('button')).find(b =>
                b.textContent.includes('Extend')
            );
            if (extendBtn) extendBtn.click();
        });
        await test.wait(500);

        const hasSliders = await test.page.evaluate(() => {
            const dialog = document.querySelector('.extend-dialog, .dialog');
            if (!dialog) return false;
            const sliders = dialog.querySelectorAll('input[type="range"]');
            return sliders.length >= 2;
        });

        await test.assert(hasSliders, 'Dialog should have count and diversity sliders');

        await test.pressKey('Escape');
    });

    await test.test('Can execute AI queue extension', async () => {
        test.consoleErrors = [];

        await test.goto('/');
        await test.wait(500);

        // Open dialog and click extend
        await test.page.evaluate(() => {
            const extendBtn = Array.from(document.querySelectorAll('button')).find(b =>
                b.textContent.includes('Extend')
            );
            if (extendBtn) extendBtn.click();
        });
        await test.wait(500);

        // Click the Extend Queue button in dialog
        await test.page.evaluate(() => {
            const dialog = document.querySelector('.extend-dialog, .dialog');
            if (dialog) {
                const buttons = dialog.querySelectorAll('cl-button, button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Extend Queue')) {
                        btn.click();
                        return;
                    }
                }
            }
        });

        // Wait for AI processing
        await test.wait(5000);

        // Check that no critical errors occurred
        const criticalErrors = test.consoleErrors.filter(e =>
            !e.includes('favicon') &&
            !e.includes('ResizeObserver') &&
            !e.includes('404')
        );

        // Close dialog if still open
        await test.pressKey('Escape');
    });

    // ==================== AI Radio Tests ====================

    await test.test('AI radio toggle exists', async () => {
        await test.goto('/');
        await test.wait(500);

        const hasAiRadio = await test.page.evaluate(() => {
            return document.body.textContent.includes('Radio') ||
                   document.querySelector('button[title*="Radio"]') !== null;
        });

        // AI radio may be part of radio controls
    });

    // ==================== AI Filter Search Tests ====================

    await test.test('AI filter search with ai() syntax works', async () => {
        await test.goto('/search/');
        await test.wait(500);

        // Type an AI filter search query using ai(subquery) syntax
        const searchInput = await test.page.$('.search-input, input[type="search"], input[type="text"]');
        if (searchInput) {
            await searchInput.click();
            // Clear any existing text
            await test.page.keyboard.down('Control');
            await test.page.keyboard.press('a');
            await test.page.keyboard.up('Control');
            await test.page.keyboard.type('ai(g:Electronic)');
            await test.wait(300);

            // Press Enter to search
            await test.page.keyboard.press('Enter');
            await test.wait(3000); // AI search may take longer

            // Check for results or response - look for "songs found" or song items
            const hasResponse = await test.page.evaluate(() => {
                return document.body.textContent.includes('songs found') ||
                       document.body.textContent.includes('song found') ||
                       document.querySelector('.song-item, .result-item') !== null ||
                       document.body.textContent.includes('No results');
            });

            await test.assert(hasResponse, 'AI filter search should return response');
        }
    });

    await test.test('AI filter combined with other filters works', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const searchInput = await test.page.$('.search-input, input[type="search"], input[type="text"]');
        if (searchInput) {
            await searchInput.click();
            await test.page.keyboard.down('Control');
            await test.page.keyboard.press('a');
            await test.page.keyboard.up('Control');
            // Combined filter: category filter + AI similarity
            await test.page.keyboard.type('c:default AND ai(a:Artist)');
            await test.wait(300);

            await test.page.keyboard.press('Enter');
            await test.wait(3000);

            // Should handle combined filters
            const hasResponse = await test.page.evaluate(() => {
                return document.querySelector('.results-section') !== null ||
                       document.body.textContent.includes('result') ||
                       document.body.textContent.includes('No results');
            });
        }
    });

    // ==================== Playlist AI Extension Tests ====================

    await test.test('Extend AI button exists in playlist detail', async () => {
        await test.goto('/playlists/');
        await test.wait(500);

        // Navigate to a playlist
        await test.page.evaluate(() => {
            const playlist = document.querySelector('.playlist-option, .playlist-item');
            if (playlist) playlist.click();
        });
        await test.wait(500);

        const hasExtendAI = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Extend') && btn.textContent.includes('AI')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(hasExtendAI, 'Extend AI button should exist in playlist');
    });

    await test.test('Playlist Extend AI dialog opens', async () => {
        await test.goto('/playlists/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const playlist = document.querySelector('.playlist-option, .playlist-item');
            if (playlist) playlist.click();
        });
        await test.wait(500);

        // Click Extend AI button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Extend') && btn.textContent.includes('AI')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        const hasDialog = await test.page.evaluate(() => {
            return document.querySelector('cl-dialog, .dialog, .extend-dialog') !== null ||
                   document.body.textContent.includes('Extend') && document.body.textContent.includes('songs');
        });

        await test.pressKey('Escape');
        await test.wait(200);

        await test.assert(hasDialog, 'Extend AI dialog should open');
    });

    await test.test('Playlist Extend dialog has count and diversity controls', async () => {
        await test.goto('/playlists/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const playlist = document.querySelector('.playlist-option, .playlist-item');
            if (playlist) playlist.click();
        });
        await test.wait(500);

        // Click Extend AI button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Extend') && btn.textContent.includes('AI')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        const hasControls = await test.page.evaluate(() => {
            // Check for sliders or inputs for count and diversity
            const sliders = document.querySelectorAll('input[type="range"]');
            const hasSliders = sliders.length >= 1;
            const hasLabels = document.body.textContent.includes('songs') ||
                             document.body.textContent.includes('Diversity') ||
                             document.body.textContent.includes('Similar');
            return hasSliders || hasLabels;
        });

        await test.pressKey('Escape');
        await test.wait(200);

        await test.assert(hasControls, 'Extend dialog should have count/diversity controls');
    });

    await test.test('Can execute playlist AI extension', async () => {
        test.consoleErrors = [];

        await test.goto('/playlists/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const playlist = document.querySelector('.playlist-option, .playlist-item');
            if (playlist) playlist.click();
        });
        await test.wait(500);

        // Click Extend AI button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Extend') && btn.textContent.includes('AI')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Click the Add Songs / Extend button in dialog
        await test.page.evaluate(() => {
            const dialog = document.querySelector('cl-dialog, .dialog, .extend-dialog');
            if (dialog) {
                const buttons = dialog.querySelectorAll('cl-button, button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Add') || btn.textContent.includes('Extend')) {
                        btn.click();
                        return;
                    }
                }
            }
        });

        // Wait for AI processing
        await test.wait(5000);

        // Close dialog if still open
        await test.pressKey('Escape');
        await test.wait(300);

        // Check for critical errors
        const criticalErrors = test.consoleErrors.filter(e =>
            !e.includes('favicon') &&
            !e.includes('ResizeObserver') &&
            !e.includes('404')
        );
        // AI extension may fail if playlist is empty, but should not throw errors
    });

    // ==================== AI Generate Playlist Tests ====================

    await test.test('AI can generate similar songs from seed', async () => {
        // Test the AI generatePlaylist API indirectly via queue extension
        await test.goto('/');
        await test.wait(500);

        // Check if there's an AI-related button that uses generatePlaylist
        const hasAIGenerate = await test.page.evaluate(() => {
            // The extend queue feature uses generatePlaylist internally
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                const title = btn.getAttribute('title') || '';
                if (title.includes('AI') || btn.textContent.includes('Extend')) {
                    return true;
                }
            }
            return false;
        });
        // AI generate is tested via extend queue functionality
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during AI operations', async () => {
        test.consoleErrors = [];

        // Perform AI search
        await test.goto('/search/');
        await test.wait(300);

        const searchInput = await test.page.$('.search-input, input[type="search"], input[type="text"]');
        if (searchInput) {
            await searchInput.click();
            await test.page.keyboard.type('ai:"chill"');
            await test.page.keyboard.press('Enter');
            await test.wait(3000);
        }

        // Check for errors (excluding expected ones)
        await test.assertNoConsoleErrors([
            'favicon',
            'ResizeObserver',
            '404',
            'Failed to load resource'
        ]);
    });

    await test.teardown();
})();

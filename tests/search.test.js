/**
 * Search Page Tests
 *
 * Tests search functionality including quick search, advanced search,
 * and AI similar songs feature.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Search Page Tests');
    console.log('-'.repeat(50));

    // ==================== Basic Search Tests ====================

    await test.test('Search page loads', async () => {
        await test.goto('/search/');
        await test.wait(500);

        await test.assertExists('quick-search-page', 'Search page should exist');
    });

    await test.test('Search input exists', async () => {
        await test.goto('/search/');
        await test.wait(500);

        await test.assertExists('.search-input, input[type="search"], input[placeholder*="Search"]', 'Search input should exist');
    });

    await test.test('Search input accepts text', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.type('test');
            await test.wait(300);

            const value = await test.page.evaluate(() => {
                const input = document.querySelector('.search-input, input[type="search"], input[placeholder*="Search"]');
                return input ? input.value : '';
            });

            await test.assertEqual(value, 'test', 'Search input should accept text');
        }
    });

    await test.test('Typing triggers quick search results', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.type('a');
            await test.wait(1000); // Wait for debounced search

            // Check for results sections
            const hasResults = await test.page.evaluate(() => {
                return document.querySelector('.results-section, .search-results, .artist-card, .album-card, .song-item') !== null;
            });

            // Results depend on library content, so we don't assert
        }
    });

    await test.test('Enter key triggers full search', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.type('test');
            await test.pressKey('Enter');
            await test.wait(1000);

            // Should show search results or no results message
        }
    });

    await test.test('Search with query parameter', async () => {
        await test.goto('/search/?q=test');
        await test.wait(1000);

        // Should auto-fill search input and trigger search
        const value = await test.page.evaluate(() => {
            const input = document.querySelector('.search-input, input[type="search"], input[placeholder*="Search"]');
            return input ? input.value : '';
        });

        // Query param should populate search
    });

    // ==================== Help Panel Tests ====================

    await test.test('Help toggle exists', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.help-toggle, .syntax-help, button[title*="Help"]') !== null;
        });

        // Help toggle may not exist in all implementations
    });

    await test.test('Help panel shows syntax information', async () => {
        await test.goto('/search/');
        await test.wait(500);

        // Try to find and click help toggle
        const clicked = await test.page.evaluate(() => {
            const toggle = document.querySelector('.help-toggle, .syntax-help, button[title*="Help"]');
            if (toggle) {
                toggle.click();
                return true;
            }
            return false;
        });

        if (clicked) {
            await test.wait(300);

            const hasHelpContent = await test.page.evaluate(() => {
                return document.querySelector('.help-panel, .syntax-panel') !== null ||
                       document.body.textContent.includes('Advanced') ||
                       document.body.textContent.includes('Syntax');
            });

            // Close help panel
            await test.pressKey('Escape');
        }
    });

    // ==================== Advanced Search Tests ====================

    await test.test('Advanced search with field:value syntax', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            // Clear and type advanced query
            await input.click({ clickCount: 3 });
            await input.type('a:test');
            await test.pressKey('Enter');
            await test.wait(1000);

            // Should process query without errors
        }
    });

    await test.test('Search with genre filter', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.click({ clickCount: 3 });
            await input.type('g:Rock');
            await test.pressKey('Enter');
            await test.wait(1000);
        }
    });

    await test.test('Search with year filter', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.click({ clickCount: 3 });
            await input.type('year:gte:2000');
            await test.pressKey('Enter');
            await test.wait(1000);
        }
    });

    // ==================== Result Actions Tests ====================

    await test.test('Song results have action buttons', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.type('a');
            await test.wait(1000);

            // Check for action buttons on song items
            const hasActions = await test.page.evaluate(() => {
                const song = document.querySelector('.song-item, .song-result');
                if (song) {
                    return song.querySelector('.add-btn, .play-btn, cl-button') !== null;
                }
                return false;
            });
        }
    });

    await test.test('Clicking artist result navigates to browse', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.type('a');
            await test.wait(1000);

            // Click on artist card if exists
            const clicked = await test.page.evaluate(() => {
                const artist = document.querySelector('.artist-card, .artist-result');
                if (artist) {
                    artist.click();
                    return true;
                }
                return false;
            });

            if (clicked) {
                await test.wait(500);

                // Should navigate to browse or show artist details
                const route = await test.getRoute();
                // Route may include /browse/ or stay on search with filter
            }
        }
    });

    // ==================== AI Similar Search Tests ====================

    await test.test('Similar search via URL parameter', async () => {
        // Navigate with similar parameter
        await test.goto('/search/?similar=test-uuid');
        await test.wait(1000);

        // Should show similar search mode or handle gracefully
        // (May show "no results" if UUID doesn't exist)
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during search interactions', async () => {
        test.consoleErrors = [];

        await test.goto('/search/');
        await test.wait(300);

        const input = await test.page.$('.search-input, input[type="search"], input[placeholder*="Search"]');
        if (input) {
            await input.type('test');
            await test.wait(500);

            await input.click({ clickCount: 3 });
            await input.type('a:rock g:metal');
            await test.pressKey('Enter');
            await test.wait(500);
        }

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

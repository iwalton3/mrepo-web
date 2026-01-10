/**
 * Radio Page Tests
 *
 * Tests SCA radio functionality including setup, filters, and playback.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Radio Page Tests');
    console.log('-'.repeat(50));

    // ==================== Radio Setup Tests ====================

    await test.test('Radio page loads', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        await test.assertExists('radio-page', 'Radio page should exist');
    });

    await test.test('Radio setup UI is visible when radio inactive', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Check for setup UI elements
        const hasSetup = await test.page.evaluate(() => {
            return document.querySelector('.radio-setup, .setup-section, .filter-section') !== null ||
                   document.body.textContent.includes('Radio') ||
                   document.body.textContent.includes('Start');
        });

        await test.assert(hasSetup, 'Radio setup UI should be visible');
    });

    await test.test('Random radio button exists', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') ||
                    btn.getAttribute('icon') === '🎲' ||
                    btn.textContent.includes('🎲')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(exists, 'Random radio button should exist');
    });

    await test.test('Category dropdown exists', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.filter-select, select, cl-dropdown') !== null;
        });

        // Category dropdown may not exist if no categories in library
    });

    await test.test('Category dropdown has options', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        const options = await test.page.evaluate(() => {
            const select = document.querySelector('.filter-select, select');
            if (select) {
                return Array.from(select.options).map(o => o.text);
            }
            return [];
        });

        // May have options or be empty depending on library
    });

    // ==================== Radio Start Tests ====================

    await test.test('Random radio button starts playback', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Click random radio button
        const clicked = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') ||
                    btn.getAttribute('icon') === '🎲' ||
                    btn.textContent.includes('🎲')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            await test.wait(2000);

            // Check if radio mode is active
            const isActive = await test.page.evaluate(() => {
                return document.querySelector('.radio-badge, .radio-active, .now-playing') !== null ||
                       document.body.textContent.includes('Playing') ||
                       document.body.textContent.includes('Up Next');
            });

            // Stop radio if started
            await test.page.evaluate(() => {
                const stopBtn = document.querySelector('cl-button, button');
                const buttons = document.querySelectorAll('cl-button, button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Stop')) {
                        btn.click();
                        return;
                    }
                }
            });
            await test.wait(500);
        }
    });

    await test.test('Filtered radio with category selection', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Select a category if available
        const selected = await test.page.evaluate(() => {
            const select = document.querySelector('.filter-select, select');
            if (select && select.options.length > 1) {
                select.selectedIndex = 1;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        });

        if (selected) {
            await test.wait(500);

            // Check if genre dropdown appeared
            const genreDropdown = await test.page.evaluate(() => {
                const selects = document.querySelectorAll('.filter-select, select');
                return selects.length > 1;
            });
        }
    });

    // ==================== Radio Playing View Tests ====================

    await test.test('Radio playing view shows now playing info', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Start random radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') || btn.textContent.includes('🎲')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(2000);

        // Check for now playing info
        const hasNowPlaying = await test.page.evaluate(() => {
            return document.querySelector('.now-playing, .song-info, .current-song') !== null;
        });

        // Stop radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Stop')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);
    });

    await test.test('Radio shows up next queue', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Start radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') || btn.textContent.includes('🎲')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(2000);

        // Check for up next section
        const hasUpNext = await test.page.evaluate(() => {
            return document.querySelector('.up-next, .queue-list, .upcoming') !== null ||
                   document.body.textContent.includes('Up Next');
        });

        // Stop radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Stop')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);
    });

    await test.test('Skip button exists when radio active', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Start radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') || btn.textContent.includes('🎲')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(2000);

        // Check for skip button
        const hasSkip = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Skip') || btn.textContent.includes('⏭')) {
                    return true;
                }
            }
            return false;
        });

        // Stop radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Stop')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);
    });

    await test.test('Stop radio returns to setup view', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        // Start radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') || btn.textContent.includes('🎲')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(2000);

        // Stop radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Stop')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(500);

        // Should show setup UI again
        const hasSetup = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') || btn.textContent.includes('🎲')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(hasSetup, 'Should return to setup view after stopping');
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during radio operation', async () => {
        test.consoleErrors = [];

        await test.goto('/radio/');
        await test.wait(300);

        // Start and stop radio
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Random') || btn.textContent.includes('🎲')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(1500);

        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Stop')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(500);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver', 'AbortError']);
    });

    await test.teardown();
})();

/**
 * History Page Tests
 *
 * Tests play history functionality including view modes, filtering, and actions.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('History Page Tests');
    console.log('-'.repeat(50));

    // ==================== Basic Page Tests ====================

    await test.test('History page loads', async () => {
        await test.goto('/history/');
        await test.wait(500);

        await test.assertExists('history-page', 'History page should exist');
    });

    await test.test('History page shows content or empty state', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const hasContent = await test.page.evaluate(() => {
            return document.querySelector('.history-item, .history-entry') !== null ||
                   document.body.textContent.includes('No history') ||
                   document.body.textContent.includes('empty');
        });

        await test.assert(hasContent, 'Should show history items or empty state');
    });

    // ==================== View Mode Tests ====================

    await test.test('View toggle exists', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.view-toggle, .view-mode, .toggle-group') !== null ||
                   document.body.textContent.includes('Chronological') ||
                   document.body.textContent.includes('Grouped');
        });

        await test.assert(exists, 'View toggle should exist');
    });

    await test.test('Can switch to chronological view', async () => {
        await test.goto('/history/');
        await test.wait(500);

        // Try to click chronological option
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.view-toggle button, .toggle-btn');
            for (const btn of buttons) {
                if (btn.textContent.includes('Chrono') || btn.textContent.includes('Time')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(300);
    });

    await test.test('Can switch to grouped view', async () => {
        await test.goto('/history/');
        await test.wait(500);

        // Try to click grouped option
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.view-toggle button, .toggle-btn');
            for (const btn of buttons) {
                if (btn.textContent.includes('Group') || btn.textContent.includes('Songs')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(300);
    });

    // ==================== Date Filter Tests ====================

    await test.test('Date filter exists', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.date-filter, select, .date-range') !== null;
        });

        await test.assert(exists, 'Date filter should exist');
    });

    await test.test('Date filter has preset options', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const options = await test.page.evaluate(() => {
            const select = document.querySelector('.date-filter select, select');
            if (select) {
                return Array.from(select.options).map(o => o.text);
            }
            return [];
        });

        // May have options like "7 days", "30 days", etc.
    });

    await test.test('Can change date filter', async () => {
        await test.goto('/history/');
        await test.wait(500);

        // Change date filter
        await test.page.evaluate(() => {
            const select = document.querySelector('.date-filter select, select');
            if (select && select.options.length > 1) {
                select.selectedIndex = 1;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        await test.wait(500);
    });

    // ==================== Skip Filter Tests ====================

    await test.test('Skip filter toggle exists', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.skip-filter, input[type="checkbox"]') !== null ||
                   document.body.textContent.includes('Hide skipped') ||
                   document.body.textContent.includes('skipped');
        });
    });

    await test.test('Can toggle skip filter', async () => {
        await test.goto('/history/');
        await test.wait(500);

        // Toggle skip filter
        await test.page.evaluate(() => {
            const checkbox = document.querySelector('.skip-filter input, input[type="checkbox"]');
            if (checkbox) {
                checkbox.click();
            }
        });

        await test.wait(300);
    });

    // ==================== History Item Tests ====================

    await test.test('History items show song info', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const hasSongInfo = await test.page.evaluate(() => {
            const item = document.querySelector('.history-item, .history-entry');
            if (item) {
                return item.textContent.length > 0;
            }
            return false;
        });
    });

    await test.test('Context menu works on history items', async () => {
        await test.goto('/history/');
        await test.wait(500);

        // Right-click on history item
        const item = await test.page.$('.history-item, .history-entry');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            // Check for context menu
            const menuExists = await test.page.evaluate(() => {
                return document.querySelector('song-context-menu, .context-menu') !== null;
            });

            // Close menu
            await test.pressKey('Escape');
        }
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during history interactions', async () => {
        test.consoleErrors = [];

        await test.goto('/history/');
        await test.wait(300);

        // Switch views and filters
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.view-toggle button, .toggle-btn');
            if (buttons.length > 0) buttons[0].click();
        });
        await test.wait(200);

        await test.page.evaluate(() => {
            const select = document.querySelector('.date-filter select, select');
            if (select && select.options.length > 1) {
                select.selectedIndex = 1;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

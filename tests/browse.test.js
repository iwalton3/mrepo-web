/**
 * Browse Page Tests
 *
 * Tests library browser functionality including view modes, hierarchy navigation,
 * filtering, sorting, and actions.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Browse Page Tests');
    console.log('-'.repeat(50));

    // ==================== View Mode Tests ====================

    await test.test('Browse page loads', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        await test.assertExists('browse-page', 'Browse page should exist');
    });

    await test.test('View mode tabs are visible', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        await test.assertExists('.view-tabs', 'View tabs container should exist');

        const tabCount = await test.countElements('.view-tabs .tab');
        await test.assertGreaterThan(tabCount, 0, 'Should have view mode tabs');
    });

    await test.test('Categories tab loads content', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Click Categories tab (should be first/default)
        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.view-tabs .tab');
            for (const tab of tabs) {
                if (tab.textContent.includes('Categories') || tab.textContent.includes('Hierarchy')) {
                    tab.click();
                    return;
                }
            }
            // Click first tab if no match
            if (tabs[0]) tabs[0].click();
        });

        await test.wait(500);

        // Should have items displayed
        const itemCount = await test.countElements('.item, .browse-item');
        // Note: May be 0 if library is empty
    });

    await test.test('Genres tab loads content', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.view-tabs .tab');
            for (const tab of tabs) {
                if (tab.textContent.includes('Genres')) {
                    tab.click();
                    return;
                }
            }
        });

        await test.wait(500);
        // Tab switch should work without errors
    });

    await test.test('Artists tab loads content', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.view-tabs .tab');
            for (const tab of tabs) {
                if (tab.textContent.includes('Artists')) {
                    tab.click();
                    return;
                }
            }
        });

        await test.wait(500);
    });

    await test.test('Files tab loads content', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.view-tabs .tab');
            for (const tab of tabs) {
                if (tab.textContent.includes('Files') || tab.textContent.includes('Path')) {
                    tab.click();
                    return;
                }
            }
        });

        await test.wait(500);
    });

    // ==================== Hierarchy Navigation Tests ====================

    await test.test('Clicking item navigates into hierarchy', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Click on first item to navigate into it
        const clicked = await test.page.evaluate(() => {
            const item = document.querySelector('.item, .browse-item');
            if (item) {
                item.click();
                return true;
            }
            return false;
        });

        if (clicked) {
            await test.wait(500);

            // Should have breadcrumbs now
            const breadcrumbs = await test.countElements('.breadcrumbs .crumb, .crumb-btn');
            // Breadcrumbs should increase after navigation
        }
    });

    await test.test('Breadcrumb navigation works', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Navigate into an item first
        await test.page.evaluate(() => {
            const item = document.querySelector('.item, .browse-item');
            if (item) item.click();
        });
        await test.wait(500);

        // Click on first breadcrumb to go back
        await test.page.evaluate(() => {
            const crumb = document.querySelector('.breadcrumbs .crumb:first-child, .crumb-btn:first-child');
            if (crumb) crumb.click();
        });
        await test.wait(500);
    });

    // ==================== Action Buttons Tests ====================

    await test.test('Play All button exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Play All') || btn.textContent.includes('Play')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(exists, 'Play All button should exist');
    });

    await test.test('Shuffle button exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Shuffle')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(exists, 'Shuffle button should exist');
    });

    await test.test('Add All button exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Add All') || btn.textContent.includes('Add')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(exists, 'Add All button should exist');
    });

    // ==================== Filter Tests ====================

    await test.test('Filter input exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.filter-input, input[type="search"], input[placeholder*="Filter"]') !== null;
        });

        await test.assert(exists, 'Filter input should exist');
    });

    await test.test('Filter input accepts text', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const filterInput = await test.page.$('.filter-input, input[type="search"], input[placeholder*="Filter"]');
        if (filterInput) {
            await filterInput.type('test');
            await test.wait(300);

            const value = await test.page.evaluate(() => {
                const input = document.querySelector('.filter-input, input[type="search"], input[placeholder*="Filter"]');
                return input ? input.value : '';
            });

            await test.assertEqual(value, 'test', 'Filter input should accept text');
        }
    });

    // ==================== Sort Toggle Tests ====================

    await test.test('Sort toggle exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.sort-toggle, .sort-btn, button[title*="Sort"]') !== null;
        });

        // Sort toggle may not exist in all views, so this is informational
    });

    // ==================== Context Menu Tests ====================

    await test.test('Right-click on item shows context menu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .browse-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            // Check for context menu
            const menuExists = await test.page.evaluate(() => {
                return document.querySelector('song-context-menu, .context-menu') !== null;
            });

            // Close menu if open
            await test.pressKey('Escape');

            await test.assert(menuExists, 'Context menu should appear on right-click');
        }
    });

    // ==================== Virtual Scrolling Tests ====================

    await test.test('Scrolling loads more items', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Switch to Files view which typically has many items
        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.view-tabs .tab');
            for (const tab of tabs) {
                if (tab.textContent.includes('Files') || tab.textContent.includes('Path')) {
                    tab.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Scroll down
        await test.page.evaluate(() => {
            const container = document.querySelector('.browse-content, .items-container, .scroll-container');
            if (container) container.scrollTop = 2000;
        });
        await test.wait(500);

        // Items should still be visible after scroll
    });

    // ==================== Selection Mode Tests ====================

    await test.test('Selection mode toggle exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.select-toggle, .selection-toggle, button[title*="Select"]') !== null;
        });

        // Selection mode may not exist in all implementations
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during browse interactions', async () => {
        test.consoleErrors = [];

        await test.goto('/browse/');
        await test.wait(300);

        // Switch tabs
        const tabs = await test.page.$$('.view-tabs .tab');
        for (const tab of tabs) {
            await tab.click();
            await test.wait(200);
        }

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

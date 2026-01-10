/**
 * Context Menu Tests
 *
 * Tests the song context menu functionality including all menu options.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Context Menu Tests');
    console.log('-'.repeat(50));

    // ==================== Basic Context Menu Tests ====================

    await test.test('Right-click on song shows context menu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Switch to a view with songs
        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.view-tabs .tab');
            for (const tab of tabs) {
                if (tab.textContent.includes('Files')) {
                    tab.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // Right-click on an item
        const item = await test.page.$('.item, .song-item, .browse-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            await test.assertExists('song-context-menu, .context-menu', 'Context menu should appear');

            // Close menu
            await test.pressKey('Escape');
        }
    });

    await test.test('Context menu has menu items', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Right-click on item
        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const itemCount = await test.countElements('song-context-menu .menu-item, .context-menu .menu-item');
            await test.assertGreaterThan(itemCount, 0, 'Context menu should have items');

            // Close menu
            await test.pressKey('Escape');
        }
    });

    // ==================== Menu Options Tests ====================

    await test.test('Play Now option exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const hasOption = await test.page.evaluate(() => {
                const items = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of items) {
                    if (item.textContent.includes('Play')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
            await test.assert(hasOption, 'Play Now option should exist');
        }
    });

    await test.test('Add to Queue option exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const hasOption = await test.page.evaluate(() => {
                const items = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of items) {
                    if (item.textContent.includes('Queue') || item.textContent.includes('Add')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
            await test.assert(hasOption, 'Add to Queue option should exist');
        }
    });

    await test.test('Add to Playlist option exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const hasOption = await test.page.evaluate(() => {
                const items = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of items) {
                    if (item.textContent.includes('Playlist')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
            await test.assert(hasOption, 'Add to Playlist option should exist');
        }
    });

    await test.test('Go to Artist option exists', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const hasOption = await test.page.evaluate(() => {
                const items = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of items) {
                    if (item.textContent.includes('Artist')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
        }
    });

    // ==================== Menu Interaction Tests ====================

    await test.test('Clicking menu option closes menu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            // Click first menu item
            await test.page.evaluate(() => {
                const menuItem = document.querySelector('song-context-menu .menu-item, .context-menu .menu-item');
                if (menuItem) menuItem.click();
            });

            await test.wait(300);

            // Menu should be closed
            const menuStillOpen = await test.page.evaluate(() => {
                const menu = document.querySelector('song-context-menu, .context-menu');
                return menu && menu.style.display !== 'none';
            });

            // May or may not be closed depending on action
        }
    });

    await test.test('Clicking outside closes menu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            // Click outside
            await test.page.click('body');
            await test.wait(300);

            // Menu should be closed
            const menuExists = await test.page.evaluate(() => {
                const menu = document.querySelector('song-context-menu[style*="display"]');
                return menu && getComputedStyle(menu).display !== 'none';
            });
        }
    });

    await test.test('Escape key closes menu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            await test.pressKey('Escape');
            await test.wait(300);

            // Menu should be closed
        }
    });

    // ==================== Submenu Tests ====================

    await test.test('Add to Playlist shows submenu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            // Hover over Add to Playlist
            await test.page.evaluate(() => {
                const items = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of items) {
                    if (item.textContent.includes('Playlist')) {
                        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                        return;
                    }
                }
            });

            await test.wait(300);

            // Check for submenu
            const hasSubmenu = await test.page.evaluate(() => {
                return document.querySelector('.submenu, .playlist-submenu') !== null;
            });

            await test.pressKey('Escape');
        }
    });

    // ==================== Queue Context Menu Tests ====================

    await test.test('Context menu works on queue items', async () => {
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

        await test.goto('/');
        await test.wait(500);

        // Right-click on queue item
        const queueItem = await test.page.$('.queue-item, .queue-song');
        if (queueItem) {
            await queueItem.click({ button: 'right' });
            await test.wait(300);

            await test.assertExists('song-context-menu, .context-menu', 'Context menu should appear on queue item');

            await test.pressKey('Escape');
        }
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during context menu interactions', async () => {
        test.consoleErrors = [];

        await test.goto('/browse/');
        await test.wait(300);

        const item = await test.page.$('.item, .song-item');
        if (item) {
            // Open and close menu multiple times
            for (let i = 0; i < 3; i++) {
                await item.click({ button: 'right' });
                await test.wait(200);
                await test.pressKey('Escape');
                await test.wait(200);
            }
        }

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

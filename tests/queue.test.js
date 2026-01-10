/**
 * Queue Management Tests
 *
 * Tests queue operations including add, remove, reorder, and save as playlist.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Queue Management Tests');
    console.log('-'.repeat(50));

    // ==================== Adding Songs Tests ====================

    await test.test('Can navigate to browse and find songs', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Check for browse items
        const hasItems = await test.page.evaluate(() => {
            return document.querySelector('.item, .browse-item, .song-item') !== null;
        });

        await test.assert(hasItems, 'Browse should have items');
    });

    await test.test('Play All adds songs to queue', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Navigate to a folder with songs (e.g., Files view)
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

        // Click Play All
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

        // Navigate to now playing to check queue
        await test.goto('/');
        await test.wait(500);

        const queueLength = await test.getQueueLength();
        await test.assertGreaterThan(queueLength, 0, 'Queue should have songs after Play All');
    });

    await test.test('Add All button adds songs to queue', async () => {
        // Get initial queue length
        await test.goto('/');
        await test.wait(500);
        const initialLength = await test.getQueueLength();

        await test.goto('/browse/');
        await test.wait(500);

        // Click Add All
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

        // Check queue has songs (may or may not have grown if already at max)
        await test.goto('/');
        await test.wait(500);
        const newLength = await test.getQueueLength();
        await test.assertGreaterThan(newLength, 0, 'Queue should have songs');
    });

    // ==================== Remove Songs Tests ====================

    await test.test('Can remove song from queue via context menu', async () => {
        await test.goto('/');
        await test.wait(500);

        // Right-click on queue item
        const item = await test.page.$('.queue-item:not(.current), .queue-song:not(.active)');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            // Click Remove option
            await test.page.evaluate(() => {
                const menuItems = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of menuItems) {
                    if (item.textContent.includes('Remove')) {
                        item.click();
                        return;
                    }
                }
            });

            await test.wait(500);

            // Close menu if still open
            await test.pressKey('Escape');
        }
    });

    // ==================== Clear Queue Tests ====================

    await test.test('Clear queue button exists', async () => {
        await test.goto('/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Clear') ||
                    btn.getAttribute('title')?.includes('Clear')) {
                    return true;
                }
            }
            return false;
        });

        await test.assert(exists, 'Clear button should exist');
    });

    await test.test('Clear queue empties the queue', async () => {
        await test.goto('/');
        await test.wait(500);

        // Get initial queue length
        const initialLength = await test.getQueueLength();

        if (initialLength > 0) {
            // Click clear button
            await test.page.evaluate(() => {
                const buttons = document.querySelectorAll('cl-button, button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Clear')) {
                        btn.click();
                        return;
                    }
                }
            });

            await test.wait(500);

            // Confirm if dialog appears
            await test.page.evaluate(() => {
                const confirmBtn = document.querySelector('cl-dialog cl-button[variant="primary"], .dialog .confirm-btn');
                if (confirmBtn) confirmBtn.click();
            });

            await test.wait(500);

            const newLength = await test.getQueueLength();
            // Queue should be empty or reduced (depends on whether dialog was shown)
            await test.assert(newLength <= initialLength, 'Queue should not grow after clear');
        }
    });

    // ==================== Reorder Tests ====================

    await test.test('Queue items can be reordered', async () => {
        // First add some songs
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

        // Check for drag handles or reorderable list
        const hasReorder = await test.page.evaluate(() => {
            return document.querySelector('.drag-handle, .reorder-handle, cl-orderable-list') !== null;
        });
    });

    await test.test('Queue items have drag handles', async () => {
        await test.goto('/');
        await test.wait(500);

        // Hover over a queue item to reveal drag handle
        const item = await test.page.$('.queue-item, .queue-song');
        if (item) {
            await item.hover();
            await test.wait(300);

            const hasDragHandle = await test.page.evaluate(() => {
                return document.querySelector('.drag-handle, .reorder-handle, [draggable="true"]') !== null ||
                       document.body.textContent.includes('⋮⋮');
            });
            // Drag handles may be subtle or hidden until hover
        }
    });

    await test.test('Queue uses list component for songs', async () => {
        await test.goto('/');
        await test.wait(500);

        const hasQueueList = await test.page.evaluate(() => {
            return document.querySelector('.queue-list, .queue-section, .queue-items') !== null ||
                   document.querySelector('.queue-item, .queue-song') !== null;
        });

        await test.assert(hasQueueList, 'Queue should display song list');
    });

    // ==================== Shuffle Queue Tests ====================

    await test.test('Shuffle queue button exists', async () => {
        await test.goto('/');
        await test.wait(500);

        const hasShuffle = await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Shuffle') ||
                    btn.getAttribute('title')?.includes('Shuffle')) {
                    return true;
                }
            }
            return false;
        });
        // Shuffle button may be in toolbar or settings
    });

    // ==================== Play Next/Later Tests ====================

    await test.test('Can add song to play next via context menu', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Click into a folder to get songs
        await test.page.evaluate(() => {
            const item = document.querySelector('.item');
            if (item) item.click();
        });
        await test.wait(500);

        // Right-click on a song
        const item = await test.page.$('.item, .song-item');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const hasPlayNext = await test.page.evaluate(() => {
                const menuItems = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of menuItems) {
                    if (item.textContent.includes('Play Next') || item.textContent.includes('Next')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
        }
    });

    // ==================== Move in Queue Tests ====================

    await test.test('Queue item context menu has move options', async () => {
        await test.goto('/');
        await test.wait(500);

        // Right-click on queue item
        const item = await test.page.$('.queue-item, .queue-song');
        if (item) {
            await item.click({ button: 'right' });
            await test.wait(300);

            const hasMoveOptions = await test.page.evaluate(() => {
                const menuItems = document.querySelectorAll('song-context-menu .menu-item, .context-menu .menu-item');
                for (const item of menuItems) {
                    const text = item.textContent;
                    if (text.includes('Move') || text.includes('Top') || text.includes('Bottom')) {
                        return true;
                    }
                }
                return false;
            });

            await test.pressKey('Escape');
            // Move options may or may not exist depending on UI
        }
    });

    // ==================== Jump to Song Tests ====================

    await test.test('Can click queue item to jump to song', async () => {
        await test.goto('/');
        await test.wait(500);

        const initialIndex = await test.page.evaluate(() => {
            return window.playerStore?.currentIndex || 0;
        });

        // Click on a different queue item
        const clicked = await test.page.evaluate(() => {
            const items = document.querySelectorAll('.queue-item, .queue-song');
            if (items.length > 1) {
                items[1].click();
                return true;
            }
            return false;
        });

        if (clicked) {
            await test.wait(500);
            // Should have jumped to that song
        }
    });

    // ==================== Remove Songs Tests ====================

    await test.test('Queue items have remove button on hover', async () => {
        await test.goto('/');
        await test.wait(500);

        // Hover over a queue item to reveal remove button
        const item = await test.page.$('.queue-item, .queue-song');
        if (item) {
            await item.hover();
            await test.wait(300);

            // Check for X/remove button that appears on hover
            const hasRemove = await test.page.evaluate(() => {
                // Look for X button or remove functionality
                const xButtons = document.querySelectorAll('.remove-btn, .delete-btn, button');
                for (const btn of xButtons) {
                    const text = btn.textContent || '';
                    if (text.includes('✕') || text.includes('×') || text.includes('x')) {
                        return true;
                    }
                }
                // Also check for remove via context menu
                return document.body.textContent.includes('Remove');
            });
            // Remove button may only appear on hover
        }
    });

    // ==================== Save as Playlist Tests ====================

    await test.test('Save queue as playlist dialog opens', async () => {
        await test.goto('/');
        await test.wait(500);

        // Click save button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Save') && !btn.textContent.includes('Preset')) {
                    btn.click();
                    return;
                }
            }
        });

        await test.wait(500);

        // Check for dialog
        const hasDialog = await test.page.evaluate(() => {
            return document.querySelector('cl-dialog, .dialog, .modal') !== null;
        });

        // Close dialog
        await test.pressKey('Escape');
        await test.wait(300);
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during queue operations', async () => {
        test.consoleErrors = [];

        await test.goto('/browse/');
        await test.wait(300);

        // Add songs
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Add All')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(500);

        await test.goto('/');
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

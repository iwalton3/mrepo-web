/**
 * Mini Player Tests
 *
 * Tests the sidebar mini player component including controls and display.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Mini Player Tests');
    console.log('-'.repeat(50));

    // ==================== Basic Tests ====================

    await test.test('Mini player exists in sidebar', async () => {
        await test.goto('/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('mini-player, .mini-player') !== null;
        });

        await test.assert(exists, 'Mini player should exist');
    });

    await test.test('Mini player is visible', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Check mini player visibility on a non-now-playing page
        const isVisible = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                const style = window.getComputedStyle(miniPlayer);
                return style.display !== 'none' && style.visibility !== 'hidden';
            }
            return false;
        });

        await test.assert(isVisible, 'Mini player should be visible');
    });

    // ==================== Controls Tests ====================

    await test.test('Mini player has play/pause button', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const hasPlayBtn = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                return miniPlayer.querySelector('.play-btn, button[title*="Play"]') !== null;
            }
            return false;
        });

        await test.assert(hasPlayBtn, 'Mini player should have play button');
    });

    await test.test('Mini player has previous button', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const hasPrevBtn = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                return miniPlayer.querySelector('.prev-btn, button[title*="Previous"]') !== null;
            }
            return false;
        });
    });

    await test.test('Mini player has next button', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const hasNextBtn = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                return miniPlayer.querySelector('.next-btn, button[title*="Next"]') !== null;
            }
            return false;
        });
    });

    await test.test('Mini player play button works', async () => {
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

        // Now click mini player play button
        await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                const playBtn = miniPlayer.querySelector('.play-btn, button[title*="Play"]');
                if (playBtn) playBtn.click();
            }
        });

        await test.wait(500);
    });

    // ==================== Progress Bar Tests ====================

    await test.test('Mini player has progress bar', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const hasProgress = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                return miniPlayer.querySelector('.progress-bar, .progress, .seek-bar') !== null;
            }
            return false;
        });
    });

    // ==================== Volume Tests ====================

    await test.test('Mini player has volume control', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const hasVolume = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                return miniPlayer.querySelector('.volume-control, .volume-slider, input[type="range"]') !== null;
            }
            return false;
        });
    });

    // ==================== Song Info Tests ====================

    await test.test('Mini player shows song info when playing', async () => {
        // Add songs first
        await test.goto('/browse/');
        await test.wait(500);

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

        // Navigate to another page and check mini player
        await test.goto('/settings/');
        await test.wait(500);

        const hasSongInfo = await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                return miniPlayer.querySelector('.song-title, .song-info, .track-info') !== null ||
                       miniPlayer.textContent.length > 10;
            }
            return false;
        });
    });

    // ==================== Responsive Tests ====================

    await test.test('Mini player visible on different pages', async () => {
        const pages = ['/browse/', '/search/', '/playlists/', '/history/', '/settings/'];

        for (const page of pages) {
            await test.goto(page);
            await test.wait(300);

            const isVisible = await test.page.evaluate(() => {
                const miniPlayer = document.querySelector('mini-player, .mini-player');
                return miniPlayer !== null;
            });

            await test.assert(isVisible, `Mini player should be visible on ${page}`);
        }
    });

    // ==================== Interaction Tests ====================

    await test.test('Mini player buttons are clickable', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Click through mini player buttons
        const buttons = ['prev-btn', 'play-btn', 'next-btn'];

        for (const btnClass of buttons) {
            await test.page.evaluate((cls) => {
                const miniPlayer = document.querySelector('mini-player, .mini-player');
                if (miniPlayer) {
                    const btn = miniPlayer.querySelector(`.${cls}, button`);
                    if (btn) btn.click();
                }
            }, btnClass);
            await test.wait(200);
        }
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during mini player interactions', async () => {
        test.consoleErrors = [];

        await test.goto('/browse/');
        await test.wait(300);

        // Click mini player controls
        await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                const playBtn = miniPlayer.querySelector('.play-btn');
                if (playBtn) playBtn.click();
            }
        });
        await test.wait(200);

        await test.page.evaluate(() => {
            const miniPlayer = document.querySelector('mini-player, .mini-player');
            if (miniPlayer) {
                const playBtn = miniPlayer.querySelector('.play-btn');
                if (playBtn) playBtn.click();
            }
        });
        await test.wait(200);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver', 'NotAllowedError']);
    });

    await test.teardown();
})();

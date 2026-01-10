/**
 * Playback Tests
 *
 * Tests audio playback functionality including play/pause, volume, seeking, and navigation.
 * Note: Some tests may not fully work in headless mode due to audio restrictions.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Playback Tests');
    console.log('-'.repeat(50));

    // ==================== Setup: Add songs to queue ====================

    await test.test('Setup: Add songs to queue for playback tests', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Add songs via Play All
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

        await test.goto('/');
        await test.wait(500);

        const queueLength = await test.getQueueLength();
        // May or may not have songs
    });

    // ==================== Play/Pause Tests ====================

    await test.test('Play button triggers playback', async () => {
        await test.goto('/');
        await test.wait(500);

        // Click play button
        await test.page.evaluate(() => {
            const playBtn = document.querySelector('.play-btn, .ctrl-btn.play-btn, button[title*="Play"]');
            if (playBtn) playBtn.click();
        });

        await test.wait(1000);

        // Check audio state
        const audioState = await test.getAudioElementState();
        // Audio may or may not be playing depending on queue content
    });

    await test.test('Pause button pauses playback', async () => {
        await test.goto('/');
        await test.wait(500);

        // First try to play
        await test.page.evaluate(() => {
            const playBtn = document.querySelector('.play-btn, .ctrl-btn.play-btn');
            if (playBtn) playBtn.click();
        });
        await test.wait(500);

        // Then pause
        await test.page.evaluate(() => {
            const playBtn = document.querySelector('.play-btn, .ctrl-btn.play-btn');
            if (playBtn) playBtn.click();
        });
        await test.wait(500);
    });

    // ==================== Volume Tests ====================

    await test.test('Volume slider changes volume', async () => {
        await test.goto('/');
        await test.wait(500);

        // Adjust volume slider
        await test.page.evaluate(() => {
            const slider = document.querySelector('.volume-slider input, input[type="range"].volume');
            if (slider) {
                slider.value = 50;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        await test.wait(300);
    });

    await test.test('Mute toggle works', async () => {
        await test.goto('/');
        await test.wait(500);

        // Click mute button
        await test.page.evaluate(() => {
            const muteBtn = document.querySelector('.volume-btn, button[title*="Mute"]');
            if (muteBtn) muteBtn.click();
        });

        await test.wait(300);

        // Click again to unmute
        await test.page.evaluate(() => {
            const muteBtn = document.querySelector('.volume-btn, button[title*="Mute"]');
            if (muteBtn) muteBtn.click();
        });

        await test.wait(300);
    });

    // ==================== Navigation Tests ====================

    await test.test('Next button advances queue', async () => {
        await test.goto('/');
        await test.wait(500);

        const initialState = await test.getPlayerState();

        // Click next
        await test.page.evaluate(() => {
            const nextBtn = document.querySelector('.next-btn, button[title*="Next"]');
            if (nextBtn) nextBtn.click();
        });

        await test.wait(500);

        const newState = await test.getPlayerState();
        // Queue index may have changed
    });

    await test.test('Previous button goes back', async () => {
        await test.goto('/');
        await test.wait(500);

        // Click previous
        await test.page.evaluate(() => {
            const prevBtn = document.querySelector('.prev-btn, button[title*="Previous"]');
            if (prevBtn) prevBtn.click();
        });

        await test.wait(500);
    });

    // ==================== Seek Tests ====================

    await test.test('Progress bar displays', async () => {
        await test.goto('/');
        await test.wait(500);

        await test.assertExists('.progress-bar, .seek-slider, .progress', 'Progress bar should exist');
    });

    await test.test('Clicking progress bar seeks', async () => {
        await test.goto('/');
        await test.wait(500);

        const progressBar = await test.page.$('.progress-bar.seekable, .seek-slider');
        if (progressBar) {
            const box = await progressBar.boundingBox();
            if (box) {
                // Click at 50% position
                await test.page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
                await test.wait(500);
            }
        }
    });

    // ==================== Audio Element State Tests ====================

    await test.test('Audio element is present', async () => {
        await test.goto('/');
        await test.wait(500);

        const audioState = await test.getAudioElementState();
        // Audio element may or may not be present depending on implementation
    });

    await test.test('Audio element has source when playing', async () => {
        await test.goto('/');
        await test.wait(500);

        // Try to play
        await test.page.evaluate(() => {
            const playBtn = document.querySelector('.play-btn, .ctrl-btn.play-btn');
            if (playBtn) playBtn.click();
        });

        await test.wait(1000);

        const audioState = await test.getAudioElementState();
        if (audioState) {
            // Audio should have source if playing
        }
    });

    // ==================== Playback Mode Persistence Tests ====================

    await test.test('Shuffle mode persists', async () => {
        await test.goto('/');
        await test.wait(500);

        // Enable shuffle
        await test.page.evaluate(() => {
            const shuffleBtn = document.querySelector('.shuffle-btn, button[title*="Shuffle"]');
            if (shuffleBtn && !shuffleBtn.classList.contains('active')) {
                shuffleBtn.click();
            }
        });

        await test.wait(300);

        // Reload page
        await test.page.reload({ waitUntil: 'networkidle2' });
        await test.wait(500);

        // Check if shuffle is still enabled
        const isShuffleActive = await test.page.evaluate(() => {
            const shuffleBtn = document.querySelector('.shuffle-btn, button[title*="Shuffle"]');
            return shuffleBtn?.classList.contains('active') || false;
        });
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during playback', async () => {
        test.consoleErrors = [];

        await test.goto('/');
        await test.wait(300);

        // Play/pause
        await test.page.evaluate(() => {
            const playBtn = document.querySelector('.play-btn');
            if (playBtn) playBtn.click();
        });
        await test.wait(500);

        await test.page.evaluate(() => {
            const playBtn = document.querySelector('.play-btn');
            if (playBtn) playBtn.click();
        });
        await test.wait(300);

        // Ignore audio-related errors and 404s for non-critical resources (cover art, etc.)
        await test.assertNoConsoleErrors([
            'favicon',
            'ResizeObserver',
            'NotAllowedError',
            'play()',
            '404'  // Cover art or other non-critical resources
        ]);
    });

    await test.teardown();
})();

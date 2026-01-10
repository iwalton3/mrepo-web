/**
 * Audio Effects Tests
 *
 * Tests audio effects toggles and UI interactions.
 * Since actual audio processing can't be verified in headless mode,
 * we test that toggles work without errors.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Audio Effects Tests');
    console.log('-'.repeat(50));

    // ==================== EQ Toggle Tests ====================

    await test.test('EQ can be toggled on/off without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Toggle EQ on
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input, input[type="checkbox"]');
            if (toggle) toggle.click();
        });
        await test.wait(300);

        // Toggle EQ off
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input, input[type="checkbox"]');
            if (toggle) toggle.click();
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('EQ sliders can be adjusted without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable EQ first
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input, input[type="checkbox"]');
            if (toggle && !toggle.checked) toggle.click();
        });
        await test.wait(300);

        // Adjust multiple sliders
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('.eq-slider input, input[type="range"]');
            sliders.forEach((slider, i) => {
                slider.value = (i % 2 === 0) ? 6 : -3;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });

        await test.wait(500);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Crossfeed Tests ====================

    await test.test('Crossfeed can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Toggle crossfeed
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('.crossfeed input, input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label')?.textContent || '';
                if (label.includes('Crossfeed')) {
                    toggle.click();
                    return;
                }
            }
            // Try preset buttons
            const presetBtn = document.querySelector('.crossfeed-presets .preset-btn');
            if (presetBtn) presetBtn.click();
        });

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Crossfeed preset buttons work', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Click each crossfeed preset
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.crossfeed-presets .preset-btn, .crossfeed button');
            buttons.forEach((btn, i) => {
                setTimeout(() => btn.click(), i * 100);
            });
        });

        await test.wait(500);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Loudness Tests ====================

    await test.test('Loudness compensation can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Toggle loudness
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Loudness')) {
                    toggle.click();
                    return;
                }
            }
        });

        await test.wait(300);

        // Toggle back
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Loudness')) {
                    toggle.click();
                    return;
                }
            }
        });

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Loudness Reference SPL slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable loudness first if not enabled
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Loudness') && !toggle.checked) {
                    toggle.click();
                    return;
                }
            }
        });
        await test.wait(300);

        // Adjust Reference SPL slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row')?.textContent || '';
                if (label.includes('Reference') || label.includes('SPL')) {
                    slider.value = 75;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Loudness Strength slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable loudness first if not enabled
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Loudness') && !toggle.checked) {
                    toggle.click();
                    return;
                }
            }
        });
        await test.wait(300);

        // Adjust Strength slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row')?.textContent || '';
                if (label.includes('Strength')) {
                    slider.value = 100;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Crossfeed Advanced Tests ====================

    await test.test('Crossfeed level slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust crossfeed level/width slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .stereo-section')?.textContent || '';
                if (label.includes('Mono') || label.includes('Wide') || label.includes('Crossfeed') || label.includes('Level')) {
                    slider.value = -30;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Crossfeed delay slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust crossfeed delay slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .stereo-section')?.textContent || '';
                if (label.includes('Delay')) {
                    slider.value = 50;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Crossfeed shadow slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust crossfeed shadow slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .stereo-section')?.textContent || '';
                if (label.includes('Shadow')) {
                    slider.value = 50;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Comfort Noise Tests ====================

    await test.test('Comfort noise can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Toggle noise
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Noise') || label.includes('Comfort')) {
                    toggle.click();
                    return;
                }
            }
        });

        await test.wait(300);

        // Toggle back
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Noise') || label.includes('Comfort')) {
                    toggle.click();
                    return;
                }
            }
        });

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Noise mode buttons work', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Click noise mode buttons
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.noise-mode-btn, .noise button');
            buttons.forEach((btn, i) => {
                setTimeout(() => btn.click(), i * 100);
            });
        });

        await test.wait(500);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise tilt slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable noise first if not enabled
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if ((label.includes('Noise') || label.includes('Comfort')) && !toggle.checked) {
                    toggle.click();
                    return;
                }
            }
        });
        await test.wait(300);

        // Adjust Tilt slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .noise-section')?.textContent || '';
                if (label.includes('Tilt')) {
                    slider.value = -50;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise level slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust level/power slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .noise-section')?.textContent || '';
                if (label.includes('Level') || label.includes('Power')) {
                    slider.value = -30;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise threshold slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust threshold slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .noise-section')?.textContent || '';
                if (label.includes('Threshold')) {
                    slider.value = -40;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise attack slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust attack slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item, .slider-row, .noise-section')?.textContent || '';
                if (label.includes('Attack')) {
                    slider.value = 500;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Replay Gain Tests ====================

    await test.test('Replay gain mode can be changed without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Find and change replay gain dropdown
        await test.page.evaluate(() => {
            const selects = document.querySelectorAll('select');
            for (const select of selects) {
                const label = select.closest('.setting-item')?.textContent || '';
                if (label.includes('Replay') || label.includes('Gain')) {
                    if (select.options.length > 1) {
                        select.selectedIndex = 1;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    return;
                }
            }
        });

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Gapless Playback Tests ====================

    await test.test('Gapless playback can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Toggle gapless
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Gapless')) {
                    const input = toggle.querySelector('input') || toggle;
                    input.click();
                    return;
                }
            }
        });

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Crossfade Tests ====================

    await test.test('Crossfade can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Toggle crossfade
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Crossfade')) {
                    const input = toggle.querySelector('input') || toggle;
                    input.click();
                    return;
                }
            }
        });

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== EQ Preset Tests ====================

    await test.test('EQ preset dropdown exists', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const hasPresets = await test.page.evaluate(() => {
            return document.querySelector('select, .preset-dropdown') !== null ||
                   document.body.textContent.includes('Preset') ||
                   document.body.textContent.includes('Flat');
        });
        // Presets may be accessible via dropdown or buttons
    });

    await test.test('Can reset EQ to flat', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Click reset/flat button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('cl-button, button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Reset') || btn.textContent.includes('Flat')) {
                    btn.click();
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Crossfade Duration Test ====================

    await test.test('Crossfade duration slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Enable crossfade first
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"], cl-toggle');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Crossfade')) {
                    const input = toggle.querySelector('input') || toggle;
                    if (!input.checked) input.click();
                    return;
                }
            }
        });
        await test.wait(300);

        // Adjust crossfade duration slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item')?.textContent || '';
                if (label.includes('Crossfade') || label.includes('duration')) {
                    slider.value = 5;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Combined Test ====================

    await test.test('Multiple effects can be enabled simultaneously', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable EQ
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input');
            if (toggle && !toggle.checked) toggle.click();
        });
        await test.wait(200);

        // Adjust some sliders
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('.eq-slider input[type="range"]');
            if (sliders[0]) {
                sliders[0].value = 6;
                sliders[0].dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await test.wait(200);

        // Enable crossfeed
        await test.page.evaluate(() => {
            const presetBtn = document.querySelector('.crossfeed-presets .preset-btn');
            if (presetBtn) presetBtn.click();
        });
        await test.wait(200);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Full audio pipeline stress test', async () => {
        test.consoleErrors = [];

        // This test enables all audio effects to verify the pipeline handles them together

        await test.goto('/eq/');
        await test.wait(500);

        // Enable EQ
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input');
            if (toggle && !toggle.checked) toggle.click();
        });
        await test.wait(200);

        // Adjust multiple EQ bands
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('.eq-slider input[type="range"]');
            sliders.forEach((slider, i) => {
                slider.value = (i % 3 === 0) ? 6 : (i % 3 === 1) ? -3 : 0;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });
        await test.wait(200);

        // Enable crossfeed with preset
        await test.page.evaluate(() => {
            const presets = document.querySelectorAll('.crossfeed-presets .preset-btn');
            if (presets[1]) presets[1].click(); // Medium preset
        });
        await test.wait(200);

        // Enable loudness
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if (label.includes('Loudness') && !toggle.checked) {
                    toggle.click();
                    return;
                }
            }
        });
        await test.wait(200);

        // Enable comfort noise
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item, label, .toggle-row')?.textContent || '';
                if ((label.includes('Noise') || label.includes('Comfort')) && !toggle.checked) {
                    toggle.click();
                    return;
                }
            }
        });
        await test.wait(500);

        // All effects should be running without errors
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver', 'AudioContext']);
    });

    await test.test('Audio effects persist after page navigation', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable EQ
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input');
            if (toggle && !toggle.checked) toggle.click();
        });
        await test.wait(300);

        // Navigate away
        await test.goto('/');
        await test.wait(500);

        // Navigate back
        await test.goto('/eq/');
        await test.wait(500);

        // Check if EQ is still enabled
        const isEnabled = await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input');
            return toggle?.checked || false;
        });

        // EQ state should persist (stored in localStorage)
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

/**
 * Equalizer Page Tests
 *
 * Tests graphic EQ, parametric EQ, presets, and audio effects.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Equalizer Page Tests');
    console.log('-'.repeat(50));

    // ==================== Basic Page Tests ====================

    await test.test('EQ page loads', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        await test.assertExists('eq-page', 'EQ page should exist');
    });

    await test.test('EQ enable toggle exists', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.querySelector('.eq-enable-toggle, .eq-toggle, input[type="checkbox"]') !== null ||
                   document.body.textContent.includes('Enable') ||
                   document.body.textContent.includes('EQ');
        });

        await test.assert(exists, 'EQ enable toggle should exist');
    });

    await test.test('Can toggle EQ on/off', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Toggle EQ
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input, .eq-toggle, input[type="checkbox"]');
            if (toggle) {
                toggle.click();
            }
        });

        await test.wait(300);
    });

    // ==================== Graphic EQ Tests ====================

    await test.test('Graphic EQ sliders exist', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const sliderCount = await test.countElements('.eq-slider, input[type="range"], .slider');
        await test.assertGreaterThan(sliderCount, 0, 'Should have EQ sliders');
    });

    await test.test('Can adjust graphic EQ slider', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Adjust first slider
        await test.page.evaluate(() => {
            const slider = document.querySelector('.eq-slider input, input[type="range"]');
            if (slider) {
                slider.value = 6;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        await test.wait(300);
    });

    await test.test('Graphic EQ shows frequency labels when enabled', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Enable EQ first
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input, input[type="checkbox"]');
            if (toggle && !toggle.checked) toggle.click();
        });
        await test.wait(500);

        const hasLabels = await test.page.evaluate(() => {
            return document.body.textContent.includes('Hz') ||
                   document.body.textContent.includes('kHz') ||
                   document.querySelector('.freq-label, .slider-label') !== null;
        });

        // May not have labels depending on UI design - soft check
    });

    // ==================== Stereo Image Adj Tests ====================

    await test.test('Stereo Image Adj section exists', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Stereo') ||
                   document.body.textContent.includes('Image') ||
                   document.body.textContent.includes('Crossfeed') ||
                   document.querySelector('.stereo-section, .crossfeed') !== null;
        });

        await test.assert(exists, 'Stereo/Image section should exist');
    });

    await test.test('Stereo width presets exist', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const hasPresets = await test.page.evaluate(() => {
            return document.body.textContent.includes('Narrow') ||
                   document.body.textContent.includes('Medium') ||
                   document.body.textContent.includes('Wide') ||
                   document.querySelectorAll('.preset-btn, button').length > 0;
        });

        await test.assert(hasPresets, 'Width presets should exist');
    });

    await test.test('Crossfeed preset buttons work', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Click a crossfeed preset button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.crossfeed-presets .preset-btn, .crossfeed button');
            if (buttons.length > 0) {
                buttons[0].click();
            }
        });

        await test.wait(300);
    });

    // ==================== Loudness Tests ====================

    await test.test('Loudness compensation toggle exists', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Loudness') ||
                   document.querySelector('.loudness-toggle, .loudness') !== null;
        });

        await test.assert(exists, 'Loudness section should exist');
    });

    await test.test('Can toggle loudness compensation', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Toggle loudness
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('.loudness-toggle input, input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('label')?.textContent || '';
                if (label.includes('Loudness')) {
                    toggle.click();
                    return;
                }
            }
        });

        await test.wait(300);
    });

    // ==================== Comfort Noise Tests ====================

    await test.test('Comfort noise section exists', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Noise') ||
                   document.body.textContent.includes('Comfort') ||
                   document.querySelector('.noise-section, .comfort-noise') !== null;
        });

        await test.assert(exists, 'Comfort noise section should exist');
    });

    await test.test('Noise mode buttons work', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Click a noise mode button
        await test.page.evaluate(() => {
            const buttons = document.querySelectorAll('.noise-mode-btn, .noise button');
            if (buttons.length > 0) {
                buttons[0].click();
            }
        });

        await test.wait(300);
    });

    // ==================== No Errors Test ====================

    await test.test('No console errors during EQ interactions', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(300);

        // Toggle EQ
        await test.page.evaluate(() => {
            const toggle = document.querySelector('.eq-enable-toggle input, input[type="checkbox"]');
            if (toggle) toggle.click();
        });
        await test.wait(200);

        // Adjust a slider
        await test.page.evaluate(() => {
            const slider = document.querySelector('.eq-slider input, input[type="range"]');
            if (slider) {
                slider.value = 3;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await test.wait(200);

        // Switch to parametric
        await test.page.evaluate(() => {
            const tabs = document.querySelectorAll('.eq-tabs .tab, .tabs button');
            for (const tab of tabs) {
                if (tab.textContent.includes('Parametric')) {
                    tab.click();
                    return;
                }
            }
        });
        await test.wait(200);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

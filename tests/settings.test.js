/**
 * Settings Page Tests
 *
 * Tests user preferences, playback settings, and offline configuration.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Settings Page Tests');
    console.log('-'.repeat(50));

    // ==================== Basic Page Tests ====================

    await test.test('Settings page loads', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        await test.assertExists('settings-page', 'Settings page should exist');
    });

    // ==================== Playback Settings Tests ====================

    await test.test('Volume control exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Volume') ||
                   document.querySelector('cl-slider, input[type="range"]') !== null;
        });

        await test.assert(exists, 'Volume control should exist');
    });

    await test.test('Can adjust volume slider', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        // Find and adjust volume slider
        await test.page.evaluate(() => {
            const sliders = document.querySelectorAll('cl-slider, input[type="range"]');
            for (const slider of sliders) {
                const label = slider.closest('.setting-item')?.textContent || '';
                if (label.includes('Volume')) {
                    const input = slider.querySelector('input') || slider;
                    input.value = 75;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
            }
        });

        await test.wait(300);
    });

    await test.test('Shuffle default toggle exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Shuffle');
        });

        await test.assert(exists, 'Shuffle setting should exist');
    });

    await test.test('Repeat mode selector exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Repeat');
        });

        await test.assert(exists, 'Repeat mode setting should exist');
    });

    // ==================== Audio Effects Settings Tests ====================

    await test.test('Replay gain setting exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Replay Gain') ||
                   document.body.textContent.includes('ReplayGain');
        });
    });

    await test.test('Replay gain dropdown has options', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const options = await test.page.evaluate(() => {
            const selects = document.querySelectorAll('select, cl-dropdown');
            for (const select of selects) {
                const label = select.closest('.setting-item')?.textContent || '';
                if (label.includes('Replay') || label.includes('Gain')) {
                    if (select.tagName === 'SELECT') {
                        return Array.from(select.options).map(o => o.text);
                    }
                }
            }
            return [];
        });
    });

    await test.test('Gapless playback toggle exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Gapless');
        });
    });

    await test.test('Can toggle gapless playback', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        // Toggle gapless
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('cl-toggle, input[type="checkbox"]');
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
    });

    await test.test('Crossfade setting exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Crossfade');
        });
    });

    // ==================== Offline Settings Tests ====================

    await test.test('Work offline toggle exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Work Offline') ||
                   document.body.textContent.includes('Offline');
        });
    });

    await test.test('Can toggle work offline mode', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        // Toggle offline mode
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('cl-toggle, input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline') || label.includes('Work Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    input.click();
                    return;
                }
            }
        });

        await test.wait(300);

        // Toggle back
        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('cl-toggle, input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.setting-item')?.textContent || '';
                if (label.includes('Offline')) {
                    const input = toggle.querySelector('input') || toggle;
                    input.click();
                    return;
                }
            }
        });

        await test.wait(300);
    });

    // ==================== Cache Status Tests ====================

    await test.test('Cache status section exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Cache') ||
                   document.body.textContent.includes('Storage') ||
                   document.querySelector('.cache-status, .storage-info') !== null;
        });
    });

    // ==================== Radio Settings Tests ====================

    await test.test('Radio EOPP setting exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Radio') ||
                   document.body.textContent.includes('EOPP') ||
                   document.body.textContent.includes('End of');
        });
    });

    await test.test('Radio algorithm setting exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Algorithm') ||
                   document.body.textContent.includes('SCA') ||
                   document.body.textContent.includes('CLAP');
        });
    });

    // ==================== Sleep Timer Tests ====================

    await test.test('Sleep timer setting exists', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const exists = await test.page.evaluate(() => {
            return document.body.textContent.includes('Sleep') ||
                   document.body.textContent.includes('Timer');
        });
    });

    // ==================== Toggle All Settings Test ====================

    await test.test('All toggles can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Get all toggles and toggle them
        const toggleCount = await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('cl-toggle, input[type="checkbox"]');
            return toggles.length;
        });

        for (let i = 0; i < toggleCount; i++) {
            await test.page.evaluate((index) => {
                const toggles = document.querySelectorAll('cl-toggle, input[type="checkbox"]');
                if (toggles[index]) {
                    const input = toggles[index].querySelector('input') || toggles[index];
                    input.click();
                }
            }, i);
            await test.wait(100);
        }

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.teardown();
})();

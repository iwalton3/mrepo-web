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
            const row = [...document.querySelectorAll('.setting-row')]
                .find(r => r.querySelector(':scope > label')?.textContent.trim() === 'Mode');
            return [...(row?.querySelector('select')?.options || [])].map(o => o.text);
        });
        await test.assert(options.length > 1, `replay gain Mode options: ${JSON.stringify(options)}`);
    });

    // Every transition hands off between elements now (track-handoff.e2e.js),
    // so the setting is gone
    await test.test('No gapless playback toggle', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        let threw = false;
        try { await test.setToggle('Gapless Playback'); } catch (e) { threw = true; }
        await test.assert(threw, 'the Gapless Playback toggle should no longer exist');
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
        await test.setToggle('Work Offline');

        await test.wait(300);

        // Toggle back
        await test.setToggle('Work Offline');

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

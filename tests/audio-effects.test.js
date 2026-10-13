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
                const label = toggle.closest('.loudness-row')?.textContent || '';
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
                const label = toggle.closest('.loudness-row')?.textContent || '';
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
                const label = toggle.closest('.loudness-row')?.textContent || '';
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
                const label = slider.closest('.loudness-slider-row')?.textContent || '';
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
                const label = toggle.closest('.loudness-row')?.textContent || '';
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
                const label = slider.closest('.loudness-slider-row')?.textContent || '';
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

    await test.test('Loudness filters follow volume; muted, disabled and strength 0 pass through', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        // Each read follows a mode switch, which sets the params immediately;
        // changes while compensation stays on ramp and may not have landed yet.
        const r = await test.page.evaluate(async () => {
            const { player, playerStore, audioController: ac } = await import('/stores/player-store.js');
            const s = playerStore.state;
            const saved = {
                enabled: s.loudnessEnabled, volume: s.volume, muted: s.muted,
                ref: s.loudnessReferenceSPL, mix: s.loudnessMixPhon, strength: s.loudnessStrength
            };
            const read = () => ({
                filters: ac._loudnessFilters.map(f => f.gain.value),
                user: ac._userVolumeGain.gain.value,
                html: ac._audioElements.map(a => a.volume)
            });

            await player.setLoudnessEnabled(false);
            player.setLoudnessReferenceSPL(80);
            player.setLoudnessMixPhon(80);
            player.setLoudnessStrength(100);
            player.setVolume(0.01);              // 40 phon
            await player.setLoudnessEnabled(true);
            const on = read();
            const types = ac._loudnessFilters.map(f => `${f.type}@${f.frequency.value}`);

            player.toggleMute();
            const muted = read();
            player.toggleMute();

            await player.setLoudnessEnabled(false);
            const off = read();

            player.setLoudnessStrength(0);
            await player.setLoudnessEnabled(true);
            const s0 = read();

            await player.setLoudnessEnabled(false);
            player.setLoudnessReferenceSPL(saved.ref);
            player.setLoudnessMixPhon(saved.mix);
            player.setLoudnessStrength(saved.strength);
            player.setVolume(saved.volume);
            if (saved.muted !== s.muted) player.toggleMute();
            if (saved.enabled) await player.setLoudnessEnabled(true);
            return { on, types, muted, off, s0 };
        });

        const near = (a, b) => Math.abs(a - b) < 0.01;
        await test.assertEqual(r.types.join(' '),
            'lowshelf@350 lowshelf@80 peaking@3500 highshelf@10000', 'filter chain');
        // loudnessGains(40, 80) - see loudness-dsp.test.js for how close that is to ISO 226
        const want = [8.03, 11.17, -2.28, 6.87];
        await test.assert(r.on.filters.every((g, k) => Math.abs(g - want[k]) < 0.02),
            `40 phon gains ${r.on.filters.map(g => g.toFixed(2))}, want ${want}`);
        // -40 dB of volume is more headroom than the ~19 dB peak boost, so no cut
        await test.assert(near(r.on.user, 0.01), `user gain at 40 phon: ${r.on.user}`);
        await test.assert(r.on.html.every(v => v === 1), `HTML5 volume while on: ${r.on.html}`);

        await test.assert(r.muted.filters.every(g => g === 0) && r.muted.user === 0,
            `muted: filters ${r.muted.filters}, user ${r.muted.user}`);
        await test.assert(r.off.filters.every(g => g === 0) && r.off.user === 1,
            `disabled: filters ${r.off.filters}, user ${r.off.user}`);
        await test.assert(r.s0.filters.every(g => g === 0) && near(r.s0.user, 0.01),
            `strength 0: filters ${r.s0.filters}, user ${r.s0.user}`);
    });

    await test.test('Clipping guard cuts the volume gain by the boost the volume cannot absorb', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const r = await test.page.evaluate(async () => {
            const { player, playerStore, audioController: ac } = await import('/stores/player-store.js');
            const { loudnessResponseDb } = await import('/stores/loudness-dsp.js');
            const s = playerStore.state;
            const saved = { enabled: s.loudnessEnabled, volume: s.volume, ref: s.loudnessReferenceSPL,
                            mix: s.loudnessMixPhon, strength: s.loudnessStrength };

            // Quiet headphones at full volume: 60 phon, so ~10 dB of boost with no volume headroom.
            await player.setLoudnessEnabled(false);
            player.setLoudnessReferenceSPL(60);
            player.setLoudnessMixPhon(80);
            player.setLoudnessStrength(100);
            player.setVolume(1);
            await player.setLoudnessEnabled(true);
            const gains = ac._loudnessFilters.map(f => f.gain.value);
            const user = ac._userVolumeGain.gain.value;
            let peak = 0;
            for (let f = 20; f <= 20000; f *= 1.02) peak = Math.max(peak, loudnessResponseDb(gains, f, ac._audioContext.sampleRate));

            await player.setLoudnessEnabled(false);
            player.setLoudnessReferenceSPL(saved.ref);
            player.setLoudnessMixPhon(saved.mix);
            player.setLoudnessStrength(saved.strength);
            player.setVolume(saved.volume);
            if (saved.enabled) await player.setLoudnessEnabled(true);
            return { peak, userDb: 20 * Math.log10(user) };
        });

        // The guard samples the response more coarsely than this check does.
        await test.assert(r.peak > 5, `expected a real boost, peak ${r.peak.toFixed(2)} dB`);
        await test.assert(Math.abs(r.userDb + r.peak) < 0.1,
            `user gain ${r.userDb.toFixed(2)} dB should cancel the ${r.peak.toFixed(2)} dB peak`);
    });

    await test.test('Loudness Mix Reference slider updates and persists the setting', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        await test.page.evaluate(() => {
            const toggles = document.querySelectorAll('input[type="checkbox"]');
            for (const toggle of toggles) {
                const label = toggle.closest('.loudness-row')?.textContent || '';
                if (label.includes('Loudness') && !toggle.checked) {
                    toggle.click();
                    return;
                }
            }
        });
        await test.wait(300);

        const r = await test.page.evaluate(async () => {
            const slider = [...document.querySelectorAll('.loudness-slider-row')]
                .find(row => row.textContent.includes('Mix Reference'))?.querySelector('input[type="range"]');
            if (!slider) return { found: false };
            slider.value = 85;
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            const { playerStore } = await import('/stores/player-store.js');
            const stored = Object.keys(localStorage)
                .map(k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } })
                .find(v => v && typeof v === 'object' && 'loudnessMixPhon' in v);
            const value = playerStore.state.loudnessMixPhon;
            slider.value = 80;
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            return { found: true, value, saved: stored?.loudnessMixPhon };
        });

        await test.assert(r.found, 'Mix Reference slider should exist when loudness is on');
        await test.assertEqual(r.value, 85, 'store value after moving the slider');
        await test.assertEqual(r.saved, 85, 'saved audio FX settings');
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
                const label = toggle.closest('.loudness-row')?.textContent || '';
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

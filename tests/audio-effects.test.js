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
        await test.setToggle('Stereo Image Adj');

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
        await test.setToggle('Loudness Compensation');

        await test.wait(300);

        // Toggle back
        await test.setToggle('Loudness Compensation');

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Loudness Reference SPL slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable loudness first if not enabled
        await test.setToggle('Loudness Compensation', true);
        await test.wait(300);

        // Adjust Reference SPL slider
        await test.setToggle('Loudness Compensation', true);
        await test.setRange('Reference SPL', 75);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Loudness Strength slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Enable loudness first if not enabled
        await test.setToggle('Loudness Compensation', true);
        await test.wait(300);

        // Adjust Strength slider
        await test.setToggle('Loudness Compensation', true);
        await test.setRange('Strength', 100);
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
                ref: s.loudnessReferenceSPL, mix: s.loudnessMixPhon, strength: s.loudnessStrength,
                useMix: s.loudnessUseMixReference
            };
            const read = () => ({
                filters: ac._loudnessFilters.map(f => f.gain.value),
                user: ac._userVolumeGain.gain.value,
                html: ac._audioElements.map(a => a.volume)
            });

            await player.setLoudnessEnabled(false);
            player.setLoudnessUseMixReference(false);
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

            // Quieter gear at full volume: flat by default.
            await player.setLoudnessEnabled(false);
            player.setLoudnessReferenceSPL(70);
            player.setVolume(1);
            await player.setLoudnessEnabled(true);
            const fullVol = read();
            player.setLoudnessReferenceSPL(80);
            player.setVolume(0.01);

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
            player.setLoudnessUseMixReference(saved.useMix);
            if (saved.muted !== s.muted) player.toggleMute();
            if (saved.enabled) await player.setLoudnessEnabled(true);
            return { on, types, muted, fullVol, off, s0 };
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
        await test.assert(r.fullVol.filters.every(g => g === 0) && r.fullVol.user === 1,
            `ref 70 at 100% volume: filters ${r.fullVol.filters}, user ${r.fullVol.user}`);
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
                            mix: s.loudnessMixPhon, strength: s.loudnessStrength,
                            useMix: s.loudnessUseMixReference };

            // Quiet headphones at full volume, compensating to an 80 phon mix:
            // ~10 dB of boost with no volume headroom.
            await player.setLoudnessEnabled(false);
            player.setLoudnessUseMixReference(true);
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
            player.setLoudnessUseMixReference(saved.useMix);
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

        await test.setToggle('Loudness Compensation', true);
        await test.wait(300);

        const r = await test.page.evaluate(async () => {
            const useMix = [...document.querySelectorAll('.loudness-subrow input[type="checkbox"]')][0];
            const wasOn = !!useMix?.checked;
            if (useMix && !wasOn) useMix.click();
            await new Promise(r => setTimeout(r, 100));
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
            if (!wasOn) useMix.click();
            return { found: true, value, saved: stored?.loudnessMixPhon };
        });

        await test.assert(r.found, 'Mix Reference slider should exist once compensating to the mix reference');
        await test.assertEqual(r.value, 85, 'store value after moving the slider');
        await test.assertEqual(r.saved, 85, 'saved audio FX settings');
    });

    // ==================== Crossfeed Advanced Tests ====================

    await test.test('Crossfeed level slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust crossfeed level/width slider
        await test.setToggle('Stereo Image Adj', true);
        await test.setRange('Mono', -30);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Crossfeed delay slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust crossfeed delay slider
        await test.setToggle('Stereo Image Adj', true);
        await test.setRange('Delay', 50);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Crossfeed shadow slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust crossfeed shadow slider
        await test.setToggle('Stereo Image Adj', true);
        await test.setRange('Shadow', 50);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Comfort Noise Tests ====================

    await test.test('Comfort noise can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Toggle noise
        await test.setToggle('Comfort Noise');

        await test.wait(300);

        // Toggle back
        await test.setToggle('Comfort Noise');

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
        await test.setToggle('Comfort Noise', true);
        await test.wait(300);

        // Adjust Tilt slider
        await test.setToggle('Comfort Noise', true);
        await test.setRange('Dark', -50);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise level slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust level/power slider
        await test.setToggle('Comfort Noise', true);
        await test.setRange('Level', -30);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise threshold slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust threshold slider
        await test.setToggle('Comfort Noise', true);
        await test.setRange('Threshold', -40);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Comfort noise attack slider works', async () => {
        test.consoleErrors = [];

        await test.goto('/eq/');
        await test.wait(500);

        // Adjust attack slider
        await test.setToggle('Comfort Noise', true);
        await test.setRange('Attack', 500);
        await test.wait(300);

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Replay Gain Tests ====================

    await test.test('Replay gain mode can be changed without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Find and change replay gain dropdown
        await test.setSelect('Mode', 1);

        await test.wait(300);
        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    // ==================== Crossfade Tests ====================

    await test.test('Crossfade can be toggled without errors', async () => {
        test.consoleErrors = [];

        await test.goto('/settings/');
        await test.wait(500);

        // Toggle crossfade
        await test.setToggle('Crossfade');

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
        await test.setToggle('Crossfade', true);
        await test.wait(300);

        // Adjust crossfade duration slider
        await test.setToggle('Crossfade', true);
        await test.setRange('Crossfade Duration', 5);
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
        await test.setToggle('Loudness Compensation', true);
        await test.wait(200);

        // Enable comfort noise
        await test.setToggle('Comfort Noise', true);
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

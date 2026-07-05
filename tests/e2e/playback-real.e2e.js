/**
 * playback-real.e2e.js — the only lane that exercises streaming.py byte-range
 * serving end to end. Plays actual fixture tracks and asserts the real audio
 * element advances, per format (opus / m4a / mp3), plus seek and next/prev.
 *
 * The player uses detached `new Audio()` elements (not in the DOM), so we reach
 * them through the exported audioController rather than document.querySelector.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

async function audioState() {
    return test.page.evaluate(async () => {
        const mod = await import('/stores/player-store.js');
        const a = mod.audioController.audio;
        if (!a) return null;
        return {
            paused: a.paused, currentTime: a.currentTime, duration: a.duration,
            readyState: a.readyState, ended: a.ended,
            errorCode: a.error ? a.error.code : null, hasSrc: !!a.src,
        };
    });
}

async function playUuid(uuid) {
    await test.page.evaluate(async (u) => {
        const mod = await import('/stores/player-store.js');
        await mod.player.clearQueue();
        await mod.player.addToQueue([{ uuid: u }], true); // playNow
    }, uuid);
}

async function waitForPlaying(timeout = 15000) {
    await test.page.waitForFunction(async () => {
        const mod = await import('/stores/player-store.js');
        const a = mod.audioController.audio;
        return a && !a.paused && a.readyState >= 2 && a.currentTime > 0 && !a.error;
    }, { timeout });
}

(async () => {
    await test.setup();
    await test.login();
    await test.goto('/');
    await test.wait(300);

    const manifest = test.loadManifest();

    console.log('Real Playback Tests');
    console.log('-'.repeat(50));

    // ---- Per-format playback (exercises direct + range streaming) ----------
    for (const fmt of ['opus', 'mp3', 'm4a']) {
        const song = manifest.perFormat[fmt];
        await test.test(`plays a ${fmt} track and currentTime advances`, async () => {
            if (!song) { throw new Error(`no ${fmt} track in fixture manifest`); }
            await playUuid(song.uuid);
            await waitForPlaying();
            const a1 = await audioState();
            await test.assert(a1.errorCode === null, `audio element error for ${fmt}: ${a1.errorCode}`);
            await test.wait(900);
            const a2 = await audioState();
            await test.assertGreaterThan(a2.currentTime, a1.currentTime,
                `${fmt} currentTime should advance (${a1.currentTime} -> ${a2.currentTime})`);
            await test.assert(a2.errorCode === null, `audio element error mid-play for ${fmt}`);
        });
    }

    // ---- Byte-range serving (streaming.py 206) -----------------------------
    await test.test('stream endpoint honours HTTP Range with a 206 response', async () => {
        const song = manifest.perFormat.opus || Object.values(manifest.perFormat)[0];
        const probe = await test.page.evaluate(async (uuid) => {
            const cfg = window.MREPO_CONFIG || {};
            const base = (cfg.streamBase || '/stream/');
            const r = await fetch(base + uuid, { headers: { Range: 'bytes=0-1023' } });
            return { status: r.status, contentRange: r.headers.get('Content-Range'),
                     acceptRanges: r.headers.get('Accept-Ranges') };
        }, song.uuid);
        await test.assertEqual(probe.status, 206, 'Range request should return 206 Partial Content');
        await test.assert(/^bytes 0-1023\//.test(probe.contentRange || ''),
            'Content-Range header should describe the served slice: ' + probe.contentRange);
    });

    // ---- Seek --------------------------------------------------------------
    await test.test('seek jumps currentTime forward', async () => {
        const song = manifest.perFormat.opus || Object.values(manifest.perFormat)[0];
        await playUuid(song.uuid);
        await waitForPlaying();
        const target = 5;
        await test.page.evaluate(async (t) => {
            const mod = await import('/stores/player-store.js');
            await mod.player.seek(t);
        }, target);
        await test.page.waitForFunction(async (t) => {
            const mod = await import('/stores/player-store.js');
            const a = mod.audioController.audio;
            return a && a.currentTime >= t - 0.5;
        }, { timeout: 8000 }, target);
        const a = await audioState();
        await test.assertGreaterThan(a.currentTime, target - 0.5, 'currentTime should reach the seek target');
    });

    // ---- Next / Previous ---------------------------------------------------
    await test.test('next and previous move between tracks', async () => {
        // Build a 3-song queue and play the first.
        const sl = await test.apiCall('songs_list', { limit: 3, sort: 'title', order: 'asc' });
        const uuids = sl.result.items.map((i) => i.uuid);
        await test.page.evaluate(async (uu) => {
            const mod = await import('/stores/player-store.js');
            await mod.player.clearQueue();
            await mod.player.addToQueue(uu.map((u) => ({ uuid: u })), true);
        }, uuids);
        await waitForPlaying();

        const cur = () => test.page.evaluate(async () => {
            const mod = await import('/stores/player-store.js');
            const s = mod.player.state.currentSong;
            return s ? s.uuid : null;
        });
        const first = await cur();

        await test.page.evaluate(async () => {
            const mod = await import('/stores/player-store.js');
            await mod.player.next();
        });
        await test.page.waitForFunction(async (prev) => {
            const mod = await import('/stores/player-store.js');
            const s = mod.player.state.currentSong;
            return s && s.uuid !== prev;
        }, { timeout: 8000 }, first);
        const second = await cur();
        await test.assertNotEqual(second, first, 'next() should change the current song');

        await test.page.evaluate(async () => {
            const mod = await import('/stores/player-store.js');
            await mod.player.previous();
        });
        await test.page.waitForFunction(async (want) => {
            const mod = await import('/stores/player-store.js');
            const s = mod.player.state.currentSong;
            return s && s.uuid === want;
        }, { timeout: 8000 }, first);
        const back = await cur();
        await test.assertEqual(back, first, 'previous() should return to the first song');
    });

    await test.teardown();
})();

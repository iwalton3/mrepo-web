/**
 * track-handoff.e2e.js — a track change must never leave both audio elements
 * stopped at once. Android freezes a background page whose playing element ends
 * (or is reloaded) before another plays, and playback dies seconds into the next
 * song. Headless Chrome does not freeze, so this pins the invariant instead:
 * through every kind of transition, at least one of the two elements is playing
 * (not paused, not ended) at every event and every 4 ms sample.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

const STORE = '/stores/player-store.js';

// Start watching both elements. Elements are replaced by a pipeline rebuild, so
// call this after any setting that builds the pipeline.
async function startWatch() {
    await test.page.evaluate(async (store) => {
        const { audioController: ac } = await import(store);
        if (window.__handoff) window.__handoff.stop();
        const els = [...ac._audioElements];
        const alive = (a) => !a.paused && !a.ended;
        const w = { dead: [], starts: [], timer: null, handlers: [] };
        const check = (why) => {
            if (!els.some(alive)) {
                w.dead.push({ why, t: performance.now(),
                    els: els.map((a) => ({ paused: a.paused, ended: a.ended, t: a.currentTime })) });
            }
        };
        els.forEach((el, i) => {
            for (const type of ['pause', 'ended', 'emptied', 'abort', 'play', 'playing']) {
                const h = () => {
                    if (type === 'play') {
                        // Was the other element still going when this one started?
                        w.starts.push({ i, otherAlive: alive(els[1 - i]) });
                    }
                    check(`${type}@${i}`);
                };
                el.addEventListener(type, h);
                w.handlers.push(() => el.removeEventListener(type, h));
            }
        });
        w.timer = setInterval(() => check('sample'), 4);
        w.stop = () => { clearInterval(w.timer); w.handlers.forEach((off) => off()); };
        window.__handoff = w;
    }, STORE);
}

async function stopWatch() {
    return test.page.evaluate(() => {
        const w = window.__handoff;
        w.stop();
        window.__handoff = null;
        return { dead: w.dead, starts: w.starts };
    });
}

async function playQueue(uuids) {
    await test.page.evaluate(async (store, uu) => {
        const { player } = await import(store);
        await player.clearQueue();
        await player.addToQueue(uu.map((u) => ({ uuid: u })), true);
    }, STORE, uuids);
    await waitPlaying();
}

async function waitPlaying(timeout = 15000) {
    await test.page.waitForFunction(async (store) => {
        const { audioController: ac } = await import(store);
        const a = ac.audio;
        return a && !a.paused && a.readyState >= 2 && a.currentTime > 0.2 && !a.error;
    }, { timeout }, STORE);
}

async function state() {
    return test.page.evaluate(async (store) => {
        const { audioController: ac, player } = await import(store);
        const s = player.state;
        return {
            uuid: s.currentSong?.uuid ?? null,
            queueIndex: s.queueIndex,
            primary: ac._primaryIndex,
            preloaded: ac.preloadedSong?.uuid ?? null,
            sources: ac._audioSources.map(Boolean),
            dual: ac._dualPipelineActive,
        };
    }, STORE);
}

// Wait until the next song the player will auto-advance to is preloaded, then
// seek near the end and wait for the song to change and play.
async function autoAdvance(fromUuid, { secondsBeforeEnd = 2.5 } = {}) {
    await test.page.waitForFunction(async (store) => {
        const { audioController: ac } = await import(store);
        return ac.audio.duration > 0 && isFinite(ac.audio.duration);
    }, { timeout: 8000 }, STORE);
    await test.page.evaluate(async (store, s) => {
        const { audioController: ac } = await import(store);
        ac.seek(ac.audio.duration - s);
    }, STORE, secondsBeforeEnd);
    await test.page.waitForFunction(async (store, prev) => {
        const { player } = await import(store);
        return player.state.currentSong && player.state.currentSong.uuid !== prev;
    }, { timeout: secondsBeforeEnd * 1000 + 10000 }, STORE, fromUuid);
    await waitPlaying();
}

async function assertNoDeadWindow(w, what) {
    await test.assert(w.dead.length === 0,
        `${what}: both elements stopped at once ${w.dead.length}x, first: ${JSON.stringify(w.dead[0])}`);
}

(async () => {
    await test.setup();
    await test.login();
    await test.goto('/');
    await test.wait(300);

    console.log('Track Handoff Tests');
    console.log('-'.repeat(50));

    const sl = await test.apiCall('songs_list', { limit: 50, sort: 'title', order: 'asc' });
    const songs = sl.result.items.filter((s) => (s.duration_seconds || 0) >= 15);
    if (songs.length < 4) throw new Error(`need 4 songs of 15 s+, fixture has ${songs.length}`);
    const uuids = songs.slice(0, 4).map((s) => s.uuid);

    const setMode = (fn, ...args) => test.page.evaluate(async (store, f, a) => {
        const { audioController: ac } = await import(store);
        await ac[f](...a);
    }, STORE, fn, args);

    await setMode('setShuffle', false);
    await setMode('setRepeatMode', 'none');
    await setMode('setCrossfadeEnabled', false);

    await test.test('automatic advance starts the preloaded song before the old one ends', async () => {
        await playQueue(uuids);
        await startWatch();
        const before = await state();
        await test.page.waitForFunction(async (store, want) => {
            const { audioController: ac } = await import(store);
            return ac.preloadedSong?.uuid === want;
        }, { timeout: 8000 }, STORE, uuids[1]);
        await autoAdvance(before.uuid);
        const after = await state();
        const w = await stopWatch();
        await assertNoDeadWindow(w, 'auto advance');
        await test.assertEqual(after.uuid, uuids[1], 'should advance to the second song');
        await test.assertNotEqual(after.primary, before.primary, 'should hand off to the other element');
        await test.assert(w.starts.length > 0 && w.starts.every((s) => s.otherAlive),
            'the new element should start while the old one still plays: ' + JSON.stringify(w.starts));
    });

    await test.test('a skip hands off without stopping both elements', async () => {
        await playQueue(uuids);
        await startWatch();
        const before = await state();
        await test.page.evaluate(async (store) => {
            const { player } = await import(store);
            await player.next();
        }, STORE);
        await waitPlaying();
        const after = await state();
        const w = await stopWatch();
        await assertNoDeadWindow(w, 'skip');
        await test.assertEqual(after.uuid, uuids[1], 'next() should play the second song');
        await test.assertNotEqual(after.primary, before.primary, 'should hand off to the other element');
        // The old element is silenced and stopped once the new one plays
        const oldStopped = await test.page.evaluate(async (store) => {
            const { audioController: ac } = await import(store);
            return ac.preloadAudio.paused || ac.preloadAudio.ended;
        }, STORE);
        await test.assert(oldStopped, 'old element should be stopped after the skip');
    });

    await test.test('repeat-one replays on the other element', async () => {
        await setMode('setRepeatMode', 'one');
        await playQueue(uuids);
        await startWatch();
        const before = await state();
        await test.page.waitForFunction(async (store, want) => {
            const { audioController: ac } = await import(store);
            return ac.preloadedSong?.uuid === want;
        }, { timeout: 8000 }, STORE, before.uuid);
        // Same song, so watch the element swap instead of the uuid
        await test.page.evaluate(async (store) => {
            const { audioController: ac } = await import(store);
            ac.seek(ac.audio.duration - 2.5);
        }, STORE);
        await test.page.waitForFunction(async (store, prevPrimary) => {
            const { audioController: ac } = await import(store);
            return ac._primaryIndex !== prevPrimary && !ac.audio.paused && ac.audio.currentTime > 0.2;
        }, { timeout: 12000 }, STORE, before.primary);
        const after = await state();
        const w = await stopWatch();
        await setMode('setRepeatMode', 'none');
        await assertNoDeadWindow(w, 'repeat-one');
        await test.assertEqual(after.uuid, before.uuid, 'repeat-one should replay the same song');
    });

    await test.test('shuffle plays the song it preloaded', async () => {
        await setMode('setShuffle', true);
        await playQueue(uuids);
        await startWatch();
        const before = await state();
        await test.page.waitForFunction(async (store) => {
            const { audioController: ac } = await import(store);
            return !!ac.preloadedSong;
        }, { timeout: 8000 }, STORE);
        const preloaded = (await state()).preloaded;
        await autoAdvance(before.uuid);
        const after = await state();
        const w = await stopWatch();
        await setMode('setShuffle', false);
        await assertNoDeadWindow(w, 'shuffle');
        await test.assertEqual(after.uuid, preloaded, 'shuffle should advance to the preloaded song');
    });

    await test.test('with the Web Audio pipeline, both elements are routed and hand off', async () => {
        await setMode('setLoudnessEnabled', true);
        await playQueue(uuids);
        const routed = await state();
        await test.assert(routed.dual && routed.sources.every(Boolean),
            'both elements should feed the pipeline: ' + JSON.stringify(routed));
        await startWatch();
        await autoAdvance(routed.uuid);
        const w1 = await stopWatch();
        await assertNoDeadWindow(w1, 'pipeline auto advance');
        await startWatch();
        await test.page.evaluate(async (store) => {
            const { player } = await import(store);
            await player.next();
        }, STORE);
        await waitPlaying();
        const w2 = await stopWatch();
        await assertNoDeadWindow(w2, 'pipeline skip');
    });

    await test.test('crossfade transitions keep an element playing', async () => {
        await setMode('setCrossfadeEnabled', true);
        await setMode('setCrossfadeDuration', 2);
        await playQueue(uuids);
        await startWatch();
        const before = await state();
        await autoAdvance(before.uuid, { secondsBeforeEnd: 4 });
        const w = await stopWatch();
        await setMode('setCrossfadeEnabled', false);
        await setMode('setLoudnessEnabled', false);
        await assertNoDeadWindow(w, 'crossfade');
    });

    await test.teardown();
})();

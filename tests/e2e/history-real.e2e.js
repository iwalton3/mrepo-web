/**
 * history-real.e2e.js — playing a real track records it in play history with
 * the right metadata, and the history page renders it.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();
    await test.goto('/');
    await test.wait(300);

    console.log('Real History Tests');
    console.log('-'.repeat(50));

    // Choose a concrete song (with metadata) to play.
    const sl = await test.apiCall('songs_list', { limit: 5, sort: 'title', order: 'asc' });
    const song = sl.result.items[0];

    await test.test('playing a track records it in history with correct metadata', async () => {
        await test.page.evaluate(async (uuid) => {
            const mod = await import('/stores/player-store.js');
            await mod.player.clearQueue();
            await mod.player.addToQueue([{ uuid }], true); // playNow -> records history on start
        }, song.uuid);
        // Wait until playback actually starts (history is recorded on play-start).
        await test.page.waitForFunction(async () => {
            const mod = await import('/stores/player-store.js');
            const a = mod.audioController.audio;
            return a && a.currentTime > 0 && !a.paused;
        }, { timeout: 15000 });

        // The most recent history entry should be this song, with real metadata.
        await test.page.waitForFunction(async (uuid) => {
            const r = await fetch('/api/', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'history_recent', kwargs: { limit: 5 }, version: 2 }),
            });
            const j = await r.json();
            return j.result && j.result.items && j.result.items.some((h) => h.uuid === uuid);
        }, { timeout: 8000 }, song.uuid);

        const recent = await test.apiCall('history_recent', { limit: 5 });
        const entry = recent.result.items.find((h) => h.uuid === song.uuid);
        await test.assert(entry, 'played song should be in recent history');
        await test.assertEqual(entry.title, song.title, 'history title should match');
        await test.assertEqual(entry.artist, song.artist, 'history artist should match');
        await test.assert(!!entry.played_at, 'history entry should have a played_at timestamp');
    });

    await test.test('the history page renders the played track', async () => {
        await test.goto('/history/');
        await test.wait(500);
        await test.page.waitForFunction((title) => document.body.textContent.includes(title),
            { timeout: 10000 }, song.title);
        const shown = await test.page.evaluate((title) => document.body.textContent.includes(title), song.title);
        await test.assert(shown, `history page should show "${song.title}"`);
    });

    await test.teardown();
})();

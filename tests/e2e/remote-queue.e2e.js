/**
 * remote-queue.e2e.js — the 2×2×2 matrix hole that let the reorder no-op survive.
 *
 * Drives the REAL logged-in (non-temp) now-playing queue and asserts SERVER
 * state via queue_list after every op — add / drag-reorder (desktop + touch) /
 * remove / sort / clear — plus persistence across reload. Ordering is tracked
 * by song uuid (fixture-independent).
 *
 * Regression pins:
 *   - move-down-by-one via desktop AND touch drag must actually move on the
 *     server (the silent down-by-one no-op bug), verified by queue_list.
 *   - genuine no-op gaps (adjacent to source) must leave the server unchanged.
 */

const TestHelper = require('../test-helper');
const {
    installQueueDriver, desktopDrag, touchDrag, serverQueueUuids, waitForServerOrder,
} = require('./_queue-driver');

const test = new TestHelper();

async function callStore(method, args = []) {
    return test.page.evaluate(async (m, a) => {
        const mod = await import('/stores/player-store.js');
        const r = mod.player[m](...a);
        if (r && typeof r.then === 'function') await r;
        return true;
    }, method, args);
}

async function ensureNowPlaying() {
    const has = await test.page.$('now-playing-page');
    if (!has) {
        await test.goto('/');
        await test.wait(400);
    }
    await test.assertExists('now-playing-page', 'now-playing should mount');
}

// Rebuild a known server queue of `uuids` THROUGH THE STORE (keeps the UI, the
// offline cache, and the server in sync — an API add + reload can race the
// offline-cached empty queue). Then (re)install the drag driver.
async function setupQueue(uuids) {
    await ensureNowPlaying();
    await callStore('clearQueue');
    await callStore('addToQueue', [uuids.map((u) => ({ uuid: u }))]);
    await test.page.waitForFunction((n) => {
        const el = document.querySelector('now-playing-page');
        return el && el.querySelectorAll('.queue-item').length >= n;
    }, { timeout: 8000 }, uuids.length);
    await installQueueDriver(test);
    // Sanity: the loaded server queue must match what we asked for.
    const got = (await serverQueueUuids(test)).join(',');
    if (got !== uuids.join(',')) {
        throw new Error(`setup queue mismatch.\n  want: ${uuids.join(',')}\n  got:  ${got}`);
    }
}

(async () => {
    await test.setup();
    await test.login();

    // Fetch 8 real uuids fresh from songs_list (title-asc) — guaranteed to exist
    // and to JOIN in queue_list (both hit the songs table), and ASCII/binary
    // ordering makes the title-sort assertion exact. Runtime fetch avoids any
    // drift between a static manifest and the live DB for live-queue ops.
    const _sl = await test.apiCall('songs_list', { limit: 12, sort: 'title', order: 'asc' });
    const U = (_sl.result && _sl.result.items ? _sl.result.items : []).map((i) => i.uuid).slice(0, 8);

    console.log('Remote Queue (server-state) Tests');
    console.log('-'.repeat(50));

    if (U.length < 8) {
        console.error(`Need 8 distinct fixture uuids, got ${U.length}`);
        test.testsFailed++;
        await test.teardown();
        return;
    }

    await test.test('queue_add establishes a known server queue', async () => {
        await setupQueue(U);
        await test.assertEqual((await serverQueueUuids(test)).join(','), U.join(','),
            'server queue should match added order');
    });

    // ---- Desktop drag ------------------------------------------------------
    await test.test('desktop drag DOWN by one actually moves on the server', async () => {
        await setupQueue(U);
        // Drag U0 onto lower half of row 1 -> gap=2, to=1: U1,U0,U2..  (the
        // exact move-down-by-one that used to collapse to a no-op).
        await desktopDrag(test, 0, 1, 'lower');
        await waitForServerOrder(test, [U[1], U[0], U[2], U[3], U[4], U[5], U[6], U[7]]);
    });

    await test.test('desktop drag DOWN several (row0 -> lower half row3)', async () => {
        await setupQueue(U);
        // gap=4, to=3 -> U1,U2,U3,U0,U4..
        await desktopDrag(test, 0, 3, 'lower');
        await waitForServerOrder(test, [U[1], U[2], U[3], U[0], U[4], U[5], U[6], U[7]]);
    });

    await test.test('desktop drag UP (row5 -> upper half row1)', async () => {
        await setupQueue(U);
        // gap=1, to=1 -> U0,U5,U1,U2,U3,U4,U6,U7
        await desktopDrag(test, 5, 1, 'upper');
        await waitForServerOrder(test, [U[0], U[5], U[1], U[2], U[3], U[4], U[6], U[7]]);
    });

    await test.test('desktop no-op gap adjacent to source leaves server unchanged', async () => {
        await setupQueue(U);
        // Drag row2 onto upper half of row3: gap=3, to=2 === from -> no-op.
        await desktopDrag(test, 2, 3, 'upper');
        await test.wait(600); // allow any (erroneous) sync to land
        await test.assertEqual((await serverQueueUuids(test)).join(','), U.join(','),
            'adjacent-gap drag must not change the server queue');
    });

    // ---- Touch drag (mobile drag-handle path) ------------------------------
    await test.test('touch drag DOWN by one actually moves on the server', async () => {
        await setupQueue(U);
        // touch U0, hover row2 -> gap=2, to=1 -> U1,U0,U2.. (down-by-one regression)
        await touchDrag(test, 0, 2);
        await waitForServerOrder(test, [U[1], U[0], U[2], U[3], U[4], U[5], U[6], U[7]]);
    });

    await test.test('touch drag DOWN several (row0 hover row4)', async () => {
        await setupQueue(U);
        // gap=4, to=3 -> U1,U2,U3,U0,U4..
        await touchDrag(test, 0, 4);
        await waitForServerOrder(test, [U[1], U[2], U[3], U[0], U[4], U[5], U[6], U[7]]);
    });

    await test.test('touch drag UP (row4 hover row1)', async () => {
        await setupQueue(U);
        // gap=1, to=1 -> U0,U4,U1,U2,U3,U5,U6,U7
        await touchDrag(test, 4, 1);
        await waitForServerOrder(test, [U[0], U[4], U[1], U[2], U[3], U[5], U[6], U[7]]);
    });

    // ---- Remove ------------------------------------------------------------
    await test.test('remove via row button updates the server queue', async () => {
        await setupQueue(U);
        await test.click('.queue-item[data-index="2"] .queue-remove');
        await waitForServerOrder(test, [U[0], U[1], U[3], U[4], U[5], U[6], U[7]]);
    });

    // ---- Sort --------------------------------------------------------------
    await test.test('sort by title asc reorders the server queue', async () => {
        // Seed in reverse (title-desc) so the asc sort has real work to do.
        await setupQueue([...U].reverse());
        await callStore('sortQueue', ['title', 'asc']);
        // Poll until the queue count is stable, then assert titles non-decreasing.
        await test.wait(500);
        const res = await test.apiCall('queue_list');
        const titles = res.result.items.map((i) => i.title || '');
        await test.assertEqual(res.result.items.length, U.length, 'sort must preserve count');
        let sorted = true;
        for (let i = 1; i < titles.length; i++) {
            if (titles[i] < titles[i - 1]) { sorted = false; break; }
        }
        await test.assert(sorted, 'server titles should be non-decreasing after sort asc: ' + JSON.stringify(titles));
    });

    // ---- Clear -------------------------------------------------------------
    await test.test('clear empties the server queue', async () => {
        await setupQueue(U);
        await callStore('clearQueue');
        await waitForServerOrder(test, []);
    });

    // ---- Persistence across reload ----------------------------------------
    await test.test('queue persists across a full page reload', async () => {
        await setupQueue(U);
        await desktopDrag(test, 0, 3, 'lower');
        const expected = [U[1], U[2], U[3], U[0], U[4], U[5], U[6], U[7]];
        await waitForServerOrder(test, expected);
        // Full reload — the store must reload the same server queue.
        await test.page.reload({ waitUntil: 'networkidle2' });
        await test.wait(600);
        await test.assertExists('now-playing-page', 'now-playing should re-mount after reload');
        await test.assertEqual((await serverQueueUuids(test)).join(','), expected.join(','),
            'server queue should be unchanged after reload');
        await test.page.waitForFunction((n) => {
            const el = document.querySelector('now-playing-page');
            return el && el.querySelectorAll('.queue-item').length >= n;
        }, { timeout: 8000 }, expected.length);
    });

    await test.teardown();
})();

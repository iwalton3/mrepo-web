/**
 * two-sessions.e2e.js — the multi-device reality the offline/sync layer exists
 * for. The same user in two isolated browser contexts (separate sessions):
 * a queue change in device A is what device B loads; a playlist created in A is
 * visible in B. Assertions are made through each device's own UI/session.
 */

const TestHelper = require('../test-helper');

const BASE = process.env.TEST_URL;
const USER = { username: process.env.TEST_USER_NAME, password: process.env.TEST_USER_PASS };

const test = new TestHelper();

// Drive a UI login on an arbitrary page (device B lives in its own context).
async function uiLogin(page) {
    await page.goto(BASE + '/#/login/', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#username', { timeout: 8000 });
    await page.type('#username', USER.username);
    await page.type('#password', USER.password);
    await page.evaluate(() => {
        document.querySelector('form.login-form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.user-badge', { timeout: 10000 });
}

function api(page, method, kwargs = {}) {
    return page.evaluate(async (m, kw) => {
        const r = await fetch('/api/', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: m, kwargs: kw, version: 2 }),
        });
        return r.json();
    }, method, kwargs);
}

async function storeQueueUuids(page) {
    return page.evaluate(async () => {
        const mod = await import('/stores/player-store.js');
        return mod.player.state.queue.map((s) => s.uuid);
    });
}

(async () => {
    await test.setup();

    console.log('Two-Sessions (multi-device) Tests');
    console.log('-'.repeat(50));

    // Device A is the harness page; device B is an isolated context.
    const ctxB = await test.browser.createIncognitoBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 1280, height: 800 });

    try {
        await test.login(USER);       // device A
        await uiLogin(pageB);         // device B (separate session)

        // Pick 5 real uuids to work with.
        const sl = await test.apiCall('songs_list', { limit: 8, sort: 'title', order: 'asc' });
        const uuids = sl.result.items.map((i) => i.uuid).slice(0, 5);

        await test.test('queue changed in device A is what device B loads', async () => {
            // A: rebuild the server queue through the store.
            await test.goto('/');
            await test.wait(300);
            await test.page.evaluate(async (uu) => {
                const mod = await import('/stores/player-store.js');
                await mod.player.clearQueue();
                await mod.player.addToQueue(uu.map((u) => ({ uuid: u })));
            }, uuids);

            // B: fresh-load the app; its store must pull A's queue from the
            // server. B already sits at '/#/' after login, so a goto to the same
            // hash would be a no-op same-document nav — force a real reload.
            await pageB.goto(BASE + '/#/', { waitUntil: 'networkidle2' });
            await pageB.reload({ waitUntil: 'networkidle2' });
            await pageB.waitForFunction((n) => {
                const el = document.querySelector('now-playing-page');
                return el && el.querySelectorAll('.queue-item').length >= n;
            }, { timeout: 10000 }, uuids.length);

            const bUuids = await storeQueueUuids(pageB);
            await test.assertEqual(bUuids.join(','), uuids.join(','),
                'device B should load exactly the queue device A set');
        });

        await test.test('queue reorder in A is reflected in B on reload', async () => {
            // A: move first song to the end via the store (server-synced).
            await test.page.evaluate(async () => {
                const mod = await import('/stores/player-store.js');
                await mod.player.reorderQueue(0, mod.player.state.queue.length - 1);
            });
            const aUuids = await storeQueueUuids(test.page);

            await pageB.reload({ waitUntil: 'networkidle2' });
            await pageB.waitForFunction((n) => {
                const el = document.querySelector('now-playing-page');
                return el && el.querySelectorAll('.queue-item').length >= n;
            }, { timeout: 10000 }, uuids.length);
            const bUuids = await storeQueueUuids(pageB);
            await test.assertEqual(bUuids.join(','), aUuids.join(','),
                'device B should reflect the reorder A made');
        });

        await test.test('playlist created in device A is visible in device B', async () => {
            const name = 'TwoSession PL ' + Date.now();
            const created = await test.apiCall('playlists_create', { name, description: 'multi-device' });
            await test.assert(created.success, 'playlist create should succeed');

            // B: load the playlists page and find the new playlist by name.
            await pageB.goto(BASE + '/#/playlists/', { waitUntil: 'networkidle2' });
            await pageB.waitForFunction((n) => document.body.textContent.includes(n),
                { timeout: 10000 }, name);
            const seen = await pageB.evaluate((n) => document.body.textContent.includes(n), name);
            await test.assert(seen, 'device B should see the playlist created in device A');

            // Also confirm via B's own session API (server-shared state).
            const list = await api(pageB, 'playlists_list');
            const names = (list.result.items || list.result || []).map((p) => p.name);
            await test.assert(names.includes(name),
                'playlists_list in device B should include the new playlist');
        });
    } finally {
        await pageB.close();
        await ctxB.close();
    }

    await test.teardown();
})();

/**
 * share-links.e2e.js — create a playlist share link and open it in a fresh
 * logged-out browser context.
 *
 * Songs load anonymously via playlists_get_songs_by_token (the unguessable
 * token is the capability). Least-privilege pins below: the token endpoint
 * only answers for its own playlist, the user-scoped playlists_get_songs
 * still requires auth, and the public by-token metadata carries no owner
 * identity.
 */

const TestHelper = require('../test-helper');
const env = require('../harness/env');

const BASE = process.env.TEST_URL;
const USER = { username: process.env.TEST_USER_NAME, password: process.env.TEST_USER_PASS };

const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login(USER);

    console.log('Share Links Tests');
    console.log('-'.repeat(50));

    // Create a playlist with songs and generate a share token (as testuser).
    const sl = await test.apiCall('songs_list', { limit: 3, sort: 'title', order: 'asc' });
    const uuids = sl.result.items.map((i) => i.uuid);
    const plName = 'Shared PL ' + Date.now();
    const created = await test.apiCall('playlists_create', { name: plName });
    const playlistId = created.result.id;
    await test.apiCall('playlists_add_songs', { playlist_id: playlistId, song_uuids: uuids });
    const shared = await test.apiCall('playlists_share', { playlist_id: playlistId });
    const token = shared.result && shared.result.share_token;

    await test.test('share token is created and resolves anonymously (public metadata)', async () => {
        await test.assert(!!token, 'playlists_share should return a token');
        // Anonymous (no cookie) resolution via the public by-token API.
        const anon = await env.apiCall(BASE, 'playlists_by_token', { share_token: token });
        await test.assert(anon.success, 'playlists_by_token should be public: ' + JSON.stringify(anon));
        await test.assertEqual(anon.result.name, plName, 'shared playlist name should resolve');
        await test.assertEqual(anon.result.song_count, uuids.length, 'shared song_count should resolve');
        await test.assert(!('user_id' in anon.result),
            'public by-token metadata must not expose the owner user_id');
    });

    await test.test('token-scoped songs endpoint: least-privilege pins', async () => {
        // The token grants exactly its own playlist's songs, anonymously.
        const songs = await env.apiCall(BASE, 'playlists_get_songs_by_token', { share_token: token });
        await test.assert(songs.success, 'valid token should return songs: ' + JSON.stringify(songs));
        await test.assertEqual(songs.result.items.length, uuids.length, 'all shared songs returned');
        await test.assertEqual(songs.result.totalCount, uuids.length, 'totalCount matches');

        // A bogus token grants nothing (and does not distinguish "exists but
        // unshared" from "does not exist").
        const bogus = await env.apiCall(BASE, 'playlists_get_songs_by_token', { share_token: 'not-a-real-token' });
        await test.assert(!bogus.success, 'bogus token must be rejected');
        await test.assert(/not found/i.test(bogus.message || ''), 'rejection is a generic not-found');

        // An empty token must not match anything.
        const empty = await env.apiCall(BASE, 'playlists_get_songs_by_token', { share_token: '' });
        await test.assert(!empty.success, 'empty token must be rejected');

        // The user-scoped endpoint is UNCHANGED: still requires auth even for
        // the very playlist that has a share token.
        const direct = await env.apiCall(BASE, 'playlists_get_songs', { playlist_id: playlistId });
        await test.assert(!direct.success && direct.error === 'NotAuthenticated',
            'playlists_get_songs must still require a logged-in user: ' + JSON.stringify(direct));
    });

    // Fresh logged-out browser context (a different device with no session).
    const ctx = await test.browser.createIncognitoBrowserContext();
    const anonPage = await ctx.newPage();
    await anonPage.setViewport({ width: 1280, height: 800 });

    try {
        await test.test('opening the share link logged-out shows the playlist name', async () => {
            await anonPage.goto(BASE + '/#/share/' + token + '/', { waitUntil: 'networkidle2' });
            await anonPage.waitForFunction((n) => document.body.textContent.includes(n),
                { timeout: 10000 }, plName);
            // Confirm this context is genuinely NOT authenticated.
            const authed = await anonPage.evaluate(() => !!document.querySelector('.user-badge'));
            await test.assert(!authed, 'share viewer context must be logged out');
        });

        await test.test('an invalid share token shows an error, not a crash', async () => {
            anonPage.__pageErrors = [];
            const onErr = (e) => anonPage.__pageErrors.push(e.message);
            anonPage.on('pageerror', onErr);
            await anonPage.goto(BASE + '/#/share/not-a-real-token/', { waitUntil: 'networkidle2' });
            // The page is already on a /share/ route, so the hash-only change may
            // not re-trigger the loader — force a full reload.
            await anonPage.reload({ waitUntil: 'networkidle2' });
            await anonPage.waitForFunction(() => /invalid|expired|not found/i.test(document.body.textContent),
                { timeout: 10000 });
            anonPage.off('pageerror', onErr);
            await test.assert(anonPage.__pageErrors.length === 0,
                'invalid share link should not crash: ' + JSON.stringify(anonPage.__pageErrors));
        });

        await test.test('shared playlist songs render for anonymous viewers', async () => {
            // Navigate back to the VALID link (the previous test left the page
            // on the invalid-token route).
            await anonPage.goto(BASE + '/#/share/' + token + '/', { waitUntil: 'networkidle2' });
            await anonPage.reload({ waitUntil: 'networkidle2' });
            await anonPage.waitForFunction((n) => document.body.textContent.includes(n),
                { timeout: 10000 }, plName);
            await anonPage.waitForFunction(() =>
                document.querySelectorAll('.playlist-song, .song-row, [data-uuid]').length > 0,
                { timeout: 10000 });
            const rows = await anonPage.evaluate(() =>
                document.querySelectorAll('.playlist-song, .song-row, [data-uuid]').length);
            await test.assertGreaterThan(rows, 0, 'anonymous viewer should see the shared songs');
            const misleading = await anonPage.evaluate(() =>
                /invalid or has expired/i.test(document.body.textContent));
            await test.assert(!misleading, 'valid link must not show the invalid/expired message');
        });
    } finally {
        await anonPage.close();
        await ctx.close();
    }

    await test.teardown();
})();

/**
 * search-scoping.e2e.js — the per-user fields of the advanced search language
 * (`in:`/`playlist:` and `tag:`) resolve against the CALLING user.
 *
 * Regression cover for a two-part wiring bug:
 *   1. music_search.py built the playlist subquery against a `p.shared` column
 *      that does not exist -> sqlite3.OperationalError, 500 on every `in:` query.
 *      (Crashed in the sibling swapi-apps monolith; the column here is is_public.)
 *   2. every build_sql() call site omitted the optional user_id argument, so the
 *      builder silently fell back to its no-user arm: playlist conditions matched
 *      only PUBLIC playlists and tag conditions compiled to the literal `1=0`.
 *      `in:Favorites` therefore returned 0 rows with no error of any kind.
 *
 * Both failure modes are invisible to a search test that only exercises
 * artist:/album:/plain-text, which is why they shipped. The assertions below are
 * deliberately two-sided: the owner MUST see their songs (catches bug 2, which a
 * "did not crash" check would pass) and another user MUST NOT (catches an
 * over-broad fix that drops the scoping instead of wiring it).
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

const ADMIN = {
    username: process.env.TEST_ADMIN_NAME || 'admin',
    password: process.env.TEST_ADMIN_PASS || 'adminpass123',
};

const uuidsOf = (res) => ((res.result && res.result.items) || []).map((s) => s.uuid);

(async () => {
    await test.setup();
    await test.login();

    const manifest = test.loadManifest();

    console.log('Search Scoping (in:/tag:) Tests');
    console.log('-'.repeat(50));

    // Distinctive names so a stale row from a previous run can never satisfy
    // these assertions by accident.
    const PL_PRIVATE = 'ScopingPrivatePL';
    const PL_PUBLIC = 'ScopingPublicPL';
    const TAG_NAME = 'ScopingTag';

    const songs = manifest.knownTracks.slice(0, 3).map((t) => t.uuid);
    let privateId = null;
    let publicId = null;
    let tagId = null;

    await test.test('setup: testuser owns a private playlist, a public one, and a tag', async () => {
        await test.assertGreaterThan(songs.length, 0, 'manifest must supply known tracks');

        const priv = await test.apiCall('playlists_create', { name: PL_PRIVATE, is_public: false });
        await test.assert(priv.success, 'private playlists_create: ' + JSON.stringify(priv).slice(0, 200));
        privateId = priv.result.id;
        const addPriv = await test.apiCall('playlists_add_songs', { playlist_id: privateId, song_uuids: songs });
        await test.assert(addPriv.success, 'add songs to private playlist');

        const pub = await test.apiCall('playlists_create', { name: PL_PUBLIC, is_public: true });
        await test.assert(pub.success, 'public playlists_create');
        publicId = pub.result.id;
        const addPub = await test.apiCall('playlists_add_songs', { playlist_id: publicId, song_uuids: [songs[0]] });
        await test.assert(addPub.success, 'add song to public playlist');

        const tag = await test.apiCall('tags_create', { name: TAG_NAME });
        await test.assert(tag.success, 'tags_create: ' + JSON.stringify(tag).slice(0, 200));
        tagId = tag.result.id;
        const tagged = await test.apiCall('tags_add_to_song', { tag_id: tagId, song_uuid: songs[0] });
        await test.assert(tagged.success, 'tags_add_to_song');
    });

    // ---- bug 1: the query must not 500 --------------------------------------

    await test.test('in: query does not error (no such column: p.shared)', async () => {
        const res = await test.apiCall('songs_search', { query: `in:${PL_PRIVATE}`, limit: 50 });
        await test.assert(res.success,
            'songs_search in: should not raise — got: ' + JSON.stringify(res).slice(0, 300));
    });

    // ---- bug 2: the owner must actually get their songs ---------------------

    await test.test('in:<private playlist> returns the owner\'s songs', async () => {
        const res = await test.apiCall('songs_search', { query: `in:${PL_PRIVATE}`, limit: 50 });
        await test.assert(res.success, 'songs_search should succeed');
        const got = uuidsOf(res);
        await test.assertEqual(got.length, songs.length,
            `expected ${songs.length} songs from in:${PL_PRIVATE}, got ${got.length} ` +
            '(0 means build_sql lost its user_id and fell back to public-only)');
        for (const uuid of songs) {
            await test.assert(got.includes(uuid), `in: results should include ${uuid}`);
        }
        await test.assertEqual(res.result.totalCount, songs.length,
            'totalCount must be scoped the same way as items');
    });

    await test.test('in:eq:<name> exact-match form is scoped too', async () => {
        const res = await test.apiCall('songs_search', { query: `in:eq:${PL_PRIVATE}`, limit: 50 });
        await test.assert(res.success, 'songs_search in:eq: should succeed');
        await test.assertEqual(uuidsOf(res).length, songs.length, 'in:eq: should match the owner\'s playlist');
    });

    await test.test('playlist: alias behaves like in:', async () => {
        const res = await test.apiCall('songs_search', { query: `playlist:${PL_PRIVATE}`, limit: 50 });
        await test.assert(res.success, 'playlist: should succeed');
        await test.assertEqual(uuidsOf(res).length, songs.length, 'playlist: alias should be scoped');
    });

    await test.test('in: composes with another field condition', async () => {
        // Compound queries walk a different build_sql branch (AndNode recursion),
        // so user_id has to survive the recursion, not just the top-level call.
        const first = manifest.knownTracks[0];
        const res = await test.apiCall('songs_search', {
            query: `in:${PL_PRIVATE} AND a:"${first.artist}"`, limit: 50,
        });
        await test.assert(res.success, 'compound search should succeed: ' + JSON.stringify(res).slice(0, 200));
        await test.assert(uuidsOf(res).includes(first.uuid),
            'compound in: AND a: should still find the owner\'s song');
    });

    await test.test('tag: returns the owner\'s tagged song (not the 1=0 fallback)', async () => {
        const res = await test.apiCall('songs_search', { query: `tag:${TAG_NAME}`, limit: 50 });
        await test.assert(res.success, 'tag: search should succeed');
        const got = uuidsOf(res);
        await test.assertGreaterThan(got.length, 0,
            'tag: returned nothing — build_sql compiles tag conditions to 1=0 without a user_id');
        await test.assert(got.includes(songs[0]), 'tag: should return the tagged song');
    });

    await test.test('songs_random honours in: scoping', async () => {
        // songs_random takes its own build_sql path and had the same omission.
        const res = await test.apiCall('songs_random', { filter_query: `in:${PL_PRIVATE}`, count: 3 });
        await test.assert(res.success, 'songs_random should succeed: ' + JSON.stringify(res).slice(0, 200));
        const picked = Array.isArray(res.result) ? res.result : [res.result];
        await test.assertGreaterThan(picked.length, 0, 'songs_random should return a song');
        for (const s of picked) {
            await test.assert(songs.includes(s.uuid),
                `songs_random picked ${s.uuid}, outside in:${PL_PRIVATE} — filter was ignored`);
        }
    });

    // ---- the other side: scoping must still exclude ------------------------

    await test.test('a different user does NOT see the private playlist via in:', async () => {
        await test.logout();
        await test.login(ADMIN);
        try {
            const res = await test.apiCall('songs_search', { query: `in:${PL_PRIVATE}`, limit: 50 });
            await test.assert(res.success, 'songs_search should succeed for the other user');
            await test.assertEqual(uuidsOf(res).length, 0,
                `admin must not see testuser's private playlist "${PL_PRIVATE}"`);
            await test.assertEqual(res.result.totalCount, 0, 'totalCount must be 0 for the other user');
        } finally {
            await test.logout();
            await test.login();
        }
    });

    await test.test('a different user DOES see a public playlist via in:', async () => {
        await test.logout();
        await test.login(ADMIN);
        try {
            const res = await test.apiCall('songs_search', { query: `in:${PL_PUBLIC}`, limit: 50 });
            await test.assert(res.success, 'songs_search should succeed');
            await test.assert(uuidsOf(res).includes(songs[0]),
                'public playlists stay visible across users — scoping must not become owner-only');
        } finally {
            await test.logout();
            await test.login();
        }
    });

    await test.test('a different user does NOT see the owner\'s tag', async () => {
        await test.logout();
        await test.login(ADMIN);
        try {
            const res = await test.apiCall('songs_search', { query: `tag:${TAG_NAME}`, limit: 50 });
            await test.assert(res.success, 'songs_search should succeed');
            await test.assertEqual(uuidsOf(res).length, 0, 'tags are per-user and must not leak');
        } finally {
            await test.logout();
            await test.login();
        }
    });

    // ---- cleanup ------------------------------------------------------------

    await test.test('cleanup: remove fixtures created by this suite', async () => {
        if (privateId) await test.apiCall('playlists_delete', { playlist_id: privateId });
        if (publicId) await test.apiCall('playlists_delete', { playlist_id: publicId });
        if (tagId) await test.apiCall('tags_delete', { tag_id: tagId });
        const left = await test.apiCall('playlists_list', {});
        const names = ((left.result && left.result.items) || left.result || []).map((p) => p.name);
        await test.assert(!names.includes(PL_PRIVATE), 'private fixture playlist should be gone');
    });

    await test.teardown();
})();

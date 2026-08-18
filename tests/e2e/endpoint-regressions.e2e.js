/**
 * endpoint-regressions.e2e.js — API methods that are reachable from the wire but
 * had no test, and were broken because of it.
 *
 * browse_genres_normalized: guards on `SELECT name FROM sqlite_master ... 'genres'`
 * and falls back to browse_genres when that optional table is absent. Nothing in
 * db.py or scanner.py ever creates it, so the fallback is the ONLY path this
 * endpoint takes -- and the fallback call forwarded `cursor`/`limit`, which
 * browse_genres does not accept. Every call raised TypeError. The endpoint has no
 * frontend caller today, which is precisely why it rotted; a live wire-reachable
 * method that always 500s is one refactor away from being someone's bug report.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Endpoint Regression Tests');
    console.log('-'.repeat(50));

    await test.test('browse_genres_normalized returns genres (was TypeError)', async () => {
        const res = await test.apiCall('browse_genres_normalized', {});
        await test.assert(res.success,
            'browse_genres_normalized should not raise: ' + JSON.stringify(res).slice(0, 300));
        const items = (res.result && res.result.items) || [];
        await test.assertGreaterThan(items.length, 0, 'should return at least [All Genres]');
        await test.assert(items.some((g) => g.name === '[All Genres]'),
            'fallback should preserve browse_genres\' [All Genres] entry');
    });

    await test.test('browse_genres_normalized agrees with browse_genres', async () => {
        // The fallback must be a faithful pass-through, not a lookalike.
        const norm = await test.apiCall('browse_genres_normalized', {});
        const plain = await test.apiCall('browse_genres', {});
        await test.assert(norm.success && plain.success, 'both endpoints should succeed');
        const a = (norm.result.items || []).map((g) => g.name);
        const b = (plain.result.items || []).map((g) => g.name);
        await test.assertEqual(JSON.stringify(a), JSON.stringify(b),
            'normalized fallback should return the same genres as browse_genres');
    });

    await test.test('browse_genres_normalized paginates', async () => {
        // browse_genres returns everything unpaginated, so the wrapper has to do
        // the paging itself -- the part most likely to be got wrong.
        const all = await test.apiCall('browse_genres_normalized', {});
        const names = (all.result.items || []).map((g) => g.name);

        const page1 = await test.apiCall('browse_genres_normalized', { limit: 1 });
        await test.assert(page1.success, 'paged call should succeed');
        await test.assertEqual((page1.result.items || []).length, 1, 'limit=1 should return 1');
        await test.assertEqual(page1.result.items[0].name, names[0], 'first page = first item');
        await test.assertEqual(page1.result.totalCount, names.length,
            'totalCount should count the whole set, not the page');

        if (names.length > 1) {
            await test.assert(page1.result.hasMore, 'hasMore should be true mid-set');
            const page2 = await test.apiCall('browse_genres_normalized',
                { limit: 1, cursor: page1.result.nextCursor });
            await test.assert(page2.success, 'second page should succeed');
            await test.assertEqual(page2.result.items[0].name, names[1],
                'nextCursor should advance by exactly one page');
        } else {
            await test.assert(!page1.result.hasMore, 'single-item set should report hasMore=false');
        }
    });

    await test.test('browse_genres_normalized honours category', async () => {
        const res = await test.apiCall('browse_genres_normalized', { category: 'music' });
        await test.assert(res.success, 'category-filtered call should succeed');
        await test.assert(Array.isArray(res.result.items), 'should return an items array');
    });

    await test.teardown();
})();

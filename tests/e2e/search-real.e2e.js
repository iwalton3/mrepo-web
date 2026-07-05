/**
 * search-real.e2e.js — quick-search + advanced search against the real fixture,
 * driven by manifest-known facts (no hardcoded library content). Also pins the
 * AI-disabled graceful-degradation: an `ai:` query must fall back to standard
 * search (no crash, sensible results) when no AI service is configured.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    const manifest = test.loadManifest();
    const asciiArtist = manifest.artists.find((a) => /^[\x20-\x7E]+$/.test(a) && a.length >= 3);
    const known = manifest.knownTracks.find((t) => /^[\x20-\x7E]+$/.test(t.title));

    console.log('Real Search Tests');
    console.log('-'.repeat(50));

    await test.test('quick-search finds a manifest-known artist (UI)', async () => {
        if (!asciiArtist) throw new Error('no ASCII artist in manifest');
        await test.goto('/search/');
        await test.page.waitForSelector('.search-input', { timeout: 8000 });
        await test.page.click('.search-input');
        await test.page.type('.search-input', asciiArtist);
        await test.page.waitForFunction((name) => {
            const sections = document.querySelector('.results-sections');
            return sections && sections.textContent.includes(name);
        }, { timeout: 8000 }, asciiArtist);
        const shown = await test.page.evaluate((name) =>
            document.querySelector('.results-sections').textContent.includes(name), asciiArtist);
        await test.assert(shown, `search results should list "${asciiArtist}"`);
    });

    await test.test('quick-search API finds a manifest-known title', async () => {
        if (!known) throw new Error('no ASCII known track');
        const res = await test.apiCall('songs_quick_search', { query: known.title, limit: 20 });
        await test.assert(res.success, 'quick_search should succeed');
        const titles = (res.result.songs || []).map((s) => s.title);
        await test.assert(titles.some((t) => t === known.title),
            `quick_search should return "${known.title}", got: ${JSON.stringify(titles.slice(0, 5))}`);
    });

    await test.test('advanced search "artist:" syntax filter returns matching songs', async () => {
        const res = await test.apiCall('songs_search', { query: `artist:"${asciiArtist}"`, limit: 50 });
        await test.assert(res.success, 'songs_search should succeed: ' + JSON.stringify(res).slice(0, 200));
        const items = res.result.items || [];
        await test.assertGreaterThan(items.length, 0, `artist:"${asciiArtist}" should return songs`);
        const allMatch = items.every((s) => (s.artist || '') === asciiArtist);
        await test.assert(allMatch,
            `every result should have artist "${asciiArtist}": ` +
            JSON.stringify([...new Set(items.map((s) => s.artist))]));
    });

    await test.test('plain search returns results and a known title is findable', async () => {
        // FTS tokenises on word boundaries, so search a distinctive word from the
        // title rather than the whole punctuation-heavy string.
        const word = (known.title.match(/[A-Za-z0-9]{4,}/g) || []).sort((a, b) => b.length - a.length)[0];
        if (!word) throw new Error(`no searchable word in title "${known.title}"`);
        const res = await test.apiCall('songs_search', { query: word, limit: 100 });
        await test.assert(res.success, 'songs_search plain should succeed');
        const uuids = (res.result.items || []).map((s) => s.uuid);
        await test.assert(uuids.includes(known.uuid),
            `plain search for "${word}" (from "${known.title}") should include its uuid`);
    });

    await test.test('ai: query degrades gracefully when AI is disabled', async () => {
        // No AI service configured -> _handle_ai_search falls back to standard
        // search. Must NOT crash and must return a well-formed result.
        const res = await test.apiCall('songs_search', { query: 'ai:relaxing ambient music', limit: 20 });
        await test.assert(res.success, 'ai: search must not error when AI disabled: ' + JSON.stringify(res).slice(0, 200));
        await test.assert(Array.isArray(res.result.items),
            'ai: fallback should return an items array');
    });

    await test.test('ai: query in the search UI does not crash the page', async () => {
        await test.goto('/search/');
        await test.page.waitForSelector('.search-input', { timeout: 8000 });
        test.pageErrors = [];
        await test.page.click('.search-input');
        await test.page.type('.search-input', 'ai:"electronic beats"');
        await test.page.keyboard.press('Enter');
        await test.wait(1500);
        await test.assert(test.pageErrors.length === 0,
            'ai: query should not raise a page error: ' + JSON.stringify(test.pageErrors));
    });

    await test.teardown();
})();

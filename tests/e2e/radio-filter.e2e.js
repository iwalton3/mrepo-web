/**
 * radio-filter.e2e.js — radio filters are compiled by the SAME parser as the
 * search box, and the filters the UI actually builds all work.
 *
 * radio.py used to carry its own regex filter parser understanding a 7-field
 * subset of the query language. Three failure modes came out of that, all
 * covered here:
 *
 *   1. HARD ERROR. Its field map lacked `l` (album) and `p` (path), so the
 *      unmapped name went into SQL verbatim -> "no such column: l". browse-page
 *      sends exactly those two, so "Start radio" from an album or from the
 *      filepath view failed outright.
 *   2. SILENT DROP. Anything not matching ^field:op:value^ was `continue`d past
 *      -- plain text, `in:`, `tag:`, and any two-part `field:value` form. A
 *      dropped filter collapses to "1=1", so radio played the WHOLE LIBRARY
 *      while reporting itself as filtered. Worse, _populate_queue skips its
 *      seed-similarity fallback whenever filter_query is truthy, so the queue
 *      went uniformly random rather than merely unfiltered.
 *   3. DIVERGENT MEANING. `t:` meant title to radio but tag to search.
 *
 * The fourth case is a regression the unification could have introduced: the
 * old regex captured `(.+)$` so multi-word values worked unquoted, while the
 * real lexer splits on whitespace. Callers now quote via quoteFilterValue().
 * `radio from a multi-word album` pins that, and it is the assertion most
 * likely to catch a careless future edit.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

const uuidsOf = (res) => ((res.result && res.result.items) || []).map((s) => s.uuid);

(async () => {
    await test.setup();
    await test.login();

    const manifest = test.loadManifest();

    console.log('Radio Filter Tests');
    console.log('-'.repeat(50));

    // Pick real library facts to filter on.
    const artist = manifest.artists.find((a) => /^[\x20-\x7E]+$/.test(a) && a.length >= 3);
    const multiWordArtist = manifest.artists.find((a) => /^[\x20-\x7E]+$/.test(a) && /\s/.test(a));
    const track = manifest.knownTracks.find((t) => t.album && /^[\x20-\x7E]+$/.test(t.album));

    // Look up the true membership of each filter directly, so the radio
    // assertions compare against the library rather than a hardcoded count.
    async function songsMatching(query) {
        const res = await test.apiCall('songs_search', { query, limit: 200 });
        if (!res.success) throw new Error(`songs_search(${query}) failed: ${JSON.stringify(res).slice(0, 200)}`);
        return uuidsOf(res);
    }

    async function startRadio(filterQuery) {
        const res = await test.apiCall('radio_start', { filter_query: filterQuery });
        await test.assert(res.success,
            `radio_start(${filterQuery}) should not error: ` + JSON.stringify(res).slice(0, 300));
        await test.assert(!res.result.error,
            `radio_start(${filterQuery}) returned an error: ${JSON.stringify(res.result).slice(0, 200)}`);
        return res.result;
    }

    // ---- 1. the fields browse-page actually sends ---------------------------

    await test.test('radio from an album (l:eq:) starts — was "no such column: l"', async () => {
        const filter = `l:eq:"${track.album.replace(/"/g, '\\"')}"`;
        const expected = await songsMatching(filter);
        await test.assertGreaterThan(expected.length, 0, 'fixture album should have songs');

        const radio = await startRadio(filter);
        const played = [radio.seed, ...radio.queue].map((s) => s.uuid);
        for (const uuid of played) {
            await test.assert(expected.includes(uuid),
                `radio played ${uuid}, which is not in ${filter} — filter was dropped or mis-parsed`);
        }
    });

    await test.test('radio from a filepath (p:mt:) starts — was "no such column: p"', async () => {
        // fixturePaths are the real directories the library was scanned from,
        // and they contain spaces — which is exactly what used to break.
        const dir = manifest.fixturePaths[0];
        const filter = `p:mt:"${dir.replace(/"/g, '\\"')}"`;
        const expected = await songsMatching(filter);

        const radio = await startRadio(filter);
        if (expected.length > 0) {
            const played = [radio.seed, ...radio.queue].map((s) => s.uuid);
            for (const uuid of played) {
                await test.assert(expected.includes(uuid),
                    `radio played ${uuid}, outside ${filter}`);
            }
        }
    });

    await test.test('radio from a multi-word value stays inside it (quoting)', async () => {
        if (!multiWordArtist) throw new Error('no multi-word ASCII artist in manifest');
        const filter = `a:eq:"${multiWordArtist.replace(/"/g, '\\"')}"`;
        const expected = await songsMatching(filter);
        await test.assertGreaterThan(expected.length, 0,
            `"${multiWordArtist}" should have songs — if 0, the value was split at whitespace`);

        const radio = await startRadio(filter);
        const played = [radio.seed, ...radio.queue].map((s) => s.uuid);
        for (const uuid of played) {
            await test.assert(expected.includes(uuid),
                `radio played ${uuid}, outside a:eq:"${multiWordArtist}"`);
        }
    });

    // ---- 2. the silent-drop cases ------------------------------------------

    await test.test('a plain-text filter actually filters (was dropped → whole library)', async () => {
        const word = (manifest.knownTracks[0].title.match(/[A-Za-z0-9]{4,}/g) || [])
            .sort((a, b) => b.length - a.length)[0];
        if (!word) throw new Error('no searchable word in the first known track');
        const expected = await songsMatching(word);
        await test.assertGreaterThan(expected.length, 0, 'plain-text filter should match something');
        // The point of the test: the match set must be a strict subset of the
        // library, otherwise "filtered" radio is just random radio.
        await test.assert(expected.length < manifest.counts.totalSongs,
            'plain-text filter should not match the entire library');

        const radio = await startRadio(word);
        const played = [radio.seed, ...radio.queue].map((s) => s.uuid);
        for (const uuid of played) {
            await test.assert(expected.includes(uuid),
                `radio played ${uuid}, outside the plain-text filter "${word}" — filter was dropped`);
        }
    });

    await test.test('a playlist filter (in:) drives radio — was dropped entirely', async () => {
        const PL = 'RadioFilterPL';
        const songs = manifest.knownTracks.slice(0, 3).map((t) => t.uuid);
        const created = await test.apiCall('playlists_create', { name: PL, is_public: false });
        await test.assert(created.success, 'playlists_create: ' + JSON.stringify(created).slice(0, 200));
        try {
            await test.apiCall('playlists_add_songs', { playlist_id: created.result.id, song_uuids: songs });

            const radio = await startRadio(`in:${PL}`);
            const played = [radio.seed, ...radio.queue].map((s) => s.uuid);
            await test.assertGreaterThan(played.length, 0, 'radio should produce songs');
            for (const uuid of played) {
                await test.assert(songs.includes(uuid),
                    `radio played ${uuid}, which is not in the playlist — in: was dropped`);
            }
        } finally {
            await test.apiCall('playlists_delete', { playlist_id: created.result.id });
        }
    });

    await test.test('a two-part field:value filter is honoured (was dropped)', async () => {
        // `field:value` (op defaults to `mt`) never matched the old 3-part regex.
        const filter = `a:"${artist.replace(/"/g, '\\"')}"`;
        const expected = await songsMatching(filter);
        await test.assertGreaterThan(expected.length, 0, 'two-part form should match');

        const radio = await startRadio(filter);
        const played = [radio.seed, ...radio.queue].map((s) => s.uuid);
        for (const uuid of played) {
            await test.assert(expected.includes(uuid), `radio played ${uuid}, outside ${filter}`);
        }
    });

    // ---- 3. the pool the SCA refills from must be filtered too --------------

    await test.test('the sca pool is filtered, so continuous play stays on-filter', async () => {
        // radio_start refills sca_song_pool with the same WHERE clause. When the
        // filter was dropped that pool became "SELECT uuid FROM songs WHERE 1=1",
        // so playback drifted back to the whole library after the queue drained.
        const filter = `a:eq:"${artist.replace(/"/g, '\\"')}"`;
        const expected = await songsMatching(filter);
        await startRadio(filter);

        const more = await test.apiCall('sca_populate_queue', { count: 10 });
        await test.assert(more.success, 'sca_populate_queue should succeed: ' + JSON.stringify(more).slice(0, 200));

        const queue = await test.apiCall('queue_list', {});
        await test.assert(queue.success, 'queue_list should succeed');
        const items = (queue.result && queue.result.items) || [];
        await test.assertGreaterThan(items.length, 0, 'queue should have songs');
        for (const s of items) {
            await test.assert(expected.includes(s.uuid),
                `queue holds ${s.uuid}, outside ${filter} — the sca pool was unfiltered`);
        }
    });

    // ---- 4. radio_next keeps the filter across repopulation -----------------

    await test.test('radio_next repopulates within the filter', async () => {
        const filter = `a:eq:"${artist.replace(/"/g, '\\"')}"`;
        const expected = await songsMatching(filter);
        const radio = await startRadio(filter);

        for (let i = 0; i < 12; i++) {
            const nxt = await test.apiCall('radio_next', { session_id: radio.session_id });
            await test.assert(nxt.success, 'radio_next should succeed');
            if (nxt.result.error) break;   // library smaller than the loop
            await test.assert(expected.includes(nxt.result.uuid),
                `radio_next returned ${nxt.result.uuid}, outside ${filter} — ` +
                'the filter was lost when the queue was repopulated');
        }
    });

    await test.teardown();
})();

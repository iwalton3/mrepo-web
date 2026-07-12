/**
 * Virtual-Scroll Windowing Tests
 *
 * Verifies the createWindowing() virtual-scroll controller as wired into the
 * now-playing queue, quick-search advanced results, and playlist detail views:
 * large injected datasets render only a small window of rows, the spacer height
 * covers the full list, the window offset stays consistent with visibleStart,
 * the window follows the scroll container, and the per-row invariant
 * (rendered row index === controller visibleStart + DOM position) holds across
 * scroll positions.
 *
 * DESIGN NOTES:
 * - These tests do NOT log in. Datasets are injected client-side into the live
 *   component state via the module-cache singletons / the mounted component
 *   instance. They run fine against a purely static server:
 *   `python3 -m http.server 9900` from the frontend/ directory - no backend.
 * - The windowing controller is read through the component's `_win` handle
 *   (visibleStart / visibleEnd / offsetY / totalHeight), matching the contract
 *   in lib/windowing.d.ts. Row heights: queue 48px, quick-search 54px,
 *   playlist 52px.
 * - Waits are on rAF settling after each state mutation / scroll rather than
 *   fixed sleeps where possible.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    // NOTE: intentionally no test.login() - all data is injected client-side.

    console.log('Virtual-Scroll Windowing Tests');
    console.log('-'.repeat(50));

    // ==================== Now-Playing Queue Windowing ====================

    await test.goto('/');
    await test.wait(600);
    await test.assertExists('now-playing-page', 'Now Playing page should mount');

    // Inject a large temp queue and let the controller commit a range.
    await test.page.evaluate(async (N) => {
        const mod = await import('/stores/player-store.js');
        const ps = mod.playerStore;
        ps.state.tempQueueMode = true;
        ps.state.queueLoaded = true;
        ps.state.queueIndex = 0;
        const songs = [];
        for (let i = 0; i < N; i++) songs.push({ uuid: 'q' + i, title: 'Song ' + i, artist: 'Art ' + i, position: i, track_number: (i % 20) + 1 });
        ps.state.queue.replace(songs);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, 500);
    await test.wait(300);

    // Snapshot of the queue window state + invariant check helper (page-side).
    await test.page.evaluate(() => {
        window.__queueSnap = () => {
            const el = document.querySelector('now-playing-page');
            const w = el._win;
            const container = el.querySelector('.queue-container');
            const list = el.querySelector('.queue-list');
            const rows = [...el.querySelectorAll('.queue-item')];
            const m = list ? (list.style.transform || '').match(/translateY\(([-\d.]+)px\)/) : null;
            const translateY = m ? parseFloat(m[1]) : null;
            // invariant: rows[i] data-index === visibleStart + i
            let mismatch = null;
            for (let i = 0; i < rows.length; i++) {
                const di = +rows[i].getAttribute('data-index');
                if (di !== w.visibleStart + i) { mismatch = { pos: i, dataIndex: di, expected: w.visibleStart + i }; break; }
            }
            return {
                queueLen: el.getVisibleQueue().length,
                visibleStart: w.visibleStart, visibleEnd: w.visibleEnd, offsetY: w.offsetY,
                renderedRows: rows.length,
                containerHeight: container ? container.style.height : null,
                translateY, mismatch,
                firstIdx: rows.length ? +rows[0].getAttribute('data-index') : null
            };
        };
    });

    await test.test('queue: 500 items render a small window, not all rows', async () => {
        const s = await test.page.evaluate(() => window.__queueSnap());
        await test.assertEqual(s.queueLen, 500, 'queue should hold 500 items');
        await test.assertGreaterThan(s.renderedRows, 0, 'window should render rows');
        await test.assert(s.renderedRows < 500, `windowed rows (${s.renderedRows}) should be far fewer than 500`);
        await test.assert(s.renderedRows < 120, `windowed rows (${s.renderedRows}) should be a small window`);
    });

    await test.test('queue: spacer height covers all items (500 * 48 = 24000px)', async () => {
        const s = await test.page.evaluate(() => window.__queueSnap());
        await test.assertEqual(s.containerHeight, '24000px', 'queue-container height should span the full list');
    });

    await test.test('queue: translateY offset equals visibleStart * 48', async () => {
        const s = await test.page.evaluate(() => window.__queueSnap());
        await test.assertEqual(s.translateY, s.offsetY, 'list translateY should equal controller offsetY');
        await test.assertEqual(s.offsetY, s.visibleStart * 48, 'offsetY should equal visibleStart * rowHeight');
    });

    await test.test('queue: window invariant holds at top (data-index === visibleStart + pos)', async () => {
        const s = await test.page.evaluate(() => window.__queueSnap());
        await test.assert(s.mismatch === null, `invariant violated: ${JSON.stringify(s.mismatch)}`);
    });

    await test.test('queue: scrolling advances the window and re-slices rows', async () => {
        const r = await test.page.evaluate(async () => {
            const el = document.querySelector('now-playing-page');
            const wrapper = el.querySelector('.queue-scroll-wrapper');
            const raf = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
            const before = el._win.visibleStart;
            const beforeFirst = window.__queueSnap().firstIdx;
            wrapper.scrollTop = 6000;   // 6000 / 48 = 125 rows down
            wrapper.dispatchEvent(new Event('scroll'));
            await raf();
            const snap = window.__queueSnap();
            return { before, beforeFirst, after: el._win.visibleStart, snap };
        });
        await test.assertGreaterThan(r.after, r.before, 'visibleStart should advance after scrolling down');
        await test.assert(r.snap.mismatch === null, `invariant violated after scroll: ${JSON.stringify(r.snap.mismatch)}`);
        await test.assertEqual(r.snap.translateY, r.snap.visibleStart * 48, 'offset should track visibleStart after scroll');
        await test.assertEqual(r.snap.firstIdx, r.snap.visibleStart, 'first rendered row should be visibleStart');
    });

    await test.test('queue: invariant holds across a sweep of scroll positions', async () => {
        const res = await test.page.evaluate(async () => {
            const el = document.querySelector('now-playing-page');
            const wrapper = el.querySelector('.queue-scroll-wrapper');
            const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const maxScroll = wrapper.scrollHeight - wrapper.clientHeight;
            const positions = [0, 137, 480, 1003, 2400, 5051, 9600, maxScroll];
            const violations = [];
            for (const s of positions) {
                wrapper.scrollTop = s;
                wrapper.dispatchEvent(new Event('scroll'));
                await raf();
                const snap = window.__queueSnap();
                if (snap.mismatch) violations.push({ scrollTop: s, ...snap.mismatch });
                if (snap.translateY !== snap.visibleStart * 48) violations.push({ scrollTop: s, offsetMismatch: snap.translateY, expected: snap.visibleStart * 48 });
            }
            // reset
            wrapper.scrollTop = 0; wrapper.dispatchEvent(new Event('scroll')); await raf();
            return { positions: positions.length, violations };
        });
        await test.assert(res.violations.length === 0, `invariant violations: ${JSON.stringify(res.violations.slice(0, 6))}`);
    });

    // ==================== Quick-Search Advanced Results Windowing ====================

    await test.goto('/search/');
    await test.wait(600);
    await test.assertExists('quick-search-page', 'Quick search page should mount');

    await test.page.evaluate(async (N) => {
        const c = document.querySelector('quick-search-page');
        const items = [];
        for (let i = 0; i < N; i++) items.push({ uuid: 'u' + i, title: 'Song ' + i, artist: 'Art ' + i, album: 'Alb ' + i });
        c.state.searchPerformed = true;
        c.state.advancedMode = true;
        c.state.advancedResults = items;
        c.state.advancedTotalCount = N;
        if (c._win) c._win.refresh();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, 500);
    await test.wait(300);

    // Page-side snapshot for quick-search. Rows have no data-index, so the
    // invariant is verified via the numeric suffix of each row's title:
    // row at DOM position p should show 'Song ' + (visibleStart + p).
    await test.page.evaluate(() => {
        window.__searchSnap = () => {
            const c = document.querySelector('quick-search-page');
            const w = c._win;
            const spacer = c.querySelector('.songs-spacer');
            const list = c.querySelector('.songs-list');
            const rows = [...c.querySelectorAll('.advanced-results .song-item')].filter(r => !r.classList.contains('loading-item'));
            const listTop = list ? parseFloat(list.style.top) : null;
            let mismatch = null;
            for (let i = 0; i < rows.length; i++) {
                const titleEl = rows[i].querySelector('.song-title');
                const n = titleEl ? parseInt((titleEl.textContent || '').replace(/[^0-9]/g, ''), 10) : NaN;
                if (n !== w.visibleStart + i) { mismatch = { pos: i, titleIndex: n, expected: w.visibleStart + i }; break; }
            }
            return {
                total: c.state.advancedResults.length,
                visibleStart: w.visibleStart, visibleEnd: w.visibleEnd, offsetY: w.offsetY, totalHeight: w.totalHeight,
                renderedRows: rows.length,
                spacerHeight: spacer ? spacer.style.height : null,
                listTop, mismatch
            };
        };
    });

    await test.test('quick-search: 500 results render a small window, not all rows', async () => {
        const s = await test.page.evaluate(() => window.__searchSnap());
        await test.assertEqual(s.total, 500, 'should hold 500 advanced results');
        await test.assertGreaterThan(s.renderedRows, 0, 'window should render rows');
        await test.assert(s.renderedRows < 500, `windowed rows (${s.renderedRows}) should be far fewer than 500`);
        await test.assert(s.renderedRows < 120, `windowed rows (${s.renderedRows}) should be a small window`);
    });

    await test.test('quick-search: spacer height covers all items (500 * 54 = 27000px)', async () => {
        const s = await test.page.evaluate(() => window.__searchSnap());
        await test.assertEqual(s.spacerHeight, '27000px', 'songs-spacer height should span the full list');
        await test.assertEqual(s.totalHeight, 27000, 'controller totalHeight should be 27000');
    });

    await test.test('quick-search: list offset equals visibleStart * 54', async () => {
        const s = await test.page.evaluate(() => window.__searchSnap());
        await test.assertEqual(s.listTop, s.offsetY, 'songs-list top should equal controller offsetY');
        await test.assertEqual(s.offsetY, s.visibleStart * 54, 'offsetY should equal visibleStart * rowHeight');
    });

    await test.test('quick-search: window invariant holds at top (title index === visibleStart + pos)', async () => {
        const s = await test.page.evaluate(() => window.__searchSnap());
        await test.assert(s.mismatch === null, `invariant violated: ${JSON.stringify(s.mismatch)}`);
    });

    await test.test('quick-search: scrolling the router-wrapper advances the window', async () => {
        const r = await test.page.evaluate(async () => {
            const c = document.querySelector('quick-search-page');
            const wrapper = document.querySelector('div.router-wrapper');
            const raf = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
            const before = c._win.visibleStart;
            wrapper.scrollTop = 8000;   // 8000 / 54 ~= 148 rows down
            wrapper.dispatchEvent(new Event('scroll'));
            await raf();
            const snap = window.__searchSnap();
            return { before, after: c._win.visibleStart, snap, wrapperFound: !!wrapper };
        });
        await test.assert(r.wrapperFound, 'div.router-wrapper scroll container should exist');
        await test.assertGreaterThan(r.after, r.before, 'visibleStart should advance after scrolling');
        await test.assert(r.snap.mismatch === null, `invariant violated after scroll: ${JSON.stringify(r.snap.mismatch)}`);
        await test.assertEqual(r.snap.listTop, r.snap.visibleStart * 54, 'offset should track visibleStart after scroll');
    });

    await test.test('quick-search: invariant holds across a sweep of scroll positions', async () => {
        const res = await test.page.evaluate(async () => {
            const c = document.querySelector('quick-search-page');
            const wrapper = document.querySelector('div.router-wrapper');
            const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const positions = [0, 200, 1100, 3050, 6400, 12000, 20000];
            const violations = [];
            for (const s of positions) {
                wrapper.scrollTop = s;
                wrapper.dispatchEvent(new Event('scroll'));
                await raf();
                const snap = window.__searchSnap();
                if (snap.mismatch) violations.push({ scrollTop: s, ...snap.mismatch });
            }
            wrapper.scrollTop = 0; wrapper.dispatchEvent(new Event('scroll')); await raf();
            return { positions: positions.length, violations };
        });
        await test.assert(res.violations.length === 0, `invariant violations: ${JSON.stringify(res.violations.slice(0, 6))}`);
    });

    // ==================== Playlist Detail Windowing ====================

    await test.goto('/playlists/');
    await test.wait(600);
    await test.assertExists('playlists-page', 'Playlists page should mount');

    await test.page.evaluate(async (N) => {
        const c = document.querySelector('playlists-page');
        const songs = [];
        for (let i = 0; i < N; i++) songs.push({ uuid: 'p' + i, title: 'Song ' + i, artist: 'Art ' + i, album: 'Alb ' + i });
        c.state.view = 'detail';
        c.state.currentPlaylist = { id: 1, name: 'Test', song_count: N };
        c.state.playlistSongs.replace(songs);
        c.state.totalCount = N;
        c.state.isLoading = false;
        if (c._win) c._win.refresh();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, 300);
    await test.wait(300);

    await test.test('playlist detail: 300 songs window to a small row set with full-height spacer (300 * 52 = 15600px)', async () => {
        const s = await test.page.evaluate(() => {
            const c = document.querySelector('playlists-page');
            const container = c.querySelector('.songs-container');
            const rows = [...c.querySelectorAll('.songs-container .song-item')].filter(r => !r.classList.contains('loading-placeholder'));
            return {
                total: c.state.playlistSongs.length,
                renderedRows: rows.length,
                containerHeight: container ? container.style.height : null,
                totalHeight: c._win ? c._win.totalHeight : null
            };
        });
        await test.assertEqual(s.total, 300, 'should hold 300 playlist songs');
        await test.assertGreaterThan(s.renderedRows, 0, 'window should render rows');
        await test.assert(s.renderedRows < 300, `windowed rows (${s.renderedRows}) should be far fewer than 300`);
        await test.assertEqual(s.containerHeight, '15600px', 'songs-container height should span the full list');
        await test.assertEqual(s.totalHeight, 15600, 'controller totalHeight should be 15600');
    });

    await test.teardown();
})();

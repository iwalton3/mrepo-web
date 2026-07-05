/**
 * Queue / Playlist Reorder Semantics Tests
 *
 * Verifies drag-and-drop reorder behavior of the now-playing queue and the
 * arrow-button reorder of playlist detail songs, by driving the real
 * component handlers with controlled geometry and asserting the resulting
 * order from the store.
 *
 * DESIGN NOTES:
 * - These tests do NOT log in. All data is injected client-side through the
 *   live module-cache singletons (`import('/stores/player-store.js')` returns
 *   the same store instance the app uses). Temp-queue mode makes
 *   reorderQueue/reorderQueueBatch run fully local (no backend sync), and the
 *   playlist arrow-reorder applies its optimistic update synchronously before
 *   the (failing, ignored) API call, so both work against a purely static
 *   server. You can run these against `python3 -m http.server 9900` launched
 *   from the frontend/ directory - no backend required.
 * - Reorders are driven with synthetic DragEvents dispatched to the real row
 *   elements (dragstart -> dragover -> drop -> dragend). clientY is placed in
 *   the upper quarter (insert-before) or lower quarter (insert-after) of the
 *   target row to exercise the pointer-midpoint insertion-gap logic
 *   (_computeDropGap). Expected orders are hand-computed from the handlers in
 *   pages/now-playing.js (handleDrop) and pages/playlists-page.js.
 *
 * Queue fixture is a 6-item labeled queue "ABCDEF" (6 rows all fit in the
 * window, so no virtual-scroll offset complicates row geometry).
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

// Install page-side helpers that own the now-playing queue fixture + the
// synthetic drag driver. Re-run after every navigation (goto reloads the page).
async function installQueueHelpers() {
    await test.page.evaluate(async () => {
        const mod = await import('/stores/player-store.js');
        const ps = mod.playerStore;
        const el = document.querySelector('now-playing-page');
        const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

        window.__ps = ps;
        window.__el = el;
        window.__raf = raf;

        window.__reset = async () => {
            ps.state.tempQueueMode = true;   // local-only queue, no backend sync
            ps.state.queueLoaded = true;
            ps.state.queueIndex = 0;
            ps.state.queue = LETTERS.map((c, i) => ({
                uuid: c, title: c, artist: 'Art ' + c, position: i, track_number: (i % 20) + 1
            }));
            ps.state.queueVersion++;
            el.state.selectionMode = false;
            el.state.selectedIndices = new Set();
            el.state.selectionVersion++;
            await raf();
        };

        window.__order = () => ps.state.queue.map(s => s.uuid).join('');
        window.__rowEl = (idx) => el.querySelector(`.queue-item[data-index="${idx}"]`);
        window.__fire = (elem, type, cx, cy) => {
            const dt = new DataTransfer();
            elem.dispatchEvent(new DragEvent(type, {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy
            }));
        };
        // Upper quarter -> gap === row index (insert before); lower quarter ->
        // gap === index + 1 (insert after).
        window.__yFor = (rect, half) => rect.top + (half === 'lower' ? rect.height * 0.75 : rect.height * 0.25);

        window.__single = async (from, target, half) => {
            await window.__reset();
            const fEl = window.__rowEl(from);
            if (!fEl) return { error: `source row ${from} not rendered` };
            const fr = fEl.getBoundingClientRect();
            window.__fire(fEl, 'dragstart', fr.left + 5, fr.top + fr.height / 2);
            const tEl = window.__rowEl(target);
            if (!tEl) return { error: `target row ${target} not rendered` };
            const tr = tEl.getBoundingClientRect();
            const cy = window.__yFor(tr, half);
            window.__fire(tEl, 'dragover', tr.left + 5, cy);
            window.__fire(tEl, 'drop', tr.left + 5, cy);
            window.__fire(fEl, 'dragend', 0, 0);
            await window.__raf();
            return { order: window.__order() };
        };

        window.__group = async (selected, from, target, half) => {
            await window.__reset();
            el.state.selectionMode = true;
            el.state.selectedIndices = new Set(selected);
            el.state.selectionVersion++;
            await window.__raf();
            const fEl = window.__rowEl(from);
            if (!fEl) return { error: `source row ${from} not rendered (group)` };
            const fr = fEl.getBoundingClientRect();
            window.__fire(fEl, 'dragstart', fr.left + 5, fr.top + fr.height / 2);
            const tEl = window.__rowEl(target);
            if (!tEl) return { error: `target row ${target} not rendered (group)` };
            const tr = tEl.getBoundingClientRect();
            const cy = window.__yFor(tr, half);
            window.__fire(tEl, 'dragover', tr.left + 5, cy);
            window.__fire(tEl, 'drop', tr.left + 5, cy);
            window.__fire(fEl, 'dragend', 0, 0);
            await window.__raf();
            return { order: window.__order() };
        };

        // ---- Mobile TOUCH drag driver (drag-handle path) -------------------
        // Drives the real handleHandleTouch{Start,Move,End} handlers by
        // dispatching synthetic touch events on the source row's
        // span.drag-handle (rendered only when NOT in selection mode). The
        // handlers read e.touches[0].clientX/clientY and resolve the hovered
        // row via document.elementFromPoint. Unlike the desktop drag path,
        // the touch path has no upper/lower-half nibble: the hovered row IS
        // the insertion gap ("insert before this row"). handleHandleTouchEnd
        // translates gap -> reorderQueue's remove-then-insert index with
        //   to = gap > from ? gap - 1 : gap
        // and no-ops when to === from. We therefore hover the TARGET row's
        // center so elementFromPoint resolves it as the gap.
        window.__fireTouch = (elem, type, cx, cy) => {
            const ev = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'touches', {
                value: (cx === null ? [] : [{ clientX: cx, clientY: cy }]),
                configurable: true
            });
            elem.dispatchEvent(ev);
        };

        window.__touch = async (from, target) => {
            await window.__reset();
            const fEl = window.__rowEl(from);
            if (!fEl) return { error: `source row ${from} not rendered` };
            const handle = fEl.querySelector('.drag-handle');
            if (!handle) return { error: `source row ${from} has no .drag-handle` };
            const tEl = window.__rowEl(target);
            if (!tEl) return { error: `target row ${target} not rendered` };

            // touchstart on the handle (marks source, adds 'dragging' class)
            const fr = fEl.getBoundingClientRect();
            window.__fireTouch(handle, 'touchstart', fr.left + 5, fr.top + fr.height / 2);
            await window.__raf();

            // touchmove with the finger over the TARGET row's center, so
            // elementFromPoint -> closest('.queue-item') resolves data-index
            // === target and sets _touchDropIndex = target (the gap). Source
            // row now carries 'dragging' and is excluded by the handler.
            const tr = tEl.getBoundingClientRect();
            const cx = tr.left + tr.width / 2;
            const cy = tr.top + tr.height / 2;
            window.__fireTouch(handle, 'touchmove', cx, cy);
            await window.__raf();
            const drop = el._touchDropIndex;   // capture before touchend clears it

            // touchend performs the reorder (reads no touches)
            window.__fireTouch(handle, 'touchend', null, null);
            await window.__raf();
            return { order: window.__order(), drop };
        };
    });
}

async function single(from, target, half) {
    const r = await test.page.evaluate((f, t, h) => window.__single(f, t, h), from, target, half);
    if (r.error) throw new Error(r.error);
    return r.order;
}

async function group(selected, from, target, half) {
    const r = await test.page.evaluate((s, f, t, h) => window.__group(s, f, t, h), selected, from, target, half);
    if (r.error) throw new Error(r.error);
    return r.order;
}

async function touch(from, target) {
    const r = await test.page.evaluate((f, t) => window.__touch(f, t), from, target);
    if (r.error) throw new Error(r.error);
    return r.order;
}

(async () => {
    await test.setup();
    // NOTE: intentionally no test.login() - all data is injected client-side.

    console.log('Queue / Playlist Reorder Semantics Tests');
    console.log('-'.repeat(50));

    await test.goto('/');
    await test.wait(600);
    await test.assertExists('now-playing-page', 'Now Playing page should mount');
    await installQueueHelpers();

    // ==================== Single-item drags (queue ABCDEF) ====================

    await test.test('single down, lower half of D inserts AFTER D (A->pos3)', async () => {
        // A dragged onto lower half of D: gap=4, to=gap-1=3 -> BCDAEF
        await test.assertEqual(await single(0, 3, 'lower'), 'BCDAEF');
    });

    await test.test('single down, upper half of D inserts BEFORE D (A->pos2)', async () => {
        // gap=3, to=gap-1=2 -> BCADEF
        await test.assertEqual(await single(0, 3, 'upper'), 'BCADEF');
    });

    await test.test('single up, upper half of B inserts BEFORE B (F->pos1)', async () => {
        // F dragged up onto upper half of B: gap=1, to=1 -> AFBCDE
        await test.assertEqual(await single(5, 1, 'upper'), 'AFBCDE');
    });

    await test.test('single up, lower half of B inserts AFTER B (F->pos2)', async () => {
        // gap=2, to=2 -> ABFCDE
        await test.assertEqual(await single(5, 1, 'lower'), 'ABFCDE');
    });

    await test.test('single drop below last row F clamps to end (A->pos5)', async () => {
        // A onto lower half of F: gap=6, to=gap-1=5 (last valid) -> BCDEFA
        await test.assertEqual(await single(0, 5, 'lower'), 'BCDEFA');
    });

    // No-op guards: an insertion gap adjacent to the dragged row resolves to
    // to === from, so the queue is unchanged.
    await test.test('no-op: drop on own row, upper half', async () => {
        await test.assertEqual(await single(2, 2, 'upper'), 'ABCDEF');
    });

    await test.test('no-op: drop on own row, lower half', async () => {
        await test.assertEqual(await single(2, 2, 'lower'), 'ABCDEF');
    });

    await test.test('no-op: gap === from (row above, lower half)', async () => {
        // Drag C(2) onto lower half of B(1): gap=2 === from -> no-op
        await test.assertEqual(await single(2, 1, 'lower'), 'ABCDEF');
    });

    await test.test('no-op: gap === from+1 (row below, upper half)', async () => {
        // Drag C(2) onto upper half of D(3): gap=3, to=2 === from -> no-op
        await test.assertEqual(await single(2, 3, 'upper'), 'ABCDEF');
    });

    // ============= Mobile TOUCH drags (drag-handle path, ABCDEF) =============
    // Regression coverage for the single-item touch drag off-by-one when
    // moving DOWN. The touch path's _touchDropIndex is the *hovered row* = an
    // insertion GAP ("insert before this row"), but reorderQueue takes a
    // remove-then-insert index. handleHandleTouchEnd now translates
    //   to = gap > from ? gap - 1 : gap   (no-op when to === from).
    // Each expectation below is hand-computed from those gap semantics.

    await test.test('touch down by one: drag A, hover C -> BACDEF', async () => {
        // from=0 (A), hover row C -> gap=2. gap>from, so to=gap-1=1.
        // reorderQueue(0,1): remove A -> BCDEF, insert A at idx1 -> B A C D E F.
        // (Hovering B instead would be gap=1 -> to=0 === from, a no-op; the
        //  real one-step-down move requires hovering the row *after* the
        //  neighbor. See the no-op guard test below.)
        await test.assertEqual(await touch(0, 2), 'BACDEF');
    });

    await test.test('touch down by several: drag A, hover E -> BCDAEF', async () => {
        // from=0 (A), hover row E -> gap=4. gap>from, so to=gap-1=3.
        // reorderQueue(0,3): remove A -> BCDEF, insert A at idx3 -> B C D A E F.
        await test.assertEqual(await touch(0, 4), 'BCDAEF');
    });

    await test.test('touch up: drag E, hover B -> AEBCDF', async () => {
        // from=4 (E), hover row B -> gap=1. gap<from, so to=gap=1.
        // reorderQueue(4,1): remove E -> ABCDF, insert E at idx1 -> A E B C D F.
        await test.assertEqual(await touch(4, 1), 'AEBCDF');
    });

    await test.test('touch no-op: drag A, hover the row directly below (B)', async () => {
        // from=0 (A), hover row B -> gap=1. gap>from, so to=gap-1=0 === from.
        // The guard skips reorderQueue -> queue unchanged. This is the exact
        // off-by-one that previously mis-moved A one slot down.
        await test.assertEqual(await touch(0, 1), 'ABCDEF');
    });

    // ==================== Group drags (select A,B) ====================

    await test.test('group down, lower half of E moves {A,B} after E', async () => {
        // select {0,1}, drag from 0 onto lower half of E(4): gap=5 -> CDEABF
        await test.assertEqual(await group([0, 1], 0, 4, 'lower'), 'CDEABF');
    });

    await test.test('group down, upper half of E moves {A,B} before E', async () => {
        // gap=4 -> CDABEF
        await test.assertEqual(await group([0, 1], 0, 4, 'upper'), 'CDABEF');
    });

    await test.test('group no-op: drop on the dragged row', async () => {
        // drop on row 0 (=== dragIndex) -> unchanged
        await test.assertEqual(await group([0, 1], 0, 0, 'upper'), 'ABCDEF');
    });

    // ==================== Playlist arrow-reorder (MoveUp / MoveDown) ====================
    // playlists-page's detail view needs playlist data from the API, but the
    // songs list is injectable and handlePlaylistMove{Up,Down} apply their
    // optimistic reorder to state.playlistSongs synchronously (before the
    // awaited, backend-only reorder call), so we can assert the local result.

    await test.goto('/playlists/');
    await test.wait(600);
    await test.assertExists('playlists-page', 'Playlists page should mount');

    await test.page.evaluate(() => {
        const c = document.querySelector('playlists-page');
        const songs = [];
        for (let i = 0; i < 6; i++) songs.push({ uuid: String(i), title: 'S' + i, artist: 'A' + i, album: 'Al' + i });
        c.state.view = 'detail';
        c.state.currentPlaylist = { id: 1, name: 'Test', song_count: 6 };
        c.state.playlistSongs = songs;
        c.state.totalCount = 6;
        c.state.isLoading = false;
    });
    await test.wait(300);

    await test.test('playlist MoveDown swaps a song with the one below it', async () => {
        // MoveDown(1): reorderPlaylistSongs(1, 3) -> remove idx1, insert at 2
        // -> 0,2,1,3,4,5 (S1 and S2 swap). Read synchronously (optimistic).
        const order = await test.page.evaluate(() => {
            const c = document.querySelector('playlists-page');
            c.state.playlistSongs = ['0', '1', '2', '3', '4', '5'].map((u, i) =>
                ({ uuid: u, title: 'S' + u, artist: 'A' + u, album: 'Al' + u }));
            c.handlePlaylistMoveDown(1, { stopPropagation() {} });   // do NOT await
            return c.state.playlistSongs.map(s => s.uuid).join('');
        });
        await test.assertEqual(order, '021345');
    });

    await test.test('playlist MoveUp swaps a song with the one above it', async () => {
        // MoveUp(2): reorderPlaylistSongs(2, 1) -> remove idx2, insert at 1
        // -> 0,2,1,3,4,5 (S2 and S1 swap).
        const order = await test.page.evaluate(() => {
            const c = document.querySelector('playlists-page');
            c.state.playlistSongs = ['0', '1', '2', '3', '4', '5'].map((u, i) =>
                ({ uuid: u, title: 'S' + u, artist: 'A' + u, album: 'Al' + u }));
            c.handlePlaylistMoveUp(2, { stopPropagation() {} });   // do NOT await
            return c.state.playlistSongs.map(s => s.uuid).join('');
        });
        await test.assertEqual(order, '021345');
    });

    await test.test('playlist MoveUp on first row is a no-op', async () => {
        const order = await test.page.evaluate(() => {
            const c = document.querySelector('playlists-page');
            c.state.playlistSongs = ['0', '1', '2', '3', '4', '5'].map((u) =>
                ({ uuid: u, title: 'S' + u, artist: 'A' + u, album: 'Al' + u }));
            c.handlePlaylistMoveUp(0, { stopPropagation() {} });
            return c.state.playlistSongs.map(s => s.uuid).join('');
        });
        await test.assertEqual(order, '012345');
    });

    await test.test('playlist MoveDown on last row is a no-op', async () => {
        const order = await test.page.evaluate(() => {
            const c = document.querySelector('playlists-page');
            c.state.playlistSongs = ['0', '1', '2', '3', '4', '5'].map((u) =>
                ({ uuid: u, title: 'S' + u, artist: 'A' + u, album: 'Al' + u }));
            c.handlePlaylistMoveDown(5, { stopPropagation() {} });
            return c.state.playlistSongs.map(s => s.uuid).join('');
        });
        await test.assertEqual(order, '012345');
    });

    await test.teardown();
})();

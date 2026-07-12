/**
 * playlists-fixes.e2e.js — regression pins for the July 2026 playlist bug round:
 *
 * 1. Temp-queue "Save as Playlist" must save the TEMP queue, not the synced
 *    main queue (queue_save_as_playlist snapshots the server queue, which in
 *    temp mode is the wrong one - the store now composes the playlist
 *    client-side from the live temp queue).
 * 2. Playlists support DUPLICATE songs. The song list is keyed by
 *    uuid+position, so duplicate rows keep distinct identity: they render as
 *    separate rows and selection of one copy must not select the other.
 *    (uuid-only keys used to collapse duplicates and the view scrolled/
 *    selected erratically.)
 * 3. In selection mode on touch, only SELECTED rows act as grab handles.
 *    Touching an unselected row must never start a drag (it used to via
 *    uuid->first-index resolution, hijacking scroll gestures).
 */

const TestHelper = require('../test-helper');

const USER = { username: process.env.TEST_USER_NAME, password: process.env.TEST_USER_PASS };
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login(USER);

    console.log('Playlist Fixes Tests');
    console.log('-'.repeat(50));

    const sl = await test.apiCall('songs_list', { limit: 4, sort: 'title', order: 'asc' });
    const [a, b, c, d] = sl.result.items.map((i) => i.uuid);

    // ==================== 1. Temp-queue save ====================

    await test.test('temp-queue Save as Playlist saves the temp queue, not the main queue', async () => {
        // Server (main) queue holds A,B ...
        await test.apiCall('queue_clear', {});
        await test.apiCall('queue_add', { song_uuids: [a, b] });

        // ... while the local temp queue holds C,D.
        const plName = 'TempSave ' + Date.now();
        const saved = await test.page.evaluate(async (cU, dU, name) => {
            const mod = await import('/stores/player-store.js');
            const ps = mod.playerStore;
            ps.state.tempQueueMode = true;
            ps.state.queueLoaded = true;
            ps.state.queue = [
                { uuid: cU, title: 'c', position: 0 },
                { uuid: dU, title: 'd', position: 1 },
            ];
            ps.state.queueVersion++;
            try {
                return await mod.player.saveQueueAsPlaylist(name);
            } finally {
                ps.state.tempQueueMode = false;
                ps.state.queueVersion++;
            }
        }, c, d, plName);

        await test.assert(saved && saved.id, 'save should return the created playlist: ' + JSON.stringify(saved));
        const songs = await test.apiCall('playlists_get_songs', { playlist_id: saved.id });
        const uuids = songs.result.items.map((i) => i.uuid);
        await test.assertEqual(JSON.stringify(uuids), JSON.stringify([c, d]),
            'saved playlist must contain the TEMP queue songs');
        await test.assert(!uuids.includes(a) && !uuids.includes(b),
            'saved playlist must NOT contain the main-queue songs');
    });

    // ==================== 2 + 3. Duplicates rendering / selection touch ====================

    // Real playlist for the detail view; duplicates are injected client-side
    // below to exercise the rendering/selection paths in isolation. (The add
    // APIs now APPEND duplicates too - that end-to-end path is pinned in the
    // "duplicate songs are first-class" section further down.)
    const created = await test.apiCall('playlists_create', { name: 'DupUI ' + Date.now() });
    const pid = created.result.id;
    await test.apiCall('playlists_add_songs', { playlist_id: pid, song_uuids: [a, b, c] });

    await test.goto(`/playlists/${pid}/`);
    await test.wait(800);

    await test.test('duplicate songs render as distinct rows with independent selection', async () => {
        const r = await test.page.evaluate(async () => {
            const el = document.querySelector('playlists-page');
            const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
            const songs = el.state.playlistSongs.filter(Boolean);
            // Inject a duplicate: [A, B, A]. replace() bumps the versionedList
            // version, which the memoEach key reads (no manual counter needed).
            el.state.playlistSongs.replace([songs[0], songs[1], { ...songs[0] }]);
            el.state.totalCount = 3;
            await raf();

            const rows = [...el.querySelectorAll('.song-item')];
            const indices = rows.map((x) => x.dataset.index);
            const uuids = rows.map((x) => x.dataset.uuid);

            // Enable selection mode and select ONLY the second copy (index 2).
            // The selection bit lives in the memoEach key, so toggling
            // selectionMode re-renders the rows (no manual version bump needed).
            el.state.selectionMode = true;
            await raf();
            el.toggleSelection(2, { stopPropagation() {} });
            await raf();

            const selected = [...el.querySelectorAll('.song-item')].map((x) =>
                x.classList.contains('selected'));
            return { indices, uuids, selected };
        });

        await test.assertEqual(r.indices.length, 3, 'all three rows render (duplicate included)');
        await test.assertEqual(JSON.stringify(r.indices), JSON.stringify(['0', '1', '2']),
            'rows keep their positions');
        await test.assert(r.uuids[0] === r.uuids[2], 'rows 0 and 2 are the same song (duplicate)');
        await test.assertEqual(JSON.stringify(r.selected), JSON.stringify([false, false, true]),
            'selecting the duplicate copy must not select the original');
    });

    await test.test('selection mode: unselected rows scroll, only selected rows arm a drag', async () => {
        const r = await test.page.evaluate(async () => {
            const el = document.querySelector('playlists-page');
            const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
            const fire = (target, type, x, y) => {
                const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
                // dispatchEvent returns false when preventDefault was called -
                // for touchend that means the browser would NOT synthesize the
                // tap's click (dead checkboxes on real devices).
                return target.dispatchEvent(new TouchEvent(type, {
                    touches: type === 'touchend' ? [] : [touch],
                    changedTouches: [touch],
                    bubbles: true, cancelable: true,
                }));
            };
            const row = (i) => el.querySelector(`.song-item[data-index="${i}"]`);

            // Row 1 is UNSELECTED (only index 2 is selected from the previous
            // test): a vertical swipe over it must not arm a drag.
            const r1 = row(1);
            const box1 = r1.getBoundingClientRect();
            fire(r1, 'touchstart', box1.x + 40, box1.y + 5);
            fire(r1, 'touchmove', box1.x + 40, box1.y + 45);
            const unselectedDragged = !!el.querySelector('.song-item.dragging');
            const unselectedEndNotPrevented = fire(r1, 'touchend', box1.x + 40, box1.y + 45);
            await raf();

            // Row 2 IS selected: the same gesture arms the drag (grab handle).
            const r2 = row(2);
            const box2 = r2.getBoundingClientRect();
            fire(r2, 'touchstart', box2.x + 40, box2.y + 5);
            fire(r2, 'touchmove', box2.x + 40, box2.y - 45);
            const selectedDragged = !!el.querySelector('.song-item.dragging');
            // Abort the drag over its own row (no drop target -> no reorder).
            fire(r2, 'touchend', box2.x + 40, box2.y + 5);
            await raf();

            const order = [...el.querySelectorAll('.song-item')].map((x) => x.dataset.index);
            return { unselectedDragged, unselectedEndNotPrevented, selectedDragged, order };
        });

        await test.assert(!r.unselectedDragged,
            'touch-dragging an UNSELECTED row must not arm a drag (scroll wins)');
        await test.assert(r.unselectedEndNotPrevented,
            'unselected-row touchend must not be default-prevented (tap-select depends on the synthesized click)');
        await test.assert(r.selectedDragged,
            'a selected row acts as a grab handle and arms the drag');
        await test.assertEqual(JSON.stringify(r.order), JSON.stringify(['0', '1', '2']),
            'no accidental reorder happened');
    });

    await test.test('checkbox tap with finger wobble toggles selection - never drags/reorders', async () => {
        const r = await test.page.evaluate(async () => {
            const el = document.querySelector('playlists-page');
            const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
            const fire = (target, type, x, y) => {
                const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
                // dispatchEvent returns false when preventDefault was called -
                // for touchend that means the browser would NOT synthesize the
                // tap's click (dead checkboxes on real devices).
                return target.dispatchEvent(new TouchEvent(type, {
                    touches: type === 'touchend' ? [] : [touch],
                    changedTouches: [touch],
                    bubbles: true, cancelable: true,
                }));
            };

            // Row 2 is selected (from the earlier test). Tap ITS CHECKBOX to
            // unselect, with realistic finger wobble (>10px) during the tap.
            const row = el.querySelector('.song-item[data-index="2"]');
            const cb = row.querySelector('.selection-checkbox');
            const box = cb.getBoundingClientRect();
            const x = box.x + box.width / 2, y = box.y + box.height / 2;
            fire(cb, 'touchstart', x, y);
            fire(cb, 'touchmove', x + 6, y + 18);   // wobble past the old 10px gate
            const draggedDuringTap = !!el.querySelector('.song-item.dragging');
            const endNotPrevented = fire(cb, 'touchend', x + 6, y + 18);
            await raf();
            // The browser would now synthesize a click on the checkbox.
            cb.click();
            await raf();

            const order = [...el.querySelectorAll('.song-item')].map((s) => s.dataset.index);
            return {
                draggedDuringTap,
                endNotPrevented,
                selectedAfter: [...el.state.selectedIndices],
                order,
            };
        });

        await test.assert(!r.draggedDuringTap,
            'a tap starting on the checkbox must never arm a drag');
        await test.assert(r.endNotPrevented,
            'checkbox touchend must not be default-prevented (or the real tap synthesizes no click and the checkbox is dead)');
        await test.assertEqual(JSON.stringify(r.order), JSON.stringify(['0', '1', '2']),
            'no reorder from the checkbox tap');
        await test.assertEqual(JSON.stringify(r.selectedAfter), JSON.stringify([]),
            'the checkbox tap toggled the selection off');
    });

    await test.test('selection toggle replaces only the toggled row (scroll-anchor safety)', async () => {
        const r = await test.page.evaluate(async () => {
            const el = document.querySelector('playlists-page');
            const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
            el.state.selectionMode = true;
            await raf();
            const rowEl = (i) => el.querySelector(`.song-item[data-index="${i}"]`);
            const before0 = rowEl(0);
            const before1 = rowEl(1);
            const wrapper = document.querySelector('.router-wrapper');
            const scrollBefore = wrapper.scrollTop;
            el.toggleSelection(1, { stopPropagation() {} });
            await raf();
            return {
                row0Same: rowEl(0) === before0,
                row1Same: rowEl(1) === before1,
                row1Selected: rowEl(1).classList.contains('selected'),
                scrollDelta: wrapper.scrollTop - scrollBefore,
                anchor: getComputedStyle(wrapper).overflowAnchor,
            };
        });
        // Replacing EVERY row per toggle is what let Chrome's scroll anchoring
        // (Android) walk the view up by visible+buffer rows.
        await test.assert(r.row0Same, 'untouched rows keep their DOM nodes (memo cache hit)');
        await test.assert(!r.row1Same, 'the toggled row is re-rendered');
        await test.assert(r.row1Selected, 'toggled row shows selected');
        await test.assertEqual(r.scrollDelta, 0, 'scroll position unchanged by the toggle');
        await test.assertEqual(r.anchor, 'none', 'scroll container opts out of scroll anchoring');
    });

    // ==================== 4. Duplicate songs are first-class (server state) ====================
    //
    // The owner's decision: playlists intentionally support the same song more
    // than once (the VVVVVV soundtrack reuses tracks). These pin the WRITE and
    // MUTATION paths against the real backend, asserting server state via
    // playlists_get_songs after each op.

    await test.test('adding the same song twice keeps both copies, in order (server state)', async () => {
        const p = await test.apiCall('playlists_create', { name: 'DupAdd ' + Date.now() });
        const dp = p.result.id;
        // Batch add with a repeat, then a single add of the same song again.
        await test.apiCall('playlists_add_songs', { playlist_id: dp, song_uuids: [a, b, a] });
        await test.apiCall('playlists_add_song', { playlist_id: dp, song_uuid: a });
        const songs = await test.apiCall('playlists_get_songs', { playlist_id: dp });
        const uuids = songs.result.items.map((i) => i.uuid);
        await test.assertEqual(JSON.stringify(uuids), JSON.stringify([a, b, a, a]),
            'every copy persists in add order (no dedup)');
        await test.apiCall('playlists_delete', { playlist_id: dp });
    });

    await test.test('removing ONE copy by index removes exactly that copy', async () => {
        const p = await test.apiCall('playlists_create', { name: 'DupRm ' + Date.now() });
        const dp = p.result.id;
        await test.apiCall('playlists_add_songs', { playlist_id: dp, song_uuids: [a, b, a] });
        // Remove the FIRST copy of A (rank 0); the trailing copy must survive.
        await test.apiCall('playlists_remove_song', { playlist_id: dp, song_uuid: a, index: 0 });
        const songs = await test.apiCall('playlists_get_songs', { playlist_id: dp });
        const uuids = songs.result.items.map((i) => i.uuid);
        await test.assertEqual(JSON.stringify(uuids), JSON.stringify([b, a]),
            'only the addressed copy of A is gone; B and the other copy remain');
        await test.apiCall('playlists_delete', { playlist_id: dp });
    });

    await test.test('UI remove of a duplicate row deletes exactly that copy (end to end)', async () => {
        const p = await test.apiCall('playlists_create', { name: 'DupUIrm ' + Date.now() });
        const dp = p.result.id;
        await test.apiCall('playlists_add_songs', { playlist_id: dp, song_uuids: [a, b, a] });
        await test.goto(`/playlists/${dp}/`);
        await test.wait(700);
        await test.page.evaluate(async () => {
            const el = document.querySelector('playlists-page');
            const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
            const songs = el.state.playlistSongs.filter(Boolean);
            // Click "remove" on the FIRST row (index 0) - the first copy of A.
            await el.handleRemoveSong(songs[0], 0, { stopPropagation() {} });
            await raf();
        });
        await test.wait(300);
        const songs = await test.apiCall('playlists_get_songs', { playlist_id: dp });
        const uuids = songs.result.items.map((i) => i.uuid);
        await test.assertEqual(JSON.stringify(uuids), JSON.stringify([b, a]),
            'removing the first row via the UI deletes only that copy (index threads to the server)');
        await test.apiCall('playlists_delete', { playlist_id: dp });
    });

    await test.test('reordering a duplicate moves the right copy', async () => {
        const p = await test.apiCall('playlists_create', { name: 'DupRe ' + Date.now() });
        const dp = p.result.id;
        await test.apiCall('playlists_add_songs', { playlist_id: dp, song_uuids: [a, b, a] });
        // [A, B, A] -> [A, A, B]
        await test.apiCall('playlists_reorder', { playlist_id: dp, positions: [
            { uuid: a, position: 0 }, { uuid: a, position: 1 }, { uuid: b, position: 2 },
        ] });
        const songs = await test.apiCall('playlists_get_songs', { playlist_id: dp });
        const uuids = songs.result.items.map((i) => i.uuid);
        await test.assertEqual(JSON.stringify(uuids), JSON.stringify([a, a, b]),
            'duplicate-aware reorder produces [A, A, B] without collapsing the copies');
        await test.apiCall('playlists_delete', { playlist_id: dp });
    });

    await test.test('queue with a duplicate saved as playlist keeps both copies', async () => {
        await test.apiCall('queue_clear', {});
        await test.apiCall('queue_add', { song_uuids: [a, b, a] });
        const saved = await test.apiCall('queue_save_as_playlist', { name: 'DupQ ' + Date.now() });
        const dp = saved.result.playlist_id;
        const songs = await test.apiCall('playlists_get_songs', { playlist_id: dp });
        const uuids = songs.result.items.map((i) => i.uuid);
        await test.assertEqual(JSON.stringify(uuids), JSON.stringify([a, b, a]),
            'saving a queue that repeats a song preserves the duplicate');
        await test.apiCall('playlists_delete', { playlist_id: dp });
        await test.apiCall('queue_clear', {});
    });

    // Cleanup
    await test.apiCall('playlists_delete', { playlist_id: pid });
    await test.apiCall('queue_clear', {});

    await test.teardown();
})();

/**
 * Shared page-side drivers for the REAL (logged-in, non-temp) now-playing queue.
 *
 * Unlike queue-reorder.test.js (which drives a local temp-mode queue), these
 * helpers operate on the server-backed queue: they dispatch the same synthetic
 * DragEvent / touch sequences against the real .queue-item rows, then the caller
 * polls queue_list to assert SERVER state after the op (the point of the
 * remote-queue suite — the reorder no-op regression lived exactly here).
 */

/**
 * Install window.__q* driver helpers into the page. Call after now-playing-page
 * has mounted with the loaded queue. Safe to re-call after navigation.
 */
async function installQueueDriver(test) {
    await test.page.evaluate(() => {
        const el = document.querySelector('now-playing-page');
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        window.__qEl = el;
        window.__qRaf = raf;
        window.__qRow = (idx) => el.querySelector(`.queue-item[data-index="${idx}"]`);

        window.__qFire = (elem, type, cx, cy) => {
            const dt = new DataTransfer();
            elem.dispatchEvent(new DragEvent(type, {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy,
            }));
        };
        // Upper quarter -> gap === index (insert before); lower quarter -> gap === index+1.
        window.__qYFor = (rect, half) => rect.top + (half === 'lower' ? rect.height * 0.75 : rect.height * 0.25);

        // Desktop drag: returns immediately after dispatching; the store's async
        // reorder + server sync happens after. Caller polls queue_list.
        window.__qDrag = async (from, target, half) => {
            const fEl = window.__qRow(from);
            if (!fEl) return { error: `source row ${from} not rendered` };
            const tEl = window.__qRow(target);
            if (!tEl) return { error: `target row ${target} not rendered` };
            const fr = fEl.getBoundingClientRect();
            window.__qFire(fEl, 'dragstart', fr.left + 5, fr.top + fr.height / 2);
            const tr = tEl.getBoundingClientRect();
            const cy = window.__qYFor(tr, half);
            window.__qFire(tEl, 'dragover', tr.left + 5, cy);
            window.__qFire(tEl, 'drop', tr.left + 5, cy);
            window.__qFire(fEl, 'dragend', 0, 0);
            await window.__qRaf();
            return { ok: true };
        };

        // Touch drag via the drag-handle path (mobile). The hovered row IS the
        // insertion gap; handleHandleTouchEnd translates gap->reorder index.
        window.__qFireTouch = (elem, type, cx, cy) => {
            const ev = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'touches', {
                value: (cx === null ? [] : [{ clientX: cx, clientY: cy }]),
                configurable: true,
            });
            elem.dispatchEvent(ev);
        };
        window.__qTouch = async (from, target) => {
            const fEl = window.__qRow(from);
            if (!fEl) return { error: `source row ${from} not rendered` };
            const handle = fEl.querySelector('.drag-handle');
            if (!handle) return { error: `source row ${from} has no .drag-handle` };
            const tEl = window.__qRow(target);
            if (!tEl) return { error: `target row ${target} not rendered` };
            const fr = fEl.getBoundingClientRect();
            window.__qFireTouch(handle, 'touchstart', fr.left + 5, fr.top + fr.height / 2);
            await window.__qRaf();
            const tr = tEl.getBoundingClientRect();
            window.__qFireTouch(handle, 'touchmove', tr.left + tr.width / 2, tr.top + tr.height / 2);
            await window.__qRaf();
            window.__qFireTouch(handle, 'touchend', null, null);
            await window.__qRaf();
            return { ok: true };
        };
    });
}

async function desktopDrag(test, from, target, half) {
    const r = await test.page.evaluate((f, t, h) => window.__qDrag(f, t, h), from, target, half);
    if (r.error) throw new Error(r.error);
}

async function touchDrag(test, from, target) {
    const r = await test.page.evaluate((f, t) => window.__qTouch(f, t), from, target);
    if (r.error) throw new Error(r.error);
}

/** Server-side queue order (uuids by position) via queue_list. */
async function serverQueueUuids(test) {
    const res = await test.apiCall('queue_list');
    if (!res.success) throw new Error('queue_list failed: ' + JSON.stringify(res));
    return res.result.items.map((i) => i.uuid);
}

/** Poll queue_list until its uuid order equals `expected` (join-compared). */
async function waitForServerOrder(test, expected, timeout = 8000) {
    const want = expected.join(',');
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = (await serverQueueUuids(test)).join(',');
        if (last === want) return;
        await test.wait(150);
    }
    throw new Error(`server queue never reached expected order.\n  want: ${want}\n  got:  ${last}`);
}

module.exports = {
    installQueueDriver,
    desktopDrag,
    touchDrag,
    serverQueueUuids,
    waitForServerOrder,
};

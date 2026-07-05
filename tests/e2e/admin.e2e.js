/**
 * admin.e2e.js — the admin surface: user create/edit/delete through the admin
 * page UI, triggering a library scan from the UI and watching it complete,
 * rescan idempotence (song count stable), and library stats matching the
 * generated fixture manifest.
 *
 * NOTE: the admin page only renders a *library-stats* block inside the AI panel,
 * which is hidden when AI is disabled (our hermetic default). So the stats
 * assertion goes through admin_get_stats (server truth) compared to the manifest
 * — see tests/README.md.
 */

const TestHelper = require('../test-helper');

const ADMIN = { username: process.env.TEST_ADMIN_NAME, password: process.env.TEST_ADMIN_PASS };
const test = new TestHelper();

async function tableUsernames() {
    return test.page.evaluate(() =>
        [...document.querySelectorAll('.users-table tbody tr td:first-child')].map((e) => e.textContent.trim()));
}

async function clickButtonByText(text) {
    const clicked = await test.page.evaluate((t) => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(t));
        if (btn) { btn.click(); return true; }
        return false;
    }, text);
    if (!clicked) throw new Error(`button "${text}" not found`);
}

(async () => {
    await test.setup();
    // Auto-accept confirm()/alert() dialogs (delete-user confirm, force-scan).
    test.page.on('dialog', (d) => d.accept().catch(() => {}));

    console.log('Admin Tests');
    console.log('-'.repeat(50));

    const manifest = test.loadManifest();

    await test.login(ADMIN);

    await test.test('admin page lists the seeded users', async () => {
        await test.goto('/admin/');
        await test.page.waitForSelector('.users-table', { timeout: 8000 });
        const names = await tableUsernames();
        await test.assert(names.includes(ADMIN.username), 'admin should be listed: ' + JSON.stringify(names));
        await test.assert(names.includes(process.env.TEST_USER_NAME),
            'testuser should be listed: ' + JSON.stringify(names));
    });

    const newUser = 'adm_' + Date.now();

    await test.test('create a user via the admin UI', async () => {
        await clickButtonByText('Add User');
        await test.page.waitForSelector('.dialog form #username', { timeout: 5000 });
        await test.page.type('.dialog #username', newUser);
        await test.page.type('.dialog #password', 'adminmade123');
        await test.page.evaluate(() => {
            document.querySelector('.dialog form')
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await test.page.waitForFunction((u) =>
            [...document.querySelectorAll('.users-table tbody tr td:first-child')]
                .some((e) => e.textContent.trim() === u), { timeout: 8000 }, newUser);
        // Confirm server-side too.
        const list = await test.apiCall('users_list');
        await test.assert(list.result.some((u) => u.username === newUser),
            'new user should exist server-side');
    });

    await test.test('edit a user via the admin UI (promote to admin)', async () => {
        // Open the Edit dialog for the row whose username === newUser.
        await test.page.evaluate((u) => {
            const rows = [...document.querySelectorAll('.users-table tbody tr')];
            const row = rows.find((r) => r.querySelector('td:first-child').textContent.trim() === u);
            row.querySelector('.btn-small:not(.btn-danger)').click();
        }, newUser);
        await test.page.waitForSelector('.dialog form #capabilities', { timeout: 5000 });
        await test.page.select('.dialog #capabilities', 'admin');
        await test.page.evaluate(() => {
            document.querySelector('.dialog form')
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await test.page.waitForFunction((u) => {
            const rows = [...document.querySelectorAll('.users-table tbody tr')];
            const row = rows.find((r) => r.querySelector('td:first-child').textContent.trim() === u);
            return row && /admin/i.test(row.querySelector('.role-badge')?.textContent || '');
        }, { timeout: 8000 }, newUser);
        const list = await test.apiCall('users_list');
        const rec = list.result.find((u) => u.username === newUser);
        await test.assert(rec && /admin/.test(rec.capabilities), 'user should be admin server-side');
    });

    await test.test('delete a user via the admin UI', async () => {
        await test.page.evaluate((u) => {
            const rows = [...document.querySelectorAll('.users-table tbody tr')];
            const row = rows.find((r) => r.querySelector('td:first-child').textContent.trim() === u);
            row.querySelector('.btn-danger').click();
        }, newUser);
        await test.page.waitForFunction((u) =>
            ![...document.querySelectorAll('.users-table tbody tr td:first-child')]
                .some((e) => e.textContent.trim() === u), { timeout: 8000 }, newUser);
        const list = await test.apiCall('users_list');
        await test.assert(!list.result.some((u) => u.username === newUser),
            'deleted user should be gone server-side');
    });

    await test.test('trigger a library scan from the UI and watch it complete', async () => {
        const before = await test.apiCall('admin_get_stats');
        const songsBefore = before.result.totalSongs;

        await clickButtonByText('Start Scan');
        // The scan-status panel should appear...
        await test.page.waitForSelector('.scan-status', { timeout: 8000 });
        // ...and the scan should reach a terminal (completed) state.
        const done = await test.page.evaluate(async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const r = await fetch('/api/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ method: 'admin_scan_status', kwargs: {}, version: 2 }),
                });
                const j = await r.json();
                const st = j.result && j.result.status;
                if (st && st !== 'running') return st;
                await new Promise((res) => setTimeout(res, 400));
            }
            return 'timeout';
        });
        await test.assertEqual(done, 'completed', 'scan should complete');

        // Rescan idempotence: the fixture is unchanged, so song count is stable.
        const after = await test.apiCall('admin_get_stats');
        await test.assertEqual(after.result.totalSongs, songsBefore,
            'rescan must not change the song count (idempotent)');
    });

    await test.test('library stats match the generated manifest', async () => {
        const stats = (await test.apiCall('admin_get_stats')).result;
        await test.assertEqual(stats.totalSongs, manifest.counts.totalSongs, 'totalSongs');
        await test.assertEqual(stats.totalArtists, manifest.counts.totalArtists, 'totalArtists');
        await test.assertEqual(stats.totalAlbums, manifest.counts.totalAlbums, 'totalAlbums');
    });

    await test.teardown();
})();

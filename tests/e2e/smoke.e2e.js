/**
 * Smoke suite — proves the hermetic harness works end to end:
 *   - the provisioned backend serves the app
 *   - testuser (seeded via API) can log in through the real UI
 *   - the fixture manifest has real, non-empty library facts
 *   - queue_list works against the fresh logged-in session
 *
 * Runs in Lane 2 (needs the provisioned backend + fixture).
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();

    const manifest = test.loadManifest();

    await test.test('manifest reports a non-empty library', async () => {
        await test.assertGreaterThan(manifest.counts.totalSongs, 0, 'expected songs > 0');
        await test.assertGreaterThan(manifest.counts.totalArtists, 0, 'expected artists > 0');
        await test.assertGreaterThan(manifest.counts.totalAlbums, 0, 'expected albums > 0');
    });

    await test.test('fixture covers at least two audio formats', async () => {
        await test.assertGreaterThan(manifest.formats.length, 1,
            `expected >1 format, got ${manifest.formats.join(',')}`);
    });

    await test.test('testuser logs in through the real UI', async () => {
        await test.login();
        const authed = await test.isAuthenticated();
        await test.assert(authed, 'expected .user-badge after login');
    });

    await test.test('queue_list works against the logged-in session', async () => {
        const res = await test.apiCall('queue_list');
        await test.assert(res.success === true, 'queue_list should succeed: ' + JSON.stringify(res));
        await test.assert(Array.isArray(res.result.items), 'queue_list.items should be an array');
    });

    await test.teardown();
})();

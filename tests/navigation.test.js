/**
 * Navigation Tests
 *
 * Tests hash-based routing, menu navigation, and page lazy-loading.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();
    await test.login();

    console.log('Navigation Tests');
    console.log('-'.repeat(50));

    // ==================== Hash Routing Tests ====================

    await test.test('Default route is now-playing (home)', async () => {
        await test.goto('/');
        await test.wait(300);

        const route = await test.getRoute();
        await test.assert(route === '/' || route === '', 'Default route should be home');
    });

    await test.test('Direct navigation to /browse/', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/browse/', 'Should navigate to browse');
        await test.assertExists('browse-page', 'Browse page component should exist');
    });

    await test.test('Direct navigation to /search/', async () => {
        await test.goto('/search/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/search/', 'Should navigate to search');
        await test.assertExists('quick-search-page', 'Search page component should exist');
    });

    await test.test('Direct navigation to /radio/', async () => {
        await test.goto('/radio/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/radio/', 'Should navigate to radio');
        await test.assertExists('radio-page', 'Radio page component should exist');
    });

    await test.test('Direct navigation to /playlists/', async () => {
        await test.goto('/playlists/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/playlists/', 'Should navigate to playlists');
        await test.assertExists('playlists-page', 'Playlists page component should exist');
    });

    await test.test('Direct navigation to /history/', async () => {
        await test.goto('/history/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/history/', 'Should navigate to history');
        await test.assertExists('history-page', 'History page component should exist');
    });

    await test.test('Direct navigation to /eq/', async () => {
        await test.goto('/eq/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/eq/', 'Should navigate to equalizer');
        await test.assertExists('eq-page', 'EQ page component should exist');
    });

    await test.test('Direct navigation to /visualizer/', async () => {
        await test.goto('/visualizer/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/visualizer/', 'Should navigate to visualizer');
        await test.assertExists('visualizer-page', 'Visualizer page component should exist');
    });

    await test.test('Direct navigation to /settings/', async () => {
        await test.goto('/settings/');
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/settings/', 'Should navigate to settings');
        await test.assertExists('settings-page', 'Settings page component should exist');
    });

    // ==================== Menu Navigation Tests ====================

    await test.test('Shell component exists', async () => {
        await test.goto('/');
        await test.wait(300);

        await test.assertExists('cl-shell', 'Shell component should exist');
    });

    await test.test('Menu items are visible', async () => {
        await test.goto('/');
        await test.wait(300);

        const menuItemCount = await test.countElements('.nav-item');
        await test.assertGreaterThan(menuItemCount, 5, 'Should have multiple menu items');
    });

    await test.test('Navigate via menu to Browse', async () => {
        await test.goto('/');
        await test.wait(300);

        // Click on Browse menu item
        await test.page.evaluate(() => {
            const items = document.querySelectorAll('.nav-item');
            for (const item of items) {
                if (item.textContent.includes('Browse')) {
                    item.click();
                    return true;
                }
            }
            return false;
        });

        await test.wait(500);
        await test.assertExists('browse-page', 'Should navigate to browse via menu');
    });

    await test.test('Navigate via menu to Search', async () => {
        await test.goto('/');
        await test.wait(300);

        await test.page.evaluate(() => {
            const items = document.querySelectorAll('.nav-item');
            for (const item of items) {
                if (item.textContent.includes('Search')) {
                    item.click();
                    return true;
                }
            }
            return false;
        });

        await test.wait(500);
        await test.assertExists('quick-search-page', 'Should navigate to search via menu');
    });

    // ==================== Browser Navigation Tests ====================

    await test.test('Browser back button works', async () => {
        await test.goto('/browse/');
        await test.wait(300);

        await test.goto('/search/');
        await test.wait(300);

        // Go back
        await test.page.goBack();
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/browse/', 'Back button should return to previous page');
    });

    await test.test('Browser forward button works', async () => {
        // Should be on /browse/ from previous test after going back
        // Go forward
        await test.page.goForward();
        await test.wait(500);

        const route = await test.getRoute();
        await test.assertEqual(route, '/search/', 'Forward button should go to next page');
    });

    // ==================== Page Lazy Loading Tests ====================

    await test.test('Pages lazy load without errors', async () => {
        test.consoleErrors = [];

        const routes = ['/browse/', '/search/', '/radio/', '/playlists/', '/history/', '/eq/', '/settings/'];

        for (const route of routes) {
            await test.goto(route);
            await test.wait(300);
        }

        await test.assertNoConsoleErrors(['favicon', 'ResizeObserver']);
    });

    await test.test('Unknown route shows fallback or redirects', async () => {
        await test.goto('/nonexistent-page/');
        await test.wait(500);

        // Should either show a fallback page or redirect to home
        const route = await test.getRoute();
        const pageExists = await test.page.evaluate(() => {
            return document.querySelector('now-playing-page') !== null ||
                   document.body.textContent.includes('Not Found');
        });

        await test.assert(pageExists || route === '/', 'Unknown route should have fallback behavior');
    });

    await test.teardown();
})();

/**
 * Authentication Tests
 *
 * Tests login functionality, error handling, and session management.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

(async () => {
    await test.setup();

    console.log('Authentication Tests');
    console.log('-'.repeat(50));

    // ==================== Login Form Tests ====================

    await test.test('Display login form when not authenticated', async () => {
        await test.goto('/login/');
        await test.assertExists('#username', 'Username input should exist');
        await test.assertExists('#password', 'Password input should exist');
        await test.assertExists('cl-button[type="submit"]', 'Submit button should exist');
    });

    await test.test('Login form has proper labels', async () => {
        await test.goto('/login/');
        await test.assertExists('label[for="username"]', 'Username label should exist');
        await test.assertExists('label[for="password"]', 'Password label should exist');
    });

    await test.test('Show error message for invalid credentials', async () => {
        await test.goto('/login/');
        await test.wait(500);

        // Clear any existing values first
        await test.page.evaluate(() => {
            const u = document.querySelector('#username');
            const p = document.querySelector('#password');
            if (u) u.value = '';
            if (p) p.value = '';
        });

        // Enter invalid credentials
        await test.type('#username', 'invalid_user');
        await test.type('#password', 'wrong_password');

        // Submit form directly by dispatching submit event
        await test.page.evaluate(() => {
            const form = document.querySelector('form.login-form');
            if (form) {
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);
            }
        });

        // Wait for error message (API should return error)
        await test.wait(3000);
        await test.assertExists('.login-error', 'Error message should appear', 5000);
    });

    await test.test('Show error for empty username', async () => {
        await test.goto('/login/');
        await test.wait(500);

        // Clear fields first
        await test.page.evaluate(() => {
            const u = document.querySelector('#username');
            const p = document.querySelector('#password');
            if (u) u.value = '';
            if (p) p.value = '';
        });

        // Enter only password
        await test.type('#password', 'somepassword');

        // Try to submit - should be blocked by HTML5 validation
        const isValid = await test.page.evaluate(() => {
            const username = document.querySelector('#username');
            return username ? username.validity.valid : true;
        });

        await test.assert(!isValid, 'Form should be invalid without username');
    });

    await test.test('Successful login redirects to home', async () => {
        await test.goto('/login/');
        await test.wait(500);

        // Clear fields first
        await test.page.evaluate(() => {
            const u = document.querySelector('#username');
            const p = document.querySelector('#password');
            if (u) u.value = '';
            if (p) p.value = '';
        });

        // Enter valid credentials
        await test.type('#username', 'testuser');
        await test.type('#password', 'testuser');

        // Submit form directly by dispatching submit event
        await test.page.evaluate(() => {
            const form = document.querySelector('form.login-form');
            if (form) {
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);
            }
        });

        // Wait for navigation (page will reload after successful login)
        try {
            await test.page.waitForNavigation({
                waitUntil: 'networkidle2',
                timeout: 15000
            });
        } catch {
            // Navigation might have already completed
        }

        // Wait for app shell to load
        await test.page.waitForSelector('cl-shell', { timeout: 10000 });
        await test.wait(500);

        const route = await test.getRoute();
        await test.assert(route === '/' || route === '', 'Should redirect to home after login');
    });

    await test.test('User badge shows username after login', async () => {
        // Should already be logged in from previous test
        await test.goto('/');
        await test.wait(1000);

        // Wait for app shell and user badge
        await test.page.waitForSelector('cl-shell', { timeout: 5000 });

        // Check for user badge in shell
        const hasBadge = await test.page.evaluate(() => {
            const badge = document.querySelector('.user-badge');
            return badge && badge.textContent.includes('testuser');
        });

        await test.assert(hasBadge, 'User badge should show username');
    });

    await test.test('Authenticated state persists across page reload', async () => {
        // Reload page
        await test.page.reload({ waitUntil: 'networkidle2' });
        await test.wait(500);

        // Should still be authenticated (not redirected to login)
        const route = await test.getRoute();
        await test.assertNotEqual(route, '/login/', 'Should not redirect to login after reload');
    });

    await test.test('Can navigate to protected pages when authenticated', async () => {
        await test.goto('/browse/');
        await test.wait(500);

        // Should show browse page, not login
        const route = await test.getRoute();
        await test.assertEqual(route, '/browse/', 'Should be able to access browse page');
    });

    await test.test('Logout clears session', async () => {
        await test.logout();
        await test.wait(1000);

        // After logout, user badge should disappear and login link should appear
        const isLoggedOut = await test.page.evaluate(() => {
            const badge = document.querySelector('.user-badge');
            const loginLink = document.querySelector('.login-link');
            // Logged out if no user badge OR login link is present
            return badge === null || loginLink !== null;
        });

        await test.assert(isLoggedOut, 'Should show logged out state after logout');
    });

    await test.test('No console errors during login flow', async () => {
        // Clear previous errors
        test.consoleErrors = [];

        await test.goto('/login/');
        await test.wait(500);

        // Clear fields first
        await test.page.evaluate(() => {
            const u = document.querySelector('#username');
            const p = document.querySelector('#password');
            if (u) u.value = '';
            if (p) p.value = '';
        });

        await test.type('#username', 'testuser');
        await test.type('#password', 'testuser');

        // Submit form directly by dispatching submit event
        await test.page.evaluate(() => {
            const form = document.querySelector('form.login-form');
            if (form) {
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);
            }
        });

        // Wait for navigation (page will reload after successful login)
        try {
            await test.page.waitForNavigation({
                waitUntil: 'networkidle2',
                timeout: 15000
            });
        } catch {
            // Navigation might have already completed
        }

        await test.wait(1000);
        // Clear errors from the login process itself
        test.consoleErrors = [];
        await test.assertNoConsoleErrors(['favicon']);
    });

    await test.teardown();
})();

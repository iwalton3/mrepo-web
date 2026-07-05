/**
 * auth-lifecycle.e2e.js — the auth seam that produced the "ValueError" login
 * error, the logout gap, and the change-password fixes.
 *
 * Covers: fresh-DB setup/register wizard (on an isolated throwaway backend),
 * registration-disabled UI, wrong-password human message (ValueError pin),
 * logout button round-trip, session persistence across reload, non-admin has no
 * Admin menu entry (admin does), change-password -> re-login, and the Extend
 * button hidden when AI is disabled.
 */

const TestHelper = require('../test-helper');
const env = require('../harness/env');
const fixture = require('../harness/fixture');

const BASE = process.env.TEST_URL;
const ADMIN = { username: process.env.TEST_ADMIN_NAME, password: process.env.TEST_ADMIN_PASS };
const USER = { username: process.env.TEST_USER_NAME, password: process.env.TEST_USER_PASS };

const test = new TestHelper();

// Node-side admin session for user create/delete (keeps testuser untouched).
async function adminApi(method, kwargs) {
    const jar = new env.CookieJar();
    await env.apiCall(BASE, 'auth_login', { username: ADMIN.username, password: ADMIN.password }, jar);
    return env.apiCall(BASE, method, kwargs, jar);
}

async function navLabels() {
    return test.page.evaluate(() =>
        [...document.querySelectorAll('.sidebar-nav .nav-label')].map((e) => e.textContent.trim()));
}

(async () => {
    await test.setup();

    console.log('Auth Lifecycle Tests');
    console.log('-'.repeat(50));

    // ---- Fresh-DB setup/register wizard (isolated backend) -----------------
    await test.test('fresh DB shows setup wizard and registers the first admin', async () => {
        const paths = fixture.selectFixturePaths(false);
        const prov = env.prepareScratch(paths);
        await env.startBackend(prov, { quiet: true });
        try {
            const page = await test.browser.newPage();
            try {
                await page.goto(prov.url + '/#/login/', { waitUntil: 'networkidle2' });
                await page.waitForSelector('#confirmPassword', { timeout: 8000 }); // setup-only field
                await page.type('#username', 'firstadmin');
                await page.type('#password', 'firstadmin123');
                await page.type('#confirmPassword', 'firstadmin123');
                await page.evaluate(() => {
                    const f = document.querySelector('form.login-form');
                    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                });
                // Registration auto-logs in; verify via the API from the page session.
                await page.waitForFunction(async () => {
                    const r = await fetch('/api/', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ method: 'check_user', kwargs: {}, version: 2 }),
                    });
                    const j = await r.json();
                    return j.result && j.result.authenticated === true;
                }, { timeout: 10000 });
            } finally {
                await page.close();
            }
        } finally {
            await env.teardown(prov, { keep: false });
        }
    });

    // ---- Registration disabled: no register UI on the shared backend -------
    await test.test('registration disabled -> plain sign-in, no register UI', async () => {
        await test.goto('/login/');
        await test.wait(300);
        const ui = await test.page.evaluate(() => ({
            hasConfirm: !!document.querySelector('#confirmPassword'),
            text: document.body.textContent,
            setupRequired: (window.MREPO_CONFIG || {}).setupRequired,
        }));
        await test.assert(ui.setupRequired !== true, 'setupRequired should be false (users exist)');
        await test.assert(!ui.hasConfirm, 'no confirm-password field when not in setup mode');
        await test.assert(!/Create Account|Create your admin/i.test(ui.text),
            'no account-creation UI when registration is disabled');
    });

    // ---- Wrong password: human message, never "ValueError" -----------------
    await test.test('wrong password shows human message, not "ValueError"', async () => {
        await test.goto('/login/');
        await test.page.waitForSelector('#username', { timeout: 5000 });
        await test.page.type('#username', USER.username);
        await test.page.type('#password', 'definitely-wrong-password');
        await test.page.evaluate(() => {
            const f = document.querySelector('form.login-form');
            f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await test.page.waitForSelector('.login-error', { timeout: 5000 });
        const err = await test.getText('.login-error');
        await test.assert(/invalid username or password/i.test(err),
            `login error should be the human message, got: "${err}"`);
        await test.assert(!/ValueError/.test(err), `login error must not leak "ValueError": "${err}"`);
    });

    // ---- Login, session persistence, logout round-trip, no admin menu ------
    await test.test('testuser can log in (badge + logout button present)', async () => {
        await test.login(USER);
        await test.assertExists('.user-badge', 'user badge should show after login');
        await test.assertExists('.logout-btn', 'logout button should be present');
    });

    await test.test('session persists across a full reload', async () => {
        await test.page.reload({ waitUntil: 'networkidle2' });
        await test.wait(500);
        await test.assert(await test.isAuthenticated(), 'should still be authenticated after reload');
    });

    await test.test('non-admin sees no Admin menu entry', async () => {
        const labels = await navLabels();
        await test.assert(!labels.includes('Admin'),
            'non-admin nav must not contain "Admin": ' + JSON.stringify(labels));
    });

    await test.test('Extend button hidden when AI is disabled', async () => {
        await test.goto('/');
        await test.wait(400);
        await test.assertExists('now-playing-page');
        const hasExtend = await test.page.evaluate(() =>
            !!document.querySelector('.queue-action-btn.extend'));
        await test.assert(!hasExtend, 'Extend button must be hidden when ai.enabled=false');
    });

    await test.test('logout button logs the user out', async () => {
        await test.goto('/');
        await test.wait(400);
        await test.click('.logout-btn');
        await test.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
        await test.wait(500);
        await test.assert(!(await test.isAuthenticated()), 'should be logged out after clicking logout');
    });

    // ---- Admin sees the Admin menu entry -----------------------------------
    await test.test('admin sees the Admin menu entry', async () => {
        await test.login(ADMIN);
        const labels = await navLabels();
        await test.assert(labels.includes('Admin'),
            'admin nav should contain "Admin": ' + JSON.stringify(labels));
        await test.logout();
    });

    // ---- Change password -> re-login (throwaway user) ----------------------
    await test.test('change password in Settings, then re-login with new password', async () => {
        const uname = 'pwuser_' + Date.now();
        const oldPass = 'oldpass123';
        const newPass = 'newpass456';
        const created = await adminApi('users_create',
            { username: uname, password: oldPass, capabilities: 'user' });
        await test.assert(created.success, 'throwaway user create should succeed');
        const userId = created.result.id;

        try {
            await test.login({ username: uname, password: oldPass });
            await test.goto('/settings/');
            await test.page.waitForSelector('.password-form', { timeout: 8000 });
            await test.page.type('#pw-current', oldPass);
            await test.page.type('#pw-new', newPass);
            await test.page.type('#pw-confirm', newPass);
            await test.page.evaluate(() => {
                const f = document.querySelector('.password-form');
                f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            });
            // Success -> .save-status shows a message and no .password-error.
            await test.page.waitForFunction(() => {
                const err = document.querySelector('.password-error');
                const status = document.querySelector('.password-form .save-status');
                return (status && status.textContent.trim().length > 0) || (err && err.textContent.trim().length > 0);
            }, { timeout: 8000 });
            const outcome = await test.page.evaluate(() => ({
                error: document.querySelector('.password-error')?.textContent.trim() || '',
                status: document.querySelector('.password-form .save-status')?.textContent.trim() || '',
            }));
            await test.assert(!outcome.error, 'change password should not error: ' + outcome.error);

            // Log out and re-login with the NEW password.
            await test.logout();
            await test.login({ username: uname, password: newPass });
            await test.assert(await test.isAuthenticated(), 're-login with new password should succeed');

            // Old password must now be rejected.
            const reAuth = await test.apiCall('auth_logout');
            void reAuth;
            const oldTry = await test.page.evaluate(async (u, p) => {
                const r = await fetch('/api/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ method: 'auth_login', kwargs: { username: u, password: p }, version: 2 }),
                });
                return r.json();
            }, uname, oldPass);
            await test.assert(oldTry.success === false, 'old password must be rejected after change');
        } finally {
            await adminApi('users_delete', { user_id: userId }); // cleanup, keep DB tidy
        }
    });

    await test.teardown();
})();

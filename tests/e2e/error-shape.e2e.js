/**
 * error-shape.e2e.js — canary that representative failing API calls surface a
 * human `message`, not the bare exception class name. This is the exact seam
 * behind the "ValueError" login regression: the frontend shows `message`, so
 * business-logic failures must carry human text.
 */

const TestHelper = require('../test-helper');
const test = new TestHelper();

const USER = { username: process.env.TEST_USER_NAME, password: process.env.TEST_USER_PASS };

// A bare exception-class name like "ValueError" / "InvalidParameters".
const looksLikeClassName = (s) => /^[A-Z][A-Za-z]*(Error|Exception)?$/.test(s) && !/\s/.test(s);

(async () => {
    await test.setup();
    await test.login();

    console.log('Error Shape (canary) Tests');
    console.log('-'.repeat(50));

    // Each of these must fail with a human message, not just an error class.
    const cases = [
        { desc: 'wrong password (auth_login)', method: 'auth_login',
          kwargs: { username: USER.username, password: 'definitely-wrong' },
          expect: /invalid username or password/i },
        { desc: 'empty playlist name (playlists_create)', method: 'playlists_create',
          kwargs: { name: '' }, expect: /required/i },
        { desc: 'invalid share token (playlists_by_token)', method: 'playlists_by_token',
          kwargs: { share_token: 'not-a-real-token' }, expect: /not found/i },
    ];

    for (const c of cases) {
        await test.test(`${c.desc} surfaces a human message`, async () => {
            const res = await test.apiCall(c.method, c.kwargs);
            await test.assert(res.success === false, `${c.method} should fail here`);
            await test.assert(typeof res.message === 'string' && res.message.length > 0,
                `${c.method} failure must include a message: ` + JSON.stringify(res));
            await test.assert(!looksLikeClassName(res.message),
                `message must be human text, not a class name: "${res.message}"`);
            await test.assert(res.message !== res.error,
                `message must differ from the error class "${res.error}"`);
            await test.assert(c.expect.test(res.message),
                `message should read sensibly, got: "${res.message}"`);
        });
    }

    await test.test('wrong-password message never leaks "ValueError" (regression pin)', async () => {
        const res = await test.apiCall('auth_login',
            { username: USER.username, password: 'still-wrong' });
        await test.assert(res.success === false, 'login should fail');
        await test.assert(!/ValueError/.test(res.message || ''),
            `login message must not contain "ValueError": "${res.message}"`);
    });

    await test.test('unknown method returns a descriptive message', async () => {
        const res = await test.apiCall('this_method_does_not_exist', {});
        await test.assert(res.success === false, 'unknown method should fail');
        await test.assert(/unknown method/i.test(res.message || ''),
            `unknown-method failure should be descriptive: ` + JSON.stringify(res));
    });

    await test.teardown();
})();

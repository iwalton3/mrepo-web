/**
 * Hermetic E2E harness: environment provisioning.
 *
 * Spins up an isolated mrepo backend against a scratch database and a curated
 * fixture music library, seeds users via the API (not the UI), and tears the
 * whole thing down. Nothing here ever touches the owner's live docker instance
 * (:9900) or the real database.
 *
 * See tests/E2E-DESIGN.md for the contract this implements.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENV_PYTHON = path.join(REPO_ROOT, 'venv', 'bin', 'python');

// Ports we must never bind: owner's live docker + reserved dev ports.
const FORBIDDEN_PORTS = new Set([9000, 9900, 9901, 9902]);

// Default seeded credentials. testuser/testuser is mandated by the design doc
// so the legacy suites' hardcoded CREDENTIALS keep working unchanged.
const DEFAULT_ADMIN = {
    username: process.env.TEST_ADMIN_NAME || 'admin',
    password: process.env.TEST_ADMIN_PASS || 'adminpass123',
};
const DEFAULT_USER = {
    username: process.env.TEST_USER_NAME || 'testuser',
    password: process.env.TEST_USER_PASS || 'testuser',
};

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ask the OS for a free high port, retrying if it lands on a forbidden one.
 */
async function findFreePort() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const port = await new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.on('error', reject);
            srv.listen(0, '127.0.0.1', () => {
                const p = srv.address().port;
                srv.close(() => resolve(p));
            });
        });
        if (!FORBIDDEN_PORTS.has(port)) return port;
    }
    throw new Error('Could not find a free non-forbidden port');
}

/**
 * Minimal cookie jar for node-side API seeding: captures Set-Cookie and
 * replays it. Enough for a single-session Flask cookie ('session').
 */
class CookieJar {
    constructor() {
        this.cookies = {};
    }
    header() {
        return Object.entries(this.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
    absorb(response) {
        const setCookies = response.headers.getSetCookie
            ? response.headers.getSetCookie()
            : [];
        for (const c of setCookies) {
            const m = c.match(/^([^=]+)=([^;]+)/);
            if (m) this.cookies[m[1]] = m[2];
        }
    }
}

/**
 * Make a v2 JSON-RPC style API call against a provisioned backend.
 * Returns the parsed envelope: {success, result} or {success:false, error, message}.
 */
async function apiCall(baseUrl, method, kwargs = {}, jar = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (jar) headers['Cookie'] = jar.header();
    const res = await fetch(`${baseUrl}/api/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, args: [], kwargs, version: 2 }),
    });
    if (jar) jar.absorb(res);
    return res.json();
}

/**
 * Create the scratch directory (under the OS tmp dir, never inside the repo)
 * and write the hermetic config.yaml. Does NOT start the backend yet — the
 * fixture layer may drop a cached music.db into place first.
 */
function prepareScratch(fixturePaths) {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrepo-e2e-'));
    const dbPath = path.join(scratchDir, 'music.db');
    const configPath = path.join(scratchDir, 'config.yaml');

    // media.paths is a LIST — this is how the curated subset works, no symlinks.
    const mediaLines = fixturePaths.map((p) => `    - ${JSON.stringify(p)}`).join('\n');
    const config = [
        'database:',
        `  path: ${JSON.stringify(dbPath)}`,
        '  timeout: 30',
        'media:',
        '  paths:',
        mediaLines,
        'streaming:',
        '  url_prefix: /stream',
        '  transcode_bitrate: 320k',
        '  ffmpeg_path: ffmpeg',
        'auth:',
        '  session_days: 30',
        '  allow_registration: false',
        'tasks:',
        '  scan_on_startup: false',
        'ai:',
        '  enabled: false',
        '',
    ].join('\n');
    fs.writeFileSync(configPath, config);

    return { scratchDir, dbPath, configPath };
}

/**
 * Start run.py against the scratch config and wait until check_user answers.
 */
async function startBackend(env, { quiet = false } = {}) {
    const port = await findFreePort();
    if (FORBIDDEN_PORTS.has(port)) {
        throw new Error(`Refusing to bind forbidden port ${port}`);
    }
    const url = `http://127.0.0.1:${port}`;

    const proc = spawn(
        VENV_PYTHON,
        ['run.py', '-p', String(port), '--host', '127.0.0.1', '--no-debug'],
        {
            cwd: REPO_ROOT,
            env: { ...process.env, MREPO_CONFIG: env.configPath },
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );
    const logPath = path.join(env.scratchDir, 'backend.log');
    const logStream = fs.createWriteStream(logPath);
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);

    let exited = false;
    proc.on('exit', () => { exited = true; });

    env.port = port;
    env.url = url;
    env.backend = proc;
    env.backendLog = logPath;

    // Poll check_user until the server answers (or the process dies).
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (exited) {
            throw new Error(
                `Backend exited during startup. See log:\n${fs.readFileSync(logPath, 'utf8')}`
            );
        }
        try {
            const j = await apiCall(url, 'check_user');
            if (j && j.success) {
                if (!quiet) console.log(`[harness] backend live on ${url}`);
                return env;
            }
        } catch (_) {
            /* not up yet */
        }
        await sleep(300);
    }
    throw new Error('Backend did not become live within 30s');
}

/**
 * Seed the admin (via setup register) and the non-admin testuser (via admin API).
 * Returns the credential objects.
 */
async function seedUsers(env) {
    const jar = new CookieJar();
    const admin = DEFAULT_ADMIN;
    const user = DEFAULT_USER;

    const status = await apiCall(env.url, 'check_user', {}, jar);
    if (!status.result || !status.result.setupRequired) {
        throw new Error(
            'Expected a fresh DB reporting setupRequired; got: ' + JSON.stringify(status)
        );
    }

    const reg = await apiCall(env.url, 'auth_register',
        { username: admin.username, password: admin.password }, jar);
    if (!reg.success) throw new Error('admin register failed: ' + JSON.stringify(reg));

    const created = await apiCall(env.url, 'users_create',
        { username: user.username, password: user.password, capabilities: 'user' }, jar);
    if (!created.success) throw new Error('testuser create failed: ' + JSON.stringify(created));

    env.adminCreds = admin;
    env.userCreds = user;
    return { admin, user, jar };
}

/**
 * Confirm seeded creds work (used on snapshot-restore path where we skip seeding).
 */
async function verifyLogin(env, creds) {
    const jar = new CookieJar();
    const res = await apiCall(env.url, 'auth_login',
        { username: creds.username, password: creds.password }, jar);
    return res.success === true;
}

/**
 * Kill the backend and remove the scratch dir. Idempotent, safe on error paths.
 */
async function teardown(env, { keep = false } = {}) {
    if (env && env.backend && env.backend.pid) {
        try {
            process.kill(env.backend.pid, 'SIGKILL');
        } catch (_) { /* already gone */ }
    }
    if (env && env.scratchDir && !keep) {
        // Only ever remove our own scratch dir under the OS tmp dir.
        if (env.scratchDir.startsWith(os.tmpdir())) {
            try {
                fs.rmSync(env.scratchDir, { recursive: true, force: true });
            } catch (_) { /* best effort */ }
        }
    }
}

module.exports = {
    REPO_ROOT,
    VENV_PYTHON,
    FORBIDDEN_PORTS,
    DEFAULT_ADMIN,
    DEFAULT_USER,
    sleep,
    findFreePort,
    CookieJar,
    apiCall,
    prepareScratch,
    startBackend,
    seedUsers,
    verifyLogin,
    teardown,
};

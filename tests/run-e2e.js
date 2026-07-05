#!/usr/bin/env node

/**
 * Hermetic E2E orchestrator for the public mrepo music player.
 *
 * Three lanes, one entry point (see tests/E2E-DESIGN.md):
 *   Lane 0 (--contract, opt-in): pytest backend contract tests.
 *   Lane 1: backend-free injection suites against a static server we start.
 *   Lane 2: hermetic e2e — provision an isolated backend + curated fixture
 *           library, seed users via API, scan (snapshot-cached), run suites.
 *
 * Usage:
 *   node run-e2e.js                 # lanes 1+2, curated fixture, all suites
 *   node run-e2e.js --only-errors   # quiet (CI)
 *   node run-e2e.js remote-queue    # filter suites by name substring
 *   node run-e2e.js --full-library  # scan the whole music root (cached after)
 *   node run-e2e.js --keep-env      # leave backend running for debugging
 *   node run-e2e.js --contract      # also run pytest lane 0 first
 *
 * SAFETY: this never binds :9900 (owner's docker) and refuses to run lane 2
 * against an externally supplied TEST_URL. Use test-runner.js for that.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = require('./harness/env');
const fixture = require('./harness/fixture');
const { startStaticServer } = require('./harness/static-server');

const TESTS_DIR = __dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');
const E2E_DIR = path.join(TESTS_DIR, 'e2e');

// Lane 1 = backend-free injection suites. Everything else *.test.js = lane 2 legacy.
const LANE1_SUITES = ['queue-reorder.test.js', 'windowing.test.js'];

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {
    onlyErrors: argv.includes('--only-errors'),
    keepEnv: argv.includes('--keep-env'),
    fullLibrary: argv.includes('--full-library'),
    contract: argv.includes('--contract'),
};
const nameFilters = argv.filter((a) => !a.startsWith('--'));

function matchesFilter(file) {
    if (nameFilters.length === 0) return true;
    return nameFilters.some((f) => file.includes(f));
}

function discoverLane2Legacy() {
    return fs.readdirSync(TESTS_DIR)
        .filter((f) => f.endsWith('.test.js') && !LANE1_SUITES.includes(f))
        .sort();
}

function discoverLane2E2e() {
    if (!fs.existsSync(E2E_DIR)) return [];
    return fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.e2e.js')).sort();
}

// ---- suite runner ---------------------------------------------------------
function runSuite(absFile, label, extraEnv) {
    return new Promise((resolve) => {
        if (!flags.onlyErrors) {
            console.log(`\n\u{1F4E6} ${label}`);
            console.log('-'.repeat(70));
        }
        const child = spawn('node', [absFile], {
            cwd: TESTS_DIR,
            env: { ...process.env, ...extraEnv, FORCE_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (d) => {
            output += d;
            if (!flags.onlyErrors) process.stdout.write(d);
        });
        child.stderr.on('data', (d) => {
            output += d;
            if (!flags.onlyErrors) process.stderr.write(d);
        });
        child.on('close', (code) => {
            const passed = lastMatch(output, /Passed:\s*(\d+)/);
            const failed = lastMatch(output, /Failed:\s*(\d+)/);
            const result = { label, code, passed, failed };
            if (flags.onlyErrors) {
                if (code === 0) {
                    process.stdout.write('.');
                } else {
                    console.log(`\n\n\u{1F4E6} ${label}`);
                    console.log('-'.repeat(70));
                    console.log(output);
                    console.log(`❌ ${label} failed with code ${code}`);
                }
            } else {
                console.log(code === 0 ? `✅ ${label} passed` : `❌ ${label} failed (code ${code})`);
            }
            resolve(result);
        });
    });
}

function lastMatch(text, re) {
    const g = new RegExp(re, 'g');
    let m, last = null;
    while ((m = g.exec(text)) !== null) last = m[1];
    return last === null ? null : parseInt(last, 10);
}

// ---- lanes ----------------------------------------------------------------
async function runLane0Contract(results) {
    console.log('\n' + '='.repeat(70));
    console.log('Lane 0: backend contract tests (pytest)');
    console.log('='.repeat(70));
    // pytest is optional here — if the venv lacks it, report clearly instead of
    // a confusing traceback (we must not install dependencies).
    const hasPytest = spawnSync(env.VENV_PYTHON, ['-c', 'import pytest'], { encoding: 'utf8' });
    if (hasPytest.status !== 0) {
        console.log('[lane0] pytest is not installed in the venv — skipping the ' +
            'contract lane. Install it (pip install pytest) to enable --contract.');
        results.push({ label: 'lane0:pytest-contract', code: 0, passed: 0, failed: 0, skipped: true });
        return true;
    }
    const r = spawnSync(env.VENV_PYTHON, ['-m', 'pytest', 'backend/test_sync_contract.py', '-q'], {
        cwd: REPO_ROOT,
        stdio: flags.onlyErrors ? 'pipe' : 'inherit',
        encoding: 'utf8',
    });
    const passed = r.status === 0;
    if (!passed && flags.onlyErrors) console.log(r.stdout, r.stderr);
    results.push({ label: 'lane0:pytest-contract', code: r.status, passed: passed ? 1 : 0, failed: passed ? 0 : 1 });
    return passed;
}

async function runLane1(results) {
    const suites = LANE1_SUITES.filter(matchesFilter);
    if (suites.length === 0) return;
    console.log('\n' + '='.repeat(70));
    console.log('Lane 1: backend-free injection suites (static server)');
    console.log('='.repeat(70));

    const { server, url } = await startStaticServer(FRONTEND_DIR);
    console.log(`[harness] static server on ${url}`);
    try {
        for (const suite of suites) {
            const r = await runSuite(path.join(TESTS_DIR, suite), `lane1:${suite}`, { TEST_URL: url });
            results.push(r);
        }
    } finally {
        await new Promise((res) => server.close(res));
    }
}

async function runLane2(results) {
    const legacy = discoverLane2Legacy().filter(matchesFilter);
    const e2e = discoverLane2E2e().filter(matchesFilter);
    if (legacy.length === 0 && e2e.length === 0) return;

    console.log('\n' + '='.repeat(70));
    console.log('Lane 2: hermetic e2e (provision + seed + scan)');
    console.log('='.repeat(70));

    // Safety rail: never run lane 2 against an externally supplied TEST_URL.
    if (process.env.TEST_URL) {
        console.warn(
            `[harness] ignoring externally set TEST_URL=${process.env.TEST_URL} for lane 2 ` +
            `(use test-runner.js to point legacy suites at an external instance).`
        );
        delete process.env.TEST_URL;
    }

    const t0 = Date.now();
    const fixturePaths = fixture.selectFixturePaths(flags.fullLibrary);
    const hash = fixture.computeFixtureHash(fixturePaths);
    const provisioned = env.prepareScratch(fixturePaths);

    // Try the DB snapshot cache before starting the backend.
    const cached = fixture.tryRestore(provisioned, hash);
    let usedCache = false;

    await env.startBackend(provisioned);

    // Enforce the no-forbidden-port rail explicitly.
    if (env.FORBIDDEN_PORTS.has(provisioned.port)) {
        throw new Error(`Refusing to proceed on forbidden port ${provisioned.port}`);
    }

    let manifest;
    let creds = { admin: env.DEFAULT_ADMIN, user: env.DEFAULT_USER };
    if (cached) {
        // Snapshot already contains seeded users + scanned songs.
        const ok = await env.verifyLogin(provisioned, env.DEFAULT_USER);
        if (!ok) {
            throw new Error('Snapshot restore produced a DB where testuser cannot log in');
        }
        provisioned.adminCreds = env.DEFAULT_ADMIN;
        provisioned.userCreds = env.DEFAULT_USER;
        manifest = cached;
        usedCache = true;
        console.log(`[fixture] restored DB snapshot (hash ${hash}) — skipped scan`);
    } else {
        const seeded = await env.seedUsers(provisioned);
        creds = seeded;
        await fixture.runScan(provisioned, seeded.jar, fixturePaths, { quiet: flags.onlyErrors });
        manifest = await fixture.buildManifest(provisioned, seeded.jar, hash, fixturePaths);
        fixture.snapshot(provisioned, hash, manifest);
        console.log(`[fixture] scanned + snapshotted (hash ${hash})`);
    }

    // Always (re)write the manifest file suites read.
    fixture.writeManifestFile(manifest);
    const provisionMs = Date.now() - t0;
    console.log(
        `[harness] provision done in ${(provisionMs / 1000).toFixed(1)}s ` +
        `(cache ${usedCache ? 'HIT' : 'MISS'}); ` +
        `library: ${manifest.counts.totalSongs} songs / ${manifest.counts.totalArtists} artists / ` +
        `${manifest.counts.totalAlbums} albums / formats ${manifest.formats.join(',')}`
    );

    const suiteEnv = {
        TEST_URL: provisioned.url,
        TEST_ADMIN_NAME: provisioned.adminCreds.username,
        TEST_ADMIN_PASS: provisioned.adminCreds.password,
        TEST_USER_NAME: provisioned.userCreds.username,
        TEST_USER_PASS: provisioned.userCreds.password,
        FIXTURE_MANIFEST: fixture.MANIFEST_FILE,
    };

    try {
        // Legacy suites first, then new e2e suites — sequential (shared backend).
        for (const suite of legacy) {
            results.push(await runSuite(path.join(TESTS_DIR, suite), `lane2:${suite}`, suiteEnv));
        }
        for (const suite of e2e) {
            results.push(await runSuite(path.join(E2E_DIR, suite), `lane2:e2e/${suite}`, suiteEnv));
        }
    } finally {
        if (flags.keepEnv) {
            console.log('\n' + '='.repeat(70));
            console.log('--keep-env: backend LEFT RUNNING for debugging');
            console.log(`  URL:   ${provisioned.url}`);
            console.log(`  admin: ${provisioned.adminCreds.username} / ${provisioned.adminCreds.password}`);
            console.log(`  user:  ${provisioned.userCreds.username} / ${provisioned.userCreds.password}`);
            console.log(`  db:    ${provisioned.dbPath}`);
            console.log(`  log:   ${provisioned.backendLog}`);
            console.log(`  pid:   ${provisioned.backend.pid}  (kill it yourself when done)`);
            console.log('='.repeat(70));
        } else {
            await env.teardown(provisioned, { keep: false });
        }
    }
    return { provisionMs, usedCache };
}

// ---- main -----------------------------------------------------------------
async function main() {
    const results = [];
    const startedAt = Date.now();

    if (flags.contract) {
        const ok = await runLane0Contract(results);
        if (!ok) {
            report(results, startedAt);
            process.exit(1);
        }
    }

    await runLane1(results);
    await runLane2(results);

    report(results, startedAt);
    const anyFail = results.some((r) => r.code !== 0);
    process.exit(anyFail ? 1 : 0);
}

function report(results, startedAt) {
    const wall = ((Date.now() - startedAt) / 1000).toFixed(1);
    let tPass = 0, tFail = 0;
    console.log('\n' + '='.repeat(70));
    console.log('E2E Summary');
    console.log('='.repeat(70));
    for (const r of results) {
        const p = r.passed == null ? '?' : r.passed;
        const f = r.failed == null ? '?' : r.failed;
        if (typeof r.passed === 'number') tPass += r.passed;
        if (typeof r.failed === 'number') tFail += r.failed;
        const mark = r.code === 0 ? '✅' : '❌';
        console.log(`  ${mark} ${r.label}  (pass ${p}, fail ${f})`);
    }
    console.log('-'.repeat(70));
    console.log(`Suites: ${results.length}   Tests: ${tPass} passed, ${tFail} failed`);
    console.log(`Wall clock: ${wall}s`);
    console.log('='.repeat(70));
}

main().catch((err) => {
    console.error('\n[harness] FATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
});

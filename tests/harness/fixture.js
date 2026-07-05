/**
 * Hermetic E2E harness: fixture music selection, scan, manifest + DB snapshot cache.
 *
 * The curated subset is listed directly as media.paths (no symlinks, no copy).
 * After the first successful scan we snapshot the scanned music.db keyed by a
 * hash of the fixture file list (paths + sizes + mtimes); subsequent runs
 * restore the snapshot instead of rescanning.
 *
 * See tests/E2E-DESIGN.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { apiCall, CookieJar, sleep, VENV_PYTHON } = require('./env');

const TESTS_DIR = path.resolve(__dirname, '..');
const MANIFEST_FILE = path.join(TESTS_DIR, 'fixture-manifest.json');
const CACHE_DIR = path.join(os.tmpdir(), 'mrepo-e2e-cache');

const MUSIC_ROOT = process.env.TEST_MUSIC_DIR || '/home/izzie/file-cache/test-music';

// Curated subset (format survey 2026-07-05): opus + m4a + mp3 + non-ASCII names.
const CURATED_SUBFOLDERS = [
    'Tunguska Chillout Grooves vol 1', // opus, clean Jamendo tags
    'blackmill',                       // opus
    'dss',                             // opus + m4a, non-ASCII filenames
    'Lewis OfMan',                     // mp3
];

const AUDIO_EXTS = new Set(['opus', 'm4a', 'mp3', 'flac', 'ogg', 'wav', 'aac']);

/**
 * Choose fixture folders. Default: curated subset. --full-library: whole root.
 * Verifies each chosen folder exists; skips (with a warning) any that don't.
 */
function selectFixturePaths(fullLibrary = false) {
    if (fullLibrary) {
        return [MUSIC_ROOT];
    }
    const paths = [];
    for (const sub of CURATED_SUBFOLDERS) {
        const full = path.join(MUSIC_ROOT, sub);
        if (fs.existsSync(full)) {
            paths.push(full);
        } else {
            console.warn(`[fixture] curated folder missing, skipping: ${full}`);
        }
    }
    if (paths.length === 0) {
        throw new Error(`No fixture folders found under ${MUSIC_ROOT}`);
    }
    return paths;
}

/** Recursively list audio files under the given roots. */
function listAudioFiles(roots) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(full);
            } else if (e.isFile()) {
                const ext = e.name.split('.').pop().toLowerCase();
                if (AUDIO_EXTS.has(ext)) out.push(full);
            }
        }
    };
    for (const r of roots) walk(r);
    out.sort();
    return out;
}

/**
 * Stable hash of the fixture file list (path + size + mtime). Changing any
 * fixture file (or the selection) invalidates the snapshot cache.
 */
function computeFixtureHash(fixturePaths) {
    const files = listAudioFiles(fixturePaths);
    const h = crypto.createHash('sha256');
    for (const f of files) {
        let st;
        try {
            st = fs.statSync(f);
        } catch (_) {
            continue;
        }
        h.update(`${f}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
    }
    h.update(`count:${files.length}`);
    return h.digest('hex').slice(0, 16);
}

function cachePaths(hash) {
    return {
        db: path.join(CACHE_DIR, `${hash}.db`),
        manifest: path.join(CACHE_DIR, `${hash}.manifest.json`),
    };
}

/**
 * If a snapshot exists for this fixture hash, copy the DB into place and return
 * the cached manifest. The backend must NOT be started yet (empty scratch db).
 */
function tryRestore(env, hash) {
    const c = cachePaths(hash);
    if (fs.existsSync(c.db) && fs.existsSync(c.manifest)) {
        fs.copyFileSync(c.db, env.dbPath);
        const manifest = JSON.parse(fs.readFileSync(c.manifest, 'utf8'));
        return manifest;
    }
    return null;
}

/**
 * The DB runs in WAL mode, so freshly-scanned rows live in the `-wal` sidecar
 * until checkpointed — copying only the main `.db` would capture a partial
 * library (the 141-of-151 bug). Force a TRUNCATE checkpoint (SQLite's blessed
 * hot-copy path) so all data lands in the main file, then copy just that.
 */
function checkpointDb(dbPath) {
    const r = spawnSync(VENV_PYTHON, ['-c',
        `import sqlite3; c=sqlite3.connect(${JSON.stringify(dbPath)}, timeout=30); ` +
        `c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()`], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error('WAL checkpoint failed: ' + (r.stderr || r.stdout || r.status));
    }
}

/** Save the scanned DB + manifest to the persistent cache. */
function snapshot(env, hash, manifest) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const c = cachePaths(hash);
    checkpointDb(env.dbPath);
    fs.copyFileSync(env.dbPath, c.db);
    fs.writeFileSync(c.manifest, JSON.stringify(manifest, null, 2));
}

/**
 * Run admin_start_scan and poll admin_scan_status to completion.
 * `jar` must carry an admin session.
 */
async function runScan(env, jar, fixturePaths, { quiet = false } = {}) {
    const start = await apiCall(env.url, 'admin_start_scan', { paths: fixturePaths }, jar);
    if (!start.success) throw new Error('admin_start_scan failed: ' + JSON.stringify(start));
    const taskId = start.result && start.result.taskId;
    if (taskId == null) throw new Error('admin_start_scan returned no taskId: ' + JSON.stringify(start));

    const deadline = Date.now() + 5 * 60 * 1000; // full-library allowance
    let completed = null;
    while (Date.now() < deadline && completed === null) {
        const st = await apiCall(env.url, 'admin_scan_status', { task_id: taskId }, jar);
        const status = st.result && st.result.status;
        if (status && status !== 'running') {
            if (status !== 'completed') {
                throw new Error('Scan did not complete: ' + JSON.stringify(st.result));
            }
            completed = st.result;
            break;
        }
        await sleep(400);
    }
    if (completed === null) throw new Error('Scan timed out');

    // The scanner marks the task 'completed' before it finishes the background
    // FTS rebuild, and admin_scan_status by-taskId can momentarily read a stale
    // row. Guard against snapshotting a mid-write DB: wait until NO scan task is
    // running AND the song count is stable across two reads. Without this, a
    // snapshot can capture a partial library (the 141-of-151 + 'running' bug).
    await settleScan(env, jar);
    if (!quiet) {
        console.log(`[fixture] scan complete: ${completed.new_songs} new, ${completed.total_files} files`);
    }
    return completed;
}

/** Block until no scan is running and the song count is stable. */
async function settleScan(env, jar) {
    const deadline = Date.now() + 60000;
    let stableCount = -1;
    let stableReads = 0;
    while (Date.now() < deadline) {
        const latest = await apiCall(env.url, 'admin_scan_status', {}, jar);
        const running = latest.result && latest.result.status === 'running';
        const stats = await apiCall(env.url, 'admin_get_stats', {}, jar);
        const count = stats.result ? stats.result.totalSongs : -1;
        if (!running && count === stableCount && count > 0) {
            stableReads++;
            if (stableReads >= 2) return count;
        } else {
            stableReads = 0;
            stableCount = count;
        }
        await sleep(250);
    }
    throw new Error('Scan never settled (background writes still in flight)');
}

/** Page through songs_list to fetch every scanned song. */
async function fetchAllSongs(env, jar) {
    const all = [];
    let cursor = null;
    for (let guard = 0; guard < 500; guard++) {
        const res = await apiCall(env.url, 'songs_list',
            { limit: 200, sort: 'title', order: 'asc', cursor }, jar);
        if (!res.success) throw new Error('songs_list failed: ' + JSON.stringify(res));
        all.push(...res.result.items);
        if (!res.result.hasMore) break;
        cursor = res.result.nextCursor;
        if (!cursor) break;
    }
    return all;
}

function formatOf(song) {
    if (song.file) {
        const ext = String(song.file).split('.').pop().toLowerCase();
        if (ext) return ext;
    }
    return song.type || 'unknown';
}

/**
 * Build the fixture manifest from live scan results, so suites assert against
 * generated facts instead of hardcoded library content.
 */
async function buildManifest(env, jar, hash, fixturePaths) {
    const statsRes = await apiCall(env.url, 'admin_get_stats', {}, jar);
    const stats = statsRes.result || {};
    const songs = await fetchAllSongs(env, jar);

    const artists = [...new Set(songs.map((s) => s.artist).filter(Boolean))].sort();
    const albums = [...new Set(songs.map((s) => s.album).filter(Boolean))].sort();
    const genres = [...new Set(songs.map((s) => s.genre).filter(Boolean))].sort();

    // One representative song per format for playback-real.
    const perFormat = {};
    for (const s of songs) {
        const fmt = formatOf(s);
        if (!perFormat[fmt]) {
            perFormat[fmt] = {
                uuid: s.uuid, title: s.title, artist: s.artist, album: s.album,
                duration: s.duration_seconds, file: s.file,
            };
        }
    }

    // A few known tracks suites can search for (prefer ASCII titles for search).
    const knownTracks = songs
        .filter((s) => s.title && /^[\x20-\x7E]+$/.test(s.title))
        .slice(0, 8)
        .map((s) => ({
            uuid: s.uuid, title: s.title, artist: s.artist, album: s.album,
        }));

    // A non-ASCII title if present (proves unicode handling end-to-end).
    const nonAsciiTrack = songs.find((s) => s.title && /[^\x00-\x7F]/.test(s.title));

    return {
        fixtureHash: hash,
        fixturePaths,
        generatedAt: new Date().toISOString(),
        counts: {
            totalSongs: stats.totalSongs != null ? stats.totalSongs : songs.length,
            totalArtists: stats.totalArtists != null ? stats.totalArtists : artists.length,
            totalAlbums: stats.totalAlbums != null ? stats.totalAlbums : albums.length,
            totalGenres: stats.totalGenres != null ? stats.totalGenres : genres.length,
        },
        stats,
        artists,
        albums,
        genres,
        formats: Object.keys(perFormat).sort(),
        perFormat,
        knownTracks,
        nonAsciiTrack: nonAsciiTrack
            ? { uuid: nonAsciiTrack.uuid, title: nonAsciiTrack.title, artist: nonAsciiTrack.artist }
            : null,
        // A small stable sample of uuids for queue-add operations.
        sampleUuids: songs.slice(0, 12).map((s) => s.uuid),
    };
}

/** Write the manifest where suites read it. */
function writeManifestFile(manifest) {
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

/** Read the manifest from a suite. */
function readManifest() {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
}

module.exports = {
    MANIFEST_FILE,
    CACHE_DIR,
    MUSIC_ROOT,
    CURATED_SUBFOLDERS,
    selectFixturePaths,
    listAudioFiles,
    computeFixtureHash,
    cachePaths,
    tryRestore,
    snapshot,
    runScan,
    settleScan,
    fetchAllSongs,
    buildManifest,
    writeManifestFile,
    readManifest,
};

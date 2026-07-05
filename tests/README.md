# mrepo E2E Test Suite

Hermetic, browser-driven end-to-end tests for the public mrepo music player.
The design contract is [E2E-DESIGN.md](E2E-DESIGN.md); this README is the
operational guide.

## TL;DR

```bash
cd tests
node run-e2e.js                 # lanes 1 + 2, curated fixture, all suites
node run-e2e.js --only-errors   # quiet mode (CI)
node run-e2e.js remote-queue    # run only suites whose filename matches
node run-e2e.js --full-library  # scan the whole music root (cached after 1st run)
node run-e2e.js --keep-env      # leave the backend running for debugging
node run-e2e.js --contract      # also run the pytest contract lane first
```

`run-e2e.js` provisions its **own** isolated backend on a free high port with a
scratch database and a curated fixture library. It never touches the owner's
live instance on :9900 and never mutates the real library — it refuses to run
lane 2 against an externally supplied `TEST_URL`.

## Architecture: three lanes, one entry point

| Lane | What | Needs |
|------|------|-------|
| **0** (opt-in `--contract`) | `pytest backend/test_sync_contract.py` | pytest in the venv |
| **1** | backend-free injection suites (`queue-reorder`, `windowing`) against a static server the runner starts | nothing (no login, no fixtures) |
| **2** | hermetic e2e: real backend + real auth + real UI | venv + `npm install` in `tests/` |

The orchestrator (`run-e2e.js`) + harness (`harness/`) do all provisioning:

```
tests/
  run-e2e.js              # orchestrator / single entry point
  harness/
    env.js                # provision/seed/teardown of the isolated backend
    fixture.js            # fixture selection, scan, manifest, DB snapshot cache
    static-server.js      # Lane 1 static file server
  e2e/                    # new hermetic suites (*.e2e.js)
    _queue-driver.js      # shared drag/touch drivers (not a suite)
  *.test.js               # the 19 legacy suites (run under the harness in lane 2)
  test-helper.js          # creds/URL from env vars; page-side apiCall; manifest loader
  fixture-manifest.json   # GENERATED each run — suites assert against these facts
```

## How lane 2 provisions

1. **Scratch env** under the OS tmp dir (never in the repo): a `config.yaml`
   with a scratch DB path, the fixture folders as `media.paths`,
   `ai.enabled: false`, `allow_registration: false`.
2. **Backend**: `venv/bin/python run.py -p <free-port> --no-debug`, selected via
   `MREPO_CONFIG`. Polls `check_user` until live.
3. **Seed users via API** (fast, not the UI): fresh DB reports `setupRequired` →
   `auth_register` creates the admin; the admin creates `testuser`/`testuser`.
4. **Seed library**: `admin_start_scan` + poll `admin_scan_status`, then write
   `fixture-manifest.json` (counts, artists/albums, per-format sample tracks,
   known titles) so suites assert against *generated* facts.
5. **Run suites** sequentially with `TEST_URL`, `TEST_ADMIN_*`, `TEST_USER_*`,
   `FIXTURE_MANIFEST` exported (reusing the legacy per-suite reporting).
6. **Teardown**: kill the backend, delete the scratch dir. `--keep-env` leaves
   it up and prints the port + creds.

### DB snapshot cache

After the first successful scan the scanned DB is snapshotted to
`$TMPDIR/mrepo-e2e-cache/<hash>.db` (+ `.manifest.json`), keyed by a hash of the
fixture file list (paths + sizes + mtimes). Later runs restore the snapshot
instead of rescanning — provisioning drops from a scan to ~0.4 s.

**WAL note:** the DB runs in SQLite WAL mode, so freshly-scanned rows live in
the `-wal` sidecar until checkpointed. The harness forces a
`PRAGMA wal_checkpoint(TRUNCATE)` before copying, and `runScan` waits until the
scan has *settled* (no running task + stable song count). Without this the
snapshot could capture a partial library (the "141 of 151 + running" trap).

## Fixture music

Curated subset (default) — folders under `/home/izzie/file-cache/test-music/`:
`Tunguska Chillout Grooves vol 1` (opus), `blackmill` (opus), `dss` (opus + m4a,
non-ASCII filenames), `Lewis OfMan` (mp3). ~151 tracks / 67 artists / 33 albums,
covering opus + m4a + mp3 and Unicode filenames. `TEST_MUSIC_DIR` overrides the
source root; `--full-library` scans the whole root.

## The suites

### New (`e2e/*.e2e.js`)

| Suite | Covers |
|-------|--------|
| `remote-queue` | REAL logged-in queue: add / drag-reorder (desktop **and** touch) / remove / sort / clear, asserting **server state via `queue_list`** after each op; the move-down-by-one regression pins; persistence across reload |
| `auth-lifecycle` | fresh-DB setup wizard (isolated backend), registration-disabled UI, wrong-password human message (**ValueError** pin), logout round-trip, session persistence, non-admin has no Admin menu (admin does), change-password → re-login, Extend button hidden when AI disabled |
| `two-sessions` | same user in two isolated contexts: A's queue change / reorder is what B loads; A's new playlist is visible in B |
| `admin` | user create/edit/delete via the admin UI, trigger a scan from the UI and watch it complete, rescan idempotence, stats match the manifest |
| `playback-real` | plays real opus/m4a/mp3 tracks (currentTime advances, no audio error), HTTP Range `206` from `streaming.py`, seek, next/prev |
| `search-real` | quick-search finds a manifest-known artist/title, `artist:` syntax filter, `ai:` query degrades gracefully with AI disabled |
| `share-links` | create a share link, open it in a fresh logged-out context (public metadata) |
| `error-shape` | canary: failing API calls surface a human `message`, not the exception class name |
| `history-real` | play → appears in history with correct metadata; history page renders it |
| `smoke` | harness self-check (login + non-empty manifest) |

### Legacy (`*.test.js`) — triaged, not rewritten

All 19 legacy suites run green under the harness. Adaptations made:

- **`ai.test.js`** — 7 tests assume a live AI adapter (Extend button, Find
  Similar, AI status enabled). AI is **disabled by design** in the hermetic env
  (`ai.enabled: false`). Those tests now use an `aiTest()` wrapper that **skips**
  when the AI adapter is unavailable and runs normally against an AI-enabled
  `TEST_URL`. The new suites assert the disabled-gates instead.
- **`navigation.test.js`** — the unknown-route test looked for the text
  "Not Found"; the 404 page actually reads "Page not found". Assertion widened
  to accept `<not-found-page>` or a case-insensitive match (the fallback works).
- **`browse.test.js`** — "No console errors during browse interactions" was
  initially skipped because it caught a genuine product bug (below); the bug is
  fixed and the test is a live regression pin again.

## Product bugs found by this suite (both FIXED 2026-07-05)

1. **Browse "Files" tab console error** (fixed in `_applyTarget()`): the
   windowing refresh used to run BEFORE `viewMode`/`level` were updated, so
   `loadMore` dispatched on the stale level and threw. `_applyTarget()` now sets
   the target view's mode state first. Pinned by `browse.test.js` "No console
   errors during browse interactions".

2. **Share links didn't show songs to logged-out viewers** (fixed): songs now
   load via `playlists_get_songs_by_token` — a public, token-scoped endpoint
   where the unguessable token is the capability (it grants exactly the one
   playlist it was minted for; `playlists_get_songs` still requires auth; the
   public by-token metadata no longer exposes the owner `user_id`). Pinned by
   `share-links.e2e.js` including least-privilege assertions.

## Environment notes

- **Ports:** the harness allocates its own free high port and refuses 9000 /
  9900 / 9901 / 9902. :9900 is the owner's live docker instance.
- **The venv must satisfy `requirements.txt`.** A hand-built partial venv
  bites late: `requests` was once missing, which broke every radio-start
  endpoint (they import it unconditionally) while everything else worked.
  When in doubt: `./venv/bin/python -m pip install -r requirements.txt`.
- **`--contract` needs pytest** in the venv. If it's missing the lane is skipped
  with a clear message (we do not install dependencies).
- **Codecs:** the bundled Chromium here decodes opus/mp3/m4a, so `playback-real`
  exercises all three. On a Chromium without proprietary codecs, m4a/mp3 decode
  may be unavailable (the Range/streaming assertion still holds).
- **Admin stats UI:** the admin page only renders a library-stats block inside
  the AI panel, which is hidden when AI is disabled, so `admin.e2e.js` asserts
  stats via `admin_get_stats` (server truth) compared to the manifest.

## Pointing legacy suites at an external instance

The old path still works for the legacy suites (never for lane 2 / `run-e2e.js`):

```bash
TEST_URL=http://host:port node test-runner.js            # all legacy suites
TEST_URL=http://host:port node test-runner.js auth.test.js
```

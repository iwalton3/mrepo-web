# E2E Test Suite Design Proposal (public mrepo)

Status: APPROVED 2026-07-05 (Izzie) — decisions on the open questions:
1. Fixture subset: one Tunguska volume + blackmill + one mixed-format folder
   (implementer verifies format/tag coverage and swaps folders if needed).
2. Seeded non-admin creds stay `testuser`/`testuser`.
3. Lane 0 (pytest contract) stays opt-in (`--contract`) — different platform,
   keep the lanes separate.
4. Default-lane budget: up to ~20 min is acceptable if the coverage is
   genuinely thorough; thoroughness beats speed here.

## Why now

The last four bugs (Extend-button gate, logout gap, "ValueError" login error,
remote-queue reorder no-op) were all invisible to the backend-free injection
tests and the backend-only contract tests. They lived in the seam between a
real backend, real auth, and the real UI. That seam is exactly what an e2e
lane covers.

## What exists today (inventory)

| Layer | What | State |
|-------|------|-------|
| 19 puppeteer suites in `tests/` | auth, browse, playback, queue, playlists, radio, history, settings, search, offline, ai, eq, mini-player, navigation, now-playing, context-menu, visualizer, audio-effects, queue-reorder, windowing | 17 call `test.login()` (hardcoded `testuser`/`testuser`) against `TEST_URL` (default: Izzie's docker on :9900). **Non-hermetic**: they depend on a manually created user + whatever library/state the docker instance has, and they mutate it (playlists, queue, history). 2 suites (queue-reorder, windowing) are backend-free injection tests and run against any static server. |
| `backend/test_sync_contract.py` | 26 pytest contract tests incl. queue-reorder drag contract | Hermetic, backend-only. |
| Scratch-backend pattern | Used ad hoc this week (isolated config + fresh DB + `run.py` on a free port + register-via-setup) to verify the logout/login/change-password fixes | Proven to work; not codified. |

**The core deliverable is a harness that makes the existing 17 suites hermetic,
plus new suites for the seams that have actually bitten us.**

## Architecture

Three lanes, one entry point:

```
tests/
  run-e2e.js            # NEW: orchestrator (single entry point)
  harness/
    env.js              # NEW: provision/teardown of the hermetic environment
    fixture.js          # NEW: fixture music selection + scan + DB snapshot cache
  e2e/                  # NEW suites (see Coverage below)
  *.test.js             # existing suites, adapted to harness-provided env
  test-helper.js        # extended: creds/URL from env vars, not constants
  E2E-DESIGN.md         # this file
```

### Lane 0 (optional flag): backend contract tests
`pytest backend/test_sync_contract.py` via the venv. Fast fail-early gate.

### Lane 1: backend-free injection suites (unchanged)
queue-reorder + windowing against a static file server the runner starts
itself. No login, no fixtures, ~1 min.

### Lane 2: hermetic e2e (the new core)
`run-e2e.js` provisions everything, then runs the suites sequentially:

1. **Provision** (`harness/env.js`):
   - scratch dir under the runner's tmp: `config.yaml` (scratch DB path,
     fixture media paths, `ai.enabled: false`, `allow_registration: false`),
     free port (never 9900 — no collision with the live docker instance)
   - start `./venv/bin/python run.py -p <port> --no-debug`, poll `check_user`
     until live
2. **Seed users** (via API, not UI, for speed):
   - fresh DB reports `setupRequired` → `auth_register` creates the admin
   - admin creates `testuser`/`testuser` (non-admin) via the users API —
     keeps the existing suites' `CREDENTIALS` working unchanged
3. **Seed library** (`harness/fixture.js`):
   - run `admin_start_scan`, poll `admin_scan_status` to completion
   - write `fixture-manifest.json` (artist/album/song counts, a few known
     track titles) from the scan result + a `songs_list` sample, so suites
     assert against *generated* facts instead of hardcoding library content
   - **DB snapshot cache**: after the first successful scan, copy the scanned
     `music.db` aside keyed by a hash of the fixture file list (paths+mtimes).
     Subsequent runs restore the snapshot instead of rescanning. Full-library
     scans go from minutes to ~1s on the second run.
4. **Run suites** with `TEST_URL`, `TEST_ADMIN_*`, `TEST_USER_*` env vars
   exported; reuse the existing per-suite runner/reporting (`--only-errors`
   preserved).
5. **Teardown**: kill backend, delete scratch. `--keep-env` flag keeps it
   (and prints the port + admin creds) for interactive debugging.

Suites stay sequential — they share one backend and mutate its state.
Per-suite DB reset is deliberately NOT done (matches reality; suites already
create what they need), but the runner restores the clean DB snapshot at the
START of every full run so runs are reproducible.

## Fixture music

Source: `/home/izzie/file-cache/test-music/` (the folder mounted into the
docker instance; 974 files, 4.4 GB, ~30 artist/album folders, mixed
opus/m4a/mp3).

- **Default: curated subset.** `config.media.paths` accepts a list, so the
  harness lists real subfolders directly (no symlinks, no copying). Chosen
  set (format survey done 2026-07-05): `Tunguska Chillout Grooves vol 1`
  (Jamendo, clean tags, opus), `blackmill` (opus), `dss` (opus + m4a,
  non-ASCII filenames), `Lewis OfMan` (mp3) — ≈130 tracks covering
  opus/m4a/mp3. Seconds to scan, deterministic, and enough for
  windowing/virtual-scroll to engage on album pages.
- **`--full-library`** flag scans the whole folder (with the DB snapshot
  cache this is a one-time cost per fixture change).
- `TEST_MUSIC_DIR` env var overrides the source folder entirely (CI or other
  machines).
- The agent must verify the chosen subset actually covers: multiple artists,
  multiple albums per artist, tracks with/without embedded art, at least
  2 file formats, and a non-ASCII filename (the `dss` folder has them).

## New coverage (`tests/e2e/`), ranked by bug history

1. **`remote-queue.e2e.js`** — the 2×2×2 matrix hole that let the reorder
   no-op survive: logged-in (non-temp) queue add / drag-reorder (desktop +
   touch) / remove / sort / clear, asserting **server state via `queue_list`
   after each op**, not just the DOM; queue persists across reload.
2. **`auth-lifecycle.e2e.js`** — fresh-DB setup/register flow, logout button
   round-trip, wrong-password shows the human message (ValueError regression
   pin), change-password in Settings → re-login with new password, session
   persists across reload, non-admin sees no Admin menu entry, registration
   disabled → no register UI.
3. **`two-sessions.e2e.js`** — same user in two browser contexts: queue
   changed in A is what B loads; playlist created in A visible in B.
   (This is the "multi-device" reality the offline/sync layer exists for.)
4. **`admin.e2e.js`** — user create/edit/delete via admin page; trigger scan
   from the UI and watch progress; rescan idempotence (song count stable);
   stats page renders real numbers from the manifest.
5. **`playback-real.e2e.js`** — play an actual fixture track: `currentTime`
   advances, no `error` on the audio element; seek; next/prev; per-format
   (opus, m4a, mp3). This is the only lane that exercises `streaming.py`
   byte-range serving end-to-end.
6. **`search-real.e2e.js`** — quick-search finds a manifest-known artist
   /album/title; syntax filters (`artist:` etc.); `ai:` query with AI
   disabled degrades gracefully (no crash, sensible message).
7. **`share-links.e2e.js`** — create playlist share link, open it in a fresh
   logged-out context.
8. **`error-shape.e2e.js`** — canary that representative failing API calls
   surface `message` (human text), not the exception class name.
9. **`history-real.e2e.js`** — play → appears in history with the right
   metadata.

Existing 17 suites: **triage, don't rewrite.** Run them under the harness and
fix what the hermetic fixture breaks (they don't hardcode artist names, so
expected fallout is small: library-size assumptions, timing). Deliverable is
all lanes green from a cold checkout with only `venv` + `npm install` done.

## Explicitly out of scope (phase 1)

- **AI service e2e** — no service in the test env; only the disabled-gates
  are covered (Extend hidden, `ai:` graceful, Radio falls back to SCA).
- **Full offline/service-worker e2e** — its own project; `offline.test.js`
  stays as-is. Phase-2 candidate: work-offline toggle blocks network + cached
  queue renders.
- **Private (swapi) backend** — covered by its contract tests + real usage;
  the shared frontend files get their coverage here via the public lane.
- **Visual regression** — not now.

## Runner UX

```bash
cd tests
node run-e2e.js                      # lanes 1+2, curated fixture, all suites
node run-e2e.js --only-errors        # quiet mode (CI)
node run-e2e.js remote-queue         # single suite (provisions env the same)
node run-e2e.js --full-library       # scan all 974 files (cached after 1st)
node run-e2e.js --keep-env           # leave backend running for debugging
node run-e2e.js --contract           # also run pytest lane 0 first
```

Time budget: lane 1 ≈ 1 min; lane 2 target < 10 min with curated fixture
(snapshot-cached DB, API-seeded users). The old
`TEST_URL=... node test-runner.js` path keeps working for pointing legacy
suites at the docker instance, but `run-e2e.js` never touches :9900.

## Safety rails

- The harness always provisions its own port/DB; it must refuse to run lane 2
  against an externally supplied `TEST_URL` (that's what test-runner.js is
  for). No test can ever mutate the real docker library/DB.
- Fixture folder is opened read-only by the backend config; scanner writes
  only to the scratch DB.

## Build plan for the implementing agent (reviewable stages)

1. `harness/env.js` + `harness/fixture.js` + `run-e2e.js` skeleton; lane 1
   wired; lane 2 provisions, seeds, scans, tears down. Smoke suite proving
   login-as-testuser works.
2. Triage pass: all 17 existing suites green under the harness (adaptations
   committed separately from harness code).
3. New e2e suites 1–4 (queue, auth, two-sessions, admin).
4. New e2e suites 5–9 (playback, search, share, error-shape, history) +
   `tests/README.md`. (SYNC.md's "run e2e before porting" step is handled
   outside this build — SYNC.md is a shared byte-identical file.)

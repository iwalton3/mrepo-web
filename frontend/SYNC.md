# Two-Repo Sync Guide

The music player exists in two copies that share most of their code
byte-for-byte:

| | PRIVATE | PUBLIC |
|---|---|---|
| Location | vdx-web repo, branch `private`, `app/apps/music/` | mrepo-web repo, `frontend/` |
| Serving | site root = `app/`, app at `/apps/music/` | deploy root = `frontend/` (or `frontend-dist/` when built) |
| Backend | swapi (`/spa-api/`, site auth, capability `music`) | mrepo backend (`/api/`, password auth + admin) |

A file that is byte-identical in both copies only needs testing once.
That is the entire point of this arrangement - protect it.

## What is shared vs divergent

**Byte-identical (the shared tree):** everything not listed below.
As of 2026-07 that is 33 of 38 common app files (up from 25 after the
AI-search + auth convergence round) - now including ALL of `pages/`
(except the public-only login/admin files), all of `components/`,
`offline/` (incl. `offline-api.js`), `music-app.js`, `api/music-api.js`,
and the stores in full (`player-store.js` byte-identical - AI radio
behind `profile.radio`).

**Intentionally divergent, by design (never sync these):**
- `index.html` - title, icons, per-repo import map, public `config.js`
- `profile.js` - THE divergence seam: per-repo endpoints AND feature
  adapters. Now exposes: `endpoints` (apiBase/audioUrl/basePath - the
  RPC transport endpoint and stream URLs), `radio` (AI-radio capability
  gate; non-null on both - public via its embedding AI service, private
  via CLAP/`radio_algorithm`), `ai` (AI-SEARCH adapter - normalized
  surface wired to `ai_*` on public / `clap_*` on private, results
  normalized to `{ items }`; `status().available` gates the AI UI),
  `auth` (frontend auth metadata: `loginUrl`, `hasAdmin`,
  `supportsRegister`, `supportsChangePassword`, `register`/
  `changePassword` methods or null, and `extraRoutes` - the lazy imports
  of the public-only login/admin page files live HERE so the shared
  `music-app` never references them), `vfs` (folder-mapping adapter;
  non-null on private, null on public - its truthiness also gates the
  `include_vfs` song param that `music-api` forwards), and (public only)
  `admin`/`aiAdmin` (API objects for the public-only `admin-page.js`).
  `music-api.js` imports `apiCall` from itself into `profile` and the
  cycle is safe because both sides only USE the imported binding at call
  time, never at module-init (apiBase/audioUrl read inside `apiCall`/
  `getStreamUrl`; profile's adapters are call-time arrows).
- `sw.js` - classic worker; per-repo API/stream/index route prefixes
- `spider-deps.js` - differs by ONE line (`PROJECT_ROOT`); keep the
  rest identical
- `cache-manifest.json` - GENERATED; never copy, always regenerate
- `pages/admin-page.js`, `pages/login-page.js` - public-only files

**Feature-divergent (sync with care):** NONE remaining. The last eight
(`api/music-api.js`, `offline/offline-api.js`, `music-app.js`,
`pages/now-playing.js`, `pages/playlists-page.js`,
`pages/quick-search-page.js`, `pages/settings-page.js`,
`components/song-context-menu.js`) converged in the AI-search + auth
round - all AI-search calls, auth links/routes, and admin gating now
sit behind `profile.ai` / `profile.auth`. Do not re-diverge them; port
future changes on one side and straight-copy.

Converged in the 2026-07 AI-search + auth round (byte-identical, do NOT
re-diverge):
- `api/music-api.js` - split into a shared core (endpoints via
  `profile.endpoints`; songs/queue/playlists/browse/eq/history/sca/
  tags/radio/playback/sync + `auth.checkUser/login/logout`) with the
  divergent groups (AI search `ai_*`/`clap_*`, VFS, admin, auth
  register/changePassword) moved behind `profile`. Exports `apiCall`;
  `getStreamUrl` delegates to `profile.endpoints.audioUrl`. `include_vfs`
  on songs_get/get_bulk is stripped unless `profile.vfs` is set
  (hazard #2 - the raw `getBulk` in the shared `offline-audio.js` passes
  it, so the guard lives in `music-api`).
- `offline/offline-api.js` - the AI/VFS/auth-extra exports now come from
  `profile` (`export const ai = profile.ai; export const vfs =
  profile.vfs;` and `auth.register`/`auth.changePassword` from
  `profile.auth`). No more `clap` export - pages import `ai` everywhere.
- `music-app.js` - `/login/` + `/admin/` merged via
  `...(profile.auth.extraRoutes || {})`; the admin capability parse +
  setup redirect + admin menu entry gate on `profile.auth.hasAdmin`; the
  login link uses `profile.auth.loginUrl`. Private NEVER imports the
  public-only page files (verified: zero requests for
  admin-page.js/login-page.js on private).
- `pages/now-playing.js` - AI extend routes through `profile.ai`
  (generatePlaylist/extendQueue -> `{ items }`); the AI-radio toggle UI
  (gated on `player.aiRadioAvailable`) is now on both. Kept private's
  more-polished queue structure (controls outside the scroll wrapper,
  `queueVersion` reactivity read) + public's AI-toggle + media queries.
- `pages/playlists-page.js` - Extend-AI via `profile.ai.extendPlaylist`
  gated on `ai.status().available`; login link via `profile.auth`.
  Union of both sides' features (private's playlist Import dialog +
  public's AI gating).
- `pages/quick-search-page.js` - see the six reconciliation decisions
  below.
- `pages/settings-page.js` - AI section gates on the normalized
  `ai.status().available`; default radio algorithm derives from AI
  availability (`clap` when available else `sca` - same names on both
  backends); login link via `profile.auth`.
- `components/song-context-menu.js` - Find-Similar gated on
  `ai.status().available` (imported from `offline-api`); private's
  adapter reports available=true so the item shows there.

The six quick-search reconciliation decisions (`ai:` search is
BACKEND-parsed - both `music_search.py` parsers share the identical
`AI_TEXT_PATTERN` regex accepting quoted AND unquoted prompts):
1. `ai:` syntax: unified on the QUOTED form (`ai:"multi word"`) - works
   on both backends; help text is identical, not profile-provided.
2. Example buttons: unified on the quoted set.
3. Blend help: unified (public's, incl. the space-before-`-` note).
4. Similar-mode UI: chose the standalone top header + Exit button
   (search input hidden in similar mode) - the more complete/polished
   variant; used identically on both.
5. Response shapes: adapter normalizes to `{ items }` (findSimilar reads
   `result.items`).
6. Similar-search API: `profile.ai.findSimilar(uuid, limit)` (ai_search_
   similar / clap_search_similar behind the seam).

Earlier convergences (still byte-identical, do not re-diverge):
- `stores/player-store.js` - AI radio branches on `profile.radio`;
  the AI adapter calls (`sca.populateQueueAi/status/setAiPreference`)
  are guarded so a null `profile.radio` degrades to plain
  `sca.populateQueue`.
- `pages/browse-page.js` + `components/vfs-folder-manager.js` - the VFS
  folder-management UI is a shared, always-present component gated at
  its mount/trigger sites on `profile.vfs`; dormant (never rendered) on
  public where `profile.vfs` is null.
- `pages/radio-page.js` - `browse` now imported from `offline-api.js`
  on both (was `api/music-api.js` on private).

The four intended divergence axes, now ALL behind the `profile` seam:
(1) library management - public has admin panel + scanner (behind
`profile.admin`/`aiAdmin` + the public-only admin-page.js), private uses
out-of-band scripts + VFS remaps (`profile.vfs`); (2) AI *search* -
`ai_*` (public) vs `clap_*` (private) behind `profile.ai`, optional on
public (runtime `ai_status` probe) and always-on on private; AI *radio*
behind `profile.radio`; (3) auth - site auth vs password/admin behind
`profile.auth` (loginUrl, hasAdmin, register/changePassword,
extraRoutes); (4) backend differences downstream of the above.

## Conventions that keep files identical

- **Bare import specifiers**: shared files import the framework as
  `vdx/<file>` (framework.js, router.js, utils.js, windowing.js,
  gestures.js) and components as `vdxui/<path>`, resolved by the
  import map in each repo's `index.html`. Never write relative
  `../lib/` paths in shared files. New shared files must follow this.
- **`#profile`** resolves to the per-repo `profile.js`. Anything that
  must differ per repo belongs behind it, not inline.
- `spider-deps.js` reads the import map FROM `index.html` - there is
  no second copy of the map to keep in sync.
- Import maps require Chrome 89+ / Firefox 108+ / Safari 16.4+.

## The sync procedure

1. Land the change on ONE side (convention: private first for app
   changes; framework changes land in vdx-web `main`, then merge to
   `private`, then flow here via vendored bundles).
2. Copy shared files to the other side (straight copy - they must be
   byte-identical; if a copy produces a diff in a file not listed as
   divergent above, STOP - that is drift, reconcile it deliberately).
3. Feature-divergent files: port the change semantically, preserving
   the other side's axis differences. Diff against the pre-change
   version to isolate what to port.
4. Framework updates (public only): copy fresh bundles from vdx-web
   `app/dist/` (`framework|router|utils|windowing|gestures` + `.map`
   + `.d.ts`) into `frontend/lib/`, and sync `frontend/componentlib/`
   from `app/componentlib/` (files there are byte-identical to the
   framework source by construction - never hand-edit them).
5. Regenerate the cache manifest in EACH repo: `node spider-deps.js`
   from the app directory. Never copy a manifest.
6. Public build: `node tools/optimize.js -i frontend -o frontend-dist -m -s`
   (the backend serves `frontend-dist` when present - including the
   local docker instance on :9900, which otherwise serves STALE code).
7. Review the `profile.js` diff between repos - it should only ever
   change deliberately.

## Testing after a sync

- Backend-free suites (run against a static server of the app dir,
  or set `TEST_URL`): `tests/queue-reorder.test.js` (drag semantics,
  desktop + touch), `tests/windowing.test.js` (virtual scroll).
  WARNING: the default `TEST_URL` (:9900) may be a docker instance
  serving the last-built `frontend-dist` - rebuild first or point at
  a static server on `frontend/`.
- Backend contract tests (public): `backend/test_sync_contract.py`
  incl. `QueueReorderDragContractTest` (frontend reorder math against
  the real backend).
- Manual testing matrix for anything touching queue/list interaction -
  this exact matrix once hid an off-by-one for a full release cycle:
  **{desktop drag, touch drag} x {temp queue, remote queue}**. Temp
  queues reorder via a local splice and remote via the backend; the
  two paths share no code below the store call.

## Backend contract hazards (same name, different semantics)

From the 2026-07 backend sweep - the traps when porting code that
talks to the API:
1. **Error shape**: public backend RAISES (transport
   `{success:false, error}` -> frontend throw); private returns
   `{'error': msg}` inline in `result` (~130 sites) - errors are
   SILENT unless the caller checks `result.error`.
2. **Additive params**: private-only kwargs (`include_vfs`,
   `radio_queue.limit`, AI-radio preference keys, `sca_get_pool`
   cursor/limit) make public's `handler(**kwargs)` reject the whole
   call with `InvalidParameters`.
3. **`queue_list`**: private paginates (cursor exclusive), public
   returns everything and ignores cursor/limit.
4. **`ai_*` (public) vs `clap_*` (private)** method names for AI
   *search* - now fully adapted behind `profile.ai`; call sites import
   `ai` from `offline-api` and never name a backend method directly, so
   this trap is retired for AI search. (Historically a `MethodNotFound`
   at any unadapted call site.) NOTE: AI *radio* is NOT part of this
   trap either - the swapi
   backend now implements `sca_status` / `sca_set_ai_preference` /
   `sca_populate_queue_ai` (matching the public backend's names and
   response shapes) so `profile.radio` resolves identically on both.
   On swapi these are CLAP-backed: `sca_set_ai_preference` maps the
   boolean onto the `radio_algorithm` pref ('clap'/'sca'),
   `sca_populate_queue_ai` delegates to `sca_populate_queue` (which
   already routes to CLAP when the pref is 'clap'), and `sca_status`
   reports CLAP `/health` as `aiAvailable`.
5. Reorder semantics are SETTLED and tested: `queue_reorder` is
   remove-then-insert on both backends (no-op when from==to); every
   frontend caller translates its own gap at the call site; the store
   passes indices through untouched. Do not add adjustments to the
   store.

## Deferred convergence work (in order)

All four items below are now DONE. There is no remaining
feature-divergent file - only the structural per-repo files
(index.html, profile.js, sw.js, spider-deps.js, cache-manifest.json)
and the public-only page files (admin-page.js, login-page.js) differ.

1. ~~AI-**search** adapter behind `profile.js`~~ - DONE. `profile.ai`
   unifies now-playing, playlists, quick-search, settings,
   song-context-menu; `ai:` syntax is backend-parsed and unified on the
   quoted form; results normalized to `{ items }`. (player-store / AI
   *radio* was already done behind `profile.radio`.)
2. ~~VFS panel extraction (frees browse-page)~~ - DONE. The VFS UI lives
   in the shared `components/vfs-folder-manager.js`, gated on
   `profile.vfs`; browse-page byte-identical.
3. ~~`api/music-api.js` split~~ - DONE. Shared core + divergent groups
   behind `profile` (`ai`/`vfs`/`admin`/auth-extras). The `sca`
   AI-method surface (populateQueueAi/status/setAiPreference) is in the
   shared core (same names on both backends). `include_vfs` is gated on
   `profile.vfs` rather than a separate `profile.library` seam.
4. ~~Error-shape normalization (hazard #1)~~ - the AI adapter preserves
   `result.error` (private inline `{error}`) alongside the normalized
   `items`, so AI call sites keep working on both error shapes. The
   broader ~130-site inline-error concern (hazard #1) is unchanged and
   remains a general porting caution, not a convergence blocker.

## Backend auth (2026-07 assessment)

The owner asked whether the public backend's auth should be "isolated
into a file". It ALREADY is: `backend/auth.py` holds every primitive
(get_current_user, has_capability, authenticate_user, create_user,
password hashing, is_setup_required, session handling) and enforcement
is centralized in the single `api_method(require=...)` dispatch gate in
`app.py` (NotAuthenticated / NotAuthorized checks + `details` user
injection) - the api/*.py handlers do NO auth checks of their own
(the `session[...]` in `api/radio.py` is a radio-session row, not the
HTTP auth session). This is structurally the same as swapi's
`require='music'` dispatch decorator. No restructuring was done - a
working backend was left alone.

## Backend note: swapi AI-radio surface (2026-07)

`swapi_apps/music.py` gained three endpoints so `profile.radio` works
on the private deployment (all `@capi.add(require='music', details=True)`,
registered by function name like every other method):
- `sca_status()` -> `{scaEnabled, poolSize, aiAvailable, aiRadioPreferred}`.
  `aiAvailable` = CLAP `/health` probe; `aiRadioPreferred` =
  (`radio_algorithm == 'clap'`).
- `sca_set_ai_preference(enabled=True)` -> sets `radio_algorithm` to
  'clap'/'sca'; returns `{success, aiRadioEnabled}`.
- `sca_populate_queue_ai(count=10, seed_uuid=None, diversity=0.3)` ->
  delegates to the existing `sca_populate_queue` (which already does the
  CLAP rolling-seed / pool-filter selection when the pref is 'clap'),
  tagging the result with `ai_used`. The richer CLAP population logic was
  ALREADY present server-side inside `sca_populate_queue`; only this thin
  status/toggle/entrypoint surface was missing. (The classic `radio_*`
  session flow uses `music_sca.py`'s `SCA` class - no CLAP there.)
  Module-level helper `clap_service_available()` mirrors the public
  `/health` availability check.

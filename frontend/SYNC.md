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
As of 2026-07 that is 21 of 35 common app files, including all of
`components/`, `offline/` (except offline-api), most pages, and the
stores' shared logic.

**Intentionally divergent, by design (never sync these):**
- `index.html` - title, icons, per-repo import map, public `config.js`
- `profile.js` - THE divergence seam: per-repo endpoints (and, later,
  feature adapters)
- `sw.js` - classic worker; per-repo API/stream/index route prefixes
- `spider-deps.js` - differs by ONE line (`PROJECT_ROOT`); keep the
  rest identical
- `cache-manifest.json` - GENERATED; never copy, always regenerate
- `pages/admin-page.js`, `pages/login-page.js` - public-only files

**Feature-divergent (sync with care; the deferred convergence steps
will shrink this list):** `api/music-api.js` (backend surface),
`offline/offline-api.js` (auth/AI/VFS exports), `stores/player-store.js`
(AI radio), `music-app.js` (admin/login routes), `pages/now-playing.js`,
`pages/playlists-page.js`, `pages/quick-search-page.js`,
`pages/settings-page.js`, `components/song-context-menu.js` (all AI
adapter + auth links), `pages/browse-page.js` (private VFS panel),
`pages/radio-page.js` (one import line).

The four intended divergence axes: (1) library management - public has
admin panel + scanner, private uses out-of-band scripts + VFS remaps;
(2) AI is optional on public; (3) auth - site auth vs password/docker;
(4) backend differences downstream of the above.

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
4. **`ai_*` (public) vs `clap_*` (private)** method names - intended
   axis, but `MethodNotFound` at any unadapted call site.
5. Reorder semantics are SETTLED and tested: `queue_reorder` is
   remove-then-insert on both backends (no-op when from==to); every
   frontend caller translates its own gap at the call site; the store
   passes indices through untouched. Do not add adjustments to the
   store.

## Deferred convergence work (in order)

1. AI adapter behind `profile.js` (unifies now-playing, playlists,
   quick-search, settings, song-context-menu, player-store; includes
   reconciling quick-search's quoted-vs-unquoted `ai:` syntax and
   `items` vs `results` shapes).
2. VFS panel extraction to a private-only component (frees
   browse-page).
3. `api/music-api.js` split (shared core + `profile.library`).
4. Error-shape normalization (hazard #1) - fold into the profile/
   offline-api seam when doing step 1.

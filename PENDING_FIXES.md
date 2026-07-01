# Upstream Fix Porting Log

**Status: ✅ All known upstream fixes ported as of 2026-07-01.** Manual retest
recommended before the next release (checklist below).

## What was ported (2026-07-01)

All three previously-pending upstream batches **and** the July 2026
state-management fix wave from vdx-web (see
`vdx-web:docs/state-management-audit.md` for the full findings) are now in:

| Area | Upstream source | Notes |
|------|-----------------|-------|
| Framework bundles (`frontend/lib/`) | vdx-web `f3843c2`, `a99653f`, `63a8c23` | Rebuilt via `bundler-esm.js` from vdx-web HEAD. Fixes `:param*` wildcard compilation (+ ReDoS), handleRoute re-entrancy, adds batched `setProps` route-prop delivery. 11 other upstream framework commits ride along (reactivity computed/watch/memo fixes, LIS keyed reconciliation, sanitizeUrl blob:/data: allowance). `FRAMEWORK.md` intentionally NOT overwritten (locally adapted import paths). |
| `frontend/stores/player-store.js` | `3f95579` + `58be0c0` | Advance-token overlap guards, bounded offline skip, temp-queue atomicity, queue-ingest clamping/re-anchoring, `queueLoaded` flag, `_persistPlayMode`, reorder/sort index math. AI-radio feature preserved. |
| `frontend/offline/*`, `offline-indicator` | `3f95579` + `0bf859a` | Position+uuid sync payloads, session-ID commit idempotency, fullSync gating + single-flight, failed_seq poison-pill, history retry, tempIdMap resolution, pull-only preferences, cache truncation/error guards, EQ temp-uuid merge, work-offline online dispatch, 5xx retry. |
| `frontend/pages/browse-page.js` | `744f3ba` + `7b5bc24` + `3f95579` + `0d49618` | `_apiFilters` aggregator translation, background-loader guards, selection fixes, router-driven navigation, unified route reconciler with `_routeEpoch`. (vdx-web's VFS feature intentionally not ported — no vfs API here.) |
| `frontend/pages/quick-search-page.js` | `3f95579` + `0d49618` | Manual merge preserving the AI/compound-search layer: offline request-ID guard, `_advancedSearchId`-keyed background pagination, Back repopulates quick results, similar-search race guard, router-driven URL writes, full state reset on similar-mode exit. |
| `frontend/pages/settings-page.js` | `3f95579` | Shuffle/repeat single source of truth via player store `play_mode` (AI-status/clap-default logic preserved). |
| Other pages + `music-app.js` + new `not-found-page.js` | `0d49618` | Playlists request-ID + error states, mounted-await leak fixes (now-playing/visualizer/playlists), loopsong propsChanged (+ fixed its broken `../../../lib/` import), routing enabled before the auth call, `/404` route, browse route precedence. Multi-user auth flow preserved. |
| `backend/api/{queue,sync,playlists}.py`, `db.py` | PENDING_FIXES backend item + swapi-apps `0e40b97` (hand-written, module style) | queue_index maintenance in remove/reorder/reorder_batch, reorder_batch target math aligned with frontend, queue_clear UPSERT (device columns preserved), queue_sort transaction, verified position+uuid sync handlers + `queue.reorderBatch` op, preference key forwarding (incl. AI keys), commit idempotency (`sync_committed_sessions`, `tempIdMap`, `failed_seq`), `playlists_add_song` duplicate-row fix. |
| `backend/test_sync_contract.py` | adapted from swapi-apps | 18 tests: client payload round-trips, divergence resolution, idempotent double-commit, device-column preservation. Run: `python3 backend/test_sync_contract.py`. |

Notes from the port:
- mrepo's backend was already ahead on some audit items (BEGIN IMMEDIATE on most
  queue ops, UPSERT in `queue_set_index`, read-then-UPDATE in
  `playback_set_state`) — those needed no changes.
- The server sync handlers accept BOTH the new (`items`/`uuid`/`uuids`) and old
  (positions-only) payload shapes, so in-flight pending writes from before this
  update still replay.
- E2E verification: full `tests/` suite run against a scratch instance —
  12/18 files fully green; the 6 remaining failures are **identical on
  pre-port code** and are all the environmental `AI status check failed`
  console error (CLAP AI service not running in the scratch instance), not
  regressions.

## Retest checklist before publishing

- [ ] Search-as-you-type online **and** offline; rapid query changes; Back from advanced
      mode; "similar to" navigation.
- [ ] Browse: navigate from quick-search into an artist/album/folder; drill down; use
      browser back/forward; Genres/Artists tabs with filters active; "Add All" from
      aggregate (`[All Genres/Artists/Albums]`) views; folder names containing `%`.
- [ ] Shuffle/repeat: toggle in player vs. settings page and confirm they agree; verify
      against the AI/clap settings logic.
- [ ] Queue: remove/reorder a song **before** the playing one (highlight + next track
      stay correct); click next as a track ends (no double-advance); two devices/tabs.
- [ ] Temp queue: enter/exit; exit with a missing snapshot; sort while playing; start
      radio from temp queue.
- [ ] Offline: queue remove/reorder offline → reconnect (edits must survive and apply
      to the right songs); favorite a song offline; kill the connection right at sync
      commit (no duplicate adds); repeatedly-failing op doesn't stall the batch;
      toggle work-offline off while online.
- [ ] With the AI service running: AI radio, Find Similar, extend dialogs (the e2e AI
      failures in the port validation were environmental).
- [ ] Deep-link to a playlist and an expired share link (error message, not a blank
      page); unknown URL shows the 404 page.

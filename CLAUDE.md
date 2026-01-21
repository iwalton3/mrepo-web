# CLAUDE.md - mrepo Development Guide

## Overview

**mrepo** is a self-hosted PWA music streaming app with Flask backend (SQLite), VDX frontend framework, offline sync, and FFmpeg transcoding.

## Running Locally

```bash
source venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml  # Edit with your settings
python run.py                        # http://localhost:8080 - first visit shows setup wizard
```

## API Patterns

JSON-RPC style API at `/api/`:
```javascript
POST /api/ → { "method": "songs_list", "kwargs": { "limit": 50 }, "version": 2 }
Response   → { "success": true, "result": { "items": [...], "hasMore": true } }
```

Add methods with `@api_method(name, require='user')` decorator in `backend/api/`. Capabilities: `'user'`, `'admin'`, `None` (public). Access current user via `details['user']`.

## Required Reading (VERY IMPORTANT)

**You MUST read these docs before starting work:**

| Before doing... | Read this first |
|-----------------|-----------------|
| Writing/modifying ANY frontend component | [frontend/lib/FRAMEWORK.md](frontend/lib/FRAMEWORK.md) |

## Frontend Framework (VDX)

Zero-dependency reactive framework. **[frontend/lib/FRAMEWORK.md](frontend/lib/FRAMEWORK.md)** contains component construction, event binding, templates, and reactivity patterns NOT repeated here.

**Key rules:**
- Use `on-*` for events (not onclick), `x-model` for two-way binding
- Use `when()` for conditionals, `each()` for lists, `memoEach()` for large lists
- Use `untracked()` for large arrays to avoid performance issues
- Array `.sort()` and `.reverse()` are safe (made atomic automatically)

## Database

SQLite with WAL mode. Migrations run automatically on startup (`db.py:_run_migrations`).

## TypeScript Validation

```bash
cd frontend && npx tsc 2>&1 | grep -E "has no exported member|Cannot find module|is not a module"
```
Most errors are false positives. Import/export errors are valuable - run after adding exports or refactoring imports.

## Common Gotchas

### Reactive Proxies Can't Be Stored in IndexedDB
IndexedDB structured clone can't handle Proxy objects - use `JSON.parse(JSON.stringify(data))` to strip proxy wrapper first.

### Cache Update in Online Path
Offline-first operations that succeed online must ALSO update local cache (e.g., `offlineDb.saveQueueCache()`).

### findIndex vs findLastIndex for Duplicates
When adding items that may already exist, use `findLastIndex` to find the newly added one.

### API Method Names
API calls use method names directly: `apiCall('sync_push', {...})` not `apiCall('music.sync_push', {...})`.

### ReplayGain Timing with Crossfade
Configure Web Audio API ReplayGain nodes BEFORE calling `play()` on secondary audio.

## Offline Sync Architecture

**Transactional batch sync**: Client pushes operations via `sync_push`, then calls `sync_commit` to execute atomically. Server commits all or rolls back all.

**Temp ID resolution**: Operations on offline-created playlists use temp IDs (`pending-xxx`) that get resolved during commit via `temp_id_map`.

**`_conn` parameter pattern**: API methods accept optional `_conn` for transactional use - if provided, caller manages commit; if None, method auto-commits.

## Audio Player Patterns

- **Per-track vs global controls**: ReplayGain uses Web Audio API gain nodes; user volume uses HTML5 `audio.volume`
- **Dual-mode architecture**: Simple mode is `source → EQ → destination`; crossfade mode adds `replayGainNode → fadeGain → mixer`
- **Mobile latencyHint**: Use `'playback'` on mobile to prevent crackling
- **Lazy AnalyserNode**: Create only when visualizer is open (FFT runs even when not read)

## Database Gotchas

- **album_artist vs artist**: `artist` = track-level; `album_artist` = album-level. Group by `album_artist` to avoid fragmenting albums with featuring tracks.
- **NULLIF for empty strings**: Use `COALESCE(NULLIF(album_artist, ''), 'Unknown')` to treat empty string as NULL.

## Documentation

| Doc | Purpose |
|-----|---------|
| [frontend/lib/FRAMEWORK.md](frontend/lib/FRAMEWORK.md) | VDX framework patterns |
| [docs/bare-metal-install.md](docs/bare-metal-install.md) | Non-Docker installation |
| README.md | Docker setup, features overview |

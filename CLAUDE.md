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

## Key Locations

| To find... | Look in... |
|------------|------------|
| Radio algorithm (SCA, CLAP, rolling seed) | `backend/api/radio.py` |
| AI embedding service, CLAP model | `backend/ai_service/service.py` |
| Background library analysis job | `backend/ai_service/analyzer.py` |
| Search query parser (ai:, ai(), in:) | `backend/music_search.py` |
| Now playing / queue UI | `frontend/pages/now-playing.js` |
| Playlist management UI | `frontend/pages/playlists-page.js` |
| Search page with advanced syntax | `frontend/pages/quick-search-page.js` |
| Player state, audio effects, crossfade | `frontend/stores/player-store.js` |
| API client (apiCall wrapper) | `frontend/api/music-api.js` |
| Right-click song menu (Find Similar) | `frontend/components/song-context-menu.js` |
| Admin dashboard, AI controls | `frontend/pages/admin-page.js` |
| Docker setup | `docker/docker-compose.yml` |

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

## AI Music Similarity System

**AI features require the optional CLAP service** (configured in config.yaml). Check availability via `admin_ai_status` endpoint.

### Components
- `backend/ai_service/service.py` - CLAP embedding service (loads model, generates embeddings)
- `backend/ai_service/analyzer.py` - Background job that scans library and generates embeddings
- `backend/api/ai.py` - AI API endpoints (similarity search, playlist generation)
- `backend/api/admin.py` - `admin_ai_status`, `admin_ai_start_analysis` for AI management

### Search Query Syntax
Advanced search in `backend/music_search.py` supports:

```
ai:"upbeat electronic"           # Semantic text search using CLAP embeddings
ai(a:Beatles)                    # Find similar songs to Beatles tracks
ai(uuid:abc123)                  # Find similar songs to a specific song UUID
in:playlist-name                 # Filter by playlist membership
c:j-pop AND ai:"happy anime"     # Combine category filter with semantic search
ai:"dreamy" -ai:"electronic"     # Semantic AND/NOT combinations
```

The parser creates AST nodes: `AITextSearch` for `ai:` and `AISubquerySearch` for `ai()`.

### Frontend AI Integration
- Context menu "Find Similar" uses `ai(uuid:...)` syntax (`frontend/components/song-context-menu.js`)
- Search page accepts all syntax (`frontend/pages/quick-search-page.js`)
- AI status checked via `aiEnabled` state; controls conditionally rendered

## Radio Algorithms

Two algorithms available (user preference: `radio_algorithm`):

### SCA (Stochastic Collector Algorithm) - Default
- Random selection from seeded pool
- **Rolling seed mode**: When pool < 200 songs, uses half-current + half-original regeneration
- See `sca_populate_queue()` and `_regenerate_rolling_seed_pool()` in `backend/api/radio.py`

### CLAP (AI Similarity)
- Uses AI embeddings to find similar songs to current playing
- Falls back to SCA if AI unavailable
- See `sca_populate_queue_ai()` in `backend/api/radio.py`

### Key Settings
- `radio_algorithm`: "sca" or "clap"
- `radio_diversity`: 0.0-1.0 (MMR diversity for AI results)
- `ROLLING_SEED_THRESHOLD = 200` (constant in radio.py)

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

## Frontend Architecture

### Pages (`frontend/pages/`)
- `quick-search-page.js` - Search with advanced syntax (ai:, in:, field operators)
- `playlists-page.js` - Playlist management (create, rename, clone, extend with AI)
- `now-playing.js` - Current queue, drag-to-reorder, visualizer toggle
- `radio-page.js` - Radio mode controls, algorithm selection
- `admin-page.js` - Admin controls, AI status, library analysis
- `settings-page.js` - User preferences (playback, radio algorithm, UI)
- `browse-page.js` - Album/artist browsing
- `history-page.js` - Playback history

### State Management (`frontend/stores/`)
- `player-store.js` - Playback state, queue, audio pipeline (EQ, crossfade, ReplayGain)
- `eq-presets-store.js` - EQ preset management

### Offline Support (`frontend/offline/`)
- `offline-api.js` - Offline-aware API wrapper, AI status detection
- `offline-db.js` - IndexedDB for offline song/playlist cache
- `sync-manager.js` - Sync operations when back online

## Documentation

| Doc | Purpose |
|-----|---------|
| [frontend/lib/FRAMEWORK.md](frontend/lib/FRAMEWORK.md) | VDX framework patterns |
| [docs/bare-metal-install.md](docs/bare-metal-install.md) | Non-Docker installation |
| README.md | Docker setup, features overview |

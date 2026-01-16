# CLAUDE.md - mrepo Development Guide

This file provides guidance for working with the mrepo codebase.

## Overview

**mrepo** is a self-hosted music streaming application with:
- Flask backend with SQLite database
- VDX (Vanilla Developer Experience) frontend framework
- PWA with offline support
- FFmpeg-based transcoding for tracker formats

## Project Structure

```
mrepo-web/
├── backend/
│   ├── app.py              # Flask app factory, API dispatcher
│   ├── config.py           # Configuration management
│   ├── auth.py             # User authentication (Argon2)
│   ├── db.py               # SQLite connections, migrations
│   ├── streaming.py        # Audio streaming, FFmpeg transcoding
│   ├── scanner.py          # Music file scanner (mutagen)
│   ├── music_search.py     # Search query parser
│   └── api/                # API modules
│       ├── songs.py        # Song listing, search
│       ├── browse.py       # Category/genre/artist browsing
│       ├── playlists.py    # Playlist management
│       ├── queue.py        # Server-side queue
│       ├── playback.py     # Playback state
│       ├── radio.py        # Radio mode, SCA algorithm
│       ├── history.py      # Play history
│       ├── preferences.py  # User preferences, EQ presets
│       ├── sync.py         # Offline sync support
│       ├── admin.py        # Admin functions, VFS
│       ├── ai.py           # AI similarity search
│       └── tags.py         # User tagging system
├── frontend/
│   ├── index.html          # Entry point
│   ├── music-app.js        # Main app component
│   ├── sw.js               # Service worker
│   ├── lib/                # VDX framework (dist bundles)
│   ├── componentlib/       # UI components (cl-* prefix)
│   ├── api/                # API client
│   ├── stores/             # State management
│   ├── pages/              # Page components
│   ├── components/         # Shared components
│   ├── offline/            # Offline support
│   └── vendor/             # Third-party (Butterchurn)
├── docker/
│   ├── Dockerfile
│   └── docker-compose.example.yml
├── docker-compose.yml      # At root (default dev setup)
├── requirements.txt
├── config.example.yaml
└── README.md
```

## Running Locally

### Prerequisites
- Python 3.11+
- FFmpeg (optional, for transcoding)

### Setup

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create config
cp config.example.yaml config.yaml
# Edit config.yaml with your settings

# Run
python run.py
```

Open http://localhost:8080 - first visit shows setup wizard.

## API Patterns

The backend uses a JSON-RPC style API at `/api/`:

```javascript
// Request
POST /api/
{
  "method": "songs_list",
  "kwargs": { "limit": 50, "sort": "title" },
  "version": 2
}

// Response
{
  "success": true,
  "result": { "items": [...], "hasMore": true }
}
```

### Adding API Methods

Use the `@api_method` decorator:

```python
from backend.app import api_method

@api_method('my_method', require='user')
def my_method(arg1, arg2, details=None):
    """Docstring."""
    user_id = details['user']  # Get current user
    # ... implementation
    return {'result': 'value'}
```

Capabilities: `'user'`, `'admin'`, `None` (public)

## Frontend Framework (VDX)

VDX is a zero-dependency reactive framework. For complete patterns, see **[frontend/lib/FRAMEWORK.md](frontend/lib/FRAMEWORK.md)**.

**Critical rules:**
- Use `on-*` for events (not onclick)
- Use `x-model` for two-way binding
- Never mutate reactive arrays with `.sort()` - use `[...arr].sort()`
- Use `when()` for conditionals, `each()` for lists
- Use `memoEach()` for large lists (queue, history)
- Use `untracked()` for large arrays to avoid performance issues

## Database

SQLite with WAL mode. Key tables:
- `users` - Authentication
- `songs` - Music library
- `playlists`, `playlist_songs` - Playlists
- `user_queue` - Server-side queue
- `play_history` - Play tracking
- `eq_presets` - EQ settings

Migrations run automatically on startup (`db.py:_run_migrations`).

## Music Import

The scanner (`scanner.py`) extracts metadata using mutagen:

```python
from backend.scanner import scan_paths
result = scan_paths(['/path/to/music'])
# Returns: {'total': N, 'processed': N, 'new': N, 'updated': N}
```

UUIDs are generated from file paths (deterministic).

## Streaming

`/stream/<uuid>` serves audio:
- Native formats: Direct file streaming with Range support
- Tracker formats (mod, xm, etc.): FFmpeg transcoding to MP3

## Configuration

Priority: Environment vars > config.yaml > defaults

Key env vars:
- `SECRET_KEY` - Session encryption
- `DATABASE_PATH` - SQLite database
- `MEDIA_PATH` - Music directory
- `MREPO_CONFIG` - Config file path

## Common Tasks

### Add a new API endpoint
1. Add function to appropriate `backend/api/*.py`
2. Decorate with `@api_method(name, require='user')`
3. Call from frontend via `apiCall('name', {args})`

### Add a new page
1. Create `frontend/pages/my-page.js`
2. Add lazy load in `music-app.js`
3. Add route in router setup

### Add a new component
1. Create `frontend/components/my-component.js`
2. Import and use in pages

## TypeScript Validation

The frontend uses TypeScript for static analysis to catch import/export errors without requiring a build step. The `.d.ts` type definition files are in `frontend/lib/`.

### Running Type Checks

```bash
cd frontend
npx tsc

# Filter to just import/export errors (most useful):
npx tsc 2>&1 | grep -E "has no exported member|Cannot find module|is not a module"
```

Note: Many errors will show, but most are false positives from TypeScript not understanding JavaScript patterns like `= {}` destructured parameters. Import/export errors are the valuable ones to catch - these reveal missing exports, typos in imports, and API wrapper inconsistencies.

### When to Run

Run TypeScript validation after:
- Adding new exports to API modules
- Creating wrapper modules (like `offline-api.js` wrapping `music-api.js`)
- Refactoring imports across multiple files

## Common Gotchas

### Reactive Proxies Can't Be Stored in IndexedDB
IndexedDB uses structured clone which can't handle Proxy objects:
```javascript
// ❌ Error: "proxy object could not be cloned"
await offlineDb.save(this.state.myData);

// ✅ Clone to strip proxy wrapper first
const cleanData = JSON.parse(JSON.stringify(this.state.myData));
await offlineDb.save(cleanData);
```

### Cache Update Required in Both Online and Offline Paths
When using offline-first patterns, operations that succeed while online must ALSO update the local cache:
```javascript
// After successful online API call
const cached = await offlineDb.getQueueCache();
if (cached) {
    cached.queueIndex = index;
    await offlineDb.saveQueueCache(cached);
}
```

### Queue Operations: Append vs Replace
"Add All" should append; only "Play All" or explicit clear should replace:
```javascript
const wasEmpty = this.store.state.queue.length === 0;
this.store.state.queue = [...this.store.state.queue, ...songs];
if (wasEmpty) await this._autoplayQueue();
```

### findIndex vs findLastIndex for Duplicates
When adding items that may already exist, use `findLastIndex` to find the newly added one:
```javascript
// ❌ Returns FIRST occurrence
const idx = queue.findIndex(s => s.uuid === song.uuid);

// ✅ Returns LAST (newly added) occurrence
const idx = queue.findLastIndex(s => s.uuid === song.uuid);
```

### API Method Names
API calls use method names directly, not prefixed:
```javascript
// ❌ Wrong
await apiCall('music.sync_push', {...})

// ✅ Correct
await apiCall('sync_push', {...})
```

### ReplayGain Timing with Crossfade
Configure Web Audio API ReplayGain nodes BEFORE calling `play()` on secondary audio:
```javascript
this._updateReplayGainNode(1, nextSong);  // Set ReplayGain first
await this._secondaryAudio.play();         // Then play
```

### Temp Queue Exit Race Condition
After exiting temp queue, prevent `_refreshQueueOnFocus()` from overwriting:
```javascript
this._tempQueueExitTime = Date.now();

// In _refreshQueueOnFocus()
if (Date.now() - this._tempQueueExitTime < 5000) return;
```

## Offline Sync Architecture

### Transactional Batch Sync
Offline writes are queued and committed atomically:
1. Client pushes operations via `sync_push`
2. Client calls `sync_commit` to execute all in one transaction
3. Server either commits all or rolls back all

### Temp ID Resolution
Operations on offline-created playlists use temp IDs (`pending-xxx`) that get resolved during commit:
```python
temp_id_map = {}
for op in operations:
    if op['type'] == 'create':
        real_id = execute(op)
        if op.get('tempId'):
            temp_id_map[op['tempId']] = real_id
    else:
        # Resolve temp IDs in later operations
        if str(op['playlistId']).startswith('pending-'):
            op['playlistId'] = temp_id_map[op['playlistId']]
```

### Optional `_conn` Parameter Pattern
API methods support both standalone (auto-commit) and transactional use:
```python
def queue_add(song_uuids, position=None, details=None, _conn=None):
    own_conn = _conn is None
    conn = _conn if _conn else get_db()
    # ... do work ...
    if own_conn:
        conn.commit()
        conn.close()
```

## Audio Player Patterns

### Separation of Per-Track vs Global Controls
- **Per-track** (ReplayGain): Web Audio API gain nodes
- **Global** (user volume): HTML5 audio.volume property

### Dual-Mode Audio Architecture
- **Simple mode** (no crossfade): `source → EQ → destination`
- **Dual mode** (crossfade): `source → replayGainNode → fadeGain → mixer → EQ → destination`

## Database Gotchas

### Offset-Based Pagination
Prefer offset-based pagination for complex sorts:
```python
offset = int(cursor) if cursor else 0
rows = conn.execute(query + " LIMIT ? OFFSET ?", [limit + 1, offset]).fetchall()
has_more = len(rows) > limit
next_cursor = str(offset + limit) if has_more else None
```

### album_artist vs artist
- `artist` = track-level (who performed this song)
- `album_artist` = album-level (who released the album)
Group by `album_artist` to avoid fragmenting albums with featuring tracks.

### NULLIF for Empty Strings
```sql
-- ❌ Returns '' if album_artist is empty
COALESCE(album_artist, 'Unknown')

-- ✅ Treats empty string as NULL
COALESCE(NULLIF(album_artist, ''), 'Unknown')
```

## Documentation Index

| Doc File | When to Read |
|----------|--------------|
| `frontend/lib/FRAMEWORK.md` | VDX framework patterns for app development |
| `README.md` | Project setup and overview |

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
│       └── admin.py        # Admin functions, VFS
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
│   └── docker-compose.yml
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

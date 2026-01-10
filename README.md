# MRepo-Web - Music Repository Web Player

This is a fully-featured PWA music app, supporting extremely large music libraries with all the bells and whistles you would expect from such an application, and probably more you did not.

It builds on a decade of me managing a music collection and being really frustrated with less than ideal systems such as mpd, Plex music support, Jellyfin music support, local application, a bespoke command line music player, and several more minimal webapps. I've tried to build on top of other systems but they always felt like they came short in some area.

## Features

- **Infinite scroll without spinners/pages!** - Scroll through your entire music library seamlessly on your phone or desktop without your browser crashing or being interrupted by spinners!
- **Synced Queue** - Play music on your desktop, then pick up where you left off on your phone! (Optional temporary queue also available for ad-hoc playback.)
- **Offline Sync** - Download arbitrary folders, playlists, genres, artists, etc to your phone and play them on the go, even with airplane mode. Downloads automatically take priority, saving your cellular bandwidth and reducing glitches.
- **Audio Pipeline** - Replaygain, Crossfade, Parametric EQ (incl AutoEQ import), Crossfeed, Tempo Control, Fletcher Munson Loudness Compensation, Customizable White Noise - it's all supported even on mobile!
- **Visualizers** - Winamp-style visualizers are included thanks to Butterchurn, even on mobile!
- **Multi User** - Create playlists and share them with other users
- **Browse & Search** - Browse and search your library by filesystem, category, genre, artist, and albums
- **Radio Mode** - Automatically generate a queue of music that evolves and explores your library, avoiding adjacent duplicate/similar songs and supporting very large pools of music to play.
- **AI Music Similarity** (optional) - Use CLAP-based audio embeddings for semantic search, finding similar songs, and AI-powered playlist extension. Supports CPU-only or GPU-accelerated deployment.
- **Auto Sleep Timer** - Intelligently stop background music playback after your bedtime on mobile, just set how long to play and it does the rest.
- **History** - Keep a history of what you play and make arbitrary "recap" playlists whenever you want with your most played songs.
- **Infinite Jukebox** - Create a permalink for a specific song that loops forever, seamlessly where possible.
- **Transcoding** - Limited support is available for playing formats which don't support mobile/web playback, such as xm/mod/s3m/it.
- **Metadata Scanner** - Scans and indexes your music metadata for performant library support. Uses sqlite.

### Non-Features

These features are not included currently, and some may never be.

- Metadata Fetching/Editing - System uses metadata as-is, no external sources
- Lyrics
- Album Art - Not displayed, used, or fetched
- CUE Sheets
- Scrobbling to external services
- Subsonic API
- Chromecast/DLNA support

## Quick Start with Docker

### Using Pre-built Images (Recommended)

1. Clone the repository (or just download `docker-compose.yml`):
   ```bash
   git clone https://github.com/iwalton3/mrepo-web.git
   cd mrepo-web
   ```

2. Edit `docker-compose.yml` to set your music path:
   ```yaml
   volumes:
     - /path/to/Music:/media:ro  # Change this to your music folder
   ```

3. Start the container:
   ```bash
   docker compose up -d
   ```

4. Open http://localhost:8080 - the setup wizard will guide you through creating an admin account.

#### With AI Features

The `docker-compose.yml` includes optional AI services for semantic search and music similarity:

```bash
# With AI (CPU) - works on any system, slower analysis
docker compose --profile ai up -d

# With AI (GPU) - requires NVIDIA GPU and Container Toolkit
docker compose --profile ai-gpu up -d
```

Note! Make sure your music volume is configured for BOTH the main service and the AI service, or analysis will fail.

AI features auto-enable when the AI service is reachable. To disable AI, simply run without a profile.

#### Available Tags

- `main` - Latest build from main branch
- `vX.Y.Z` - Specific version (e.g., `v1.0.0`)
- `X.Y` - Latest patch for a minor version
- `<sha>` - Specific commit

#### Pre-built Images

| Image | Description |
|-------|-------------|
| `ghcr.io/iwalton3/mrepo-web` | Main application |
| `ghcr.io/iwalton3/mrepo-web-ai` | AI service (CPU, amd64/arm64) |
| `ghcr.io/iwalton3/mrepo-web-ai-gpu` | AI service (CUDA GPU, amd64 only) |

### Building from Source

For development or customization, use the build-from-source compose file:

1. Clone the repository:
   ```bash
   git clone https://github.com/iwalton3/mrepo-web.git
   cd mrepo-web
   ```

2. Copy and edit the development compose file:
   ```bash
   cp docker/docker-compose.example.yml docker/docker-compose.yml
   # Edit docker/docker-compose.yml to set your music path
   ```

3. Optionally create a configuration file:
   ```bash
   cp config.example.yaml docker/config.yaml
   # Edit docker/config.yaml
   ```

4. Start the container:
   ```bash
   cd docker
   docker compose up -d
   ```

5. Open http://localhost:8080 - the setup wizard will guide you through creating an admin account.

A secure session key is automatically generated and stored in `/data/.secret_key` on first run.

## Manual Installation

### Prerequisites

- Python 3.11+
- FFmpeg (optional, for tracker format transcoding)

### Setup

1. Create a virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Create configuration:
   ```bash
   cp config.example.yaml config.yaml
   ```

4. Edit `config.yaml` with your settings (see Configuration below).

5. Run the server:
   ```bash
   python run.py
   ```

6. Open http://localhost:8080 and complete the setup wizard.

### Optimized Frontend (Optional)

For better performance, especially on phones or with large libraries, you can build an optimized version of the frontend:

```bash
# Requires Node.js
node tools/optimize.js -i frontend -o frontend-dist -m -s
cd frontend-dist && node spider-deps.js
```

This creates a minified build with source maps in `frontend-dist/`. The server automatically detects and uses it when present. Benefits include:

- ~11% smaller file sizes (faster initial load)
- Minified JavaScript (faster parsing)
- Fine-grained reactivity optimizations (smoother scrolling in large lists)
- Source maps for debugging

The `spider-deps.js` step regenerates the cache manifest so the PWA caches the optimized files.

To revert to the development version, simply delete `frontend-dist/`.

## Configuration

Configuration can be set via `config.yaml` or environment variables. Environment variables take precedence.

### config.yaml

```yaml
database:
  path: /data/music.db       # SQLite database location
  timeout: 30                # Connection timeout in seconds

media:
  paths:                     # Directories containing your music
    - /media/music
    - /media/podcasts

streaming:
  url_prefix: /stream        # URL prefix for audio streaming
  transcode_bitrate: 320k    # Bitrate for transcoded files
  ffmpeg_path: ffmpeg        # Path to FFmpeg binary

auth:
  secret_key: null           # Session encryption key (use env var)
  session_days: 30           # Session duration
  allow_registration: false  # Allow new user registration

tasks:
  scan_on_startup: false     # Scan music on server start
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_PATH` | SQLite database path |
| `MEDIA_PATH` | Music directory (single path) |
| `MREPO_CONFIG` | Path to config.yaml |

The session secret key is automatically generated and stored in `.secret_key` in the data directory. You can override this by setting `auth.secret_key` in config.yaml.

## Importing Music

1. Log in as an admin user
2. Go to Admin (in the sidebar)
3. Click "Start Scan" to import music from configured paths

The scanner extracts metadata using mutagen and supports:
- MP3, FLAC, OGG, M4A, WAV, AIFF
- Tracker formats (mod, xm, s3m, it, etc.) with FFmpeg

Files are referenced by their original paths - no reorganization required.

## Categories

Music is organized into categories for browsing. By default, all music is assigned to the `default` category.

To assign music to different categories, create a `.category` file in any directory. The file should contain a single line with the category name:

```
/media/music/
├── .category          # Contains: Music
├── Rock/
│   └── song1.mp3      # Category: Music
├── Jazz/
│   └── song2.mp3      # Category: Music
└── Podcasts/
    ├── .category      # Contains: Podcasts
    └── episode1.mp3   # Category: Podcasts
```

**How it works:**
- The scanner walks up the directory tree from each audio file looking for `.category` files
- The nearest `.category` file wins (most specific)
- If no `.category` file is found, the category is `default`
- Categories can be nested - a subdirectory can override its parent's category

**Example structure:**
```
/media/
├── .category              # "Music" - applies to all unless overridden
├── Albums/
│   └── Artist/
│       └── Album/
│           └── track.mp3  # Category: Music
├── Soundtracks/
│   ├── .category          # "Soundtracks" - overrides parent
│   └── movie-ost.mp3      # Category: Soundtracks
└── Podcasts/
    ├── .category          # "Podcasts"
    └── show/
        └── episode.mp3    # Category: Podcasts
```

## AI Features (Optional)

MRepo includes optional AI-powered music similarity features using the LAION CLAP model. When enabled, you get:

- **Semantic Search** - Search using natural language (e.g., `ai:upbeat electronic with synths`)
- **Find Similar Songs** - Right-click any song to find acoustically similar tracks
- **Extend Playlist/Queue** - Add similar songs to playlists or your queue with one click
- **AI Radio Mode** - Radio that uses audio similarity instead of random selection

### AI System Requirements

The AI service analyzes audio files to create embeddings. Requirements vary by deployment mode:

| Mode | RAM | VRAM | Speed (per song) |
|------|-----|------|------------------|
| CPU | 4GB+ | - | 2-5 seconds |
| GPU (CUDA) | 4GB+ | 4GB+ | ~100ms |

**Model size**: ~500MB download on first run (cached in Docker volume)

### Enabling AI with Docker

The `docker-compose.yml` in the repository root includes AI service profiles.

#### Option 1: CPU Mode (Recommended for Small Libraries)

```bash
docker compose --profile ai up -d
```

#### Option 2: GPU Mode (NVIDIA CUDA)

Requires [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

```bash
docker compose --profile ai-gpu up -d
```

#### Option 3: Remote AI Service

Run the AI service on a separate machine (e.g., a GPU server):

```bash
# On the AI server - use pre-built image
docker run -d -p 5002:5002 \
  -v /path/to/music:/media:ro \
  -v ai-models:/root/.cache \
  ghcr.io/iwalton3/mrepo-web-ai:main

# On the main server - point to your AI server hostname
AI_SERVICE_URL=http://ai-server:5002 docker compose up -d
```

### Enabling AI Without Docker

See [Bare Metal Installation Guide](docs/bare-metal-install.md) for instructions on running the AI service without Docker using conda and systemd.

### Analyzing Your Library

Once AI is enabled:

1. Go to **Admin** in the sidebar
2. Look for the **AI Music Analysis** section
3. Click **Start Analysis** to begin embedding your library

Analysis progress is shown in real-time. You can continue using the app while analysis runs in the background.

**Performance tips:**
- CPU mode: ~2-5 seconds per song. A 10,000 song library takes 6-14 hours.
- GPU mode: ~100ms per song. A 10,000 song library takes ~20 minutes.
- Analysis only needs to run once per song (stored in database).
- New songs added via scan are automatically queued for analysis.

### AI Search Syntax

Once your library is analyzed, use these search operators:

| Syntax | Description | Example |
|--------|-------------|---------|
| `ai:prompt` | Semantic text search | `ai:upbeat electronic music` |
| `ai(query)` | Find similar to query results | `ai(a:Beatles)` |
| `in:playlist` | Songs in playlist (contains) | `in:Favorites` |
| `in:eq:name` | Songs in exact playlist name | `in:eq:Rock Anthems` |

**Context-aware AI search**: Combine with filters to search within a subset:
```
c:youtube-music AND ai:happy anime song
```
This finds "happy anime songs" specifically within the youtube-music category.

### Disabling AI

AI features auto-enable when the AI service is reachable. To disable AI:

1. Stop the AI service container (or don't start it)
2. Or set `AI_SERVICE_URL` to empty
3. AI-related UI elements will automatically hide

## API

mrepo uses a JSON-RPC style API at `/api/`:

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

See `backend/api/` for available methods.

## Development

See [CLAUDE.md](CLAUDE.md) for development documentation.

## Quality Assurance

This is a side project primarily written using Claude, based on a custom web framework. I use a codebase similar to this one for my personal music system, so it gets a decent amount of manual QA testing. I've code reviewed the important bits such as authentication, so as long as no one cracks your password the attack surface is low.

## License

Main Project: AGPLv3

(If you host the project, you have to let your users access the code and any modifications you make if they ask for it. Most companies are allergic to this license, for good reason.)

Dependencies (all bundled in minified form in this repo) are all MIT licensed:

- [Butterchurn](https://github.com/jberg/butterchurn)
- [Butterchurn Presets](https://github.com/jberg/butterchurn-presets)
- [VDX web framework](https://github.com/iwalton3/vdx-web)

Butterchurn was built using the default configuration in docker and committed into the repo for your convenience and to avoid build issues in the future.

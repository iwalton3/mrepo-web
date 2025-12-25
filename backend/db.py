"""
Database connection and migration management for mrepo.

Uses SQLite with WAL mode for concurrent access.
Thread-local connections for WSGI compatibility.
"""

import sqlite3
import threading
from pathlib import Path

from flask import current_app, g


# Thread-local storage for connections outside Flask context
_local = threading.local()


def get_db():
    """Get a database connection for the current context.

    In Flask request context, stores connection in g.
    Outside Flask, uses thread-local storage.
    """
    try:
        # Try Flask context first
        if 'db' not in g:
            g.db = _create_connection(current_app.config['DATABASE_PATH'],
                                       current_app.config['DATABASE_TIMEOUT'])
        return g.db
    except RuntimeError:
        # Outside Flask context, use thread-local
        if not hasattr(_local, 'db') or _local.db is None:
            from .config import config
            _local.db = _create_connection(
                config.get('database', 'path'),
                config.get('database', 'timeout')
            )
        return _local.db


def _create_connection(db_path, timeout=30):
    """Create a new database connection with proper settings."""
    # Ensure directory exists
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(
        db_path,
        timeout=timeout,
        check_same_thread=False,
        isolation_level=None  # Autocommit mode
    )
    conn.row_factory = sqlite3.Row

    # Enable WAL mode and set busy timeout
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute(f'PRAGMA busy_timeout={timeout * 1000}')

    return conn


def close_db(e=None):
    """Close the database connection."""
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db(app):
    """Initialize database with schema migrations."""
    with app.app_context():
        db = get_db()
        _run_migrations(db)


def _run_migrations(db):
    """Run database migrations to ensure schema is up to date."""
    cur = db.cursor()

    # Check existing tables
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    existing_tables = {row[0] for row in cur.fetchall()}

    # Users table (new for standalone version)
    if 'users' not in existing_tables:
        cur.execute('''
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                capabilities TEXT DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        ''')
        cur.execute('CREATE INDEX idx_users_username ON users(username)')

    # App settings table
    if 'app_settings' not in existing_tables:
        cur.execute('''
            CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        ''')

    # Songs table (may already exist from imported data)
    if 'songs' not in existing_tables:
        cur.execute('''
            CREATE TABLE songs (
                uuid TEXT PRIMARY KEY,
                file TEXT NOT NULL,
                title TEXT,
                artist TEXT,
                album TEXT,
                album_artist TEXT,
                track_number INTEGER,
                disc_number INTEGER,
                year INTEGER,
                genre TEXT,
                category TEXT,
                duration_seconds REAL,
                type TEXT,
                seekable INTEGER DEFAULT 1,
                size INTEGER,
                modified_at TIMESTAMP,
                replay_gain_track REAL,
                replay_gain_album REAL,
                key TEXT,
                bpm REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cur.execute('CREATE INDEX idx_songs_title ON songs(title)')
        cur.execute('CREATE INDEX idx_songs_artist ON songs(artist)')
        cur.execute('CREATE INDEX idx_songs_album ON songs(album)')
        cur.execute('CREATE INDEX idx_songs_genre ON songs(genre)')
        cur.execute('CREATE INDEX idx_songs_category ON songs(category)')
        cur.execute('CREATE INDEX idx_songs_file ON songs(file)')

        # Full-text search
        cur.execute('''
            CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
                uuid, title, artist, album, album_artist, genre, category, file,
                content='songs',
                content_rowid='rowid',
                tokenize='unicode61'
            )
        ''')

        # FTS sync triggers
        cur.execute('''
            CREATE TRIGGER IF NOT EXISTS songs_ai AFTER INSERT ON songs BEGIN
                INSERT INTO songs_fts(rowid, uuid, title, artist, album, album_artist, genre, category, file)
                VALUES (NEW.rowid, NEW.uuid, NEW.title, NEW.artist, NEW.album, NEW.album_artist, NEW.genre, NEW.category, NEW.file);
            END
        ''')
        cur.execute('''
            CREATE TRIGGER IF NOT EXISTS songs_ad AFTER DELETE ON songs BEGIN
                INSERT INTO songs_fts(songs_fts, rowid, uuid, title, artist, album, album_artist, genre, category, file)
                VALUES ('delete', OLD.rowid, OLD.uuid, OLD.title, OLD.artist, OLD.album, OLD.album_artist, OLD.genre, OLD.category, OLD.file);
            END
        ''')
        cur.execute('''
            CREATE TRIGGER IF NOT EXISTS songs_au AFTER UPDATE ON songs BEGIN
                INSERT INTO songs_fts(songs_fts, rowid, uuid, title, artist, album, album_artist, genre, category, file)
                VALUES ('delete', OLD.rowid, OLD.uuid, OLD.title, OLD.artist, OLD.album, OLD.album_artist, OLD.genre, OLD.category, OLD.file);
                INSERT INTO songs_fts(rowid, uuid, title, artist, album, album_artist, genre, category, file)
                VALUES (NEW.rowid, NEW.uuid, NEW.title, NEW.artist, NEW.album, NEW.album_artist, NEW.genre, NEW.category, NEW.file);
            END
        ''')

    # Playlists table
    if 'playlists' not in existing_tables:
        cur.execute('''
            CREATE TABLE playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                is_public INTEGER DEFAULT 0,
                share_token TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cur.execute('CREATE INDEX idx_playlists_user_id ON playlists(user_id)')
        cur.execute('CREATE INDEX idx_playlists_share_token ON playlists(share_token)')

    # Playlist songs table
    if 'playlist_songs' not in existing_tables:
        cur.execute('''
            CREATE TABLE playlist_songs (
                playlist_id INTEGER NOT NULL,
                song_uuid TEXT NOT NULL,
                position INTEGER NOT NULL,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (playlist_id, position),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE
            )
        ''')
        cur.execute('CREATE INDEX idx_playlist_songs_song ON playlist_songs(song_uuid)')

    # User queue table
    if 'user_queue' not in existing_tables:
        cur.execute('''
            CREATE TABLE user_queue (
                user_id TEXT NOT NULL,
                song_uuid TEXT NOT NULL,
                position INTEGER NOT NULL,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, position),
                FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE
            )
        ''')
        cur.execute('CREATE INDEX idx_user_queue_user ON user_queue(user_id)')

    # User playback state table
    if 'user_playback_state' not in existing_tables:
        cur.execute('''
            CREATE TABLE user_playback_state (
                user_id TEXT PRIMARY KEY,
                queue_index INTEGER DEFAULT 0,
                sca_enabled INTEGER DEFAULT 0,
                play_mode TEXT DEFAULT 'sequential',
                volume REAL DEFAULT 1.0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                active_device_id TEXT,
                active_device_seq INTEGER DEFAULT 0
            )
        ''')
    else:
        # Migration: add device tracking columns
        cur.execute("PRAGMA table_info(user_playback_state)")
        columns = {row[1] for row in cur.fetchall()}
        if 'active_device_id' not in columns:
            cur.execute("ALTER TABLE user_playback_state ADD COLUMN active_device_id TEXT")
        if 'active_device_seq' not in columns:
            cur.execute("ALTER TABLE user_playback_state ADD COLUMN active_device_seq INTEGER DEFAULT 0")

    # Per-device sequence numbers for queue index updates
    if 'device_queue_seqs' not in existing_tables:
        cur.execute('''
            CREATE TABLE device_queue_seqs (
                user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                seq INTEGER DEFAULT 0,
                PRIMARY KEY (user_id, device_id)
            )
        ''')

    # Play history table
    if 'play_history' not in existing_tables:
        cur.execute('''
            CREATE TABLE play_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                song_uuid TEXT NOT NULL,
                played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                play_duration_seconds INTEGER,
                skipped INTEGER DEFAULT 0,
                source TEXT,
                FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE
            )
        ''')
        cur.execute('CREATE INDEX idx_play_history_user ON play_history(user_id)')
        cur.execute('CREATE INDEX idx_play_history_time ON play_history(played_at)')

    # User preferences table
    if 'user_preferences' not in existing_tables:
        cur.execute('''
            CREATE TABLE user_preferences (
                user_id TEXT PRIMARY KEY,
                volume REAL DEFAULT 1.0,
                shuffle INTEGER DEFAULT 0,
                repeat_mode TEXT DEFAULT 'none',
                radio_eopp INTEGER DEFAULT 0,
                dark_mode INTEGER DEFAULT 1,
                replay_gain_mode TEXT DEFAULT 'off',
                replay_gain_preamp REAL DEFAULT 0.0,
                replay_gain_fallback REAL DEFAULT 0.0
            )
        ''')

    # EQ presets table
    if 'eq_presets' not in existing_tables:
        cur.execute('''
            CREATE TABLE eq_presets (
                uuid TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                bands TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cur.execute('CREATE INDEX idx_eq_presets_user ON eq_presets(user_id)')

    # Tags table
    if 'tags' not in existing_tables:
        cur.execute('''
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#808080',
                UNIQUE(user_id, name)
            )
        ''')
        cur.execute('CREATE INDEX idx_tags_user ON tags(user_id)')

    # Song tags table
    if 'song_tags' not in existing_tables:
        cur.execute('''
            CREATE TABLE song_tags (
                song_uuid TEXT NOT NULL,
                tag_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                PRIMARY KEY (song_uuid, tag_id),
                FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            )
        ''')

    # Pending sync operations table
    if 'pending_sync_ops' not in existing_tables:
        cur.execute('''
            CREATE TABLE pending_sync_ops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                op_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_id, seq)
            )
        ''')
        cur.execute('CREATE INDEX idx_pending_sync_user ON pending_sync_ops(user_id)')

    # SCA song pool table
    if 'sca_song_pool' not in existing_tables:
        cur.execute('''
            CREATE TABLE sca_song_pool (
                user_id TEXT NOT NULL,
                song_uuid TEXT NOT NULL,
                PRIMARY KEY (user_id, song_uuid),
                FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE
            )
        ''')

    # Radio sessions table
    if 'radio_sessions' not in existing_tables:
        cur.execute('''
            CREATE TABLE radio_sessions (
                session_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                filter_query TEXT,
                seed_uuid TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cur.execute('CREATE INDEX idx_radio_sessions_user ON radio_sessions(user_id)')

    # Radio queue table
    if 'radio_queue' not in existing_tables:
        cur.execute('''
            CREATE TABLE radio_queue (
                session_id TEXT NOT NULL,
                song_uuid TEXT NOT NULL,
                position INTEGER NOT NULL,
                played INTEGER DEFAULT 0,
                PRIMARY KEY (session_id, position),
                FOREIGN KEY (session_id) REFERENCES radio_sessions(session_id) ON DELETE CASCADE,
                FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE
            )
        ''')

    # Scan tasks table (new for standalone)
    if 'scan_tasks' not in existing_tables:
        cur.execute('''
            CREATE TABLE scan_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT DEFAULT 'pending',
                paths TEXT NOT NULL,
                total_files INTEGER DEFAULT 0,
                processed_files INTEGER DEFAULT 0,
                new_songs INTEGER DEFAULT 0,
                updated_songs INTEGER DEFAULT 0,
                errors TEXT,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

    # Migration: rename duration to duration_seconds in songs table
    if 'songs' in existing_tables:
        cur.execute("PRAGMA table_info(songs)")
        columns = {row[1] for row in cur.fetchall()}
        if 'duration' in columns and 'duration_seconds' not in columns:
            cur.execute("ALTER TABLE songs RENAME COLUMN duration TO duration_seconds")

    # Migration: add key and bpm columns to songs table
    if 'songs' in existing_tables:
        cur.execute("PRAGMA table_info(songs)")
        columns = {row[1] for row in cur.fetchall()}
        if 'key' not in columns:
            cur.execute("ALTER TABLE songs ADD COLUMN key TEXT")
        if 'bpm' not in columns:
            cur.execute("ALTER TABLE songs ADD COLUMN bpm REAL")

    # Migration: fix radio_sessions schema (change from INTEGER id to TEXT session_id)
    if 'radio_sessions' in existing_tables:
        cur.execute("PRAGMA table_info(radio_sessions)")
        columns = {row[1] for row in cur.fetchall()}
        # Check if using old schema (has 'id' column instead of 'session_id')
        if 'id' in columns and 'session_id' not in columns:
            # Drop old tables and recreate with correct schema
            cur.execute("DROP TABLE IF EXISTS radio_queue")
            cur.execute("DROP TABLE IF EXISTS radio_sessions")
            cur.execute('''
                CREATE TABLE radio_sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    filter_query TEXT,
                    seed_uuid TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            cur.execute('CREATE INDEX idx_radio_sessions_user ON radio_sessions(user_id)')
            cur.execute('''
                CREATE TABLE radio_queue (
                    session_id TEXT NOT NULL,
                    song_uuid TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    played INTEGER DEFAULT 0,
                    PRIMARY KEY (session_id, position),
                    FOREIGN KEY (session_id) REFERENCES radio_sessions(session_id) ON DELETE CASCADE,
                    FOREIGN KEY (song_uuid) REFERENCES songs(uuid) ON DELETE CASCADE
                )
            ''')

    # Add missing indexes if tables exist
    _create_index_if_not_exists(cur, 'idx_playlists_public', 'playlists', 'is_public')
    _create_index_if_not_exists(cur, 'idx_play_history_song', 'play_history', 'song_uuid')
    _create_index_if_not_exists(cur, 'idx_user_queue_user', 'user_queue', 'user_id')


def _create_index_if_not_exists(cur, index_name, table_name, columns):
    """Create an index if it doesn't already exist."""
    cur.execute("SELECT name FROM sqlite_master WHERE type='index' AND name=?", (index_name,))
    if not cur.fetchone():
        try:
            cur.execute(f"CREATE INDEX {index_name} ON {table_name}({columns})")
        except Exception:
            pass  # Table might not exist yet


def row_to_dict(row):
    """Convert a sqlite3.Row to a dictionary."""
    if row is None:
        return None
    return dict(row)


def rows_to_list(rows):
    """Convert a list of sqlite3.Row to a list of dictionaries."""
    return [dict(row) for row in rows]

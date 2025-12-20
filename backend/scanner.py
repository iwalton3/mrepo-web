"""
Music file scanner for mrepo.

Scans directories for audio files and extracts metadata using mutagen.
"""

import os
import hashlib
import uuid as uuid_module
from pathlib import Path
from datetime import datetime

from mutagen import File as MutagenFile
from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.mp4 import MP4
from mutagen.wave import WAVE

from .db import get_db


# Supported audio file extensions
AUDIO_EXTENSIONS = {
    # Common formats
    '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.wma', '.webm',
    # Tracker/module formats
    '.mod', '.xm', '.s3m', '.it', '.stm', '.med', '.mtm', '.ult', '.wow',
    '.669', '.far', '.okt', '.ptm', '.dmf', '.dsm', '.amf', '.gdm', '.imf',
    '.j2b', '.mdl', '.mt2', '.psm', '.umx',
}

# Formats that can't seek (must be transcoded)
NON_SEEKABLE_FORMATS = {
    '.mod', '.xm', '.s3m', '.it', '.stm', '.med', '.mtm', '.ult', '.wow',
    '.669', '.far', '.okt', '.ptm', '.dmf', '.dsm', '.amf', '.gdm', '.imf',
    '.j2b', '.mdl', '.mt2', '.psm', '.umx',
}


def generate_uuid(file_path):
    """Generate a deterministic UUID from file path."""
    # Use MD5 of the path for a stable, reproducible UUID
    path_hash = hashlib.md5(str(file_path).encode('utf-8')).hexdigest()
    return path_hash[:8] + '-' + path_hash[8:12] + '-' + path_hash[12:16] + '-' + path_hash[16:20] + '-' + path_hash[20:32]


def extract_metadata(file_path):
    """Extract metadata from an audio file using mutagen."""
    path = Path(file_path)
    ext = path.suffix.lower()

    metadata = {
        'file': str(file_path),
        'type': ext.lstrip('.'),
        'title': path.stem,  # Default to filename without extension
        'artist': None,
        'album': None,
        'album_artist': None,
        'track_number': None,
        'disc_number': None,
        'year': None,
        'genre': None,
        'category': None,
        'duration_seconds': None,
        'seekable': 0 if ext in NON_SEEKABLE_FORMATS else 1,
        'replay_gain_track': None,
        'replay_gain_album': None,
        'key': None,
        'bpm': None,
    }

    try:
        audio = MutagenFile(file_path, easy=True)

        if audio is None:
            # Mutagen couldn't identify the file
            return metadata

        # Duration
        if hasattr(audio, 'info') and hasattr(audio.info, 'length'):
            metadata['duration_seconds'] = audio.info.length

        # Tags (handle different tag formats)
        if hasattr(audio, 'tags') and audio.tags:
            tags = audio.tags

            # MP3 with ID3
            if isinstance(tags, dict) or hasattr(tags, 'get'):
                metadata['title'] = _get_tag(tags, 'title', metadata['title'])
                metadata['artist'] = _get_tag(tags, 'artist')
                metadata['album'] = _get_tag(tags, 'album')
                metadata['album_artist'] = _get_tag(tags, 'albumartist') or _get_tag(tags, 'album_artist')
                metadata['genre'] = _get_tag(tags, 'genre')
                metadata['year'] = _parse_year(_get_tag(tags, 'date') or _get_tag(tags, 'year'))

                # Track number
                track = _get_tag(tags, 'tracknumber')
                if track:
                    metadata['track_number'] = _parse_track_number(track)

                # Disc number
                disc = _get_tag(tags, 'discnumber')
                if disc:
                    metadata['disc_number'] = _parse_track_number(disc)

                # Replay gain
                rg_track = _get_tag(tags, 'replaygain_track_gain')
                if rg_track:
                    metadata['replay_gain_track'] = _parse_replay_gain(rg_track)

                rg_album = _get_tag(tags, 'replaygain_album_gain')
                if rg_album:
                    metadata['replay_gain_album'] = _parse_replay_gain(rg_album)

                # Key (musical key)
                key = _get_tag(tags, 'initialkey') or _get_tag(tags, 'key')
                if key:
                    metadata['key'] = key

                # BPM
                bpm = _get_tag(tags, 'bpm') or _get_tag(tags, 'tempo')
                if bpm:
                    metadata['bpm'] = _parse_bpm(bpm)

        # M4A/AAC specific handling
        if ext in ('.m4a', '.aac', '.mp4') and isinstance(audio, MP4):
            tags = audio.tags or {}
            metadata['title'] = _get_mp4_tag(tags, '\xa9nam', metadata['title'])
            metadata['artist'] = _get_mp4_tag(tags, '\xa9ART')
            metadata['album'] = _get_mp4_tag(tags, '\xa9alb')
            metadata['album_artist'] = _get_mp4_tag(tags, 'aART')
            metadata['genre'] = _get_mp4_tag(tags, '\xa9gen')
            metadata['year'] = _parse_year(_get_mp4_tag(tags, '\xa9day'))

            track = tags.get('trkn')
            if track and isinstance(track, list) and len(track) > 0:
                metadata['track_number'] = track[0][0] if isinstance(track[0], tuple) else track[0]

            disc = tags.get('disk')
            if disc and isinstance(disc, list) and len(disc) > 0:
                metadata['disc_number'] = disc[0][0] if isinstance(disc[0], tuple) else disc[0]

    except Exception as e:
        # If metadata extraction fails, return defaults
        pass

    return metadata


def _get_tag(tags, key, default=None):
    """Get a tag value, handling list values."""
    if hasattr(tags, 'get'):
        value = tags.get(key)
    elif hasattr(tags, '__getitem__'):
        try:
            value = tags[key]
        except (KeyError, IndexError):
            value = None
    else:
        value = None

    if value is None:
        return default

    if isinstance(value, list):
        return value[0] if value else default

    return str(value) if value else default


def _get_mp4_tag(tags, key, default=None):
    """Get an MP4/M4A tag value."""
    value = tags.get(key)
    if value is None:
        return default
    if isinstance(value, list):
        return str(value[0]) if value else default
    return str(value) if value else default


def _parse_year(value):
    """Parse year from various date formats."""
    if not value:
        return None
    try:
        # Handle YYYY-MM-DD format
        if '-' in str(value):
            return int(str(value).split('-')[0])
        return int(value)
    except (ValueError, TypeError):
        return None


def _parse_track_number(value):
    """Parse track number from various formats (e.g., "1/12")."""
    if not value:
        return None
    try:
        # Handle "1/12" format
        if '/' in str(value):
            return int(str(value).split('/')[0])
        return int(value)
    except (ValueError, TypeError):
        return None


def _parse_replay_gain(value):
    """Parse replay gain value (e.g., "-3.5 dB")."""
    if not value:
        return None
    try:
        # Remove " dB" suffix
        value = str(value).replace(' dB', '').replace('dB', '')
        return float(value)
    except (ValueError, TypeError):
        return None


def _parse_bpm(value):
    """Parse BPM value."""
    if not value:
        return None
    try:
        bpm = float(str(value).strip())
        # Sanity check - BPM should be between 1 and 999
        if 1 <= bpm <= 999:
            return bpm
        return None
    except (ValueError, TypeError):
        return None


def get_category_for_path(file_path, base_path):
    """Determine category for a file by checking for .category files.

    Walks up the directory tree from the file's directory to the base path,
    looking for .category files. The nearest .category file wins.
    If no .category file is found, returns 'default'.

    Args:
        file_path: Path to the audio file
        base_path: Base media path being scanned

    Returns:
        Category name string
    """
    current_dir = file_path.parent

    # Walk up from file's directory to base_path
    while current_dir >= base_path:
        category_file = current_dir / '.category'
        if category_file.exists():
            try:
                category = category_file.read_text().strip()
                if category:
                    return category
            except Exception:
                pass

        if current_dir == base_path:
            break
        current_dir = current_dir.parent

    return 'default'


def scan_paths(paths, task_id=None):
    """Scan directories for audio files and import them to the database.

    Args:
        paths: List of directory paths to scan
        task_id: Optional task ID for progress tracking

    Returns:
        dict with total, processed, new, updated counts
    """
    conn = get_db()
    cur = conn.cursor()

    total_files = 0
    processed = 0
    new_songs = 0
    updated_songs = 0

    # First pass: count files
    for base_path in paths:
        base_path = Path(base_path)
        if not base_path.exists():
            continue

        for file_path in base_path.rglob('*'):
            if file_path.suffix.lower() in AUDIO_EXTENSIONS:
                # Skip broken symlinks
                if not file_path.exists():
                    continue
                total_files += 1

    # Update task with total
    if task_id:
        cur.execute("UPDATE scan_tasks SET total_files = ? WHERE id = ?",
                   (total_files, task_id))
        conn.commit()

    # Second pass: process files
    for base_path in paths:
        base_path = Path(base_path)
        if not base_path.exists():
            continue

        for file_path in base_path.rglob('*'):
            if file_path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue

            # Skip broken symlinks
            if not file_path.exists():
                continue

            file_str = str(file_path)
            file_uuid = generate_uuid(file_str)

            # Check if file already exists - first by UUID, then by file path
            # (file path check handles database moved to new location)
            cur.execute("SELECT uuid, modified_at FROM songs WHERE uuid = ?", (file_uuid,))
            existing = cur.fetchone()
            existing_uuid = file_uuid  # UUID to use for updates

            if not existing:
                # UUID didn't match - check by file path for relocated databases
                cur.execute("SELECT uuid, modified_at FROM songs WHERE file = ?", (file_str,))
                existing = cur.fetchone()
                if existing:
                    # Use the existing UUID from the database
                    existing_uuid = existing['uuid']

            # Get file modification time
            file_mtime = datetime.fromtimestamp(file_path.stat().st_mtime)

            if existing:
                # Check if file has been modified
                if existing['modified_at']:
                    existing_mtime = datetime.fromisoformat(existing['modified_at'])
                    if file_mtime <= existing_mtime:
                        # File hasn't changed, skip
                        processed += 1
                        continue

            # Extract metadata
            metadata = extract_metadata(file_path)
            metadata['uuid'] = existing_uuid  # Use existing UUID if found by path
            metadata['modified_at'] = file_mtime.isoformat()
            metadata['size'] = file_path.stat().st_size

            # Determine category from .category files or use 'default'
            metadata['category'] = get_category_for_path(file_path, base_path)

            if existing:
                # Update existing record
                cur.execute("""
                    UPDATE songs SET
                        file = ?, title = ?, artist = ?, album = ?, album_artist = ?,
                        track_number = ?, disc_number = ?, year = ?, genre = ?,
                        category = ?, duration_seconds = ?, type = ?, seekable = ?,
                        size = ?, modified_at = ?, replay_gain_track = ?, replay_gain_album = ?,
                        key = ?, bpm = ?
                    WHERE uuid = ?
                """, (
                    metadata['file'], metadata['title'], metadata['artist'],
                    metadata['album'], metadata['album_artist'], metadata['track_number'],
                    metadata['disc_number'], metadata['year'], metadata['genre'],
                    metadata['category'], metadata['duration_seconds'], metadata['type'],
                    metadata['seekable'], metadata['size'], metadata['modified_at'],
                    metadata['replay_gain_track'], metadata['replay_gain_album'],
                    metadata['key'], metadata['bpm'],
                    existing_uuid
                ))
                updated_songs += 1
            else:
                # Insert new record
                cur.execute("""
                    INSERT INTO songs (
                        uuid, file, title, artist, album, album_artist,
                        track_number, disc_number, year, genre, category,
                        duration_seconds, type, seekable, size, modified_at,
                        replay_gain_track, replay_gain_album, key, bpm
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    file_uuid, metadata['file'], metadata['title'], metadata['artist'],
                    metadata['album'], metadata['album_artist'], metadata['track_number'],
                    metadata['disc_number'], metadata['year'], metadata['genre'],
                    metadata['category'], metadata['duration_seconds'], metadata['type'],
                    metadata['seekable'], metadata['size'], metadata['modified_at'],
                    metadata['replay_gain_track'], metadata['replay_gain_album'],
                    metadata['key'], metadata['bpm']
                ))
                new_songs += 1

            processed += 1

            # Update progress periodically
            if task_id and processed % 100 == 0:
                cur.execute("""
                    UPDATE scan_tasks SET processed_files = ?, new_songs = ?, updated_songs = ?
                    WHERE id = ?
                """, (processed, new_songs, updated_songs, task_id))
                conn.commit()

    return {
        'total': total_files,
        'processed': processed,
        'new': new_songs,
        'updated': updated_songs
    }


def remove_missing_songs(paths):
    """Remove songs from database that no longer exist on disk.

    Args:
        paths: List of base paths to check

    Returns:
        Number of songs removed
    """
    conn = get_db()
    cur = conn.cursor()

    # Get all songs
    cur.execute("SELECT uuid, file FROM songs")
    songs = cur.fetchall()

    removed = 0
    for song in songs:
        file_path = Path(song['file'])

        # Check if file exists (either absolute or relative to any base path)
        exists = file_path.exists()

        if not exists:
            for base_path in paths:
                if (Path(base_path) / file_path).exists():
                    exists = True
                    break

        if not exists:
            cur.execute("DELETE FROM songs WHERE uuid = ?", (song['uuid'],))
            removed += 1

    return removed

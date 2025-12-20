"""
Audio streaming and transcoding for mrepo.

Handles direct file streaming with Range request support,
and FFmpeg-based transcoding for tracker formats.
"""

import mimetypes
import os
import subprocess
from pathlib import Path

from flask import Blueprint, Response, abort, request, current_app, send_file

from .db import get_db


bp = Blueprint('stream', __name__)


# Formats that require transcoding (tracker/module formats)
TRANSCODE_FORMATS = {
    'mod', 'xm', 's3m', 'it', 'stm', 'med', 'mtm', 'ult', 'wow',
    '669', 'far', 'okt', 'ptm', 'dmf', 'dsm', 'amf', 'gdm', 'imf',
    'j2b', 'mdl', 'mt2', 'psm', 'umx'
}

# MIME types for common audio formats
MIME_TYPES = {
    'mp3': 'audio/mpeg',
    'flac': 'audio/flac',
    'ogg': 'audio/ogg',
    'opus': 'audio/opus',
    'wav': 'audio/wav',
    'wave': 'audio/wav',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'wma': 'audio/x-ms-wma',
    'webm': 'audio/webm',
}

# Cache FFmpeg availability
_ffmpeg_available = None


def ffmpeg_available():
    """Check if FFmpeg is available on the system."""
    global _ffmpeg_available

    if _ffmpeg_available is None:
        ffmpeg_path = current_app.config.get('FFMPEG_PATH', 'ffmpeg')
        try:
            result = subprocess.run(
                [ffmpeg_path, '-version'],
                capture_output=True,
                timeout=5
            )
            _ffmpeg_available = result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            _ffmpeg_available = False

    return _ffmpeg_available


def get_mime_type(ext):
    """Get MIME type for a file extension."""
    ext = ext.lower().lstrip('.')
    if ext in MIME_TYPES:
        return MIME_TYPES[ext]
    # Fall back to mimetypes module
    mime, _ = mimetypes.guess_type(f'file.{ext}')
    return mime or 'audio/mpeg'


@bp.route('/stream/<uuid>')
def stream_audio(uuid):
    """Stream an audio file by UUID.

    Supports:
    - Direct streaming for native browser formats with Range requests
    - FFmpeg transcoding for tracker formats (if FFmpeg available)
    """
    db = get_db()
    cur = db.cursor()
    cur.execute('SELECT file, type FROM songs WHERE uuid = ?', (uuid,))
    song = cur.fetchone()

    if not song:
        abort(404)

    # Get the file path from database
    file_path = Path(song['file'])

    # If path is relative, try to resolve against media paths
    if not file_path.is_absolute():
        for media_path in current_app.config.get('MEDIA_PATHS', []):
            candidate = Path(media_path) / file_path
            if candidate.exists():
                file_path = candidate
                break

    if not file_path.exists():
        current_app.logger.error(f'Audio file not found: {file_path}')
        abort(404)

    # Get file extension
    ext = (song['type'] or file_path.suffix).lower().lstrip('.')

    # Check if transcoding is needed
    if ext in TRANSCODE_FORMATS:
        if ffmpeg_available():
            return transcode_stream(file_path)
        else:
            # Can't play without transcoding
            abort(415)  # Unsupported Media Type

    # Direct streaming with Range support
    return stream_file(file_path, ext)


@bp.route('/stream/<uuid>.<ext>')
def stream_audio_with_ext(uuid, ext):
    """Stream audio with explicit extension (for cache-busting)."""
    return stream_audio(uuid)


def stream_file(file_path, ext):
    """Stream a file with HTTP Range request support."""
    file_size = file_path.stat().st_size
    mime_type = get_mime_type(ext)

    range_header = request.headers.get('Range')

    if range_header:
        # Parse range header
        byte_range = parse_range_header(range_header, file_size)
        if byte_range:
            start, end = byte_range
            length = end - start + 1

            def generate():
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk_size = min(8192, remaining)
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            return Response(
                generate(),
                status=206,
                mimetype=mime_type,
                headers={
                    'Content-Range': f'bytes {start}-{end}/{file_size}',
                    'Accept-Ranges': 'bytes',
                    'Content-Length': length,
                    'Cache-Control': 'no-cache',
                }
            )

    # Full file response
    return send_file(
        file_path,
        mimetype=mime_type,
        as_attachment=False,
        conditional=True
    )


def parse_range_header(range_header, file_size):
    """Parse HTTP Range header.

    Returns (start, end) tuple or None if invalid.
    """
    if not range_header.startswith('bytes='):
        return None

    range_spec = range_header[6:]

    try:
        if range_spec.startswith('-'):
            # Suffix range: -500 means last 500 bytes
            suffix_length = int(range_spec[1:])
            start = max(0, file_size - suffix_length)
            end = file_size - 1
        elif range_spec.endswith('-'):
            # Open-ended range: 500- means from byte 500 to end
            start = int(range_spec[:-1])
            end = file_size - 1
        else:
            # Specific range: 500-999
            parts = range_spec.split('-')
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else file_size - 1

        # Validate
        if start < 0 or start >= file_size:
            return None
        if end < start or end >= file_size:
            end = file_size - 1

        return (start, end)
    except (ValueError, IndexError):
        return None


def transcode_stream(file_path):
    """Transcode a file to MP3 and stream it.

    Used for tracker formats that browsers can't play natively.
    """
    ffmpeg_path = current_app.config.get('FFMPEG_PATH', 'ffmpeg')
    bitrate = current_app.config.get('TRANSCODE_BITRATE', '320k')

    def generate():
        process = subprocess.Popen(
            [
                ffmpeg_path,
                '-i', str(file_path),
                '-f', 'mp3',
                '-ab', bitrate,
                '-vn',  # No video
                '-y',   # Overwrite
                '-'     # Output to stdout
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL
        )

        try:
            while True:
                chunk = process.stdout.read(8192)
                if not chunk:
                    break
                yield chunk
        finally:
            process.terminate()
            process.wait()

    return Response(
        generate(),
        mimetype='audio/mpeg',
        headers={
            'Content-Disposition': 'inline',
            'Accept-Ranges': 'none',  # No seeking for transcoded streams
            'Cache-Control': 'no-cache',
        }
    )

#!/usr/bin/env python3
"""
CLAP Music Analyzer for mrepo

Analyzes music using LAION's CLAP model and stores embeddings in FAISS
for fast similarity search.
"""

import sqlite3
import subprocess
import os
from pathlib import Path
from datetime import datetime

import numpy as np

# Lazy imports for heavy dependencies
faiss = None
laion_clap = None
torch = None

# Configurable paths via environment variables
MUSIC_DB = Path(os.environ.get('MUSIC_DB', '/data/mrepo.db'))
MEDIA_PATH = Path(os.environ.get('MEDIA_PATH', '/music'))
EMBEDDINGS_PATH = Path(os.environ.get('EMBEDDINGS_PATH', '/data/ai'))
EMBEDDINGS_FAISS = EMBEDDINGS_PATH / 'clap_embeddings.faiss'
METADATA_DB = EMBEDDINGS_PATH / 'clap_metadata.db'

# Supported audio formats
SUPPORTED_FORMATS = {'mp3', 'opus', 'flac', 'wav', 'ogg', 'm4a', 'aac'}

# CLAP model settings
# Default to cache directory (mounted volume in Docker) for persistence
_default_checkpoint = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'mrepo-ai' / 'music_audioset_epoch_15_esc_90.14.pt'
CLAP_CHECKPOINT = os.environ.get('CLAP_CHECKPOINT', str(_default_checkpoint))
CLAP_CHECKPOINT_URL = 'https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt'
CLAP_MODEL_VERSION = 'music_audioset_v1'
EMBEDDING_DIM = 512
SAMPLE_RATE = 48000

# Batch settings
SAVE_INTERVAL = 100
DEFAULT_BATCH_SIZE = 4
DEFAULT_NUM_SEGMENTS = 3
SEGMENT_DURATION = 10
MAX_SEGMENTS_PER_BATCH = 16


def lazy_import_faiss():
    """Lazy import faiss to avoid loading when not needed."""
    global faiss
    if faiss is None:
        import faiss as _faiss
        faiss = _faiss
    return faiss


def lazy_import_clap():
    """Lazy import laion_clap to avoid loading when not needed."""
    global laion_clap
    if laion_clap is None:
        import laion_clap as _laion_clap
        laion_clap = _laion_clap
    return laion_clap


def lazy_import_torch():
    """Lazy import torch to avoid loading when not needed."""
    global torch
    if torch is None:
        import torch as _torch
        torch = _torch
    return torch


def ensure_checkpoint_exists():
    """Download CLAP checkpoint if it doesn't exist."""
    checkpoint_path = Path(CLAP_CHECKPOINT)
    if checkpoint_path.exists():
        return

    print(f"CLAP checkpoint not found at {checkpoint_path}")
    print(f"Downloading from {CLAP_CHECKPOINT_URL}...")

    # Create parent directory if needed
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)

    import urllib.request
    import shutil

    # Download with progress
    temp_path = checkpoint_path.with_suffix('.tmp')
    try:
        with urllib.request.urlopen(CLAP_CHECKPOINT_URL) as response:
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            block_size = 8192

            with open(temp_path, 'wb') as f:
                while True:
                    chunk = response.read(block_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        pct = (downloaded / total_size) * 100
                        print(f"\rDownloading: {downloaded / 1024 / 1024:.1f} MB / {total_size / 1024 / 1024:.1f} MB ({pct:.1f}%)", end='', flush=True)

        print()  # New line after progress
        shutil.move(str(temp_path), str(checkpoint_path))
        print(f"Downloaded CLAP checkpoint to {checkpoint_path}")
    except Exception as e:
        if temp_path.exists():
            temp_path.unlink()
        raise RuntimeError(f"Failed to download CLAP checkpoint: {e}")


def get_device(device_arg):
    """Determine the device to use (cuda/cpu)."""
    lazy_import_torch()
    if device_arg == 'auto':
        if torch.cuda.is_available():
            device = 'cuda'
            print(f"CUDA available: {torch.cuda.get_device_name(0)}")
        else:
            device = 'cpu'
            print("CUDA not available, using CPU")
    else:
        device = device_arg
        if device == 'cuda' and not torch.cuda.is_available():
            print("Warning: CUDA requested but not available, falling back to CPU")
            device = 'cpu'
    return device


class CLAPAnalyzer:
    """Analyzes music using CLAP and stores embeddings in FAISS."""

    def __init__(self, device='auto', num_segments=DEFAULT_NUM_SEGMENTS):
        self.model = None
        self.faiss_index = None
        self.metadata_conn = None
        self.model_version = CLAP_MODEL_VERSION
        self.device = get_device(device)
        self.num_segments = num_segments

    def load_model(self):
        """Load CLAP model lazily and move to GPU if available."""
        if self.model is not None:
            return

        # Download checkpoint if needed
        ensure_checkpoint_exists()

        print(f"Loading CLAP model ({CLAP_CHECKPOINT}) on {self.device}...")
        clap = lazy_import_clap()
        lazy_import_torch()

        self.model = clap.CLAP_Module(
            enable_fusion=False,
            amodel='HTSAT-base',
            device=self.device
        )
        self.model.load_ckpt(ckpt=CLAP_CHECKPOINT)
        print(f"CLAP model loaded on {self.device}")

    def init_storage(self, update=False):
        """Initialize FAISS index and metadata database."""
        lazy_import_faiss()

        # Ensure embeddings directory exists
        EMBEDDINGS_PATH.mkdir(parents=True, exist_ok=True)

        # Initialize metadata database (for writes during analysis)
        # Read operations use get_metadata_db() for thread-safety
        self.metadata_conn = sqlite3.connect(str(METADATA_DB))
        self.metadata_conn.row_factory = sqlite3.Row
        self._ensure_metadata_tables()

        # Load or create FAISS index
        if update and EMBEDDINGS_FAISS.exists():
            print(f"Loading existing FAISS index from {EMBEDDINGS_FAISS}")
            self.faiss_index = faiss.read_index(str(EMBEDDINGS_FAISS))
            print(f"Loaded index with {self.faiss_index.ntotal} embeddings")
        else:
            print("Creating new FAISS index")
            self.faiss_index = faiss.IndexFlatIP(EMBEDDING_DIM)

    def _ensure_metadata_tables(self):
        """Create metadata tables if they don't exist."""
        self.metadata_conn.executescript('''
            CREATE TABLE IF NOT EXISTS embeddings (
                id INTEGER PRIMARY KEY,
                uuid TEXT UNIQUE NOT NULL,
                embedding_version TEXT,
                analyzed_at TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_embeddings_uuid ON embeddings(uuid);
        ''')
        self.metadata_conn.commit()

    def get_music_db(self):
        """Get connection to main music database."""
        conn = sqlite3.connect(str(MUSIC_DB), timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def get_metadata_db(self):
        """Get thread-safe connection to metadata database for reads."""
        conn = sqlite3.connect(str(METADATA_DB), timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def get_all_songs(self):
        """Query music.db for all songs with supported formats."""
        conn = self.get_music_db()
        cur = conn.cursor()

        placeholders = ','.join('?' * len(SUPPORTED_FORMATS))
        cur.execute(f'''
            SELECT uuid, title, artist, album, type, category, file
            FROM songs
            WHERE type IN ({placeholders})
            ORDER BY category, artist, album, track_number
        ''', list(SUPPORTED_FORMATS))

        songs = [dict(row) for row in cur.fetchall()]
        conn.close()
        return songs

    def get_analyzed_uuids(self):
        """Get set of already-analyzed song UUIDs."""
        conn = self.get_metadata_db()
        cur = conn.cursor()
        cur.execute('SELECT uuid FROM embeddings WHERE embedding_version = ?',
                    (self.model_version,))
        result = {row['uuid'] for row in cur.fetchall()}
        conn.close()
        return result

    def get_audio_path(self, song):
        """Get the audio file path for a song."""
        # Use the file path from the database
        return Path(song['file'])

    def get_audio_duration(self, audio_path):
        """Get audio duration in seconds using ffprobe."""
        cmd = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            str(audio_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffprobe error: {result.stderr}")
        return float(result.stdout.strip())

    def load_audio_segment(self, audio_path, start_time=0, duration=None):
        """Load a segment of audio starting at start_time."""
        cmd = ['ffmpeg']
        if start_time > 0:
            cmd.extend(['-ss', str(start_time)])
        cmd.extend(['-i', str(audio_path)])
        if duration:
            cmd.extend(['-t', str(duration)])
        cmd.extend([
            '-f', 'f32le',
            '-acodec', 'pcm_f32le',
            '-ar', str(SAMPLE_RATE),
            '-ac', '1',
            '-v', 'error',
            '-'
        ])
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg error: {result.stderr.decode()}")

        audio = np.frombuffer(result.stdout, dtype=np.float32)
        return audio

    def load_audio_segments(self, audio_path, num_segments=DEFAULT_NUM_SEGMENTS, segment_duration=SEGMENT_DURATION):
        """Load multiple segments from different parts of the song."""
        duration = self.get_audio_duration(audio_path)

        if duration <= segment_duration:
            return [self.load_audio_segment(audio_path)]

        end_buffer = min(10, duration * 0.1)
        usable_duration = duration - end_buffer

        if num_segments == 1:
            positions = [0]
        elif num_segments == 2:
            positions = [0, usable_duration / 2]
        else:
            positions = [
                0,
                usable_duration / 2,
                max(0, usable_duration - segment_duration)
            ]

        segments = []
        for pos in positions[:num_segments]:
            try:
                segment = self.load_audio_segment(audio_path, start_time=pos, duration=segment_duration)
                if len(segment) > 0:
                    segments.append(segment)
            except Exception:
                continue

        return segments if segments else [self.load_audio_segment(audio_path, duration=segment_duration)]

    def load_audio(self, audio_path):
        """Load audio file - returns list of segments for multi-segment analysis."""
        return self.load_audio_segments(audio_path, num_segments=self.num_segments)

    def analyze_audio(self, audio_path):
        """Load audio and extract CLAP embedding (single file, multi-segment)."""
        segments = self.load_audio(audio_path)

        embeddings = self.model.get_audio_embedding_from_data(
            segments,
            use_tensor=False
        )

        avg_embedding = np.mean(embeddings, axis=0)
        avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)
        return avg_embedding

    def add_embedding(self, uuid, embedding):
        """Add embedding to FAISS index and record in metadata."""
        idx = self.faiss_index.ntotal
        self.faiss_index.add(embedding.reshape(1, -1).astype('float32'))

        self.metadata_conn.execute('''
            INSERT OR REPLACE INTO embeddings (id, uuid, embedding_version, analyzed_at)
            VALUES (?, ?, ?, ?)
        ''', (idx, uuid, self.model_version, datetime.now().isoformat()))
        self.metadata_conn.commit()

    def save(self):
        """Persist FAISS index to disk."""
        print(f"Saving FAISS index to {EMBEDDINGS_FAISS}")
        faiss.write_index(self.faiss_index, str(EMBEDDINGS_FAISS))
        print(f"Saved index with {self.faiss_index.ntotal} embeddings")

    def clear(self):
        """Clear all embeddings and reset the index."""
        import os

        # Delete FAISS index file
        if EMBEDDINGS_FAISS.exists():
            os.remove(str(EMBEDDINGS_FAISS))
            print(f"Deleted FAISS index file: {EMBEDDINGS_FAISS}")

        # Clear metadata database
        self.metadata_conn.execute('DELETE FROM embeddings')
        self.metadata_conn.commit()
        print("Cleared metadata database")

        # Also clear any thread-local connections' view
        conn = self.get_metadata_db()
        conn.execute('DELETE FROM embeddings')
        conn.commit()
        conn.close()

        # Create new empty FAISS index
        self.faiss_index = faiss.IndexFlatIP(EMBEDDING_DIM)
        print("Created new empty FAISS index")

        return self.faiss_index.ntotal

    def get_text_embedding(self, query):
        """Get CLAP text embedding for a query."""
        self.load_model()
        embedding = self.model.get_text_embedding([query], use_tensor=False)
        return embedding[0]

    def get_song_embedding(self, uuid):
        """Get the stored embedding for a song by UUID."""
        conn = self.get_metadata_db()
        cur = conn.cursor()
        cur.execute('SELECT id FROM embeddings WHERE uuid = ?', (uuid,))
        row = cur.fetchone()
        conn.close()
        if not row:
            return None

        idx = row['id']
        embedding = self.faiss_index.reconstruct(idx)
        return embedding

    def search(self, query_embedding, k=10):
        """Search FAISS index and return song info."""
        distances, indices = self.faiss_index.search(
            query_embedding.reshape(1, -1).astype('float32'),
            k
        )

        results = []
        conn = self.get_metadata_db()
        cur = conn.cursor()

        for i, (dist, idx) in enumerate(zip(distances[0], indices[0])):
            if idx < 0:
                continue

            cur.execute('SELECT uuid FROM embeddings WHERE id = ?', (int(idx),))
            row = cur.fetchone()
            if row:
                results.append({
                    'uuid': row['uuid'],
                    'score': float(dist),
                    'rank': i + 1
                })

        conn.close()
        return results

    def search_by_text(self, query, k=10):
        """Search by text query."""
        embedding = self.get_text_embedding(query)
        results = self.search(embedding, k)
        return self._enrich_results(results)

    def search_by_audio(self, uuid, k=10):
        """Find songs similar to a given song."""
        embedding = self.get_song_embedding(uuid)
        if embedding is None:
            print(f"Song {uuid} not found in embeddings database")
            return []

        results = self.search(embedding, k + 1)
        results = [r for r in results if r['uuid'] != uuid][:k]
        return self._enrich_results(results)

    def _enrich_results(self, results, min_duration=0):
        """Add song metadata to search results."""
        if not results:
            return results

        conn = self.get_music_db()
        cur = conn.cursor()

        uuids = [r['uuid'] for r in results]
        placeholders = ','.join('?' * len(uuids))
        cur.execute(f'''
            SELECT uuid, title, artist, album, category, duration_seconds
            FROM songs
            WHERE uuid IN ({placeholders})
        ''', uuids)

        metadata = {row['uuid']: dict(row) for row in cur.fetchall()}
        conn.close()

        enriched = []
        for result in results:
            if result['uuid'] in metadata:
                result.update(metadata[result['uuid']])
                duration = result.get('duration_seconds') or 0
                if duration >= min_duration:
                    enriched.append(result)
            else:
                enriched.append(result)

        return enriched

    def generate_playlist_from_prompt(self, prompt, size=25, diversity=0.0, min_duration=30):
        """Generate a playlist from a text prompt."""
        embedding = self.get_text_embedding(prompt)
        return self._generate_playlist_from_embedding(embedding, size, diversity, min_duration=min_duration)

    def generate_playlist_from_seeds(self, seed_uuids, size=25, diversity=0.0, min_duration=30):
        """Generate a playlist from seed song(s)."""
        seed_embeddings = []
        for uuid in seed_uuids:
            emb = self.get_song_embedding(uuid)
            if emb is not None:
                seed_embeddings.append(emb)

        if not seed_embeddings:
            raise ValueError(f"No valid seed songs found in embeddings database. Requested {len(seed_uuids)} seed UUIDs but none have been analyzed. Run AI analysis from admin page first.")

        target_embedding = np.mean(seed_embeddings, axis=0)
        target_embedding = target_embedding / np.linalg.norm(target_embedding)

        results = self._generate_playlist_from_embedding(
            target_embedding, size + len(seed_uuids), diversity,
            exclude_uuids=set(seed_uuids), min_duration=min_duration
        )

        return results[:size]

    def _generate_playlist_from_embedding(self, target_embedding, size, diversity=0.0, exclude_uuids=None, min_duration=30):
        """Generate playlist using embedding similarity with optional diversity (MMR)."""
        exclude_uuids = exclude_uuids or set()

        if diversity <= 0:
            results = self.search(target_embedding, k=(size + len(exclude_uuids)) * 3 + 50)
            results = [r for r in results if r['uuid'] not in exclude_uuids]
            enriched = self._enrich_results(results, min_duration=min_duration)
            return enriched[:size]

        # Use Maximal Marginal Relevance (MMR) for diversity
        lambda_param = 1 - diversity

        n_candidates = min(size * 10, self.faiss_index.ntotal)
        distances, indices = self.faiss_index.search(
            target_embedding.reshape(1, -1).astype('float32'),
            n_candidates
        )

        candidates = []
        meta_conn = self.get_metadata_db()
        cur = meta_conn.cursor()
        music_conn = self.get_music_db()
        music_cur = music_conn.cursor()

        for dist, idx in zip(distances[0], indices[0]):
            if idx < 0:
                continue
            cur.execute('SELECT uuid FROM embeddings WHERE id = ?', (int(idx),))
            row = cur.fetchone()
            if row and row['uuid'] not in exclude_uuids:
                music_cur.execute('SELECT duration_seconds FROM songs WHERE uuid = ?', (row['uuid'],))
                song_row = music_cur.fetchone()
                duration = song_row['duration_seconds'] if song_row else 0
                if duration and duration >= min_duration:
                    emb = self.faiss_index.reconstruct(int(idx))
                    candidates.append({
                        'uuid': row['uuid'],
                        'score': float(dist),
                        'embedding': emb
                    })

        meta_conn.close()
        music_conn.close()

        if not candidates:
            return []

        # MMR selection
        selected = []
        selected_embeddings = []

        while len(selected) < size and candidates:
            best_idx = 0
            best_mmr = float('-inf')

            for i, cand in enumerate(candidates):
                relevance = cand['score']

                if selected_embeddings:
                    similarities = [
                        np.dot(cand['embedding'], sel_emb)
                        for sel_emb in selected_embeddings
                    ]
                    max_sim = max(similarities)
                else:
                    max_sim = 0

                mmr = lambda_param * relevance - (1 - lambda_param) * max_sim

                if mmr > best_mmr:
                    best_mmr = mmr
                    best_idx = i

            best = candidates.pop(best_idx)
            selected.append({
                'uuid': best['uuid'],
                'score': best['score'],
                'rank': len(selected)
            })
            selected_embeddings.append(best['embedding'])

        return self._enrich_results(selected)

    def analyze_songs(self, songs, update=False, callback=None):
        """Analyze a list of songs and add embeddings.

        Args:
            songs: List of song dicts
            update: If True, skip already-analyzed songs
            callback: Optional callback(processed, total) for progress
        """
        self.load_model()

        if update:
            analyzed = self.get_analyzed_uuids()
            songs = [s for s in songs if s['uuid'] not in analyzed]
            if not songs:
                print("All songs already analyzed.")
                return {'processed': 0, 'errors': []}

        print(f"Analyzing {len(songs)} songs (device={self.device})...")
        errors = []
        processed = 0

        for song in songs:
            audio_path = self.get_audio_path(song)
            if not audio_path.exists():
                errors.append((song['uuid'], f"File not found: {audio_path}"))
                continue

            try:
                segments = self.load_audio(audio_path)
                all_embeddings = []

                for i in range(0, len(segments), MAX_SEGMENTS_PER_BATCH):
                    sub_batch = segments[i:i + MAX_SEGMENTS_PER_BATCH]
                    sub_embeddings = self.model.get_audio_embedding_from_data(
                        sub_batch,
                        use_tensor=False
                    )
                    all_embeddings.append(sub_embeddings)

                all_embeddings = np.concatenate(all_embeddings, axis=0)
                avg_embedding = np.mean(all_embeddings, axis=0)
                avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)

                self.add_embedding(song['uuid'], avg_embedding)
                processed += 1

                del segments, all_embeddings
                if self.device == 'cuda':
                    torch.cuda.empty_cache()

                if callback:
                    callback(processed, len(songs))

            except Exception as e:
                errors.append((song['uuid'], str(e)))
                if self.device == 'cuda':
                    torch.cuda.empty_cache()

            if processed > 0 and processed % SAVE_INTERVAL == 0:
                self.save()

        self.save()
        print(f"Processed {processed} songs successfully")

        return {'processed': processed, 'errors': errors}

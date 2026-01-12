#!/usr/bin/env python3
"""
CLAP Microservice for mrepo

FastAPI service providing GPU-accelerated CLAP operations for music similarity search.
Runs as a separate service from the main Flask application.

Usage:
    # Development
    uvicorn service:app --host 127.0.0.1 --port 5002 --reload

    # Production (with gunicorn)
    gunicorn service:app -w 1 -k uvicorn.workers.UvicornWorker --bind 127.0.0.1:5002

Note: Use only 1 worker (-w 1) since the CLAP model is loaded into GPU memory.
"""

import asyncio
import os
import logging
from typing import List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global analyzer instance (singleton)
_analyzer = None
_analyzer_lock = asyncio.Lock()


# Request/Response models
class TextSearchRequest(BaseModel):
    """Request for text-based similarity search."""
    query: str = Field(..., min_length=1, max_length=500)
    k: int = Field(default=50, ge=1, le=2000)
    min_score: float = Field(default=0.2, ge=0.0, le=1.0)
    filter_uuids: Optional[List[str]] = Field(default=None)


class SimilarSearchRequest(BaseModel):
    """Request for finding similar songs."""
    uuid: str
    k: int = Field(default=50, ge=1, le=2000)
    exclude_uuids: List[str] = Field(default_factory=list)
    filter_uuids: Optional[List[str]] = Field(default=None)


class PlaylistGenerateRequest(BaseModel):
    """Request for playlist generation."""
    prompt: Optional[str] = None
    seed_uuids: Optional[List[str]] = None
    size: int = Field(default=30, ge=1, le=10000)
    diversity: float = Field(default=0.2, ge=0.0, le=1.0)
    min_duration: int = Field(default=30, ge=0)
    exclude_uuids: List[str] = Field(default_factory=list)


class BatchSimilarRequest(BaseModel):
    """Request for batch similarity search."""
    uuids: List[str] = Field(..., min_length=1)
    k: int = Field(default=50, ge=1, le=2000)
    exclude_uuids: List[str] = Field(default_factory=list)


class CompoundSearchRequest(BaseModel):
    """Request for compound embedding search with positive/negative terms."""
    positive_texts: List[str] = Field(default_factory=list, max_length=10)
    negative_texts: List[str] = Field(default_factory=list, max_length=10)
    positive_uuids: List[str] = Field(default_factory=list, max_length=100)
    negative_uuids: List[str] = Field(default_factory=list, max_length=100)
    k: int = Field(default=50, ge=1, le=2000)
    min_score: float = Field(default=0.2, ge=0.0, le=1.0)
    neg_weight: float = Field(default=0.5, ge=0.0, le=1.0, description="Weight for negative terms (0.5 = half strength)")
    filter_uuids: Optional[List[str]] = Field(default=None, description="If provided, only return results matching these UUIDs")


class DuplicateCheckRequest(BaseModel):
    """Request for checking duplicates among songs."""
    uuids: List[str] = Field(..., min_length=1, max_length=1000)
    threshold: float = Field(default=0.95, ge=0.5, le=1.0)


class AnalyzeSongItem(BaseModel):
    """Single song to analyze."""
    uuid: str
    path: str


class AnalyzeBatchRequest(BaseModel):
    """Request for batch analysis of songs."""
    songs: List[AnalyzeSongItem] = Field(..., min_length=1, max_length=100)


class AnalyzeBatchResponse(BaseModel):
    """Response from batch analysis."""
    analyzed: List[str]
    errors: List[str]


class CheckAnalyzedRequest(BaseModel):
    """Request to check which UUIDs are analyzed."""
    uuids: List[str] = Field(..., min_length=1, max_length=1000)


class CheckAnalyzedResponse(BaseModel):
    """Response with analyzed status."""
    analyzed_count: int
    total_count: int
    analyzed_uuids: List[str]


class SearchResult(BaseModel):
    """Single search result."""
    uuid: str
    score: float


class SearchResponse(BaseModel):
    """Response containing search results."""
    results: List[SearchResult]


class PlaylistResponse(BaseModel):
    """Response containing generated playlist."""
    songs: List[SearchResult]


class DuplicateGroup(BaseModel):
    """Group of duplicate songs."""
    songs: List[SearchResult]


class DuplicateResponse(BaseModel):
    """Response containing duplicate groups."""
    groups: List[DuplicateGroup]


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    model_loaded: bool
    index_size: int
    device: str


class ClearResponse(BaseModel):
    """Response for clear embeddings operation."""
    success: bool
    cleared: bool
    index_size: int


async def get_analyzer():
    """Get or create the CLAPAnalyzer singleton."""
    global _analyzer

    if _analyzer is not None:
        return _analyzer

    async with _analyzer_lock:
        if _analyzer is not None:
            return _analyzer

        logger.info("Initializing CLAPAnalyzer...")

        from analyzer import CLAPAnalyzer

        loop = asyncio.get_event_loop()

        def init_analyzer():
            analyzer = CLAPAnalyzer(device='auto')
            analyzer.init_storage(update=True)
            analyzer.load_model()
            return analyzer

        _analyzer = await loop.run_in_executor(None, init_analyzer)
        logger.info(f"CLAPAnalyzer initialized with {_analyzer.faiss_index.ntotal} embeddings")

        return _analyzer


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    if os.environ.get('CLAP_PRELOAD', '1') == '1':
        logger.info("Pre-loading CLAP model...")
        await get_analyzer()
    yield
    logger.info("Shutting down CLAP service")


app = FastAPI(
    title="mrepo AI Music Similarity Service",
    description="GPU-accelerated music similarity search using CLAP embeddings",
    version="1.0.0",
    lifespan=lifespan
)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check service health and model status."""
    try:
        analyzer = await get_analyzer()
        return HealthResponse(
            status="ok",
            model_loaded=analyzer.model is not None,
            index_size=analyzer.faiss_index.ntotal if analyzer.faiss_index else 0,
            device=str(analyzer.device) if hasattr(analyzer, 'device') else 'unknown'
        )
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return HealthResponse(
            status="error",
            model_loaded=False,
            index_size=0,
            device="unknown"
        )


@app.post("/clear", response_model=ClearResponse)
async def clear_embeddings():
    """Clear all embeddings and reset the FAISS index."""
    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        # Run clear in executor since it does file I/O
        await loop.run_in_executor(None, analyzer.clear)

        return ClearResponse(
            success=True,
            cleared=True,
            index_size=analyzer.faiss_index.ntotal
        )
    except Exception as e:
        logger.error(f"Clear embeddings failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/check/analyzed", response_model=CheckAnalyzedResponse)
async def check_analyzed(request: CheckAnalyzedRequest):
    """Check which UUIDs have been analyzed and have embeddings."""
    try:
        analyzer = await get_analyzer()

        # Get the set of analyzed UUIDs from metadata database
        analyzed_set = analyzer.get_analyzed_uuids()

        # Find which requested UUIDs are in the analyzed set
        analyzed_uuids = [uuid for uuid in request.uuids if uuid in analyzed_set]

        return CheckAnalyzedResponse(
            analyzed_count=len(analyzed_uuids),
            total_count=len(request.uuids),
            analyzed_uuids=analyzed_uuids
        )
    except Exception as e:
        logger.error(f"Check analyzed failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/text", response_model=SearchResponse)
async def search_by_text(request: TextSearchRequest):
    """Search for similar songs using a text query."""
    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        filter_set = set(request.filter_uuids) if request.filter_uuids else None
        search_k = min(len(filter_set), 10000) if filter_set else request.k

        def do_search():
            results = analyzer.search_by_text(request.query, k=search_k)
            filtered = []
            for r in results:
                if r['score'] < request.min_score:
                    continue
                if filter_set and r['uuid'] not in filter_set:
                    continue
                filtered.append(SearchResult(uuid=r['uuid'], score=r['score']))
                if len(filtered) >= request.k:
                    break
            return filtered

        results = await loop.run_in_executor(None, do_search)
        return SearchResponse(results=results)

    except Exception as e:
        logger.error(f"Text search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/similar", response_model=SearchResponse)
async def search_similar(request: SimilarSearchRequest):
    """Find songs similar to a given song."""
    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        filter_set = set(request.filter_uuids) if request.filter_uuids else None
        search_k = min(len(filter_set), 10000) if filter_set else request.k + len(request.exclude_uuids) + 1

        def do_search():
            results = analyzer.search_by_audio(request.uuid, k=search_k)
            exclude_set = set(request.exclude_uuids)
            exclude_set.add(request.uuid)

            filtered = []
            for r in results:
                if r['uuid'] in exclude_set:
                    continue
                if filter_set and r['uuid'] not in filter_set:
                    continue
                filtered.append(SearchResult(uuid=r['uuid'], score=r['score']))
                if len(filtered) >= request.k:
                    break
            return filtered

        results = await loop.run_in_executor(None, do_search)
        return SearchResponse(results=results)

    except Exception as e:
        logger.error(f"Similar search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/batch_similar", response_model=SearchResponse)
async def batch_similar_search(request: BatchSimilarRequest):
    """Find songs similar to multiple seed songs (averaged embedding)."""
    if not request.uuids:
        raise HTTPException(status_code=400, detail="At least one UUID required")

    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        def do_search():
            import numpy as np

            embeddings = []
            for uuid in request.uuids:
                emb = analyzer.get_song_embedding(uuid)
                if emb is not None:
                    embeddings.append(emb)

            if not embeddings:
                return []

            avg_embedding = np.mean(embeddings, axis=0)
            avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)

            k_adjusted = request.k + len(request.exclude_uuids) + len(request.uuids)
            scores, indices = analyzer.faiss_index.search(
                avg_embedding.reshape(1, -1).astype('float32'),
                k_adjusted
            )

            exclude_set = set(request.exclude_uuids) | set(request.uuids)
            results = []

            conn = analyzer.get_metadata_db()
            cur = conn.cursor()
            for score, idx in zip(scores[0], indices[0]):
                if idx < 0:
                    continue
                cur.execute("SELECT uuid FROM embeddings WHERE id = ?", (int(idx),))
                row = cur.fetchone()
                if row and row['uuid'] not in exclude_set:
                    results.append(SearchResult(uuid=row['uuid'], score=float(score)))
                    if len(results) >= request.k:
                        break
            conn.close()

            return results

        results = await loop.run_in_executor(None, do_search)
        return SearchResponse(results=results)

    except Exception as e:
        logger.error(f"Batch similar search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/compound", response_model=SearchResponse)
async def compound_search(request: CompoundSearchRequest):
    """Search using combined positive and negative embeddings.

    Combines text and song embeddings at the embedding level:
    - Positive terms are averaged together
    - Negative terms are subtracted (weighted by neg_weight)
    - Result is normalized and searched

    This enables queries like "dreamy piano music" minus "electronic" minus "vocals".
    """
    if not request.positive_texts and not request.positive_uuids:
        raise HTTPException(
            status_code=400,
            detail="At least one positive term (text or UUID) required"
        )

    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        # If filtering, adjust search size
        filter_set = set(request.filter_uuids) if request.filter_uuids else None
        if filter_set:
            search_k = min(len(filter_set), 10000)
        else:
            search_k = request.k

        def do_compound_search():
            import numpy as np

            positive_embs = []
            negative_embs = []

            # Get text embeddings for positive terms
            if request.positive_texts:
                # Add "music" suffix for better CLAP matching
                texts = [t if 'music' in t.lower() else f"{t} music" for t in request.positive_texts]
                text_embs = analyzer.model.get_text_embedding(texts, use_tensor=False)
                positive_embs.extend(text_embs)

            # Get song embeddings for positive UUIDs
            for uuid in request.positive_uuids:
                emb = analyzer.get_song_embedding(uuid)
                if emb is not None:
                    positive_embs.append(emb)

            # Get text embeddings for negative terms
            if request.negative_texts:
                texts = [t if 'music' in t.lower() else f"{t} music" for t in request.negative_texts]
                text_embs = analyzer.model.get_text_embedding(texts, use_tensor=False)
                negative_embs.extend(text_embs)

            # Get song embeddings for negative UUIDs
            for uuid in request.negative_uuids:
                emb = analyzer.get_song_embedding(uuid)
                if emb is not None:
                    negative_embs.append(emb)

            if not positive_embs:
                return []

            # Combine embeddings
            # Start with average of positive embeddings
            combined = np.mean(positive_embs, axis=0)

            # Subtract negative embeddings (weighted)
            for neg_emb in negative_embs:
                combined = combined - neg_emb * request.neg_weight

            # Normalize
            norm = np.linalg.norm(combined)
            if norm > 0:
                combined = combined / norm
            else:
                # Edge case: negatives cancelled out positives
                return []

            # Search FAISS
            scores, indices = analyzer.faiss_index.search(
                combined.reshape(1, -1).astype('float32'),
                search_k
            )

            # Build results
            exclude_set = set(request.positive_uuids) | set(request.negative_uuids)
            results = []

            conn = analyzer.get_metadata_db()
            cur = conn.cursor()
            for score, idx in zip(scores[0], indices[0]):
                if idx < 0:
                    continue
                if score < request.min_score:
                    continue

                cur.execute("SELECT uuid FROM embeddings WHERE id = ?", (int(idx),))
                row = cur.fetchone()
                if row:
                    uuid = row['uuid']
                    if uuid in exclude_set:
                        continue
                    if filter_set and uuid not in filter_set:
                        continue
                    results.append(SearchResult(uuid=uuid, score=float(score)))
                    if len(results) >= request.k:
                        break
            conn.close()

            return results

        results = await loop.run_in_executor(None, do_compound_search)

        return SearchResponse(results=results)

    except Exception as e:
        logger.error(f"Compound search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/playlist/generate", response_model=PlaylistResponse)
async def generate_playlist(request: PlaylistGenerateRequest):
    """Generate a playlist from a text prompt or seed songs."""
    if not request.prompt and not request.seed_uuids:
        raise HTTPException(
            status_code=400,
            detail="Either 'prompt' or 'seed_uuids' must be provided"
        )

    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        def do_generate():
            if request.prompt:
                results = analyzer.generate_playlist_from_prompt(
                    request.prompt,
                    size=request.size,
                    diversity=request.diversity,
                    min_duration=request.min_duration
                )
            else:
                results = analyzer.generate_playlist_from_seeds(
                    request.seed_uuids,
                    size=request.size,
                    diversity=request.diversity,
                    min_duration=request.min_duration
                )

            exclude_set = set(request.exclude_uuids)
            songs = [
                SearchResult(uuid=r['uuid'], score=r.get('score', 0))
                for r in results
                if r['uuid'] not in exclude_set
            ]
            return songs

        songs = await loop.run_in_executor(None, do_generate)
        return PlaylistResponse(songs=songs)

    except Exception as e:
        logger.error(f"Playlist generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/duplicates/check", response_model=DuplicateResponse)
async def check_duplicates(request: DuplicateCheckRequest):
    """Check for duplicate songs among the given UUIDs."""
    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        def find_duplicates():
            import numpy as np

            embeddings = {}
            for uuid in request.uuids:
                emb = analyzer.get_song_embedding(uuid)
                if emb is not None:
                    embeddings[uuid] = emb

            if len(embeddings) < 2:
                return []

            uuids = list(embeddings.keys())
            emb_matrix = np.array([embeddings[u] for u in uuids])
            similarities = np.dot(emb_matrix, emb_matrix.T)

            parent = {u: u for u in uuids}

            def find(x):
                if parent[x] != x:
                    parent[x] = find(parent[x])
                return parent[x]

            def union(x, y):
                px, py = find(x), find(y)
                if px != py:
                    parent[px] = py

            for i, uuid_i in enumerate(uuids):
                for j, uuid_j in enumerate(uuids):
                    if i < j and similarities[i, j] >= request.threshold:
                        union(uuid_i, uuid_j)

            groups_dict = {}
            for uuid in uuids:
                root = find(uuid)
                if root not in groups_dict:
                    groups_dict[root] = []
                groups_dict[root].append(uuid)

            groups = []
            for root, members in groups_dict.items():
                if len(members) > 1:
                    group_songs = []
                    for uuid in members:
                        idx = uuids.index(uuid)
                        score = float(similarities[uuids.index(members[0]), idx])
                        group_songs.append(SearchResult(uuid=uuid, score=score))
                    groups.append(DuplicateGroup(songs=group_songs))

            return groups

        groups = await loop.run_in_executor(None, find_duplicates)
        return DuplicateResponse(groups=groups)

    except Exception as e:
        logger.error(f"Duplicate check failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/batch", response_model=AnalyzeBatchResponse)
async def analyze_batch(request: AnalyzeBatchRequest):
    """Analyze a batch of songs and store their embeddings.

    This endpoint is used by the admin dashboard to analyze songs
    that don't yet have embeddings in the index.
    """
    try:
        analyzer = await get_analyzer()
        loop = asyncio.get_event_loop()

        def do_analyze():
            import numpy as np
            from pathlib import Path

            analyzed = []
            errors = []

            for song in request.songs:
                audio_path = Path(song.path)
                if not audio_path.exists():
                    errors.append(f"{song.uuid}: File not found: {song.path}")
                    continue

                try:
                    # Load and analyze audio
                    segments = analyzer.load_audio(audio_path)

                    # Get embeddings for all segments
                    all_embeddings = []
                    MAX_SEGMENTS_PER_BATCH = 8

                    for i in range(0, len(segments), MAX_SEGMENTS_PER_BATCH):
                        sub_batch = segments[i:i + MAX_SEGMENTS_PER_BATCH]
                        sub_embeddings = analyzer.model.get_audio_embedding_from_data(
                            sub_batch,
                            use_tensor=False
                        )
                        all_embeddings.append(sub_embeddings)

                    all_embeddings = np.concatenate(all_embeddings, axis=0)
                    avg_embedding = np.mean(all_embeddings, axis=0)
                    avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)

                    # Store embedding
                    analyzer.add_embedding(song.uuid, avg_embedding)
                    analyzed.append(song.uuid)

                    # Clean up GPU memory
                    del segments, all_embeddings
                    if analyzer.device == 'cuda':
                        import torch
                        torch.cuda.empty_cache()

                except Exception as e:
                    errors.append(f"{song.uuid}: {str(e)}")
                    if analyzer.device == 'cuda':
                        import torch
                        torch.cuda.empty_cache()

            return analyzed, errors

        analyzed, errors = await loop.run_in_executor(None, do_analyze)

        # Save FAISS index to disk after batch analysis
        if analyzed:
            await loop.run_in_executor(None, analyzer.save)
            logger.info(f"Saved FAISS index with {analyzer.faiss_index.ntotal} embeddings")

        if errors:
            logger.warning(f"Batch: {len(analyzed)} analyzed, {len(errors)} errors")
        return AnalyzeBatchResponse(analyzed=analyzed, errors=errors)

    except Exception as e:
        logger.error(f"Batch analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "service:app",
        host="127.0.0.1",
        port=int(os.environ.get("CLAP_SERVICE_PORT", 5002)),
        reload=False,
        workers=1
    )

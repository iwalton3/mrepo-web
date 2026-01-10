# Stage 1: Build optimized frontend with Node.js
FROM node:20-alpine AS frontend-builder

WORKDIR /build

# Copy optimizer tools
COPY tools/optimize.js tools/bundler-esm.js ./tools/

# Copy frontend source
COPY frontend/ ./frontend/

# Run optimizer: minify + sourcemap
# Output goes to frontend-dist/
RUN mkdir -p ./frontend-dist && \
    node tools/optimize.js \
    --input ./frontend \
    --output ./frontend-dist \
    --minify \
    --sourcemap && \
    cd ./frontend-dist && node spider-deps.js

# Stage 2: Final Python runtime (no Node.js)
FROM python:3.11-slim

# Install FFmpeg for audio transcoding
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1000 mrepo

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code (with correct ownership for non-root user)
COPY --chown=mrepo:mrepo backend/ ./backend/

# Copy optimized frontend from builder stage
COPY --chown=mrepo:mrepo --from=frontend-builder /build/frontend-dist/ ./frontend/

# Create data directories
RUN mkdir -p /data /config && chown -R mrepo:mrepo /data /config /app

USER mrepo

# Environment
ENV PYTHONUNBUFFERED=1
ENV MREPO_CONFIG=/config/config.yaml

EXPOSE 8080

# Run with gunicorn
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "4", "--access-logfile", "-", "backend.app:create_app()"]

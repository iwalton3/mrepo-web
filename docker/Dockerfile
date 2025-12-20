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

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create data directories
RUN mkdir -p /data /config && chown -R mrepo:mrepo /data /config

USER mrepo

# Environment
ENV PYTHONUNBUFFERED=1
ENV MREPO_CONFIG=/config/config.yaml

EXPOSE 8080

# Run with gunicorn
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "4", "--access-logfile", "-", "backend.app:create_app()"]

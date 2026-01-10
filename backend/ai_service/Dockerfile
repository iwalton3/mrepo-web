# AI Music Similarity Service
# Runs CLAP model for music embedding and similarity search

FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install PyTorch (CPU version by default - smaller image)
# torchvision is required by laion_clap
# For GPU: use --index-url https://download.pytorch.org/whl/cu118
RUN pip install --no-cache-dir torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cpu

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directories for data
RUN mkdir -p /data/ai

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV CLAP_PRELOAD=1
ENV MUSIC_DB=/data/mrepo.db
ENV MEDIA_PATH=/music
ENV EMBEDDINGS_PATH=/data/ai

# Expose service port
EXPOSE 5002

# Run with single worker (GPU memory constraint)
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "5002", "--workers", "1"]

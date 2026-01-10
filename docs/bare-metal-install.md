# Bare Metal Installation Guide

This guide covers installing mrepo on a bare metal server using conda environments and systemd for service management.

## Prerequisites

- Linux server (Debian/Ubuntu recommended)
- Python 3.10+
- FFmpeg (for audio transcoding)
- Conda or Miniconda
- nginx (recommended for reverse proxy)

### Install System Dependencies

```bash
# Debian/Ubuntu
sudo apt update
sudo apt install -y ffmpeg nginx

# Install Miniconda if not already installed
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh
```

## Directory Structure

```
/opt/mrepo/
├── mrepo-web/          # Application code
├── data/               # Database and config
│   ├── mrepo.db
│   └── config.yaml
├── music/              # Music library (or symlink)
└── ai/                 # AI embeddings (if AI enabled)
    ├── clap_embeddings.faiss
    └── clap_metadata.db
```

```bash
sudo mkdir -p /opt/mrepo/{data,music,ai}
sudo chown -R www-data:www-data /opt/mrepo
```

---

## Option A: Basic Installation (No AI)

### 1. Create Conda Environment

```bash
conda create -n mrepo python=3.11
conda activate mrepo
```

### 2. Clone and Install

```bash
cd /opt/mrepo
git clone https://github.com/your-repo/mrepo-web.git
cd mrepo-web
pip install -r requirements.txt
pip install gunicorn
```

### 3. Configure

```bash
cp config.example.yaml /opt/mrepo/data/config.yaml
```

Edit `/opt/mrepo/data/config.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 8080

database:
  path: /opt/mrepo/data/mrepo.db

media:
  paths:
    - /opt/mrepo/music

# AI disabled
ai:
  enabled: false
```

### 4. Create Systemd Service

Create `/etc/systemd/system/mrepo.service`:

```ini
[Unit]
Description=mrepo Music Server
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mrepo/mrepo-web

Environment="MREPO_CONFIG=/opt/mrepo/data/config.yaml"

ExecStart=/home/YOUR_USER/miniconda3/envs/mrepo/bin/gunicorn \
    --worker-class sync \
    --workers 4 \
    --bind 127.0.0.1:8080 \
    --timeout 120 \
    "backend.app:create_app()"

Restart=always
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mrepo

[Install]
WantedBy=multi-user.target
```

### 5. Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable mrepo
sudo systemctl start mrepo
sudo systemctl status mrepo
```

---

## Option B: Installation with AI Support

AI features require additional dependencies for the CLAP model and FAISS vector search.

### 1. Create Conda Environment (GPU)

For NVIDIA GPU acceleration:

```bash
conda create -n mrepo-ai python=3.10
conda activate mrepo-ai

# PyTorch with CUDA support
conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia

# FAISS with GPU support
conda install -c pytorch faiss-gpu

# Audio processing
conda install -c conda-forge librosa numpy tqdm

# CLAP model and web framework
pip install laion-clap gunicorn uvicorn "fastapi[standard]"
```

### 1b. Create Conda Environment (CPU Only)

For CPU-only systems:

```bash
conda create -n mrepo-ai python=3.10
conda activate mrepo-ai

# PyTorch CPU version
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# FAISS CPU version
pip install faiss-cpu

# Audio processing and CLAP
conda install -c conda-forge librosa numpy tqdm
pip install laion-clap gunicorn uvicorn "fastapi[standard]"
```

### 2. Install Main Application

```bash
# Use the same environment or create separate one for main app
conda activate mrepo-ai  # or separate mrepo env

cd /opt/mrepo
git clone https://github.com/your-repo/mrepo-web.git
cd mrepo-web
pip install -r requirements.txt
pip install gunicorn
```

### 3. Configure with AI

Edit `/opt/mrepo/data/config.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 8080

database:
  path: /opt/mrepo/data/mrepo.db

media:
  paths:
    - /opt/mrepo/music

# AI configuration
ai:
  enabled: true
  service_url: http://127.0.0.1:5002
  service_timeout: 30.0
  search_timeout: 10.0
```

### 4. Create Systemd Services

#### Main Application Service

Create `/etc/systemd/system/mrepo.service`:

```ini
[Unit]
Description=mrepo Music Server
After=network.target mrepo-ai.service
Wants=mrepo-ai.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mrepo/mrepo-web

Environment="MREPO_CONFIG=/opt/mrepo/data/config.yaml"

ExecStart=/home/YOUR_USER/miniconda3/envs/mrepo-ai/bin/gunicorn \
    --worker-class sync \
    --workers 4 \
    --bind 127.0.0.1:8080 \
    --timeout 120 \
    "backend.app:create_app()"

Restart=always
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mrepo

[Install]
WantedBy=multi-user.target
```

#### AI Service

Create `/etc/systemd/system/mrepo-ai.service`:

```ini
[Unit]
Description=mrepo AI Music Similarity Service
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mrepo/mrepo-web/backend/ai_service

# Environment
Environment="EMBEDDINGS_PATH=/opt/mrepo/ai"
Environment="MUSIC_DB=/opt/mrepo/data/mrepo.db"
Environment="CLAP_PRELOAD=1"

# Use gunicorn with uvicorn worker for production
# Single worker since CLAP model is loaded into GPU memory
ExecStart=/home/YOUR_USER/miniconda3/envs/mrepo-ai/bin/gunicorn \
    service:app \
    --worker-class uvicorn.workers.UvicornWorker \
    --workers 1 \
    --bind 127.0.0.1:5002 \
    --timeout 120 \
    --graceful-timeout 30 \
    --keep-alive 5

Restart=always
RestartSec=5

# Give time for model loading on startup (downloads ~600MB on first run)
TimeoutStartSec=600

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mrepo-ai

[Install]
WantedBy=multi-user.target
```

### 5. Enable and Start Services

```bash
sudo systemctl daemon-reload

# Start AI service first (main app depends on it)
sudo systemctl enable mrepo-ai
sudo systemctl start mrepo-ai

# Wait for AI service to load model (check logs)
sudo journalctl -u mrepo-ai -f

# Once AI service shows "Application startup complete", start main app
sudo systemctl enable mrepo
sudo systemctl start mrepo
```

---

## nginx Configuration

Create `/etc/nginx/sites-available/mrepo`:

```nginx
server {
    listen 80;
    server_name music.example.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name music.example.com;

    ssl_certificate /etc/letsencrypt/live/music.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;

    # Increase timeouts for long audio streams
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;

    # Allow large file uploads for music import
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (if needed)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Streaming endpoint - disable buffering
    location /stream/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_buffering off;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Range $http_range;
        proxy_set_header If-Range $http_if_range;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/mrepo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Managing Services

```bash
# View logs
sudo journalctl -u mrepo -f
sudo journalctl -u mrepo-ai -f

# Restart services
sudo systemctl restart mrepo
sudo systemctl restart mrepo-ai

# Check status
sudo systemctl status mrepo mrepo-ai
```

---

## First Run

1. Open `https://music.example.com` in your browser
2. Complete the setup wizard to create an admin account
3. Add your music library path in Admin > Settings
4. Click "Scan Library" to import music

### With AI Support

After scanning your library:

1. Go to Admin > AI Settings
2. Click "Analyze Library" to generate embeddings
3. First run downloads the CLAP model (~600MB)
4. Analysis takes ~2-5 seconds per song (GPU) or ~5-15 seconds (CPU)

---

## Troubleshooting

### AI Service Won't Start

Check if the model can be loaded:

```bash
cd /opt/mrepo/mrepo-web/backend/ai_service
conda activate mrepo-ai
python -c "from analyzer import CLAPAnalyzer; a = CLAPAnalyzer(); a.load_model(); print('OK')"
```

### Permission Issues

```bash
sudo chown -R www-data:www-data /opt/mrepo/data /opt/mrepo/ai
sudo chmod 755 /opt/mrepo/music  # Music can be read-only
```

### GPU Not Detected

```bash
conda activate mrepo-ai
python -c "import torch; print(torch.cuda.is_available())"
```

If False, reinstall PyTorch with correct CUDA version:

```bash
# Check your CUDA version
nvidia-smi

# Reinstall PyTorch (example for CUDA 12.1)
conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia
```

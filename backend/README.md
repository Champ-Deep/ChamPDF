# ChamPDF Backend

FastAPI backend providing optional AI-powered image and video processing features for ChamPDF.

## Features

The backend extends ChamPDF with advanced processing capabilities that require server-side computation:

| Feature | Description | Technology |
|---------|-------------|------------|
| **Remove Background (AI)** | ML-powered background removal from images | rembg + U2Net model (~176MB) |
| **Video Logo Remover** | Remove watermarks from videos and rebrand with custom logos | FFmpeg |
| **Image Watermark Remover** | Content-aware watermark removal from JPG/PNG/WebP | Python + PIL |

**Privacy-First:** All processing happens on **your own server** - files are never sent to third parties.

---

## Quick Start

### Prerequisites

- Python 3.11+
- FFmpeg (for video processing)
- Docker & Docker Compose (optional, recommended)

### Local Development (Docker)

From the project root:

```bash
docker-compose -f docker-compose.dev.yml up --build
```

Backend will be available at: `http://localhost:8000`

### Local Development (without Docker)

1. **Install System Dependencies:**
   ```bash
   # macOS
   brew install ffmpeg

   # Ubuntu/Debian
   sudo apt-get install ffmpeg

   # Windows
   # Download from https://ffmpeg.org/download.html
   ```

2. **Install Python Dependencies:**
   ```bash
   cd backend
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. **Add Logo Assets:**
   Place PNG logos in `assets/logos/`:
   - `lakeb2b.png`
   - `champions.png`
   - `ampliz.png`

4. **Configure Environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

5. **Run the Server:**
   ```bash
   uvicorn main:app --reload --port 8000
   ```

---

## API Documentation

### Base URL
- **Development:** `http://localhost:8000`
- **Production:** `https://your-backend.railway.app`

### Authentication
No authentication required (public API with CORS restrictions)

### Rate Limits
- **Concurrent Jobs:** 2 (configurable via `MAX_CONCURRENT_JOBS`)
- **File Size Limits:**
  - Images: 10MB
  - Videos: 100MB

---

## API Endpoints

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "ffmpeg": true
}
```

**Description:** Check backend status and FFmpeg availability

---

### Remove Background (AI)
```http
POST /api/remove-background
Content-Type: multipart/form-data
```

**Parameters:**
- `file` (required): Image file (PNG, JPG, JPEG, WebP)

**Response:** PNG image with transparent background

**Description:** AI-powered background removal using U2Net model (~176MB). Model is pre-downloaded during Docker build to prevent cold starts.

**Example:**
```bash
curl -X POST http://localhost:8000/api/remove-background \
  -F "file=@photo.jpg" \
  -o result.png
```

---

### Process Video
```http
POST /api/process-video
Content-Type: multipart/form-data
```

**Parameters:**
- `file` (required): Video file (MP4, MOV, WebM, AVI)
- `logo_preset` (required): Logo to overlay
  - `"lakeb2b"` - Lake B2B logo
  - `"champions"` - Champions logo
  - `"ampliz"` - Ampliz logo
  - `"none"` - No logo overlay
- `watermark_position` (required): Watermark location
  - `"bottom-right"` | `"bottom-left"` | `"top-right"` | `"top-left"`

**Response:** Processed MP4 video (H.264 + AAC)

**Description:** Remove watermarks from videos using FFmpeg delogo filter and optionally overlay a custom logo.

**Example:**
```bash
curl -X POST http://localhost:8000/api/process-video \
  -F "file=@video.mp4" \
  -F "logo_preset=champions" \
  -F "watermark_position=bottom-right" \
  -o output.mp4
```

**Processing Pipeline:**
1. Upload video to temp directory
2. Detect video resolution and calculate watermark region
3. Apply FFmpeg `delogo` filter to blur watermark
4. Optionally overlay new logo using `overlay` filter
5. Encode with H.264 (CRF 18, fast preset)
6. Stream result back to client
7. Cleanup temp files

**Watermark Regions** (automatically scaled):

| Resolution | X | Y | Width | Height |
|------------|---|---|-------|--------|
| 720p | 1100 | 660 | 180 | 60 |
| 1080p | 1700 | 1000 | 220 | 80 |
| 480p | 700 | 440 | 140 | 40 |
| 4K | 3600 | 2080 | 400 | 160 |

---

### Get Logo Presets
```http
GET /api/presets
```

**Response:**
```json
{
  "lakeb2b": true,
  "champions": true,
  "ampliz": false
}
```

**Description:** Returns available logo presets and their availability

---

### Cleanup Temp Files
```http
DELETE /api/cleanup
```

**Response:**
```json
{
  "message": "Cleanup initiated"
}
```

**Description:** Manually trigger cleanup of temporary files

---

## Environment Variables

See [.env.example](.env.example) for complete configuration reference.

### Critical Variables (Production)

```bash
# CORS Configuration - REQUIRED FOR PRODUCTION
# Comma-separated list of allowed origins
ALLOWED_ORIGINS=https://champdf.com,https://www.champdf.com

# Logging Level
# Options: DEBUG, INFO, WARNING, ERROR, CRITICAL
# Recommended: WARNING for production
LOG_LEVEL=WARNING

# File Size Limits (MB)
MAX_VIDEO_SIZE_MB=100
MAX_IMAGE_SIZE_MB=10

# Resource Limits
MAX_CONCURRENT_JOBS=2  # Prevents OOM on limited memory
PROCESS_TIMEOUT=300    # 5 minutes for ML/FFmpeg tasks
```

### Railway-Specific Variables

These are set automatically by Railway:

```bash
PORT=<dynamic>           # Railway assigns port dynamically
WEB_CONCURRENCY=2        # Number of uvicorn workers
```

---

## Deployment

### Railway (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

**Quick Deploy:**

1. Click the Railway button above
2. Set environment variables:
   ```bash
   ALLOWED_ORIGINS=https://your-domain.com,https://www.your-domain.com
   LOG_LEVEL=WARNING
   MAX_CONCURRENT_JOBS=2
   ```
3. Deploy and copy your backend URL
4. Update frontend `VITE_API_URL` to point to backend

**Deployment Configuration:**
- Dockerfile: `backend/Dockerfile.railway`
- Build command: Automatic via Docker
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 2`
- Health check: `/health` (120s timeout)

For detailed Railway instructions, see [Railway Deployment Guide](../.railway/README.md)

### Docker Production

Build and run with Docker:

```bash
# Build
docker build -f backend/Dockerfile.railway -t champdf-backend .

# Run
docker run -d -p 8000:8000 \
  -e ALLOWED_ORIGINS="https://your-domain.com" \
  -e LOG_LEVEL="WARNING" \
  champdf-backend
```

### Other Cloud Platforms

The backend can be deployed to any Python hosting platform:

- **Render:** Use `backend/Dockerfile.railway`
- **Fly.io:** Use Dockerfile deployment
- **Google Cloud Run:** Use Dockerfile deployment
- **AWS Fargate:** Use Dockerfile deployment

---

## Configuration

### File Size Limits

Adjust in `.env`:

```bash
MAX_VIDEO_SIZE_MB=100  # Maximum video upload size
MAX_IMAGE_SIZE_MB=10   # Maximum image upload size
```

### Concurrency Control

Prevent OOM by limiting concurrent jobs:

```bash
MAX_CONCURRENT_JOBS=2  # Recommended for 512MB-1GB RAM
PROCESS_TIMEOUT=300    # Kill jobs after 5 minutes
```

### Logging

Set appropriate log level for your environment:

```bash
# Development
LOG_LEVEL=INFO

# Production
LOG_LEVEL=WARNING  # Less verbose, only warnings/errors
```

---

## Troubleshooting

### Health Check Fails

**Symptom:** `/health` returns 500 or times out

**Solutions:**
1. Check FFmpeg is installed: `ffmpeg -version`
2. Check logs for errors: `docker logs <container>`
3. Verify CORS settings in `.env`

### Model Download Fails (Cold Start)

**Symptom:** First request to `/api/remove-background` times out

**Solutions:**
1. Model should pre-download during Docker build
2. Check Docker build logs for "Model download complete!"
3. If using Railway, increase health check timeout to 120s

### CORS Errors

**Symptom:** Browser console shows CORS errors

**Solutions:**
1. Set `ALLOWED_ORIGINS` in environment variables:
   ```bash
   ALLOWED_ORIGINS=https://your-frontend.com,https://www.your-frontend.com
   ```
2. Restart backend after changing environment variables
3. Verify frontend is making requests to correct backend URL

### Out of Memory (OOM)

**Symptom:** Backend crashes during processing

**Solutions:**
1. Reduce `MAX_CONCURRENT_JOBS` to 1
2. Reduce `MAX_FILE_SIZE` limits
3. Upgrade to higher memory tier (Railway: 1GB → 2GB)
4. Add swap space (not recommended for production)

### Video Processing Timeout

**Symptom:** Video processing fails with timeout

**Solutions:**
1. Increase `PROCESS_TIMEOUT` (e.g., 600 seconds for large files)
2. Reduce video file size before upload
3. Check FFmpeg logs for errors

---

## Development

### Project Structure

```
backend/
├── main.py              # FastAPI application and endpoints
├── config.py            # Pydantic settings and environment config
├── image_processor.py   # Background removal logic
├── video_processor.py   # Video watermark removal logic
├── requirements.txt     # Python dependencies
├── Dockerfile.railway   # Production Dockerfile for Railway
├── Dockerfile          # Development Dockerfile
├── .env.example        # Environment variables template
└── assets/
    └── logos/          # Logo assets for video rebranding
        ├── lakeb2b.png
        ├── champions.png
        └── ampliz.png
```

### Running Tests

```bash
# Coming soon
pytest tests/
```

### Code Quality

```bash
# Format code
black .

# Lint
flake8 .

# Type checking
mypy .
```

---

## Support

- **Issues:** [GitHub Issues](https://github.com/Champ-Deep/ChamPDF/issues)
- **Discord:** [Join Server](https://discord.gg/Bgq3Ay3f2w)
- **Documentation:** [ChamPDF Docs](https://champdf.com/docs/)

---

## License

See [LICENSE](../LICENSE) in the project root.

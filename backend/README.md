# Video Rebrander Backend

FastAPI backend for video watermark removal and logo replacement using FFmpeg.

## Setup

### Local Development (without Docker)

1. **Install FFmpeg**:
   ```bash
   # macOS
   brew install ffmpeg

   # Ubuntu/Debian
   sudo apt-get install ffmpeg
   ```

2. **Install Python dependencies**:
   ```bash
   cd backend
   pip install -r requirements.txt
   ```

3. **Add logo assets**:
   Place PNG logos in `assets/logos/`:
   - `lakeb2b.png`
   - `champions.png`
   - `ampliz.png`

4. **Run the server**:
   ```bash
   uvicorn main:app --reload --port 8000
   ```

### Docker Development

From the project root:
```bash
docker compose -f docker-compose.dev.yml up --build
```

## API Endpoints

### Health Check
```
GET /health
```
Returns API status and FFmpeg availability.

### Process Video
```
POST /api/process-video
Content-Type: multipart/form-data

Parameters:
- file: Video file (MP4, MOV, WebM, AVI)
- logo_preset: "lakeb2b" | "champions" | "ampliz" | "none"
- watermark_position: "bottom-right" | "bottom-left" | "top-right" | "top-left"

Response: Processed video file (MP4)
```

### Get Presets
```
GET /api/presets
```
Returns available logo presets and their availability.

## Configuration

- **MAX_FILE_SIZE**: 100MB (configurable in `main.py`)
- **Allowed formats**: MP4, MOV, WebM, AVI
- **Output format**: Always MP4 (H.264 + AAC)

## Processing Pipeline

1. Upload video to temp directory
2. Detect video resolution and calculate watermark region
3. Apply FFmpeg `delogo` filter to blur watermark
4. Optionally overlay new logo using `overlay` filter
5. Encode with H.264 (CRF 18, fast preset)
6. Stream result back to client
7. Cleanup temp files

## Watermark Regions

Pre-configured regions for common AI tool watermarks:

| Resolution | X | Y | Width | Height |
|------------|---|---|-------|--------|
| 720p | 1100 | 660 | 180 | 60 |
| 1080p | 1700 | 1000 | 220 | 80 |
| 480p | 700 | 440 | 140 | 40 |
| 4K | 3600 | 2080 | 400 | 160 |

Regions are automatically scaled based on actual video dimensions.

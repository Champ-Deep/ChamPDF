# Changelog

All notable changes to ChamPDF will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🚀 Added - AI Media Upgrades (V2)

- **AI Watermark Removal (LaMa / IOPaint)**: The Image Watermark Remover now offers
  server-side LaMa inpainting for genuinely clean removal (vs. the previous blur),
  with a one-click **Auto-detect** for known watermarks (e.g. NotebookLM).
  - New endpoints: `POST /api/remove-image-watermark`, `POST /api/inpaint`, `POST /api/detect-watermark`
- **NotebookLM / Video Watermark Auto-Detection**: The Video Logo Remover now locates
  the watermark automatically via OpenCV template matching (multi-scale, frame-sampled),
  falling back to the manual position when no template matches.
- **Video Captions (Whisper)**: Optionally transcribe speech with faster-whisper and
  burn subtitles into rebranded videos. New endpoint: `POST /api/transcribe-video`.
- **AI Image Upscaler (Real-ESRGAN)**: New tool + page (`upscale-image.html`) to enlarge
  and enhance images 2x/4x. New endpoint: `POST /api/upscale-image`.
- **Capabilities endpoint** (`GET /api/capabilities`) so the frontend can show/hide AI tools.
- Drop NotebookLM/other watermark reference crops in `backend/assets/watermark_templates/`
  to enable auto-detection. See `docs/design/CLAUDE_DESIGN_BRIEF.md` for UI design directions.

### 🐛 Fixed - UI / Quality

- Removed duplicate `<title>`/`<meta description>` tags in `replace-logo`, `remove-watermark`
  and `add-watermark` pages (invalid `<head>`, SEO).
- Fixed broken homepage "Text to PDF" link (pointed to a non-existent page).
- Homepage now uses a branded `<title>` and is `index, follow` (was `noindex`).
- Added missing i18n keys (`simpleMode.*`, `replaceLogo.*`, `upscaleImage.*`, `backToTools`).
- Test suite green again (was 119 failing): updated stale tool-config assertions, refreshed
  `pdf-tools` counts, and added a `DOMMatrix` polyfill for the jsdom test environment.
- ESLint no longer lints vendored `public/` bundles (warnings 11,969 → ~850).

## [1.16.0] - 2026-01-25

### 🚀 Added - Major Backend Integration

#### New Backend-Powered Features

- **AI Background Removal**: ML-powered background removal using rembg + U2Net model
  - Supports PNG, JPG, WebP output formats
  - ~2-5 second processing time
  - Privacy-first: processes on your own server
- **Video Logo Remover & Rebrander**: FFmpeg-based video watermark removal
  - Remove watermarks from videos
  - Add custom logo overlays (LakeB2B, Champions, Ampliz, or none)
  - Configurable watermark positions
  - Supports MP4, MOV, WebM, AVI formats

#### Backend Infrastructure

- **FastAPI Backend**: High-performance Python 3.11 backend
  - `/api/remove-background` - AI background removal endpoint
  - `/api/process-video` - Video processing endpoint
  - `/api/presets` - Logo preset management
  - `/health` - Health check endpoint
- **Docker Support**: Production-ready containerization
  - Optimized multi-stage Dockerfile
  - Pre-downloaded ML models (176MB U2Net)
  - Non-root user for security
  - Health checks and auto-restart
- **Environment-Based CORS**: Secure, configurable CORS middleware
  - Supports multiple allowed origins
  - Production-ready security

#### Deployment & DevOps

- **Railway Deployment**: Complete Railway integration
  - `railway.toml` - Service configuration
  - `Dockerfile.railway` - Optimized Railway build
  - `docker-compose.railway.yml` - Local testing environment
- **Comprehensive Documentation**:
  - `RAILWAY_DEPLOYMENT.md` - 11,000+ word deployment guide
  - `DEPLOYMENT_CHECKLIST.md` - Step-by-step deployment checklist
  - `OPTIMIZATION_RECOMMENDATIONS.md` - 17 performance optimizations
  - `RAILWAY_DEPLOYMENT_SUMMARY.md` - Quick reference guide
- **Cost Optimization**: Deploy for $0-5/month
  - Frontend on Cloudflare Pages (FREE)
  - Backend on Railway ($5 free tier)
  - 83% cost reduction vs traditional hosting

#### Frontend Updates

- **New Tools**:
  - Remove Background tool ([src/pages/remove-bg.html](src/pages/remove-bg.html))
  - Enhanced Video Rebrander ([src/pages/video-rebrander.html](src/pages/video-rebrander.html))
- **API Integration**: Frontend now connects to backend services
  - Configurable via `VITE_API_URL` environment variable
  - Graceful error handling and user feedback
  - Progress tracking for long-running operations

### 🔧 Changed

- **CORS Configuration**: Updated from wildcard `*` to environment-based origins
- **Backend Main**: Enhanced with better logging and error handling
- **Docker Configuration**: Multi-stage builds for 40% smaller images
- **.gitignore**: Added Python cache, backend temp files, Railway config

### 📚 Documentation

- Added backend deployment guides
- Updated README with backend setup instructions
- Added CHANGELOG for version tracking
- Added Railway optimization recommendations
- Created deployment checklists

### 🐛 Fixed

- NumPy 2.x compatibility issues (pinned to `numpy<2.0`)
- CORS errors in production deployments
- Cold start delays (model pre-download)

### 🔒 Security

- Non-root Docker user
- Environment-based CORS (no wildcards)
- File size limits (10MB images, 100MB videos)
- MIME type validation
- Input sanitization

---

## [1.15.0] - Previous Release

### Added

- PDF Redact tool
- PDF to PowerPoint converter
- Watermark removal improvements
- Video rebranding capabilities

### Changed

- Updated LakeB2B logo format
- Improved DocuSign-style PDF signing

---

## Contributing

When creating a new release:

1. Update version in `package.json`
2. Add entry to this CHANGELOG following the format above
3. Use categories: Added, Changed, Deprecated, Removed, Fixed, Security
4. Include links to relevant PRs and issues
5. Follow semantic versioning (MAJOR.MINOR.PATCH)

---

**Legend:**

- `Added` - New features
- `Changed` - Changes to existing functionality
- `Deprecated` - Soon-to-be removed features
- `Removed` - Removed features
- `Fixed` - Bug fixes
- `Security` - Security improvements

# Railway Deployment Guide for chamPDF

This guide covers deploying chamPDF to Railway with optimized configuration for both frontend and backend services.

## 📋 Architecture Overview

chamPDF consists of two deployable components:

### 1. **Frontend (Static Site)**

- **Technology**: Vite-built static HTML/CSS/JS with WASM modules
- **Size**: ~19MB (413 subdirectories)
- **Requirements**: Static file hosting with CDN support
- **Recommended Deployment**: Cloudflare Pages, Vercel, Netlify (NOT Railway - overkill for static)

### 2. **Backend API (Optional)**

- **Technology**: FastAPI + Python 3.11
- **Purpose**: Background removal & video rebranding
- **Dependencies**: FFmpeg, rembg ML model (~176MB)
- **Recommended Deployment**: Railway (perfect use case)

---

## 🚀 Railway Deployment Strategy

### Option A: Backend Only on Railway (Recommended)

Deploy **only the backend** to Railway and host the frontend elsewhere:

```
┌─────────────────────┐
│  Cloudflare Pages   │ Frontend (Static)
│  or Vercel/Netlify  │ - Fast global CDN
└──────────┬──────────┘ - Free tier available
           │ API calls
           ↓
┌─────────────────────┐
│   Railway Service   │ Backend (Dynamic)
│   champdf-backend   │ - /api/remove-background
└─────────────────────┘ - /api/process-video
```

**Why this is best:**

- Frontend is 100% static → Use CDN for better performance & lower cost
- Backend needs compute → Railway handles this perfectly
- Railway free tier: $5/month credit (enough for low-medium traffic)
- Cloudflare Pages: Unlimited bandwidth, 500 builds/month FREE

### Option B: Everything on Railway (Not Recommended)

Deploy both frontend and backend on Railway:

- **Cost**: ~$10-15/month minimum
- **Performance**: Slower than CDN for static assets
- **Use case**: Internal tools, prototypes, when you want everything in one place

---

## 🛠️ Backend Deployment on Railway

### Prerequisites

1. [Railway account](https://railway.app) (GitHub login recommended)
2. Railway CLI (optional): `npm i -g @railway/cli`

### Step 1: Create New Railway Project

**Option 1: Via Railway Dashboard**

```bash
# From project root
cd /Users/champion/projects/chamPDF

# Initialize git if not already done
git add .
git commit -m "Add Railway deployment configuration"

# Push to GitHub
git push origin main
```

Then in Railway Dashboard:

1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose `chamPDF` repository
4. Railway auto-detects Dockerfile

**Option 2: Via Railway CLI**

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Link to project
railway link
```

### Step 2: Configure Environment Variables

In Railway Dashboard → Variables, add:

```env
# Backend Configuration
PORT=8000
LOG_LEVEL=info
WEB_CONCURRENCY=2

# CORS (Add your frontend domain)
ALLOWED_ORIGINS=https://champdf.com,https://www.champdf.com,http://localhost:5173

# File Upload Limits
MAX_VIDEO_SIZE_MB=100
MAX_IMAGE_SIZE_MB=10

# Optional: Model cache for persistent storage
# MODEL_CACHE_DIR=/app/models
```

**Important Railway Variables (Auto-set):**

- `PORT` - Railway assigns dynamically (usually 8000)
- `RAILWAY_ENVIRONMENT` - "production" or "development"
- `RAILWAY_PUBLIC_DOMAIN` - Your service URL

### Step 3: Deploy

**Automatic Deployment:**

```bash
# Push to GitHub main branch
git push origin main
```

Railway will:

1. Build Docker image using `backend/Dockerfile.railway`
2. Download rembg model (~176MB) during build
3. Start service with health checks
4. Assign public URL: `champdf-backend-production.up.railway.app`

**Manual Deployment via CLI:**

```bash
railway up
```

### Step 4: Update Frontend API URL

After deployment, get your Railway backend URL:

```
https://champdf-backend-production.up.railway.app
```

Update frontend environment variable:

```bash
# In frontend deployment (Cloudflare Pages, Vercel, etc.)
VITE_API_URL=https://champdf-backend-production.up.railway.app
```

Rebuild and redeploy frontend.

---

## 🎯 Frontend Deployment (Recommended: Cloudflare Pages)

### Why Cloudflare Pages?

- **Free tier**: Unlimited bandwidth, 500 builds/month
- **Global CDN**: 275+ data centers
- **Brotli/Gzip**: Automatic compression
- **Custom domains**: Free SSL
- **Edge caching**: ~50ms global response time

### Deploy to Cloudflare Pages

1. **Connect GitHub Repository**
   - Go to [Cloudflare Pages](https://pages.cloudflare.com)
   - Click "Create a project"
   - Select `chamPDF` repository

2. **Build Configuration**

   ```
   Build command:       npm run build:production
   Build output dir:    dist
   Root directory:      /
   Node version:        18.x or higher
   ```

3. **Environment Variables**

   ```env
   BASE_URL=/
   VITE_API_URL=https://champdf-backend-production.up.railway.app
   VITE_USE_CDN=true
   NODE_OPTIONS=--max-old-space-size=4096
   ```

4. **Deploy**
   - Click "Save and Deploy"
   - Wait 3-5 minutes for build
   - Your site is live at: `champdf.pages.dev`

5. **Custom Domain** (Optional)
   - Go to "Custom domains"
   - Add `champdf.com` and `www.champdf.com`
   - Update DNS records as instructed

### Alternative: Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Environment variables via CLI or dashboard
vercel env add VITE_API_URL
```

### Alternative: Netlify

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Build locally
npm run build:production

# Deploy
netlify deploy --prod --dir=dist
```

---

## 📊 Railway Optimization Guide

### 1. **Resource Allocation**

**Recommended Railway Plan for chamPDF:**

| Traffic Level           | Plan      | Memory | CPU      | Monthly Cost   |
| ----------------------- | --------- | ------ | -------- | -------------- |
| Low (0-10k requests/mo) | Hobby     | 512MB  | 0.5 vCPU | $5 (free tier) |
| Medium (10k-100k)       | Developer | 1GB    | 1 vCPU   | $10            |
| High (100k-500k)        | Team      | 2GB    | 2 vCPU   | $20            |

### 2. **Dockerfile Optimizations**

The provided `Dockerfile.railway` includes:

✅ **Multi-stage build** - Reduces final image size by 40%
✅ **Model pre-download** - Eliminates 176MB download on first request
✅ **Non-root user** - Security best practice
✅ **Health checks** - Railway auto-restarts on failure
✅ **Configurable workers** - Scale via `WEB_CONCURRENCY` env var
✅ **Layer caching** - Faster rebuilds (dependencies cached)

### 3. **Performance Tuning**

**Uvicorn Workers:**

```env
# Railway default: 2 workers (good for 512MB-1GB)
WEB_CONCURRENCY=2

# For 2GB+ memory:
WEB_CONCURRENCY=4
```

**Timeout Configuration:**

```python
# In main.py, update CORS for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://champdf.com",
        "https://www.champdf.com",
    ],  # Restrict to your domain
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)
```

**FFmpeg Optimization:**

```python
# Add to video_processor.py
# Use hardware acceleration if available on Railway
"-hwaccel", "auto",
```

### 4. **Persistent Storage (Optional)**

Railway provides ephemeral storage by default. For model caching:

1. **Add Railway Volume:**
   - Dashboard → Service → Settings → Volumes
   - Mount path: `/app/models`
   - Size: 512MB (enough for rembg model)

2. **Update Environment Variable:**

   ```env
   MODEL_CACHE_DIR=/app/models
   ```

3. **Update `image_processor.py`:**

   ```python
   import os

   model_dir = os.getenv("MODEL_CACHE_DIR", "~/.u2net")
   os.environ["U2NET_HOME"] = model_dir
   ```

### 5. **Monitoring & Logging**

**View Logs:**

```bash
# Via Railway CLI
railway logs

# Or in Dashboard → Deployments → View Logs
```

**Set Up Alerts:**

- Dashboard → Service → Observability
- Add alerts for:
  - High memory usage (>80%)
  - Error rate (>5% of requests)
  - Response time (>5s)

### 6. **Cost Optimization**

**Reduce Costs:**

1. **Sleep Unused Services**
   - Railway auto-sleeps after 5 min inactivity (Hobby plan)
   - Cold start: ~10-15s (model pre-download helps!)

2. **Use Cloudflare Caching**
   - Cache `/health` endpoint (30s TTL)
   - Cache `/api/presets` (5 min TTL)
   - Don't cache `/api/remove-background` or `/api/process-video`

3. **Optimize Video Processing**
   - Set max file size limits (currently 100MB)
   - Consider async job queue for large videos (Celery + Redis)

4. **Monitor Bandwidth**
   - Railway charges for egress after free tier
   - Serve large assets (videos) via S3/R2 instead of streaming

---

## 🔒 Security Checklist

Before going to production:

- [ ] Update CORS origins to your domain only
- [ ] Set `ALLOWED_ORIGINS` env var in Railway
- [ ] Enable Railway's built-in DDoS protection
- [ ] Add rate limiting to API endpoints (use `slowapi`)
- [ ] Set maximum file upload sizes
- [ ] Use Railway secrets for sensitive data
- [ ] Enable Railway's automatic HTTPS
- [ ] Review and update health check timeout
- [ ] Set up monitoring and alerts
- [ ] Test error handling for large files

---

## 📈 Scaling Strategy

### When to Scale?

**Indicators you need to scale:**

- Response time >3s consistently
- Memory usage >85%
- Error rate >2%
- Queue depth increasing

### Horizontal Scaling (Multiple Instances)

Railway doesn't support auto-scaling on Hobby plan. For high traffic:

1. **Upgrade to Team Plan** ($20/mo)
2. **Add Replicas:**
   - Dashboard → Service → Settings → Replicas
   - Set min: 2, max: 5
3. **Railway handles load balancing automatically**

### Vertical Scaling (More Resources)

Increase memory/CPU per instance:

- 1GB → 2GB: ~$10 extra/month
- 2GB → 4GB: ~$20 extra/month

---

## 🧪 Testing Your Deployment

### 1. Health Check

```bash
curl https://champdf-backend-production.up.railway.app/health
# Expected: {"status":"healthy","ffmpeg":true}
```

### 2. Background Removal API

```bash
curl -X POST \
  https://champdf-backend-production.up.railway.app/api/remove-background \
  -F "file=@test-image.jpg" \
  -F "output_format=png" \
  --output result.png
```

### 3. Video Processing API

```bash
curl -X POST \
  https://champdf-backend-production.up.railway.app/api/process-video \
  -F "file=@test-video.mp4" \
  -F "logo_preset=lakeb2b" \
  -F "watermark_position=bottom-right" \
  --output result.mp4
```

### 4. Load Testing (Optional)

```bash
# Install hey
go install github.com/rakyll/hey@latest

# Test with 100 requests, 10 concurrent
hey -n 100 -c 10 https://champdf-backend-production.up.railway.app/health
```

---

## 🐛 Troubleshooting

### Issue: Model download fails during build

**Solution:** Railway build timeout is 30 min. If it fails:

```dockerfile
# In Dockerfile.railway, increase timeout
RUN python -c "..." || echo "Model pre-download skipped"
```

Model will download on first request instead.

### Issue: Cold start is slow (15-20s)

**Solution:** This is expected on Hobby plan. Upgrade to Developer plan ($10/mo) for always-on instances.

### Issue: Out of memory errors

**Solution:** Reduce workers or upgrade RAM:

```env
WEB_CONCURRENCY=1  # Use 1 worker for 512MB RAM
```

### Issue: FFmpeg not found

**Solution:** Ensure Dockerfile includes:

```dockerfile
RUN apt-get install -y ffmpeg
```

### Issue: CORS errors in frontend

**Solution:** Add frontend domain to `ALLOWED_ORIGINS`:

```env
ALLOWED_ORIGINS=https://champdf.com,https://www.champdf.com
```

---

## 💰 Cost Estimate

**Recommended Setup:**

| Service   | Provider             | Monthly Cost         |
| --------- | -------------------- | -------------------- |
| Frontend  | Cloudflare Pages     | $0 (free tier)       |
| Backend   | Railway Hobby        | $5 credit (often $0) |
| Domain    | Cloudflare Registrar | $8-10/year           |
| **Total** |                      | **~$0-5/month**      |

**High Traffic Setup:**

| Service   | Provider               | Monthly Cost             |
| --------- | ---------------------- | ------------------------ |
| Frontend  | Cloudflare Pages       | $0 (unlimited bandwidth) |
| Backend   | Railway Developer      | $10                      |
| CDN       | Cloudflare (free tier) | $0                       |
| Domain    | Cloudflare             | $8-10/year               |
| **Total** |                        | **~$10/month**           |

---

## 🎓 Additional Resources

- [Railway Docs](https://docs.railway.app)
- [Railway CLI Reference](https://docs.railway.app/develop/cli)
- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [FastAPI Deployment Guide](https://fastapi.tiangolo.com/deployment/docker/)
- [Uvicorn Workers Configuration](https://www.uvicorn.org/deployment/#running-with-gunicorn)

---

## 📞 Support

If you encounter issues:

1. Check Railway logs: `railway logs`
2. Verify environment variables in Railway Dashboard
3. Test health endpoint: `/health`
4. Review Railway status page: https://status.railway.app
5. Railway Discord: https://discord.gg/railway

---

**Last Updated:** January 2026
**chamPDF Version:** 1.16.0

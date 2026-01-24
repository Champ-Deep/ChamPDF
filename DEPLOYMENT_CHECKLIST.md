# Quick Deployment Checklist

## Pre-Deployment Setup

### 1. Backend Configuration

- [ ] Review [backend/main.py](backend/main.py) CORS settings
- [ ] Set `ALLOWED_ORIGINS` environment variable for production domains
- [ ] Test backend locally: `cd backend && uvicorn main:app --reload`
- [ ] Verify health endpoint: `curl http://localhost:8000/health`
- [ ] Test background removal API with sample image
- [ ] Test video processing API with sample video

### 2. Frontend Configuration

- [ ] Set `VITE_API_URL` to your Railway backend URL
- [ ] Enable CDN mode: `VITE_USE_CDN=true`
- [ ] Test frontend build locally: `npm run build:production`
- [ ] Verify build output in `dist/` directory

### 3. Repository Setup

- [ ] Commit all changes to git
- [ ] Push to GitHub main branch
- [ ] Ensure repository is public or Railway has access

## Railway Backend Deployment

### Step-by-Step

1. [ ] Go to [Railway Dashboard](https://railway.app)
2. [ ] Click "New Project" → "Deploy from GitHub repo"
3. [ ] Select `chamPDF` repository
4. [ ] Configure service:
   - [ ] Name: `champdf-backend`
   - [ ] Root Directory: `/backend`
   - [ ] Dockerfile Path: `Dockerfile.railway`
5. [ ] Add environment variables:
   ```
   PORT=8000
   LOG_LEVEL=info
   WEB_CONCURRENCY=2
   ALLOWED_ORIGINS=https://your-domain.com
   MAX_VIDEO_SIZE_MB=100
   MAX_IMAGE_SIZE_MB=10
   ```
6. [ ] Deploy and wait for build (~5-10 min first time)
7. [ ] Copy Railway-assigned URL: `https://champdf-backend-xxxxx.up.railway.app`
8. [ ] Test health check: `curl https://your-backend-url/health`

### Post-Deployment Verification

- [ ] Health endpoint returns `{"status":"healthy","ffmpeg":true}`
- [ ] Background removal endpoint works
- [ ] Video processing endpoint works
- [ ] Logs show no errors
- [ ] Memory usage is normal (<80%)

## Frontend Deployment (Cloudflare Pages)

### Step-by-Step

1. [ ] Go to [Cloudflare Pages](https://pages.cloudflare.com)
2. [ ] Click "Create a project"
3. [ ] Connect GitHub account
4. [ ] Select `chamPDF` repository
5. [ ] Configure build:
   ```
   Build command:       npm run build:production
   Build output dir:    dist
   Root directory:      /
   Framework preset:    None
   ```
6. [ ] Add environment variables:
   ```
   BASE_URL=/
   VITE_API_URL=https://champdf-backend-xxxxx.up.railway.app
   VITE_USE_CDN=true
   NODE_OPTIONS=--max-old-space-size=4096
   ```
7. [ ] Click "Save and Deploy"
8. [ ] Wait for build (~3-5 min)
9. [ ] Your site is live at: `https://champdf.pages.dev`

### Post-Deployment Verification

- [ ] Site loads correctly
- [ ] All PDF tools work (client-side)
- [ ] Background removal tool connects to backend
- [ ] Video rebrander connects to backend
- [ ] No CORS errors in browser console
- [ ] Performance is good (<2s page load)

## Custom Domain Setup (Optional)

### Cloudflare Pages

1. [ ] Go to Pages → Custom domains
2. [ ] Add `champdf.com` and `www.champdf.com`
3. [ ] Update DNS records:

   ```
   Type: CNAME
   Name: @
   Value: champdf.pages.dev

   Type: CNAME
   Name: www
   Value: champdf.pages.dev
   ```

4. [ ] Wait for SSL provisioning (~5 min)
5. [ ] Update backend `ALLOWED_ORIGINS`:
   ```
   ALLOWED_ORIGINS=https://champdf.com,https://www.champdf.com
   ```

## Security Hardening

- [ ] Update CORS to specific domains (remove wildcards)
- [ ] Enable Railway DDoS protection
- [ ] Add rate limiting to backend endpoints
- [ ] Review and restrict file upload sizes
- [ ] Set up monitoring alerts
- [ ] Enable automatic security updates
- [ ] Review logs for suspicious activity

## Monitoring Setup

### Railway

- [ ] Enable observability in Railway Dashboard
- [ ] Set up alerts:
  - [ ] High memory usage (>80%)
  - [ ] Error rate (>5%)
  - [ ] Response time (>5s)
- [ ] Configure log retention

### Cloudflare Pages

- [ ] Enable Web Analytics
- [ ] Review Core Web Vitals
- [ ] Set up custom error pages

## Performance Optimization

### Backend

- [ ] Verify model pre-downloaded during build
- [ ] Check worker count matches RAM allocation
- [ ] Monitor cold start times
- [ ] Set up persistent storage for model cache (optional)

### Frontend

- [ ] Verify Brotli/Gzip compression enabled
- [ ] Check CDN cache headers
- [ ] Monitor Core Web Vitals
- [ ] Optimize WASM loading

## Cost Management

- [ ] Review Railway usage dashboard
- [ ] Set spending alerts in Railway
- [ ] Monitor bandwidth usage
- [ ] Consider Railway volume for model persistence
- [ ] Optimize video file size limits if needed

## Rollback Plan

If something goes wrong:

### Backend

1. [ ] Railway Dashboard → Deployments → Previous version → Redeploy
2. [ ] Or: `git revert HEAD && git push origin main`

### Frontend

1. [ ] Cloudflare Pages → Deployments → Previous deployment → Rollback
2. [ ] Or: Redeploy previous git commit

## Load Testing (Optional)

- [ ] Install load testing tool: `go install github.com/rakyll/hey@latest`
- [ ] Test health endpoint: `hey -n 1000 -c 10 https://your-backend/health`
- [ ] Test background removal: Use Postman/Insomnia for file uploads
- [ ] Monitor Railway metrics during test
- [ ] Verify no errors or timeouts

## Documentation

- [ ] Update README with deployment URLs
- [ ] Document environment variables
- [ ] Create runbook for common issues
- [ ] Share credentials securely (1Password, etc.)

## Final Verification

- [ ] All backend endpoints respond correctly
- [ ] All frontend tools work properly
- [ ] CORS configured correctly
- [ ] SSL certificates valid
- [ ] Custom domain working (if configured)
- [ ] Monitoring and alerts active
- [ ] Logs show no errors
- [ ] Performance meets expectations
- [ ] Security checklist completed
- [ ] Team has access to dashboards

---

## Emergency Contacts

- **Railway Support**: https://railway.app/help
- **Cloudflare Support**: https://support.cloudflare.com
- **Project Maintainer**: [Your contact info]

## Useful Commands

```bash
# Railway CLI
railway login
railway logs
railway status
railway open
railway environment

# Test backend locally
cd backend
uvicorn main:app --reload

# Test frontend locally
VITE_API_URL=http://localhost:8000 npm run dev

# Build frontend
npm run build:production

# Test API endpoints
curl https://your-backend/health
curl -X POST https://your-backend/api/remove-background \
  -F "file=@image.jpg" -o result.png
```

---

**Last Updated:** January 2026

# FixIt AI Proxy — Railway Deployment Guide

## Quick Deploy (10 minutes)

### Step 1: Push to GitHub
```bash
cd Dev/proxy
git init
git add .
git commit -m "FixIt AI proxy with rate limiting"
# Create a new PRIVATE repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/cooltech-proxy.git
git push -u origin main
```

### Step 2: Deploy on Railway
1. Go to https://railway.app
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `cooltech-proxy` repo
4. Railway auto-detects Node.js and runs `npm start`

### Step 3: Set Environment Variables
In Railway dashboard → your service → **Variables** tab:

| Variable | Value | Required |
|----------|-------|----------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | YES |
| `RATE_LIMIT_FREE` | `5` | No (default: 5) |
| `STRIPE_PAYMENT_LINK` | `https://buy.stripe.com/...` | No (add when ready) |
| `ALLOWED_ORIGINS` | `https://yourdomain.com` | No (default: all) |

### Step 4: Update Your App
Once deployed, Railway gives you a URL like `https://cooltech-proxy-production-XXXX.up.railway.app`

Update the PROXY constant in your `index.html`:
```javascript
const PROXY = 'https://your-new-railway-url.up.railway.app';
```

### Step 5: Delete the Old Proxy
Once the new one is working, delete the old Railway service to avoid confusion.

## What This Proxy Does

- **Rate limits**: 5 requests/day per IP (free tier), 3 requests/minute (burst protection)
- **Input validation**: Max 10K chars text, max 5 images, max 2000 tokens
- **Model lock**: Only allows Claude Sonnet (prevents model switching attacks)
- **Size limit**: 500KB max request body (prevents text bombs)
- **Security headers**: Helmet.js adds standard security headers
- **CORS**: Configurable allowed origins
- **Cost control**: Caps max_tokens at 2000 per request

## Testing Locally
```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# Then: curl -X POST http://localhost:3000/ai -H "Content-Type: application/json" -d '{"system":"test","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}'
```

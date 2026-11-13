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
3. Select your `fixit-ai-proxy` repo
4. Railway auto-detects Node.js and runs `npm start`

### Step 3: Add Redis (do this before launch)
In your Railway project → **+ New** → **Database** → **Add Redis**. Then in your
proxy service → **Variables** → **+ New Variable** → **Add Reference** → pick the
Redis service's `REDIS_URL`.

Without Redis, everything is kept in memory: **every deploy or restart hands every
user a brand-new free trial and wipes all limits.** The server prints a
`WARNING: No working REDIS_URL` line at startup when this is the case — check the
deploy logs after each deploy.

### Step 4: Set Environment Variables
In Railway dashboard → your service → **Variables** tab:

| Variable | Value | Required |
|----------|-------|----------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | YES |
| `FIREBASE_PROJECT_ID` | your Firebase project ID | YES (server won't start without it) |
| `REDIS_URL` | reference to the Railway Redis service | Strongly recommended |
| `TRIAL_DAYS` | `7` | No (default: 7) |
| `TRIAL_DAILY_CAP` | `10` | No (default: 10) — max diagnoses per user per day during the trial |
| `FREE_MONTHLY` | `3` | No (default: 3) — free diagnoses per 30 days after the trial |
| `GLOBAL_DAILY_CAP` | `2000` | No (default: 2000) — max diagnoses per day across ALL users |
| `STRIPE_PAYMENT_LINK` | `https://buy.stripe.com/...` | No (add when ready) |
| `ALLOWED_ORIGINS` | `https://yourdomain.com` | No (has built-in defaults) |

(`RATE_LIMIT_FREE`, listed in older versions of this guide, is not read by the
code — use `FREE_MONTHLY`.)

**Picking `GLOBAL_DAILY_CAP`:** it's your worst-case daily AI bill divided by the
cost of one diagnosis. Check a few `DIAG` log lines for typical token counts and
your Anthropic usage page for the real per-request cost (photos cost more). For
example, at roughly $0.02–$0.05 per diagnosis, 2000/day caps spend at about
$40–$100/day. Lower it while you're small; raise it as real usage grows. When the
cap is hit, the logs show `🚨 GLOBAL DAILY CAP HIT` and the app gets a "busy"
message until midnight UTC.

### Step 5: Set spend alerts (5 minutes, do it now)
- **Anthropic:** console.anthropic.com → **Settings → Limits / Billing**: set a
  monthly **spend limit** and an email **usage alert** below it. This is the hard
  backstop if anything here ever fails.
- **Railway:** project → **Settings → Usage**: set a **usage limit / alert** so a
  traffic spike can't run up hosting costs.

### Step 6: Update Your App
Once deployed, Railway gives you a URL like `https://fixit-ai-proxy-production-XXXX.up.railway.app`

Update the PROXY constant in your `index.html`:
```javascript
const PROXY = 'https://your-new-railway-url.up.railway.app';
```

### Step 7: Delete the Old Proxy
Once the new one is working, delete the old Railway service to avoid confusion.

## What This Proxy Does

- **Free trial**: 7 days from a user's first request, up to 10 diagnoses/day (`TRIAL_DAYS`, `TRIAL_DAILY_CAP`).
  The trial start is saved in Redis per Firebase user, so restarts/deploys don't reset it.
- **After the trial**: 3 free diagnoses per 30 days per user (`FREE_MONTHLY`)
- **Burst protection**: 3 requests/minute per user
- **Global circuit breaker**: at most `GLOBAL_DAILY_CAP` (default 2000) diagnoses/day across all users
- **Paid users**: not recognized yet — see the TODO in `server.js` (`trialDailyLimiter` / `freeLimiter`)
- **Input validation**: Max 10K chars text, max 5 images, max 2000 tokens
- **Model lock**: Only allows Claude Sonnet (prevents model switching attacks)
- **Size limit**: 2MB max request body (prevents text bombs; fits ~5 images)
- **Security headers**: Helmet.js adds standard security headers
- **CORS**: Configurable allowed origins
- **Cost control**: Caps max_tokens at 2000 per request

## Testing Locally
```bash
npm install
npm test   # automated tests (Redis, Firebase and Anthropic are mocked)
ANTHROPIC_API_KEY=sk-ant-... FIREBASE_PROJECT_ID=your-project-id node server.js
# Then: curl -X POST http://localhost:3000/ai -H "Content-Type: application/json" -d '{"system":"test","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}'
```

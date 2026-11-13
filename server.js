/**
 * FixIt AI Proxy Server
 * ─────────────────────
 * Sits between the app and Anthropic's API.
 * Handles: rate limiting, input validation, CORS, API key security.
 *
 * Deploy to Railway:
 *   1. Push this folder to a GitHub repo
 *   2. Connect repo to Railway
 *   3. Set environment variable: ANTHROPIC_API_KEY=sk-ant-...
 *   4. Add Redis from Railway dashboard (one-click add-on)
 *   5. Set REDIS_URL (Railway does this automatically when you add Redis)
 *   6. Railway auto-detects Node and runs `npm start`
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   — Required. Your Anthropic API key.
 *   PORT                — Optional. Railway sets this automatically.
 *   RATE_LIMIT_FREE     — Optional. Max requests per IP per day (default: 3)
 *   ALLOWED_ORIGINS     — Optional. Comma-separated origins (default: capacitor://localhost, https://localhost, http://localhost:3333)
 *   STRIPE_PAYMENT_LINK — Optional. Your Stripe payment URL for upgrades.
 *   REDIS_URL           — Optional. Redis connection URL for persistent rate limiting.
 *                          If not set, falls back to in-memory (resets on deploy/restart).
 *   FIREBASE_PROJECT_ID — Required. Your Firebase project ID for token verification.
 *   TRIAL_DAYS          — Optional. Length of the free trial in days (default: 7)
 *   FREE_MONTHLY        — Optional. Free diagnoses per 30 days after the trial (default: 3)
 *   TRIAL_DAILY_CAP     — Optional. Max requests per user per UTC day during the trial (default: 10)
 *   GLOBAL_DAILY_CAP    — Optional. Max requests across ALL users per UTC day — a circuit
 *                          breaker that protects the Anthropic bill (default: 2000)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { KEY_PREFIX, todayUTC, nextResetUTC, createUsageStore, LongWindowMemoryStore } = require('./usage');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════

// Basic security headers
app.use(helmet());

// CORS — restrict to your domains in production.
// Set ALLOWED_ORIGINS on Railway to override this list (comma-separated).
// Defaults cover: Capacitor native apps, localhost dev, and current production web origins.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'capacitor://localhost',
      'https://localhost',
      'http://localhost:3333',
      'https://animated-tapioca-b59102.netlify.app',
      'https://deploy-zeta-sage.vercel.app'
    ];

app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Trust first proxy (Railway) so req.ip is the real client IP
app.set('trust proxy', 1);

// Parse JSON with size limit (prevents text bombs).
// 2MB is enough for ~5 photos at 1200×1200 base64-encoded; images are pre-compressed client-side.
app.use(express.json({ limit: '2mb' }));

// ═══════════════════════════════════════
// FIREBASE AUTH (token verification)
// ═══════════════════════════════════════

if (!process.env.FIREBASE_PROJECT_ID) {
  console.error('FATAL: FIREBASE_PROJECT_ID not set — refusing to start without auth.');
  process.exit(1);
}

let firebaseEnabled = false;
try {
  admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  firebaseEnabled = true;
  console.log(`Firebase Auth enabled (project: ${process.env.FIREBASE_PROJECT_ID})`);
} catch (err) {
  console.error('FATAL: Firebase Admin init failed:', err.message);
  process.exit(1);
}

// Middleware: verify Firebase ID token from Authorization header
async function verifyAuth(req, res, next) {

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Authentication required. Please sign in.', type: 'auth_required' }
    });
  }

  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = decoded.email;
    next();
  } catch (err) {
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({
        error: { message: 'Session expired. Please sign in again.', type: 'token_expired' }
      });
    }
    return res.status(401).json({
      error: { message: 'Invalid authentication. Please sign in again.', type: 'auth_invalid' }
    });
  }
}

// ═══════════════════════════════════════
// REDIS (persistent rate limiting)
// ═══════════════════════════════════════

let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      enableOfflineQueue: true
    });
    redisClient.on('connect', () => console.log('Redis connected — persistent rate limiting active'));
    redisClient.on('error', (err) => console.error('Redis error:', err.message));
  } catch (err) {
    redisClient = null;
    console.warn('Redis setup failed, using in-memory rate limiting:', err.message);
  }
}
if (!redisClient) {
  console.warn('⚠️  WARNING: No working REDIS_URL — trial dates and all usage counters are IN MEMORY.');
  console.warn('⚠️  Every deploy/restart gives every user a fresh trial and resets all limits.');
  console.warn('⚠️  Add Redis on Railway before launch (see DEPLOY.md).');
}

// Each rate limiter gets its OWN Redis store with its OWN key prefix.
// (Sharing one store made the burst and monthly limiters overwrite each other's counts.)
function makeRedisStore(prefix) {
  if (!redisClient) return null;
  const { RedisStore } = require('rate-limit-redis');
  return new RedisStore({ prefix, sendCommand: (...args) => redisClient.call(...args) });
}
const burstStore = makeRedisStore(KEY_PREFIX.burst);
// Without Redis, the monthly limiter needs a memory store that supports a 30-day window.
const monthlyStore = makeRedisStore(KEY_PREFIX.monthly) || new LongWindowMemoryStore();

// Trial start dates + daily counters (Redis if available, else memory)
const usageStore = createUsageStore(redisClient);

// ═══════════════════════════════════════
// RATE LIMITING — TRIAL-AWARE
// ═══════════════════════════════════════
// Model: 7-day trial (up to TRIAL_DAILY_CAP a day) → then N free diagnoses /
// 30-day rolling window. On top of that, GLOBAL_DAILY_CAP stops ALL AI calls
// for the rest of the UTC day if total traffic spikes (protects the bill).
// The trial start per UID is stored in Redis, so restarts don't reset it.

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS) || 7;
const FREE_MONTHLY = parseInt(process.env.FREE_MONTHLY) || 3;
const TRIAL_DAILY_CAP = parseInt(process.env.TRIAL_DAILY_CAP) || 10;
const GLOBAL_DAILY_CAP = parseInt(process.env.GLOBAL_DAILY_CAP) || 2000;

// Legacy env alias — keep so existing Railway var doesn't blow up
const FREE_LIMIT = FREE_MONTHLY;

// Use Firebase UID if authenticated (fair per-user limiting), fall back to IP
const userKey = (req) => req.uid || req.ip;

// Middleware: look up (or record) when this user's trial started.
// Sets req.inTrial and req.trialDaysLeft for the limiters and headers below.
async function loadTrial(req, res, next) {
  try {
    req.inTrial = false;
    req.trialDaysLeft = 0;
    if (req.uid) {
      const start = await usageStore.getTrialStart(req.uid);
      const msLeft = TRIAL_DAYS * DAY_MS - (Date.now() - start);
      req.inTrial = msLeft > 0;
      req.trialDaysLeft = Math.max(0, Math.ceil(msLeft / DAY_MS));
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Expose trial+quota status on every /ai response via headers.
function attachTrialHeaders(req, res) {
  if (!req.uid) return;
  res.setHeader('X-Trial-Days-Left', String(req.trialDaysLeft));
  res.setHeader('X-Trial-Active', req.inTrial ? '1' : '0');
}

// Middleware: hard daily cap for trial users (TRIAL_DAILY_CAP per UTC day).
async function trialDailyLimiter(req, res, next) {
  // TODO: Skip for paid/subscribed users once payments exist (e.g. a Firebase
  // custom claim like decoded.paid). Today nobody can pay, so everyone is free.
  if (!req.inTrial) return next();
  try {
    const key = `${KEY_PREFIX.trialDaily}${todayUTC()}:${req.uid}`;
    const count = await usageStore.incrementDaily(key);
    if (count > TRIAL_DAILY_CAP) {
      attachTrialHeaders(req, res);
      return res.status(429).json({
        error: 'daily_limit',
        message: `You've reached today's limit of ${TRIAL_DAILY_CAP} diagnoses. Try again tomorrow.`,
        limit: TRIAL_DAILY_CAP,
        resetAt: nextResetUTC()
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware: global circuit breaker — total AI calls across ALL users per UTC day.
async function globalDailyBreaker(req, res, next) {
  try {
    const count = await usageStore.incrementDaily(`${KEY_PREFIX.globalDaily}${todayUTC()}`);
    if (count > GLOBAL_DAILY_CAP) {
      if (count === GLOBAL_DAILY_CAP + 1) {
        console.error(`🚨 GLOBAL DAILY CAP HIT: ${GLOBAL_DAILY_CAP} AI requests today. ` +
          `All AI calls are paused until ${nextResetUTC()}. Check for abuse, or raise GLOBAL_DAILY_CAP.`);
      } else if (count % 100 === 0) {
        console.error(`🚨 GLOBAL DAILY CAP still active: ${count} requests blocked/attempted today.`);
      }
      return res.status(503).json({
        error: 'service_busy',
        message: 'FixIt AI is very busy right now. Please try again later.'
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

const freeLimiter = rateLimit({
  windowMs: 30 * 24 * 60 * 60 * 1000,   // 30-day rolling window
  max: FREE_MONTHLY,                      // N free looks after trial ends
  standardHeaders: true,                  // Return rate limit info in headers
  legacyHeaders: false,
  store: monthlyStore,
  keyGenerator: userKey,
  handler: (req, res) => {
    attachTrialHeaders(req, res);
    res.status(429).json({
      error: {
        message: `You've used your ${FREE_MONTHLY} free diagnoses this month. Upgrade for unlimited.`,
        type: 'monthly_limit_reached',
        upgrade_url: process.env.STRIPE_PAYMENT_LINK || null
      }
    });
  },
  skip: (req) => {
    // Skip the monthly limiter entirely for users still inside their trial.
    // TODO: Also skip for paid/subscribed users (check Firebase custom claim).
    if (req.uid && req.inTrial) return true;
    return false;
  }
});

// Burst protection: max 3 requests per minute (even for paid users)
const burstLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 3,                 // 3 per minute
  standardHeaders: true,
  legacyHeaders: false,
  ...(burstStore && { store: burstStore }),
  keyGenerator: userKey,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        message: 'Too many requests. Please wait a moment before trying again.',
        type: 'burst_limit_exceeded'
      }
    });
  }
});

// ═══════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════

function validateRequest(body) {
  const errors = [];

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    errors.push('messages is required and must be a non-empty array');
  }

  if (!body.system || typeof body.system !== 'string') {
    errors.push('system prompt is required');
  }

  // Enforce max tokens to control costs
  if (body.max_tokens && body.max_tokens > 2000) {
    errors.push('max_tokens cannot exceed 2000');
  }

  // Validate message content size
  if (body.messages) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string' && msg.content.length > 10000) {
        errors.push('Message content too long (max 10000 chars)');
        break;
      }
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(c => c.type === 'text');
        const totalText = textParts.reduce((sum, c) => sum + (c.text?.length || 0), 0);
        if (totalText > 10000) {
          errors.push('Total text content too long (max 10000 chars)');
          break;
        }
        // Limit number of images
        const imageParts = msg.content.filter(c => c.type === 'image');
        if (imageParts.length > 5) {
          errors.push('Too many images (max 5)');
          break;
        }
      }
    }
  }

  return errors;
}

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

// Health check (Railway uses this)
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FixIt AI Proxy',
    version: '1.0.0'
  });
});

// Upgrade URL endpoint (app calls this to get payment link)
app.get('/upgrade', (req, res) => {
  const url = process.env.STRIPE_PAYMENT_LINK;
  if (url) {
    res.json({ url });
  } else {
    res.status(503).json({ error: { message: 'Upgrade not yet available.' } });
  }
});

// Main AI endpoint — auth verified, rate limited
// Order matters: per-user limits run first, so blocked users never count
// toward the global cap.
app.post('/ai', verifyAuth, burstLimiter, loadTrial, trialDailyLimiter, freeLimiter, globalDailyBreaker, async (req, res) => {
  // Validate API key is configured
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({
      error: { message: 'Server configuration error. Contact support.' }
    });
  }

  // Validate input
  const errors = validateRequest(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: { message: errors.join('; ') } });
  }

  try {
    // Only allow the model we control (prevent model switching attacks)
    const allowedModel = 'claude-sonnet-4-20250514';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: allowedModel,
        max_tokens: Math.min(req.body.max_tokens || 1800, 2000),
        system: req.body.system,
        messages: req.body.messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', { status: response.status, type: data?.error?.type });
      return res.status(response.status).json({
        error: { message: data.error?.message || 'AI service error. Try again.' }
      });
    }

    // Usage log — one line per successful diagnosis for DAU/volume analysis.
    // Keyed by Firebase UID (hashed prefix only, so raw UID never lands in logs).
    // Grep Railway logs for `DIAG` to count.
    const uidHash = req.uid ? String(req.uid).slice(0, 8) : 'anon';
    console.log('DIAG', JSON.stringify({
      ts: new Date().toISOString(),
      uid: uidHash,
      trial: req.inTrial ? 1 : 0,
      in: data.usage?.input_tokens,
      out: data.usage?.output_tokens
    }));

    // Expose trial status so client can render "3 days left in trial" etc.
    attachTrialHeaders(req, res);

    // Return only what the client needs (strip metadata)
    res.json({
      content: data.content,
      usage: {
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens
      }
    });

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({
      error: { message: 'Could not reach AI service. Try again in a moment.' }
    });
  }
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found' } });
});

// Global error handler (prevents crash on unhandled exceptions)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: { message: 'Internal server error. Try again.' } });
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

function start() {
  return app.listen(PORT, () => {
    console.log(`FixIt AI Proxy running on port ${PORT}`);
    console.log(`Trial: ${TRIAL_DAYS} days, max ${TRIAL_DAILY_CAP} requests/day per user`);
    console.log(`After trial: ${FREE_LIMIT} free requests per 30 days per user`);
    console.log(`Burst limit: 3 requests/minute per user`);
    console.log(`Global cap: ${GLOBAL_DAILY_CAP} requests/day across all users`);
    console.log(`Storage: ${redisClient ? 'Redis (persistent)' : 'In-memory (resets on restart)'}`);
    console.log(`Auth: ${firebaseEnabled ? 'Firebase (required)' : 'Disabled (open access)'}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('⚠️  WARNING: ANTHROPIC_API_KEY not set! AI calls will fail.');
    }
    if (process.env.STRIPE_PAYMENT_LINK) {
      console.log(`Upgrade URL: ${process.env.STRIPE_PAYMENT_LINK}`);
    }
  });
}

// Start the server when run directly (`npm start`); tests import the app instead.
if (require.main === module) start();

module.exports = { app, start };

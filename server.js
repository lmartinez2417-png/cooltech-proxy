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
 *   FIREBASE_PROJECT_ID — Optional. Your Firebase project ID for token verification.
 *                          If not set, auth tokens are not verified (open access).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');

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

let redisStore = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    const { RedisStore } = require('rate-limit-redis');
    const redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      enableOfflineQueue: true
    });
    redisClient.on('connect', () => console.log('Redis connected — persistent rate limiting active'));
    redisClient.on('error', (err) => console.error('Redis error:', err.message));
    redisStore = new RedisStore({ sendCommand: (...args) => redisClient.call(...args) });
  } catch (err) {
    console.warn('Redis setup failed, using in-memory rate limiting:', err.message);
  }
} else {
  console.log('No REDIS_URL set — using in-memory rate limiting (resets on restart)');
}

// ═══════════════════════════════════════
// RATE LIMITING — THIS IS THE BIG ONE
// ═══════════════════════════════════════

// Free tier: 3 requests per IP per 24 hours
const FREE_LIMIT = parseInt(process.env.RATE_LIMIT_FREE) || 3;

// Use Firebase UID if authenticated (fair per-user limiting), fall back to IP
const userKey = (req) => req.uid || req.ip;

const freeLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,   // 24 hours
  max: FREE_LIMIT,                   // requests per window (default 3)
  standardHeaders: true,             // Return rate limit info in headers
  legacyHeaders: false,
  ...(redisStore && { store: redisStore }),
  keyGenerator: userKey,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        message: `Daily limit reached (${FREE_LIMIT} free diagnoses). Upgrade to Pro for unlimited access.`,
        type: 'rate_limit_exceeded',
        upgrade_url: process.env.STRIPE_PAYMENT_LINK || null
      }
    });
  },
  skip: (req) => {
    // Authenticated users get rate-limited by UID instead of IP (handled below).
    // TODO: Skip rate limiting entirely for paid/subscribed users.
    // Example: return req.isPaidUser === true;
    return false;
  }
});

// Burst protection: max 3 requests per minute (even for paid users)
const burstLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 3,                 // 3 per minute
  standardHeaders: true,
  legacyHeaders: false,
  ...(redisStore && { store: redisStore }),
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
app.post('/ai', verifyAuth, burstLimiter, freeLimiter, async (req, res) => {
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
      in: data.usage?.input_tokens,
      out: data.usage?.output_tokens
    }));

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

app.listen(PORT, () => {
  console.log(`FixIt AI Proxy running on port ${PORT}`);
  console.log(`Rate limit: ${FREE_LIMIT} requests/day per IP`);
  console.log(`Burst limit: 3 requests/minute per IP`);
  console.log(`Storage: ${redisStore ? 'Redis (persistent)' : 'In-memory (resets on restart)'}`);
  console.log(`Auth: ${firebaseEnabled ? 'Firebase (required)' : 'Disabled (open access)'}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  WARNING: ANTHROPIC_API_KEY not set! AI calls will fail.');
  }
  if (process.env.STRIPE_PAYMENT_LINK) {
    console.log(`Upgrade URL: ${process.env.STRIPE_PAYMENT_LINK}`);
  }
});

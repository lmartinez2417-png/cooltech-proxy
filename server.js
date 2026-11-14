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
 *   TEAM_DAILY_CAP      — Optional. Max AI requests per team member per UTC day (default: 100)
 *   PLATE_DAILY_CAP     — Optional. Max data plate scans per user per UTC day (default: 30)
 *   ORG_BOOTSTRAP       — Optional. JSON to create/seed the first company on startup, e.g.
 *                          {"id":"infinity-air","name":"Infinity Air Heating and Cooling",
 *                           "domain":"infinityaircool.com","adminEmail":"leo@infinityaircool.com","seatLimit":25}
 *   ORG_DEFAULT_SEATS   — Optional. Seat limit for companies created in the app (default: 10)
 *   ORG_SELF_SERVE_ACTIVE — Optional. "true" = companies created in the app are active
 *                          immediately (default: inactive until you activate them)
 *   PLATFORM_ADMIN_EMAILS — Optional. Comma-separated verified emails allowed to use /admin/orgs
 *   ANTHROPIC_MODEL     — Optional. Model id (default: claude-sonnet-4-20250514)
 *   FAULT_DAILY_CAP     — Optional. Max fault-code lookups per user per UTC day (default: 30)
 *   GAUGE_DAILY_CAP     — Optional. Max gauge/meter photo reads per user per UTC day (default: 40)
 *   CLOSEOUT_DAILY_CAP  — Optional. Max close-out write-ups per user per UTC day (default: 30)
 *   ASK_DAILY_CAP       — Optional. Max "Ask a lead tech" requests per user per UTC day (default: 20)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { KEY_PREFIX, todayUTC, nextResetUTC, createUsageStore, LongWindowMemoryStore } = require('./usage');
const {
  buildAiRequest, buildDataPlateRequest, parsePlate, BadRequest,
  buildFaultRequest, buildGaugeRequest, parseGauge, buildCloseoutRequest, historyBlock, withHistory, clean
} = require('./prompts');
const { createOrgStore, OrgError } = require('./orgs');
const { createEquipmentStore, EqError } = require('./equipment');
const { createAskStore, AskError, isLead } = require('./asks');
const { literatureLinks } = require('./literature');

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
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Trust first proxy (Railway) so req.ip is the real client IP
app.set('trust proxy', 1);

// Parse JSON with size limit (prevents text bombs).
// 10MB covers 5 photos (each capped at ~1.5 MB in prompts.js) plus text;
// the app compresses photos to ~1200px JPEG before sending.
app.use(express.json({ limit: '10mb' }));

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
    req.emailVerified = decoded.email_verified === true;
    req.displayName = decoded.name || null;
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
// RATE LIMITING — TRIAL / TEAM AWARE
// ═══════════════════════════════════════
// Plans, checked in this order for every AI call:
//   team  — member of an ACTIVE organization: no trial/monthly limits, but at
//           most TEAM_DAILY_CAP requests per user per UTC day (safety cap).
//   paid  — TODO: individual subscriptions (see isPaid below).
//   trial — first TRIAL_DAYS days: up to TRIAL_DAILY_CAP per UTC day.
//   free  — after the trial: FREE_MONTHLY per rolling 30 days.
// GLOBAL_DAILY_CAP stops ALL AI calls for the rest of the UTC day if total
// traffic spikes (protects the bill). The trial start per UID is in Redis.

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS) || 7;
const FREE_MONTHLY = parseInt(process.env.FREE_MONTHLY) || 3;
const TRIAL_DAILY_CAP = parseInt(process.env.TRIAL_DAILY_CAP) || 10;
const TEAM_DAILY_CAP = parseInt(process.env.TEAM_DAILY_CAP) || 100;
const PLATE_DAILY_CAP = parseInt(process.env.PLATE_DAILY_CAP) || 30;
const FAULT_DAILY_CAP = parseInt(process.env.FAULT_DAILY_CAP) || 30;
const GAUGE_DAILY_CAP = parseInt(process.env.GAUGE_DAILY_CAP) || 40;
const CLOSEOUT_DAILY_CAP = parseInt(process.env.CLOSEOUT_DAILY_CAP) || 30;
const ASK_DAILY_CAP = parseInt(process.env.ASK_DAILY_CAP) || 20;
const GLOBAL_DAILY_CAP = parseInt(process.env.GLOBAL_DAILY_CAP) || 2000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const PLATFORM_ADMIN_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// Legacy env alias — keep so existing Railway var doesn't blow up
const FREE_LIMIT = FREE_MONTHLY;

// Organizations (team mode) — same Redis as the limits
const orgStore = createOrgStore(redisClient, {
  defaultSeatLimit: parseInt(process.env.ORG_DEFAULT_SEATS) || 10,
  // Self-created companies start INACTIVE (normal limits) unless this is set,
  // so nobody can create a company just to skip the free limits.
  selfServeActive: process.env.ORG_SELF_SERVE_ACTIVE === 'true'
});
// Equipment history (customers/addresses, units, jobs) and the lead-tech queue — same Redis
const equipmentStore = createEquipmentStore(redisClient);
const askStore = createAskStore(redisClient);
let bootstrapDone = null;
function ensureBootstrap() {
  if (!bootstrapDone) {
    bootstrapDone = (async () => {
      if (!process.env.ORG_BOOTSTRAP) return;
      try {
        const cfg = JSON.parse(process.env.ORG_BOOTSTRAP);
        const org = await orgStore.bootstrap(cfg);
        if (org) console.log(`Org bootstrap: ${org.name} (${org.id}) active=${org.active} domain=${org.domain || '-'}`);
      } catch (err) {
        console.error('ORG_BOOTSTRAP failed (expects JSON):', err.message);
      }
    })();
  }
  return bootstrapDone;
}

// Use Firebase UID if authenticated (fair per-user limiting), fall back to IP
const userKey = (req) => req.uid || req.ip;

// TODO(payments): return true for users with an active individual subscription
// (e.g. a Firebase custom claim set by an App Store / Play / RevenueCat webhook).
function isPaid(req) { // eslint-disable-line no-unused-vars
  return false;
}

// Middleware: work out the caller's plan (team / paid / trial / free).
async function loadAccount(req, res, next) {
  try {
    await ensureBootstrap();
    const { org, role } = await orgStore.resolveUser({ uid: req.uid, email: req.email, emailVerified: req.emailVerified });
    req.org = org;
    req.orgRole = role;
    req.isTeam = !!(org && org.active);
    req.isPaid = !req.isTeam && isPaid(req);
    req.inTrial = false;
    req.trialDaysLeft = 0;
    if (req.uid) {
      const start = await usageStore.getTrialStart(req.uid);
      const msLeft = TRIAL_DAYS * DAY_MS - (Date.now() - start);
      req.inTrial = msLeft > 0;
      req.trialDaysLeft = Math.max(0, Math.ceil(msLeft / DAY_MS));
    }
    req.plan = req.isTeam ? 'team' : req.isPaid ? 'paid' : req.inTrial ? 'trial' : 'free';
    next();
  } catch (err) {
    next(err);
  }
}

// Expose trial+quota status via headers.
function attachTrialHeaders(req, res) {
  if (!req.uid) return;
  res.setHeader('X-Trial-Days-Left', String(req.trialDaysLeft));
  res.setHeader('X-Trial-Active', req.inTrial ? '1' : '0');
  if (req.plan) res.setHeader('X-Plan', req.plan);
}

// What the app shows: plan, company, and how many requests are left.
async function accountSummary(req) {
  const today = todayUTC();
  let quota;
  if (req.plan === 'team') {
    const used = await usageStore.getDaily(`${KEY_PREFIX.teamDaily}${today}:${req.uid}`);
    quota = { kind: 'team_daily', limit: TEAM_DAILY_CAP, used, remaining: Math.max(0, TEAM_DAILY_CAP - used), resetAt: nextResetUTC() };
  } else if (req.plan === 'paid') {
    quota = { kind: 'unlimited', limit: null, used: null, remaining: null, resetAt: null };
  } else if (req.plan === 'trial') {
    const used = await usageStore.getDaily(`${KEY_PREFIX.trialDaily}${today}:${req.uid}`);
    quota = { kind: 'trial_daily', limit: TRIAL_DAILY_CAP, used, remaining: Math.max(0, TRIAL_DAILY_CAP - used), resetAt: nextResetUTC() };
  } else {
    const info = await monthlyStore.get(req.uid);
    const used = info ? info.totalHits : 0;
    quota = {
      kind: 'monthly', limit: FREE_MONTHLY, used, remaining: Math.max(0, FREE_MONTHLY - used),
      resetAt: info && info.resetTime ? new Date(info.resetTime).toISOString() : null
    };
  }
  const o = req.org;
  return {
    uid: req.uid,
    email: req.email || null,
    emailVerified: !!req.emailVerified,
    plan: req.plan,
    trial: { active: req.inTrial, daysLeft: req.trialDaysLeft, lengthDays: TRIAL_DAYS },
    quota,
    org: o ? {
      id: o.id, name: o.name, active: !!o.active, plan: o.plan, seatLimit: o.seatLimit,
      domain: o.domain, logo: o.logo || null, role: req.orgRole,
      inviteCode: req.orgRole === 'admin' ? o.inviteCode : undefined
    } : null
  };
}

function limitResponse(req, res, status, error, extra = {}) {
  attachTrialHeaders(req, res);
  return res.status(status).json({ error, ...extra });
}

// Middleware: per-user safety cap for team members (TEAM_DAILY_CAP per UTC day).
async function teamDailyLimiter(req, res, next) {
  if (!req.isTeam) return next();
  try {
    const count = await usageStore.incrementDaily(`${KEY_PREFIX.teamDaily}${todayUTC()}:${req.uid}`);
    if (count > TEAM_DAILY_CAP) {
      return limitResponse(req, res, 429, {
        message: `You've reached today's team safety limit of ${TEAM_DAILY_CAP} requests. It resets at midnight UTC.`,
        type: 'team_daily_limit'
      }, { limit: TEAM_DAILY_CAP, resetAt: nextResetUTC() });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware: hard daily cap for trial users (TRIAL_DAILY_CAP per UTC day).
async function trialDailyLimiter(req, res, next) {
  if (req.plan !== 'trial') return next();
  try {
    const key = `${KEY_PREFIX.trialDaily}${todayUTC()}:${req.uid}`;
    const count = await usageStore.incrementDaily(key);
    if (count > TRIAL_DAILY_CAP) {
      return limitResponse(req, res, 429, {
        message: `You've reached today's limit of ${TRIAL_DAILY_CAP} diagnoses. Try again tomorrow.`,
        type: 'daily_limit'
      }, { limit: TRIAL_DAILY_CAP, resetAt: nextResetUTC() });
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
      return res.status(429).json({
        error: {
          message: 'FixIt AI is very busy right now. Please try again later.',
          type: 'service_busy'
        },
        resetAt: nextResetUTC()
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
    limitResponse(req, res, 429, {
      message: `You've used your ${FREE_MONTHLY} free diagnoses for this 30-day period.`,
      type: 'monthly_limit_reached',
      upgrade_url: process.env.STRIPE_PAYMENT_LINK || null
    }, {
      limit: FREE_MONTHLY,
      resetAt: req.rateLimit && req.rateLimit.resetTime ? new Date(req.rateLimit.resetTime).toISOString() : null
    });
  },
  // Only free (post-trial, non-team, unpaid) users use the monthly allowance.
  skip: (req) => req.plan !== 'free'
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
      },
      resetAt: req.rateLimit && req.rateLimit.resetTime ? new Date(req.rateLimit.resetTime).toISOString() : null
    });
  }
});

// Light, separate per-user daily caps for the helper tools (don't use the trial/monthly
// diagnosis allowance): data plate scans, fault-code lookups, gauge reads, close-outs, lead asks.
function dailyCap(prefix, cap, type, what) {
  return async (req, res, next) => {
    try {
      const count = await usageStore.incrementDaily(`${prefix}${todayUTC()}:${req.uid}`);
      if (count > cap) {
        return limitResponse(req, res, 429, { message: `You've reached today's limit of ${cap} ${what}.`, type },
          { limit: cap, resetAt: nextResetUTC() });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
const plateDailyLimiter = dailyCap(KEY_PREFIX.plateDaily, PLATE_DAILY_CAP, 'plate_daily_limit', 'data plate scans');
const faultDailyLimiter = dailyCap(KEY_PREFIX.faultDaily, FAULT_DAILY_CAP, 'fault_daily_limit', 'fault code lookups');
const gaugeDailyLimiter = dailyCap(KEY_PREFIX.gaugeDaily, GAUGE_DAILY_CAP, 'gauge_daily_limit', 'gauge photo reads');
const closeoutDailyLimiter = dailyCap(KEY_PREFIX.closeoutDaily, CLOSEOUT_DAILY_CAP, 'closeout_daily_limit', 'close-outs');
const askDailyLimiter = dailyCap(KEY_PREFIX.askDaily, ASK_DAILY_CAP, 'ask_daily_limit', 'lead tech requests');

// ═══════════════════════════════════════
// INPUT VALIDATION (prompts are built server-side — see prompts.js)
// ═══════════════════════════════════════

function validateWith(builder) {
  return (req, res, next) => {
    try {
      req.aiRequest = builder(req.body);
      next();
    } catch (err) {
      if (err instanceof BadRequest) {
        return res.status(err.type === 'app_update_required' ? 426 : 400)
          .json({ error: { message: err.message, type: err.type } });
      }
      next(err);
    }
  };
}

async function callAnthropic({ system, messages, maxTokens }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
  });
  const data = await response.json();
  return { response, data };
}

function requireApiKey(req, res, next) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: { message: 'Server configuration error. Contact support.', type: 'server_config' } });
  }
  next();
}

// Wrap async route handlers so errors reach the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sendOrgError(res, err) {
  return res.status(err.status).json({ error: { message: err.message, type: err.type } });
}
const orgRoute = (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof OrgError) return sendOrgError(res, err);
    throw err;
  }
});

function requireOrgAdmin(req, res, next) {
  if (!req.org) return res.status(404).json({ error: { message: 'You are not in a company.', type: 'no_org' } });
  if (req.orgRole !== 'admin') return res.status(403).json({ error: { message: 'Only company admins can do that.', type: 'forbidden' } });
  next();
}

function requirePlatformAdmin(req, res, next) {
  if (!req.emailVerified || !PLATFORM_ADMIN_EMAILS.includes(String(req.email || '').toLowerCase())) {
    return res.status(403).json({ error: { message: 'Forbidden', type: 'forbidden' } });
  }
  next();
}

// Equipment history scope: the company (shared by all its techs) or the solo user.
const eqScope = (req) => (req.org ? `org:${req.org.id}` : `user:${req.uid}`);
const eqAdmin = (req) => !req.org || req.orgRole === 'admin';

// If the app sends siteId (and optionally unitIds), add that customer's equipment
// and recent jobs to the diagnosis as data. Unknown ids are ignored, never an error.
async function attachHistory(req, res, next) {
  try {
    const siteId = req.body && req.body.siteId;
    if (!siteId) return next();
    const full = await equipmentStore.getSiteFull(eqScope(req), String(siteId), 5);
    if (!full) return next();
    const ids = Array.isArray(req.body.unitIds) ? req.body.unitIds : null;
    const units = ids && ids.length ? full.units.filter((u) => ids.includes(u.id)) : full.units;
    const jobs = ids && ids.length ? full.jobs.filter((j) => !j.unitIds.length || j.unitIds.some((u) => ids.includes(u))) : full.jobs;
    req.aiRequest = withHistory(req.aiRequest, historyBlock(full.site, units.length ? units : full.units, jobs));
    req.historyUsed = true;
    next();
  } catch (err) {
    next(err);
  }
}

// Shared Anthropic call + error mapping for the tool endpoints. Returns the text or null (response sent).
async function aiTextOrError(req, res, tag) {
  let result;
  try {
    result = await callAnthropic(req.aiRequest);
  } catch (err) {
    res.status(502).json({ error: { message: 'Could not reach AI service. Try again in a moment.', type: 'upstream_unreachable' } });
    return null;
  }
  const { response, data } = result;
  if (!response.ok) {
    console.error(`Anthropic API error (${tag}):`, { status: response.status, type: data?.error?.type });
    res.status(502).json({ error: { message: 'AI service error. Try again.', type: 'upstream_error' } });
    return null;
  }
  console.log(tag.toUpperCase(), JSON.stringify({ ts: new Date().toISOString(), uid: String(req.uid).slice(0, 8), org: req.org ? req.org.id : null, in: data.usage?.input_tokens, out: data.usage?.output_tokens }));
  return { text: (data.content || []).map((c) => c.text || '').join('').trim(), data };
}

const typedRoute = (Err) => (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof Err || err instanceof OrgError) return res.status(err.status).json({ error: { message: err.message, type: err.type } });
    throw err;
  }
});
const eqRoute = typedRoute(EqError);
const askRoute = typedRoute(AskError);

function requireOrg(req, res, next) {
  if (!req.org) return res.status(404).json({ error: { message: 'You are not in a company.', type: 'no_org' } });
  next();
}
function requireOrgLead(req, res, next) {
  if (!req.org) return res.status(404).json({ error: { message: 'You are not in a company.', type: 'no_org' } });
  if (!isLead(req.orgRole)) return res.status(403).json({ error: { message: 'Only lead techs and admins can do that.', type: 'forbidden' } });
  next();
}
async function memberName(req) {
  const m = req.org ? await orgStore.getMember(req.org.id, req.uid) : null;
  return (m && m.name) || req.displayName || req.email || null;
}

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

// Health check (Railway uses this)
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FixIt AI Proxy',
    version: '1.1.0'
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

// Main AI endpoint — auth verified, input validated (so bad requests never use
// up quota), then per-user limits, then the global cap.
app.post('/ai', verifyAuth, burstLimiter, validateWith(buildAiRequest), loadAccount, attachHistory,
  teamDailyLimiter, trialDailyLimiter, freeLimiter, globalDailyBreaker, requireApiKey, wrap(async (req, res) => {
    let result;
    try {
      result = await callAnthropic(req.aiRequest);
    } catch (err) {
      console.error('Proxy error:', err.message);
      return res.status(502).json({ error: { message: 'Could not reach AI service. Try again in a moment.', type: 'upstream_unreachable' } });
    }
    const { response, data } = result;
    if (!response.ok) {
      console.error('Anthropic API error:', { status: response.status, type: data?.error?.type });
      return res.status(response.status >= 500 ? 502 : 503).json({
        error: { message: 'AI service error. Try again.', type: 'upstream_error' }
      });
    }

    // Usage log — one line per successful diagnosis for DAU/volume analysis.
    // Keyed by Firebase UID (hashed prefix only, so raw UID never lands in logs).
    // Grep Railway logs for `DIAG` to count.
    const uidHash = req.uid ? String(req.uid).slice(0, 8) : 'anon';
    console.log('DIAG', JSON.stringify({
      ts: new Date().toISOString(),
      uid: uidHash,
      plan: req.plan,
      org: req.org ? req.org.id : null,
      trial: req.inTrial ? 1 : 0,
      in: data.usage?.input_tokens,
      out: data.usage?.output_tokens
    }));
    if (req.org) await orgStore.recordUsage(req.org.id, req.uid).catch(() => {});

    attachTrialHeaders(req, res);
    res.json({
      content: data.content,
      historyUsed: !!req.historyUsed,
      usage: {
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens
      },
      account: await accountSummary(req)
    });
  }));

// Data plate scan → structured JSON. Same auth; light limits (own daily cap + global cap).
app.post('/dataplate', verifyAuth, burstLimiter, validateWith(buildDataPlateRequest), loadAccount,
  plateDailyLimiter, globalDailyBreaker, requireApiKey, wrap(async (req, res) => {
    let result;
    try {
      result = await callAnthropic(req.aiRequest);
    } catch (err) {
      return res.status(502).json({ error: { message: 'Could not reach AI service. Try again in a moment.', type: 'upstream_unreachable' } });
    }
    const { response, data } = result;
    if (!response.ok) {
      console.error('Anthropic API error (dataplate):', { status: response.status, type: data?.error?.type });
      return res.status(502).json({ error: { message: 'AI service error. Try again.', type: 'upstream_error' } });
    }
    const text = (data.content || []).map((c) => c.text || '').join('');
    const plate = parsePlate(text);
    if (!plate) {
      return res.status(422).json({ error: { message: "Couldn't read that data plate. Try a closer, sharper photo with less glare.", type: 'plate_unreadable' } });
    }
    console.log('PLATE', JSON.stringify({ ts: new Date().toISOString(), uid: String(req.uid).slice(0, 8), in: data.usage?.input_tokens, out: data.usage?.output_tokens }));
    res.json({ plate });
  }));

// Fault / error code lookup → result cards + manufacturer literature searches.
// Own daily cap (doesn't use the diagnosis allowance) + global cap.
app.post('/fault', verifyAuth, burstLimiter, validateWith(buildFaultRequest), loadAccount,
  faultDailyLimiter, globalDailyBreaker, requireApiKey, wrap(async (req, res) => {
    const out = await aiTextOrError(req, res, 'fault');
    if (!out) return;
    if (!out.text) return res.status(502).json({ error: { message: 'AI service error. Try again.', type: 'upstream_error' } });
    res.json({ content: [{ type: 'text', text: out.text }], lookup: req.aiRequest.lookup, links: literatureLinks(req.aiRequest.lookup) });
  }));

// Gauge / meter photo → readings (psig, °F, V, A) the tech must confirm before use.
app.post('/gauge', verifyAuth, burstLimiter, validateWith(buildGaugeRequest), loadAccount,
  gaugeDailyLimiter, globalDailyBreaker, requireApiKey, wrap(async (req, res) => {
    const out = await aiTextOrError(req, res, 'gauge');
    if (!out) return;
    const gauge = parseGauge(out.text);
    if (!gauge) {
      return res.status(422).json({ error: { message: "Couldn't read the gauges in that photo. Try straight-on, closer, with less glare — or type the values.", type: 'gauge_unreadable' } });
    }
    res.json({ gauge });
  }));

// Close-out: parts, repair vs replace, additional work, customer summary.
// Company members use the company's price list (server-side); solo techs may send their own.
app.post('/closeout', verifyAuth, burstLimiter, loadAccount, wrap(async (req, res, next) => {
  try {
    const priceList = req.org ? await orgStore.getPriceList(req.org.id) : undefined;
    req.aiRequest = buildCloseoutRequest(req.body, { priceList });
    next();
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: { message: err.message, type: err.type } });
    throw err;
  }
}), closeoutDailyLimiter, globalDailyBreaker, requireApiKey, wrap(async (req, res) => {
  const out = await aiTextOrError(req, res, 'closeout');
  if (!out) return;
  if (!out.text) return res.status(502).json({ error: { message: 'AI service error. Try again.', type: 'upstream_error' } });
  res.json({ content: [{ type: 'text', text: out.text }], priceListUsed: req.aiRequest.hasPriceList });
}));

// ── Equipment history (customers / addresses, units, jobs) ──
app.get('/sites', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  res.json(await equipmentStore.search(eqScope(req), clean(req.query.q, 100), Math.min(50, parseInt(req.query.limit, 10) || 20)));
}));
app.post('/sites', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  res.status(201).json({ site: await equipmentStore.createSite(eqScope(req), req.body, { uid: req.uid }) });
}));
app.get('/sites/:id', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  const full = await equipmentStore.getSiteFull(eqScope(req), req.params.id);
  if (!full) return res.status(404).json({ error: { message: 'Customer not found', type: 'not_found' } });
  res.json(full);
}));
app.patch('/sites/:id', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  res.json({ site: await equipmentStore.updateSite(eqScope(req), req.params.id, req.body) });
}));
app.delete('/sites/:id', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  if (!eqAdmin(req)) return res.status(403).json({ error: { message: 'Only company admins can delete a customer.', type: 'forbidden' } });
  await equipmentStore.deleteSite(eqScope(req), req.params.id);
  res.json({ deleted: true });
}));
app.post('/sites/:id/units', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  res.json({ unit: await equipmentStore.upsertUnit(eqScope(req), req.params.id, req.body) });
}));
app.delete('/sites/:id/units/:unitId', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  if (!eqAdmin(req)) return res.status(403).json({ error: { message: 'Only company admins can remove a unit.', type: 'forbidden' } });
  await equipmentStore.deleteUnit(eqScope(req), req.params.id, req.params.unitId);
  res.json({ deleted: true });
}));
app.post('/sites/:id/jobs', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  const body = { ...(req.body || {}), techName: (req.body && req.body.techName) || await memberName(req) };
  res.status(201).json({ job: await equipmentStore.addJob(eqScope(req), req.params.id, body, { uid: req.uid }) });
}));
app.delete('/sites/:id/jobs/:jobId', verifyAuth, loadAccount, eqRoute(async (req, res) => {
  await equipmentStore.deleteJob(eqScope(req), req.params.id, req.params.jobId, { uid: req.uid, isAdmin: eqAdmin(req) });
  res.json({ deleted: true });
}));

// ── Ask a lead tech (company members; leads/admins answer from a queue) ──
app.post('/ask', verifyAuth, loadAccount, requireOrg, askDailyLimiter, askRoute(async (req, res) => {
  const ask = await askStore.create(req.org, { uid: req.uid, name: await memberName(req), email: req.email }, req.body);
  res.status(201).json({ ask });
}));
app.get('/ask/mine', verifyAuth, loadAccount, requireOrg, askRoute(async (req, res) => {
  res.json({ asks: await askStore.mine(req.org.id, req.uid) });
}));
app.get('/ask/queue', verifyAuth, loadAccount, requireOrgLead, askRoute(async (req, res) => {
  res.json(await askStore.queue(req.org.id));
}));
app.get('/ask/:id', verifyAuth, loadAccount, requireOrg, askRoute(async (req, res) => {
  res.json({ ask: await askStore.read(req.org.id, req.params.id, req.uid, req.orgRole) });
}));
app.post('/ask/:id/reply', verifyAuth, loadAccount, requireOrg, askRoute(async (req, res) => {
  const ask = await askStore.reply(req.org.id, req.params.id, { uid: req.uid, name: await memberName(req), email: req.email }, req.orgRole, req.body);
  res.json({ ask });
}));
app.post('/ask/:id/close', verifyAuth, loadAccount, requireOrg, askRoute(async (req, res) => {
  res.json({ ask: await askStore.close(req.org.id, req.params.id, req.uid, req.orgRole) });
}));

// Company price list for close-outs (any member reads; admin edits). Optional.
app.get('/org/pricelist', verifyAuth, loadAccount, requireOrg, wrap(async (req, res) => {
  res.json({ text: await orgStore.getPriceList(req.org.id) });
}));
app.put('/org/pricelist', verifyAuth, loadAccount, requireOrgAdmin, wrap(async (req, res) => {
  const text = (req.body || {}).text;
  if (text != null && typeof text !== 'string') return res.status(400).json({ error: { message: 'text must be a string', type: 'bad_request' } });
  if (String(text || '').length > 4000) return res.status(400).json({ error: { message: 'Price list too long (max 4000 characters)', type: 'bad_request' } });
  const v = clean(text, 4000);
  await orgStore.setPriceList(req.org.id, v);
  res.json({ text: v });
}));

// Who am I: plan, remaining quota, company + role.
app.get('/me', verifyAuth, loadAccount, wrap(async (req, res) => {
  res.json(await accountSummary(req));
}));

// Delete server-side data for this account (called by in-app account deletion).
app.delete('/me', verifyAuth, wrap(async (req, res) => {
  await ensureBootstrap();
  // Equipment history + lead asks: solo data is deleted; in a company, the company keeps
  // its customer records but this person's name/uid is removed and their asks are deleted.
  const { org } = await orgStore.resolveUser({ uid: req.uid });
  await equipmentStore.deleteScope(`user:${req.uid}`);
  if (org) {
    await equipmentStore.anonymizeUser(`org:${org.id}`, req.uid);
    await askStore.deleteUser(org.id, req.uid);
  }
  try {
    const left = await orgStore.leave({ uid: req.uid }, { promote: true });
    if (left && left.orgDeleted) {
      await equipmentStore.deleteScope(`org:${left.orgId}`);
      await askStore.deleteOrg(left.orgId);
    }
  } catch (err) {
    if (!(err instanceof OrgError)) throw err;
  }
  const today = todayUTC();
  const yesterday = todayUTC(Date.now() - DAY_MS);
  const keys = [`${KEY_PREFIX.trialStart}${req.uid}`];
  for (const d of [today, yesterday]) {
    keys.push(`${KEY_PREFIX.trialDaily}${d}:${req.uid}`, `${KEY_PREFIX.teamDaily}${d}:${req.uid}`, `${KEY_PREFIX.plateDaily}${d}:${req.uid}`,
      `${KEY_PREFIX.faultDaily}${d}:${req.uid}`, `${KEY_PREFIX.gaugeDaily}${d}:${req.uid}`, `${KEY_PREFIX.closeoutDaily}${d}:${req.uid}`, `${KEY_PREFIX.askDaily}${d}:${req.uid}`);
  }
  await usageStore.deleteKeys(keys);
  await monthlyStore.resetKey(req.uid);
  if (burstStore) await burstStore.resetKey(req.uid);
  res.json({ deleted: true });
}));

// ── Organizations (team mode) ──

// Create a company; the caller becomes its admin.
app.post('/org', verifyAuth, loadAccount, orgRoute(async (req, res) => {
  const { name, domain } = req.body || {};
  let useDomain = null;
  if (domain) {
    // Auto-join domain must match the creator's own verified email.
    const d = String(domain).trim().toLowerCase().replace(/^@/, '');
    if (!req.emailVerified || String(req.email || '').toLowerCase().split('@')[1] !== d) {
      return res.status(400).json({ error: { message: 'To link an email domain, sign in with a verified email at that domain.', type: 'domain_not_verified' } });
    }
    useDomain = d;
  }
  const org = await orgStore.createOrg({ name, domain: useDomain, owner: { uid: req.uid, email: req.email } });
  req.org = org; req.orgRole = 'admin'; req.isTeam = !!org.active;
  req.plan = req.isTeam ? 'team' : req.plan;
  res.status(201).json(await accountSummary(req));
}));

// Join with an invite code.
app.post('/org/join', verifyAuth, loadAccount, orgRoute(async (req, res) => {
  const org = await orgStore.joinWithCode({ uid: req.uid, email: req.email }, (req.body || {}).code);
  req.org = org; req.orgRole = 'tech'; req.isTeam = !!org.active;
  if (req.isTeam) req.plan = 'team';
  res.json(await accountSummary(req));
}));

// Leave the company.
app.post('/org/leave', verifyAuth, loadAccount, orgRoute(async (req, res) => {
  const left = await orgStore.leave({ uid: req.uid });
  if (left && left.orgDeleted) {
    await equipmentStore.deleteScope(`org:${left.orgId}`);
    await askStore.deleteOrg(left.orgId);
  }
  req.org = null; req.orgRole = null; req.isTeam = false;
  req.plan = req.isPaid ? 'paid' : req.inTrial ? 'trial' : 'free';
  res.json(await accountSummary(req));
}));

// Update my member profile (name shown to admins and on reports).
app.patch('/org/me', verifyAuth, loadAccount, orgRoute(async (req, res) => {
  if (!req.org) return res.status(404).json({ error: { message: 'You are not in a company.', type: 'no_org' } });
  const m = await orgStore.getMember(req.org.id, req.uid);
  m.name = String((req.body || {}).name || '').trim().slice(0, 60) || null;
  await orgStore.kv.hset(`fixit:org:members:${req.org.id}`, req.uid, JSON.stringify(m));
  res.json({ member: m });
}));

// Members + usage (admin).
app.get('/org/members', verifyAuth, loadAccount, requireOrgAdmin, orgRoute(async (req, res) => {
  const [members, month] = await Promise.all([orgStore.listMembers(req.org.id), orgStore.monthUsage(req.org.id)]);
  const today = todayUTC();
  const out = await Promise.all(members.map(async (m) => ({
    uid: m.uid, email: m.email, name: m.name || null, role: m.role, joinedAt: m.joinedAt,
    usage: { today: await usageStore.getDaily(`${KEY_PREFIX.teamDaily}${today}:${m.uid}`), month: month[m.uid] || 0 }
  })));
  res.json({
    org: { id: req.org.id, name: req.org.name, active: req.org.active, seatLimit: req.org.seatLimit, inviteCode: req.org.inviteCode, domain: req.org.domain },
    members: out,
    totals: { month: Object.values(month).reduce((a, b) => a + b, 0), seatsUsed: out.length }
  });
}));

// Remove a tech (admin).
app.delete('/org/members/:uid', verifyAuth, loadAccount, requireOrgAdmin, orgRoute(async (req, res) => {
  const uid = req.params.uid;
  if (uid === req.uid) return res.status(400).json({ error: { message: 'Use "Leave company" to remove yourself.', type: 'bad_request' } });
  if (!await orgStore.getMember(req.org.id, uid)) return res.status(404).json({ error: { message: 'Not a member', type: 'not_found' } });
  await orgStore.removeMember(req.org.id, uid);
  res.json({ removed: uid });
}));

// Change a member's role (admin).
app.post('/org/members/:uid/role', verifyAuth, loadAccount, requireOrgAdmin, orgRoute(async (req, res) => {
  const role = (req.body || {}).role;
  if (!['admin', 'lead', 'tech'].includes(role)) return res.status(400).json({ error: { message: 'role must be admin, lead or tech', type: 'bad_request' } });
  if (req.params.uid === req.uid && role !== 'admin') {
    const admins = (await orgStore.listMembers(req.org.id)).filter((m) => m.role === 'admin');
    if (admins.length < 2) return res.status(409).json({ error: { message: 'You are the only admin.', type: 'last_admin' } });
  }
  res.json({ member: await orgStore.setRole(req.org, req.params.uid, role) });
}));

// New invite code — old code stops working (admin).
app.post('/org/invite/rotate', verifyAuth, loadAccount, requireOrgAdmin, orgRoute(async (req, res) => {
  const org = await orgStore.rotateInvite(req.org);
  res.json({ inviteCode: org.inviteCode });
}));

// Update company name / logo (admin). Logo: small PNG/JPEG data URL for reports.
app.patch('/org', verifyAuth, loadAccount, requireOrgAdmin, orgRoute(async (req, res) => {
  const { name, logo } = req.body || {};
  const org = req.org;
  if (logo !== undefined) {
    if (logo === null || logo === '') org.logo = null;
    else if (typeof logo === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo) && logo.length <= 200_000) org.logo = logo;
    else return res.status(400).json({ error: { message: 'Logo must be a PNG or JPEG under ~150 KB', type: 'bad_request' } });
  }
  const updated = await orgStore.update(org, { name });
  res.json({ org: { id: updated.id, name: updated.name, logo: updated.logo || null } });
}));

// ── Platform admin (you, the app owner): activate companies, seats, plan ──
app.get('/admin/orgs', verifyAuth, requirePlatformAdmin, wrap(async (req, res) => {
  res.json({ orgs: await orgStore.listAll() });
}));
app.post('/admin/orgs/:id', verifyAuth, requirePlatformAdmin, orgRoute(async (req, res) => {
  const org = await orgStore.getOrg(req.params.id);
  if (!org) return res.status(404).json({ error: { message: 'No such org', type: 'not_found' } });
  const { active, seatLimit, plan, domain } = req.body || {};
  res.json({ org: await orgStore.update(org, { active, seatLimit, plan, domain }) });
}));

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
  ensureBootstrap();
  return app.listen(PORT, () => {
    console.log(`FixIt AI Proxy running on port ${PORT}`);
    console.log(`Trial: ${TRIAL_DAYS} days, max ${TRIAL_DAILY_CAP} requests/day per user`);
    console.log(`After trial: ${FREE_LIMIT} free requests per 30 days per user`);
    console.log(`Team members: up to ${TEAM_DAILY_CAP} requests/day per user`);
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

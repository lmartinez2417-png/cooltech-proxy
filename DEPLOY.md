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
| `TEAM_DAILY_CAP` | `100` | No (default: 100) — max AI requests per company member per day |
| `PLATE_DAILY_CAP` | `30` | No (default: 30) — max data plate scans per user per day |
| `FAULT_DAILY_CAP` | `30` | No (default: 30) — max fault-code lookups per user per day |
| `GAUGE_DAILY_CAP` | `40` | No (default: 40) — max gauge/meter photo reads per user per day |
| `CLOSEOUT_DAILY_CAP` | `30` | No (default: 30) — max close-out write-ups per user per day |
| `ASK_DAILY_CAP` | `20` | No (default: 20) — max "Ask a lead tech" requests per user per day |
| `ORG_BOOTSTRAP` | JSON (see Team mode) | No — seeds your first company on startup |
| `ORG_DEFAULT_SEATS` | `10` | No — seat limit for companies created in the app |
| `ORG_SELF_SERVE_ACTIVE` | `false` | No — `true` makes app-created companies active immediately |
| `PLATFORM_ADMIN_EMAILS` | `leo@infinityaircool.com` | No — verified emails allowed to use `/admin/orgs` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | No — model id |
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

### Step 6: Team mode (companies) — Infinity Air first

FixIt AI supports companies ("organizations"). Members of an **active** company
skip the free trial / monthly limits (they still have `TEAM_DAILY_CAP` per person
per day and the global cap). Roles: **admin** (creates the company, invite code,
removes techs, sees usage) and **tech**.

Companies live in the same Redis as the limits (no extra service, and no Firebase
service-account key needed — the proxy only verifies sign-in tokens). **Redis is
required** for team mode in production; without it companies vanish on restart.

**Seed Infinity Air** — add this Railway variable (one line):
```
ORG_BOOTSTRAP={"id":"infinity-air","name":"Infinity Air Heating and Cooling","domain":"infinityaircool.com","adminEmail":"leo@infinityaircool.com","seatLimit":25}
```
On startup the proxy creates the company if it doesn't exist (it never wipes
members on later restarts). Then:
1. Leo signs in to the app with **leo@infinityaircool.com** and verifies the email
   (Settings → Team → "Send verification email", or use Google sign-in on the web).
   He becomes the company admin automatically.
2. Techs either sign in with a verified **@infinityaircool.com** email (auto-join), or
   sign in with any email and enter the **invite code** shown to Leo in Settings → Team.
3. Removing a tech: Settings → Team → member → Remove. Rotate the invite code if
   it was shared widely.

**Other HVAC companies** can tap "Create company" in Settings → Team. New
companies start **inactive** (normal free limits) so nobody can skip the limits
for free. Activate one when they've paid (billing is a TODO — the `active`/`plan`
flags are where a payment webhook will plug in):
```bash
railway run node scripts/org-admin.js list
railway run node scripts/org-admin.js activate <orgId>
railway run node scripts/org-admin.js seats <orgId> 15
```
or `POST /admin/orgs/<orgId>` with `{"active":true}` while signed in as a
`PLATFORM_ADMIN_EMAILS` user.

### Step 7: Firebase settings
- Authentication → Sign-in method: Email/Password ON; Google ON (web only for now —
  the native app hides Google until the Capacitor Firebase plugin is added).
- Authentication → Templates: check the **email verification** template (needed for
  domain auto-join and the bootstrap admin).
- Authentication → Settings → Authorized domains: your web domains.
- Account deletion happens in the app (Settings → Delete account): it deletes the
  Firebase user and calls `DELETE /me` to remove server-side usage data.

### Step 8: Deploy the app and proxy together
This proxy builds the AI prompts itself. Old app builds that send `system`/`messages`
get **HTTP 426 "please update"**. Deploy the updated `index.html` (web + app builds)
at the same time as this proxy.

### Step 9: Update Your App
Once deployed, Railway gives you a URL like `https://fixit-ai-proxy-production-XXXX.up.railway.app`

Update the PROXY constant in your `index.html`:
```javascript
const PROXY = 'https://your-new-railway-url.up.railway.app';
```

### Step 10: Delete the Old Proxy
Once the new one is working, delete the old Railway service to avoid confusion.

## What This Proxy Does

- **Free trial**: 7 days from a user's first request, up to 10 diagnoses/day (`TRIAL_DAYS`, `TRIAL_DAILY_CAP`).
  The trial start is saved in Redis per Firebase user, so restarts/deploys don't reset it.
- **After the trial**: 3 free diagnoses per 30 days per user (`FREE_MONTHLY`)
- **Burst protection**: 3 requests/minute per user
- **Global circuit breaker**: at most `GLOBAL_DAILY_CAP` (default 2000) diagnoses/day across all users
- **Team mode**: active-company members skip trial/monthly limits; `TEAM_DAILY_CAP` per person per day
- **Paid users**: not recognized yet — see `isPaid()` in `server.js`
- **Server-built prompts** (`prompts.js`): the app sends only skill, Pro mode (fast/guided),
  service, language, text (≤2000), readings/data-plate fields (≤60 chars each), up to 5
  photos (JPEG/PNG/WebP, ≤~1.5 MB each) and a follow-up history (≤12 alternating turns,
  question ≤500, each earlier message ≤8000 chars). Old-style `system`/`messages` bodies are refused (426).
- **Data plate scan**: `POST /dataplate` → structured JSON (unknown values are `null`)
- **Fault code lookup**: `POST /fault` → result cards (MEANING/CONFIDENCE/CAUSE/SAFETY/STEPS/NOTES/VERIFY).
  The prompt must say "Not sure"/"Unknown" instead of guessing, never invents part/document numbers or URLs,
  and always points to the unit label / manufacturer literature. `links` are Google searches
  (manufacturer site + manual search) built on the server — never a specific manual page.
  No curated fault-code table yet: codes vary by board revision and we haven't sourced one we can stand behind.
- **Gauge/meter photo**: `POST /gauge` → readings normalized to psig/°F/V/A; converted or doubtful values are `sure:false`.
  The app makes the tech confirm/edit before anything is used.
- **Close-out**: `POST /closeout` → PARTS / REPAIR OR REPLACE / ADDITIONAL WORK / CUSTOMER SUMMARY.
  No invented prices: only items from the company price list (`PUT /org/pricelist`, admin) or, for solo
  techs, the list the app sends.
- **Equipment history**: customers/addresses, units and jobs in Redis (`fixit:eq:<scope>:…`), scope =
  the company (shared by all its techs) or the solo user. `/ai` with `siteId` adds the history as data.
- **Ask a lead tech**: `fixit:ask:<orgId>`; techs send a call, leads/admins answer from a queue; the app polls.
- **Account deletion** (`DELETE /me`): solo customers/jobs deleted; in a company the records stay with the
  company but the person's uid/name is removed from jobs and lead replies, and their own asks are deleted.
  When the last member leaves, the company's customers and asks are deleted too.
- **Model lock**: model is set on the server (`ANTHROPIC_MODEL`)
- **Size limit**: 10MB max request body
- **Security headers**: Helmet.js adds standard security headers
- **CORS**: Configurable allowed origins
- **Cost control**: Caps max_tokens at 2000 per request

## Testing Locally
```bash
npm install
npm test   # automated tests (Redis, Firebase and Anthropic are mocked)
ANTHROPIC_API_KEY=sk-ant-... FIREBASE_PROJECT_ID=your-project-id node server.js
# Then (needs a real Firebase ID token):
# curl -X POST http://localhost:3000/ai -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
#   -d '{"skill":"pro","proMode":"fast","serviceId":"hvac","lang":"en","text":"AC not cooling"}'
```

## API (for the app and future integrations)
| Method | Path | What |
|---|---|---|
| POST | `/ai` | Diagnosis / follow-up. Optional `siteId`, `unitIds` add equipment history. Response: `{content, usage, account, historyUsed}` |
| POST | `/dataplate` | `{photo:{mime,data}}` → `{plate:{brand, model, serial, tonnage, ...}}` |
| POST | `/fault` | `{code, brand?, model?, equipmentType?, notes?, plate?, lang?}` → `{content, lookup, links[]}` |
| POST | `/gauge` | `{photo:{mime,data}}` → `{gauge:{readings:{key:{value,unit,sure}}, unsure[], confidence, refrigerant, notes}}` |
| POST | `/closeout` | `{diagnosis, problem?, plate?, readings?, followUps?, priceList? (solo), lang?}` → `{content, priceListUsed}` |
| GET/POST | `/sites` | Search `?q=` / create `{name, address, notes?}` |
| GET/PATCH/DELETE | `/sites/:id` | Customer + units + jobs / edit / delete (company admin) |
| POST/DELETE | `/sites/:id/units[/:unitId]` | Add/update a unit (matched by serial) / remove (admin) |
| POST/DELETE | `/sites/:id/jobs[/:jobId]` | Save a job (`reportId` replaces the same report) / delete (author or admin) |
| POST | `/ask` | Company member: `{question, call:{service, problem, diagnosis, readings, plate, notes, site, photos≤3}}` |
| GET | `/ask/mine`, `/ask/:id` | Your asks with replies (`unread`) / one ask |
| GET | `/ask/queue` | Lead/admin: open first, then recent |
| POST | `/ask/:id/reply`, `/ask/:id/close` | `{text, close?}` |
| GET/PUT | `/org/pricelist` | Company price list text (admin edits; ≤4000 chars) |
| GET | `/me` | Plan, remaining quota (`quota.limit/used/remaining/resetAt`), company + role |
| DELETE | `/me` | Delete server-side data (account deletion) |
| POST | `/org` | Create company `{name, domain?}` (caller = admin) |
| POST | `/org/join` | `{code}` |
| POST | `/org/leave` | Leave company |
| PATCH | `/org/me` | `{name}` — your name for the member list / reports |
| GET | `/org/members` | Admin: members + usage today / this month |
| DELETE | `/org/members/:uid` | Admin: remove a tech |
| POST | `/org/members/:uid/role` | Admin: `{role:"admin"|"lead"|"tech"}` (lead = answers Ask-a-lead, no admin powers) |
| POST | `/org/invite/rotate` | Admin: new invite code |
| PATCH | `/org` | Admin: `{name?, logo?}` (logo = PNG/JPEG data URL ≤150 KB, used on PDF reports) |
| GET/POST | `/admin/orgs`, `/admin/orgs/:id` | Platform admin: list / `{active, seatLimit, plan, domain}` |

Limit errors are `429` with `{error:{message,type}, limit, resetAt}`; types:
`daily_limit`, `monthly_limit_reached`, `team_daily_limit`, `plate_daily_limit`, `fault_daily_limit`,
`gauge_daily_limit`, `closeout_daily_limit`, `ask_daily_limit`,
`burst_limit_exceeded`, `service_busy`.
```

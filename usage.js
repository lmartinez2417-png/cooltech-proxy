/**
 * Usage store — trial start dates and daily counters.
 * ──────────────────────────────────────────────────
 * Uses Redis when available so nothing resets on a Railway deploy/restart.
 * Falls back to process memory (resets on restart) when Redis isn't configured.
 *
 * Redis keys (each limiter has its own prefix so they never collide):
 *   fixit:trial:start:<uid>               — trial start timestamp (ms), never expires
 *   fixit:trial:daily:<YYYY-MM-DD>:<uid>  — requests during trial that UTC day
 *   fixit:global:daily:<YYYY-MM-DD>       — requests across ALL users that UTC day
 *   fixit:team:daily:<YYYY-MM-DD>:<uid>   — requests by a team (org) member that UTC day
 *   fixit:plate:daily:<YYYY-MM-DD>:<uid>  — data plate scans by a user that UTC day
 *   fixit:fault:daily:… / fixit:gauge:daily:… / fixit:closeout:daily:… / fixit:ask:daily:…
 *                                         — fault lookups, gauge reads, close-outs, lead asks per user per UTC day
 * (The express-rate-limit stores in server.js use fixit:rl:burst: and fixit:rl:monthly:)
 */

const KEY_PREFIX = {
  trialStart: 'fixit:trial:start:',
  trialDaily: 'fixit:trial:daily:',
  globalDaily: 'fixit:global:daily:',
  teamDaily: 'fixit:team:daily:',
  plateDaily: 'fixit:plate:daily:',
  faultDaily: 'fixit:fault:daily:',
  gaugeDaily: 'fixit:gauge:daily:',
  closeoutDaily: 'fixit:closeout:daily:',
  askDaily: 'fixit:ask:daily:',
  burst: 'fixit:rl:burst:',
  monthly: 'fixit:rl:monthly:'
};

// Daily counters are kept for 2 days so they cover the whole UTC day, then vanish.
const DAILY_TTL_SECONDS = 2 * 24 * 60 * 60;

// Current UTC date as YYYY-MM-DD (daily caps reset at midnight UTC).
function todayUTC(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// When today's daily caps reset (next midnight UTC), as an ISO string.
function nextResetUTC(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function createUsageStore(redisClient) {
  if (redisClient) {
    return {
      persistent: true,

      // First call for a uid records "now"; later calls return the original value.
      async getTrialStart(uid) {
        const key = KEY_PREFIX.trialStart + uid;
        await redisClient.set(key, String(Date.now()), 'NX');
        return parseInt(await redisClient.get(key), 10);
      },

      // Adds 1 to a daily counter and returns the new total.
      async incrementDaily(key) {
        const count = await redisClient.incr(key);
        if (count === 1) await redisClient.expire(key, DAILY_TTL_SECONDS);
        return count;
      },

      async getDaily(key) {
        return parseInt(await redisClient.get(key), 10) || 0;
      },

      async deleteKeys(keys) {
        if (keys.length) await redisClient.del(...keys);
      }
    };
  }

  // In-memory fallback — resets whenever the process restarts.
  const trialStarts = new Map();
  const counters = new Map();
  let countersDay = todayUTC();
  return {
    persistent: false,

    async getTrialStart(uid) {
      if (!trialStarts.has(uid)) trialStarts.set(uid, Date.now());
      return trialStarts.get(uid);
    },

    async incrementDaily(key) {
      // Drop yesterday's counters so memory doesn't grow forever.
      if (todayUTC() !== countersDay) {
        counters.clear();
        countersDay = todayUTC();
      }
      const count = (counters.get(key) || 0) + 1;
      counters.set(key, count);
      return count;
    },

    async getDaily(key) {
      if (todayUTC() !== countersDay) return 0;
      return counters.get(key) || 0;
    },

    async deleteKeys(keys) {
      for (const k of keys) {
        counters.delete(k);
        if (k.startsWith(KEY_PREFIX.trialStart)) trialStarts.delete(k.slice(KEY_PREFIX.trialStart.length));
      }
    }
  };
}

// Simple in-memory store for express-rate-limit, used for the 30-day monthly
// limiter when Redis isn't available. The library's built-in MemoryStore can't
// handle a 30-day window: Node timers max out at ~24.8 days, so its cleanup
// timer fires every 1 ms and forgets everyone's count almost immediately.
class LongWindowMemoryStore {
  constructor() {
    this.clients = new Map();
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async get(key) {
    const client = this.clients.get(key);
    if (!client || client.resetTime.getTime() <= Date.now()) return undefined;
    return client;
  }

  async increment(key) {
    let client = await this.get(key);
    if (!client) {
      client = { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
      this.clients.set(key, client);
    }
    client.totalHits++;
    return client;
  }

  async decrement(key) {
    const client = await this.get(key);
    if (client && client.totalHits > 0) client.totalHits--;
  }

  async resetKey(key) {
    this.clients.delete(key);
  }
}

module.exports = { KEY_PREFIX, todayUTC, nextResetUTC, createUsageStore, LongWindowMemoryStore };

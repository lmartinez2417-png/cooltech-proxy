/**
 * Minimal key-value layer over Redis (ioredis) with an in-memory fallback for
 * dev/tests. Only the commands the stores use. Without Redis everything resets
 * on restart, so don't run production without REDIS_URL.
 */
function memoryKV() {
  const s = new Map(), h = new Map(), l = new Map();
  const hash = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
  const list = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };
  const range = (arr, a, b) => { const n = arr.length; const s0 = a < 0 ? n + a : a; const e0 = b < 0 ? n + b : b; return arr.slice(Math.max(0, s0), e0 + 1); };
  return {
    get: async (k) => (s.has(k) ? s.get(k) : null),
    set: async (k, v, nx) => { if (nx === 'NX' && s.has(k)) return null; s.set(k, String(v)); return 'OK'; },
    del: async (...ks) => { ks.forEach((k) => { s.delete(k); h.delete(k); l.delete(k); }); },
    hget: async (k, f) => (h.get(k)?.get(f) ?? null),
    hset: async (k, f, v) => { hash(k).set(f, String(v)); },
    hdel: async (k, ...fs) => { fs.forEach((f) => h.get(k)?.delete(f)); },
    hgetall: async (k) => Object.fromEntries(h.get(k) || []),
    hlen: async (k) => (h.get(k)?.size || 0),
    hincrby: async (k, f, n) => { const m = hash(k); const v = parseInt(m.get(f) || '0', 10) + n; m.set(f, String(v)); return v; },
    lpush: async (k, ...vs) => { const a = list(k); vs.forEach((v) => a.unshift(String(v))); return a.length; },
    lrange: async (k, a, b) => range(l.get(k) || [], a, b),
    ltrim: async (k, a, b) => { if (l.has(k)) l.set(k, range(l.get(k), a, b)); },
    lset: async (k, i, v) => { const a = l.get(k); if (a && a[i] !== undefined) a[i] = String(v); },
    lrem: async (k, n, v) => { const a = l.get(k); if (!a) return 0; const before = a.length; l.set(k, a.filter((x) => x !== v)); return before - l.get(k).length; },
    expire: async () => {}
  };
}

function redisKV(r) {
  return {
    get: (k) => r.get(k),
    set: (k, v, nx) => (nx === 'NX' ? r.set(k, v, 'NX') : r.set(k, v)),
    del: (...ks) => (ks.length ? r.del(...ks) : 0),
    hget: (k, f) => r.hget(k, f),
    hset: (k, f, v) => r.hset(k, f, v),
    hdel: (k, ...fs) => r.hdel(k, ...fs),
    hgetall: (k) => r.hgetall(k),
    hlen: (k) => r.hlen(k),
    hincrby: (k, f, n) => r.hincrby(k, f, n),
    lpush: (k, ...vs) => r.lpush(k, ...vs),
    lrange: (k, a, b) => r.lrange(k, a, b),
    ltrim: (k, a, b) => r.ltrim(k, a, b),
    lset: (k, i, v) => r.lset(k, i, v),
    lrem: (k, n, v) => r.lrem(k, n, v),
    expire: (k, s) => r.expire(k, s)
  };
}

const createKV = (redisClient) => (redisClient ? redisKV(redisClient) : memoryKV());

module.exports = { createKV, memoryKV, redisKV };

/**
 * Tests for the FixIt AI proxy limits.
 * Redis is replaced with ioredis-mock (all mock clients share one fake database,
 * just like a real Redis survives a server restart). Firebase and Anthropic are mocked.
 */
const request = require('supertest');
const RedisMock = require('ioredis-mock');

// ioredis-mock has no `.call()` (used by rate-limit-redis) and no SCRIPT LOAD,
// so add a tiny shim: remember scripts by a fake SHA and run them with EVAL.
const scripts = new Map();
class RedisWithCall extends RedisMock {
  call(command, ...args) {
    const cmd = command.toUpperCase();
    if (cmd === 'SCRIPT' && String(args[0]).toUpperCase() === 'LOAD') {
      const sha = `sha${scripts.size}`;
      scripts.set(sha, args[1]);
      return Promise.resolve(sha);
    }
    if (cmd === 'EVALSHA') return this.eval(scripts.get(args[0]), ...args.slice(1));
    return this[cmd.toLowerCase()](...args);
  }
}

const REDIS_URL = 'redis://mock:6379';
const redis = new RedisWithCall(REDIS_URL); // test's own view of the shared fake Redis
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_ENV = { ...process.env };

// Load a fresh copy of server.js — calling this twice simulates a restart/deploy.
function startServer(env = {}) {
  jest.resetModules();
  process.env = { ...BASE_ENV, FIREBASE_PROJECT_ID: 'test-project', ANTHROPIC_API_KEY: 'sk-test', ...env };
  jest.doMock('ioredis', () => RedisWithCall);
  jest.doMock('firebase-admin', () => ({
    initializeApp: jest.fn(),
    auth: () => ({
      verifyIdToken: async (token) => {
        if (token.startsWith('good-')) return { uid: token.slice(5), email: 'a@b.c' };
        throw Object.assign(new Error('bad token'), { code: 'auth/argument-error' });
      }
    })
  }));
  return require('../server').app;
}

const withRedis = (env = {}) => startServer({ REDIS_URL, ...env });

const body = { system: 'You are an HVAC tech.', messages: [{ role: 'user', content: 'AC not cooling' }] };
const ask = (app, uid) => request(app).post('/ai').set('Authorization', `Bearer good-${uid}`).send(body);

beforeEach(async () => {
  await redis.flushall();
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'Check the capacitor.' }], usage: { input_tokens: 10, output_tokens: 20 } })
  }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = BASE_ENV;
});

describe('existing behavior', () => {
  test('health check', async () => {
    const res = await request(withRedis()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('requires sign-in', async () => {
    const res = await request(withRedis()).post('/ai').send(body);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('auth_required');
  });

  test('rejects a bad token', async () => {
    const res = await request(withRedis()).post('/ai').set('Authorization', 'Bearer nope').send(body);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('auth_invalid');
  });

  test('a new user gets a diagnosis and trial headers', async () => {
    const res = await ask(withRedis(), 'alice');
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe('Check the capacitor.');
    expect(res.body.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(res.headers['x-trial-active']).toBe('1');
    expect(res.headers['x-trial-days-left']).toBe('7');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('invalid input still returns 400', async () => {
    const res = await request(withRedis()).post('/ai').set('Authorization', 'Bearer good-bob').send({ messages: [] });
    expect(res.status).toBe(400);
  });

  test('burst limit: 4th request in a minute is blocked', async () => {
    const app = withRedis();
    for (let i = 0; i < 3; i++) expect((await ask(app, 'carol')).status).toBe(200);
    const res = await ask(app, 'carol');
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('burst_limit_exceeded');
  });

  test('after the trial: monthly free limit still applies (same response shape)', async () => {
    await redis.set('fixit:trial:start:dave', String(Date.now() - 8 * DAY_MS));
    const app = withRedis({ FREE_MONTHLY: '2' });
    expect((await ask(app, 'dave')).status).toBe(200);
    expect((await ask(app, 'dave')).status).toBe(200);
    const res = await ask(app, 'dave');
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('monthly_limit_reached');
    expect(res.headers['x-trial-active']).toBe('0');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('without Redis, the monthly limit still works in memory', async () => {
    // Regression: the built-in MemoryStore forgot counts instantly with a 30-day window.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const app = startServer({ FREE_MONTHLY: '1', TRIAL_DAYS: '1' });
    expect((await ask(app, 'erin')).status).toBe(200); // starts trial (in memory)
    jest.setSystemTime(Date.now() + 2 * DAY_MS); // trial over
    expect((await ask(app, 'erin')).status).toBe(200); // 1st free one
    jest.setSystemTime(Date.now() + 60 * 1000);
    const res = await ask(app, 'erin');
    jest.useRealTimers();
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('monthly_limit_reached');
  });
});

describe('trial persists across restarts', () => {
  test('trial start is stored once in Redis and survives a restart', async () => {
    await ask(withRedis(), 'frank');
    const firstStart = await redis.get('fixit:trial:start:frank');
    expect(firstStart).toBeTruthy();
    expect(await redis.ttl('fixit:trial:start:frank')).toBe(-1); // never expires

    await ask(withRedis(), 'frank'); // "restart" = fresh copy of server.js
    expect(await redis.get('fixit:trial:start:frank')).toBe(firstStart);
  });

  test('an expired trial stays expired after a restart', async () => {
    await redis.set('fixit:trial:start:gina', String(Date.now() - 8 * DAY_MS));
    withRedis(); // first boot
    const res = await ask(withRedis(), 'gina'); // after a redeploy
    expect(res.headers['x-trial-active']).toBe('0');
    expect(res.headers['x-trial-days-left']).toBe('0');
  });

  test('without Redis a startup WARNING is logged', () => {
    startServer();
    const warnings = console.warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnings).toMatch(/WARNING: No working REDIS_URL/);
  });
});

describe('trial daily cap', () => {
  test('blocks a trial user after TRIAL_DAILY_CAP requests today', async () => {
    const app = withRedis({ TRIAL_DAILY_CAP: '2' });
    expect((await ask(app, 'hank')).status).toBe(200);
    expect((await ask(app, 'hank')).status).toBe(200);
    const res = await ask(app, 'hank');
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('daily_limit');
    expect(res.body.error.message).toMatch(/today's limit of 2/);
    expect(res.body.limit).toBe(2);
    expect(new Date(res.body.resetAt).toISOString()).toBe(res.body.resetAt);
    expect(new Date(res.body.resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(global.fetch).toHaveBeenCalledTimes(2); // Anthropic never called for the blocked one
  });

  test('one user hitting the cap does not affect another user', async () => {
    const app = withRedis({ TRIAL_DAILY_CAP: '1' });
    expect((await ask(app, 'ivan')).status).toBe(200);
    expect((await ask(app, 'ivan')).status).toBe(429);
    expect((await ask(app, 'judy')).status).toBe(200);
  });

  test('the daily count survives a restart', async () => {
    expect((await ask(withRedis({ TRIAL_DAILY_CAP: '1' }), 'kate')).status).toBe(200);
    const res = await ask(withRedis({ TRIAL_DAILY_CAP: '1' }), 'kate');
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('daily_limit');
  });

  test('defaults to 10 per day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await redis.set(`fixit:trial:daily:${today}:liam`, '10');
    const res = await ask(withRedis(), 'liam');
    expect(res.status).toBe(429);
    expect(res.body.limit).toBe(10);
  });
});

describe('global daily circuit breaker', () => {
  test('returns 429 service_busy for everyone once GLOBAL_DAILY_CAP is hit', async () => {
    const app = withRedis({ GLOBAL_DAILY_CAP: '2' });
    expect((await ask(app, 'u1')).status).toBe(200);
    expect((await ask(app, 'u2')).status).toBe(200);
    const res = await ask(app, 'u3');
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({
      message: 'FixIt AI is very busy right now. Please try again later.',
      type: 'service_busy'
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const errors = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errors).toMatch(/GLOBAL DAILY CAP HIT/);
  });

  test('requests blocked by a per-user limit do not use up the global budget', async () => {
    const app = withRedis({ TRIAL_DAILY_CAP: '1', GLOBAL_DAILY_CAP: '2' });
    expect((await ask(app, 'u1')).status).toBe(200);
    expect((await ask(app, 'u1')).status).toBe(429); // per-user block
    expect((await ask(app, 'u2')).status).toBe(200); // global budget still available
  });
});

describe('separate Redis key prefixes', () => {
  test('each limiter writes to its own key', async () => {
    await redis.set('fixit:trial:start:mona', String(Date.now() - 8 * DAY_MS)); // post-trial so monthly runs
    await ask(withRedis(), 'mona');
    await ask(withRedis(), 'nate'); // trial user
    const today = new Date().toISOString().slice(0, 10);
    const keys = (await redis.keys('*')).sort();
    expect(keys).toEqual([
      `fixit:global:daily:${today}`,
      'fixit:rl:burst:mona',
      'fixit:rl:burst:nate',
      'fixit:rl:monthly:mona',
      'fixit:trial:daily:' + today + ':nate',
      'fixit:trial:start:mona',
      'fixit:trial:start:nate'
    ].sort());
    expect(await redis.get(`fixit:global:daily:${today}`)).toBe('2');
  });

  test('burst and monthly counters no longer overwrite each other', async () => {
    await redis.set('fixit:trial:start:olga', String(Date.now() - 8 * DAY_MS));
    const app = withRedis({ FREE_MONTHLY: '3' });
    await ask(app, 'olga');
    await ask(app, 'olga');
    expect(await redis.get('fixit:rl:burst:olga')).toBe('2');
    expect(await redis.get('fixit:rl:monthly:olga')).toBe('2');
    // Monthly window is ~30 days, burst window is ~1 minute
    expect(await redis.pttl('fixit:rl:monthly:olga')).toBeGreaterThan(29 * DAY_MS);
    expect(await redis.pttl('fixit:rl:burst:olga')).toBeLessThanOrEqual(60 * 1000);
  });
});

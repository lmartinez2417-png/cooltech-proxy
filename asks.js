/**
 * "Ask a lead tech": a company tech sends the current call to the company's
 * leads/admins, who answer from a queue in the app. The app polls (no push yet).
 * ────────────────────────────────────────────────────────────────────────────
 * Keys:
 *   fixit:ask:<orgId>   hash askId -> JSON {id,fromUid,fromName,createdAt,updatedAt,status,question,call,replies[]}
 * status: open (waiting for a lead) → answered (a lead replied) → closed.
 * Old closed/answered asks are pruned so a company keeps at most MAX_ASKS; anything
 * older than ASK_TTL_DAYS is dropped on read.
 */
const crypto = require('crypto');
const { createKV } = require('./kv');
const { clean, cleanFields, READING_FIELDS, PLATE_FIELDS } = require('./prompts');
const { FORMER } = require('./equipment');

const MAX_ASKS = 200;
const ASK_TTL_DAYS = 30;
const MAX_REPLIES = 30;
const MAX_PHOTOS = 3;
const PHOTO_MAX = 200_000; // data URL chars (~150 KB); the app sends small thumbnails

class AskError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}
const K = { asks: (orgId) => `fixit:ask:${orgId}` };
const isLead = (role) => role === 'admin' || role === 'lead';

function createAskStore(redisClient) {
  const kv = createKV(redisClient);
  const ttlMs = ASK_TTL_DAYS * 24 * 60 * 60 * 1000;

  async function all(orgId) {
    const now = Date.now();
    const list = Object.values(await kv.hgetall(K.asks(orgId)) || {}).map((v) => JSON.parse(v));
    const stale = list.filter((a) => now - a.updatedAt > ttlMs).map((a) => a.id);
    if (stale.length) await kv.hdel(K.asks(orgId), ...stale);
    return list.filter((a) => now - a.updatedAt <= ttlMs).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function save(orgId, ask) {
    await kv.hset(K.asks(orgId), ask.id, JSON.stringify(ask));
    await kv.expire(K.asks(orgId), 2 * ASK_TTL_DAYS * 24 * 60 * 60);
    return ask;
  }
  async function get(orgId, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) return null;
    const v = await kv.hget(K.asks(orgId), id);
    return v ? JSON.parse(v) : null;
  }

  function callInput(c) {
    c = c && typeof c === 'object' ? c : {};
    const photos = Array.isArray(c.photos) ? c.photos.slice(0, MAX_PHOTOS).filter((p) =>
      typeof p === 'string' && p.length <= PHOTO_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) : [];
    return {
      service: clean(c.service, 40), serviceId: clean(c.serviceId, 20),
      problem: clean(c.problem, 2000), diagnosis: clean(c.diagnosis, 8000), notes: clean(c.notes, 1000),
      site: clean(c.site, 200), faultCode: clean(c.faultCode, 40),
      readings: cleanFields(c.readings, READING_FIELDS), plate: cleanFields(c.plate, PLATE_FIELDS), photos
    };
  }

  async function create(org, user, body) {
    body = body || {};
    const question = clean(body.question, 500);
    const call = callInput(body.call);
    if (!question && !call.problem && !call.diagnosis) throw new AskError(400, 'bad_request', 'Add a question or a diagnosis to send');
    const now = Date.now();
    const ask = {
      id: crypto.randomBytes(6).toString('hex'), fromUid: user.uid, fromName: clean(user.name, 60) || clean(user.email, 80) || 'Tech',
      createdAt: now, updatedAt: now, status: 'open', question, call, replies: [], techSeenAt: now
    };
    await save(org.id, ask);
    // Prune: keep the newest MAX_ASKS, dropping closed/answered ones first.
    const list = await all(org.id);
    if (list.length > MAX_ASKS) {
      const drop = [...list].sort((a, b) => (a.status === 'open') - (b.status === 'open') || a.updatedAt - b.updatedAt).slice(0, list.length - MAX_ASKS);
      await kv.hdel(K.asks(org.id), ...drop.map((a) => a.id));
    }
    return ask;
  }

  const summary = (a) => ({ ...a, call: { ...a.call, photos: undefined, photoCount: (a.call.photos || []).length } });

  async function mine(orgId, uid) {
    return (await all(orgId)).filter((a) => a.fromUid === uid).slice(0, 30)
      .map((a) => ({ ...summary(a), unread: a.replies.some((r) => r.uid !== uid && r.ts > (a.techSeenAt || 0)) }));
  }

  async function queue(orgId) {
    const list = await all(orgId);
    const open = list.filter((a) => a.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
    const rest = list.filter((a) => a.status !== 'open').slice(0, 30);
    return { open: open.length, asks: [...open, ...rest].map(summary) };
  }

  function canSee(ask, uid, role) { return ask.fromUid === uid || isLead(role); }

  async function read(orgId, id, uid, role) {
    const ask = await get(orgId, id);
    if (!ask || !canSee(ask, uid, role)) throw new AskError(404, 'not_found', 'Not found');
    if (ask.fromUid === uid) { ask.techSeenAt = Date.now(); await save(orgId, ask); }
    return ask;
  }

  async function reply(orgId, id, user, role, body) {
    const ask = await get(orgId, id);
    if (!ask || !canSee(ask, user.uid, role)) throw new AskError(404, 'not_found', 'Not found');
    const text = clean((body || {}).text, 1000);
    if (!text) throw new AskError(400, 'bad_request', 'Write a reply');
    if (ask.status === 'closed') throw new AskError(409, 'closed', 'This request is closed');
    if (ask.replies.length >= MAX_REPLIES) throw new AskError(409, 'too_many_replies', 'Too many replies — start a new request');
    const fromLead = ask.fromUid !== user.uid;
    ask.replies.push({ uid: user.uid, name: clean(user.name, 60) || clean(user.email, 80) || 'Lead', role: fromLead ? (role === 'admin' ? 'admin' : 'lead') : 'tech', text, ts: Date.now() });
    ask.status = (body || {}).close && fromLead ? 'closed' : fromLead ? 'answered' : 'open';
    ask.updatedAt = Date.now();
    return save(orgId, ask);
  }

  async function close(orgId, id, uid, role) {
    const ask = await get(orgId, id);
    if (!ask || !canSee(ask, uid, role)) throw new AskError(404, 'not_found', 'Not found');
    ask.status = 'closed'; ask.updatedAt = Date.now();
    return save(orgId, ask);
  }

  // Account deletion: remove the person's own requests; keep leads' replies on
  // other people's calls but drop the name/uid.
  async function deleteUser(orgId, uid) {
    const list = Object.values(await kv.hgetall(K.asks(orgId)) || {}).map((v) => JSON.parse(v));
    const mineIds = list.filter((a) => a.fromUid === uid).map((a) => a.id);
    if (mineIds.length) await kv.hdel(K.asks(orgId), ...mineIds);
    for (const a of list.filter((x) => x.fromUid !== uid && x.replies.some((r) => r.uid === uid))) {
      a.replies = a.replies.map((r) => (r.uid === uid ? { ...r, uid: null, name: FORMER } : r));
      await kv.hset(K.asks(orgId), a.id, JSON.stringify(a));
    }
    return mineIds.length;
  }
  async function deleteOrg(orgId) { await kv.del(K.asks(orgId)); }

  return { create, mine, queue, read, reply, close, deleteUser, deleteOrg, get };
}

module.exports = { createAskStore, AskError, isLead, K, MAX_ASKS };

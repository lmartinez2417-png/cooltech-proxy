/**
 * Organizations (companies) for team mode.
 * ────────────────────────────────────────
 * Stored in the same Redis the proxy already uses for limits (no extra
 * service, no Firebase service-account key needed — firebase-admin here only
 * verifies ID tokens). Railway Redis is persistent; without Redis this falls
 * back to memory (dev/tests only — orgs vanish on restart, so don't run
 * production without REDIS_URL).
 *
 * Keys:
 *   fixit:org:<orgId>                 JSON {id,name,ownerUid,seatLimit,active,plan,domain,inviteCode,createdAt}
 *   fixit:org:members:<orgId>         hash uid -> JSON {uid,email,role,joinedAt}
 *   fixit:org:invite:<CODE>           orgId
 *   fixit:org:domain:<domain>         orgId (verified-email auto-join)
 *   fixit:org:admin-email:<email>     orgId (bootstrap: this verified email becomes admin on first sign-in)
 *   fixit:org:usage:<orgId>:<YYYY-MM> hash uid -> successful AI requests that month
 *   fixit:user:org:<uid>              orgId
 *   fixit:orgs:index                  hash orgId -> name (platform admin listing)
 *   fixit:org:pricelist:<orgId>       company price list text (admin-entered; used by close-out)
 *
 * Billing: TODO — `active` and `plan` are set by the platform admin today
 * (scripts/org-admin.js or POST /admin/orgs/:id). When org billing exists, a
 * payment webhook should flip `active`/`plan` instead.
 */
const crypto = require('crypto');

const K = {
  org: (id) => `fixit:org:${id}`,
  members: (id) => `fixit:org:members:${id}`,
  invite: (code) => `fixit:org:invite:${code}`,
  domain: (d) => `fixit:org:domain:${d}`,
  adminEmail: (e) => `fixit:org:admin-email:${e}`,
  usage: (id, ym) => `fixit:org:usage:${id}:${ym}`,
  userOrg: (uid) => `fixit:user:org:${uid}`,
  index: 'fixit:orgs:index',
  priceList: (id) => `fixit:org:pricelist:${id}`
};

class OrgError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

const { createKV } = require('./kv');

const normEmail = (e) => String(e || '').trim().toLowerCase();
const domainOf = (e) => normEmail(e).split('@')[1] || '';
const normDomain = (d) => String(d || '').trim().toLowerCase().replace(/^@/, '');
const monthKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
// Unambiguous invite codes (no 0/O/1/I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  const b = crypto.randomBytes(8);
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
  return c;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function createOrgStore(redisClient, opts = {}) {
  const kv = createKV(redisClient);
  const defaultSeats = opts.defaultSeatLimit || 10;
  const selfServeActive = !!opts.selfServeActive;

  async function getOrg(id) {
    const v = id && await kv.get(K.org(id));
    return v ? JSON.parse(v) : null;
  }
  async function saveOrg(o) {
    await kv.set(K.org(o.id), JSON.stringify(o));
    await kv.hset(K.index, o.id, o.name);
  }
  async function getMember(orgId, uid) {
    const v = await kv.hget(K.members(orgId), uid);
    return v ? JSON.parse(v) : null;
  }
  async function listMembers(orgId) {
    const all = await kv.hgetall(K.members(orgId));
    return Object.values(all || {}).map((v) => JSON.parse(v)).sort((a, b) => a.joinedAt - b.joinedAt);
  }
  async function addMember(org, user, role) {
    if (await kv.hlen(K.members(org.id)) >= org.seatLimit) {
      throw new OrgError(409, 'seat_limit', `${org.name} has no free seats (limit ${org.seatLimit}). Ask your admin to add seats.`);
    }
    const m = { uid: user.uid, email: normEmail(user.email) || null, role, joinedAt: Date.now() };
    await kv.hset(K.members(org.id), user.uid, JSON.stringify(m));
    await kv.set(K.userOrg(user.uid), org.id);
    return m;
  }
  async function removeMember(orgId, uid) {
    await kv.hdel(K.members(orgId), uid);
    if (await kv.get(K.userOrg(uid)) === orgId) await kv.del(K.userOrg(uid));
  }
  async function newUniqueCode(orgId) {
    for (let i = 0; i < 5; i++) {
      const code = newInviteCode();
      if (await kv.set(K.invite(code), orgId, 'NX')) return code;
    }
    throw new Error('Could not create an invite code');
  }
  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'org';
  }

  async function createOrg({ name, owner, domain, seatLimit, active, plan, id }) {
    name = String(name || '').trim().slice(0, 80);
    if (name.length < 2) throw new OrgError(400, 'bad_request', 'Company name is required');
    if (owner && await kv.get(K.userOrg(owner.uid))) {
      throw new OrgError(409, 'already_in_org', 'You already belong to a company. Leave it first.');
    }
    const orgId = id || `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`;
    if (await getOrg(orgId)) throw new OrgError(409, 'exists', 'That company id already exists');
    const org = {
      id: orgId, name, ownerUid: owner ? owner.uid : null,
      seatLimit: Math.max(1, parseInt(seatLimit, 10) || defaultSeats),
      active: active === undefined ? selfServeActive : !!active,
      plan: plan || 'team', domain: null, inviteCode: null, createdAt: Date.now()
    };
    org.inviteCode = await newUniqueCode(orgId);
    await saveOrg(org);
    if (domain) await setDomain(org, domain);
    if (owner) await addMember(org, owner, 'admin');
    return getOrg(orgId);
  }

  async function setDomain(org, domain) {
    const d = normDomain(domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new OrgError(400, 'bad_request', 'Invalid email domain');
    const taken = await kv.get(K.domain(d));
    if (taken && taken !== org.id) throw new OrgError(409, 'domain_taken', 'That email domain is already linked to another company');
    if (org.domain && org.domain !== d) await kv.del(K.domain(org.domain));
    org.domain = d;
    await kv.set(K.domain(d), org.id);
    await saveOrg(org);
    return org;
  }

  async function rotateInvite(org) {
    if (org.inviteCode) await kv.del(K.invite(org.inviteCode));
    org.inviteCode = await newUniqueCode(org.id);
    await saveOrg(org);
    return org;
  }

  async function joinWithCode(user, code) {
    if (await kv.get(K.userOrg(user.uid))) throw new OrgError(409, 'already_in_org', 'You already belong to a company. Leave it first.');
    const orgId = await kv.get(K.invite(normCode(code)));
    const org = await getOrg(orgId);
    if (!org) throw new OrgError(404, 'invalid_code', 'That invite code is not valid. Check it with your admin.');
    await addMember(org, user, 'tech');
    return org;
  }

  // Resolve the caller's org + role. Handles bootstrap-admin and verified-domain auto-join.
  async function resolveUser(user) {
    let orgId = await kv.get(K.userOrg(user.uid));
    if (orgId) {
      const org = await getOrg(orgId);
      const member = org && await getMember(orgId, user.uid);
      if (org && member) return { org, role: member.role };
      await kv.del(K.userOrg(user.uid)); // stale pointer
    }
    if (!user.emailVerified || !user.email) return { org: null, role: null };
    const email = normEmail(user.email);
    const adminOrg = await getOrg(await kv.get(K.adminEmail(email)));
    if (adminOrg) {
      await kv.hset(K.members(adminOrg.id), user.uid, JSON.stringify({ uid: user.uid, email, role: 'admin', joinedAt: Date.now() }));
      await kv.set(K.userOrg(user.uid), adminOrg.id);
      if (!adminOrg.ownerUid) { adminOrg.ownerUid = user.uid; await saveOrg(adminOrg); }
      await kv.del(K.adminEmail(email));
      return { org: adminOrg, role: 'admin' };
    }
    const domOrg = await getOrg(await kv.get(K.domain(domainOf(email))));
    if (domOrg && domOrg.active) {
      try {
        await addMember(domOrg, user, 'tech');
        return { org: domOrg, role: 'tech' };
      } catch (e) {
        if (e.type !== 'seat_limit') throw e; // full: just treat as a normal user
      }
    }
    return { org: null, role: null };
  }

  // Leave (or account deletion). The last admin can't leave while techs remain,
  // unless `promote` is set (account deletion): then the longest-tenured member becomes admin.
  async function leave(user, { promote = false } = {}) {
    const { org, role } = await resolveUser({ uid: user.uid });
    if (!org) return { left: false };
    const members = await listMembers(org.id);
    const others = members.filter((m) => m.uid !== user.uid);
    if (role === 'admin' && !others.some((m) => m.role === 'admin')) {
      if (others.length && !promote) {
        throw new OrgError(409, 'last_admin', 'You are the only admin. Remove your techs first, or make someone else admin.');
      }
      if (others.length) {
        const heir = others[0];
        heir.role = 'admin';
        await kv.hset(K.members(org.id), heir.uid, JSON.stringify(heir));
        org.ownerUid = heir.uid;
        await saveOrg(org);
      }
    }
    await removeMember(org.id, user.uid);
    if (!others.length) await deleteOrg(org);
    return { left: true, orgId: org.id, orgDeleted: !others.length };
  }

  async function deleteOrg(org) {
    await kv.hdel(K.index, org.id);
    const keys = [K.org(org.id), K.members(org.id), K.priceList(org.id)];
    if (org.inviteCode) keys.push(K.invite(org.inviteCode));
    if (org.domain) keys.push(K.domain(org.domain));
    await kv.del(...keys);
  }

  async function setRole(org, uid, role) {
    const m = await getMember(org.id, uid);
    if (!m) throw new OrgError(404, 'not_found', 'Not a member of this company');
    m.role = role;
    await kv.hset(K.members(org.id), uid, JSON.stringify(m));
    return m;
  }

  async function recordUsage(orgId, uid) {
    const key = K.usage(orgId, monthKey());
    await kv.hincrby(key, uid, 1);
    await kv.expire(key, 400 * 24 * 60 * 60);
  }
  async function monthUsage(orgId) {
    const all = await kv.hgetall(K.usage(orgId, monthKey()));
    const out = {};
    for (const [k, v] of Object.entries(all || {})) out[k] = parseInt(v, 10) || 0;
    return out;
  }

  async function update(org, patch) {
    if (patch.name !== undefined) org.name = String(patch.name).trim().slice(0, 80) || org.name;
    if (patch.seatLimit !== undefined) org.seatLimit = Math.max(1, parseInt(patch.seatLimit, 10) || org.seatLimit);
    if (patch.active !== undefined) org.active = !!patch.active;
    if (patch.plan !== undefined) org.plan = String(patch.plan).slice(0, 30);
    await saveOrg(org);
    if (patch.domain) await setDomain(org, patch.domain);
    return getOrg(org.id);
  }

  // Idempotent bootstrap from ORG_BOOTSTRAP (JSON). Never overwrites an existing org's members.
  async function bootstrap(cfg) {
    if (!cfg || !cfg.name) return null;
    const id = cfg.id || slug(cfg.name);
    let org = await getOrg(id);
    if (!org) {
      org = await createOrg({ id, name: cfg.name, seatLimit: cfg.seatLimit, active: cfg.active !== false, plan: cfg.plan || 'team' });
    } else if (cfg.seatLimit && org.seatLimit !== cfg.seatLimit) {
      org = await update(org, { seatLimit: cfg.seatLimit });
    }
    if (cfg.domain && org.domain !== normDomain(cfg.domain)) org = await setDomain(org, cfg.domain);
    if (cfg.adminEmail) {
      const email = normEmail(cfg.adminEmail);
      const members = await listMembers(org.id);
      if (!members.some((m) => m.email === email && m.role === 'admin')) await kv.set(K.adminEmail(email), org.id);
    }
    return org;
  }

  // Company price list (plain text the admin pastes in; never required).
  async function getPriceList(orgId) {
    return (await kv.get(K.priceList(orgId))) || '';
  }
  async function setPriceList(orgId, text) {
    if (text) await kv.set(K.priceList(orgId), text); else await kv.del(K.priceList(orgId));
  }

  async function listAll() {
    const ids = Object.keys(await kv.hgetall(K.index) || {});
    return (await Promise.all(ids.map(getOrg))).filter(Boolean);
  }

  return {
    kv, getOrg, getMember, listMembers, createOrg, setDomain, rotateInvite, joinWithCode, resolveUser,
    leave, removeMember, setRole, recordUsage, monthUsage, update, bootstrap, deleteOrg, listAll,
    getPriceList, setPriceList
  };
}

module.exports = { createOrgStore, OrgError, K, normCode, monthKey };

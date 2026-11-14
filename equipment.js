/**
 * Equipment history: customers/addresses ("sites"), the units installed there,
 * and past jobs. Shared by everyone in a company; private for solo users.
 * ────────────────────────────────────────────────────────────────────────
 * Scope: "org:<orgId>" for company members (all techs share it), "user:<uid>" otherwise.
 * Keys:
 *   fixit:eq:<scope>:sites            hash siteId -> JSON {id,name,address,notes,createdAt,updatedAt,createdBy}
 *   fixit:eq:<scope>:units:<siteId>   hash unitId -> JSON {id,position,equipmentType,brand,model,serial,refrigerant,tonnage,installDate,manufactureDate,label,...}
 *   fixit:eq:<scope>:jobs:<siteId>    list (newest first) of JSON jobs, trimmed to MAX_JOBS
 * Search loads the scope's sites hash (fine to a few thousand sites; move to a
 * search index if a company gets much bigger).
 */
const crypto = require('crypto');
const { createKV } = require('./kv');
const { clean, cleanFields, READING_FIELDS } = require('./prompts');

const MAX_SITES = 5000;
const MAX_UNITS = 20;
const MAX_JOBS = 100;
const POSITIONS = new Set(['indoor', 'outdoor', 'other']);
const UNIT_FIELDS = {
  equipmentType: 40, brand: 40, model: 40, serial: 40, refrigerant: 20, tonnage: 10,
  installDate: 30, manufactureDate: 40, label: 40, btu: 20, voltage: 20
};
const FORMER = 'Former team member';

class EqError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

const K = {
  sites: (s) => `fixit:eq:${s}:sites`,
  units: (s, id) => `fixit:eq:${s}:units:${id}`,
  jobs: (s, id) => `fixit:eq:${s}:jobs:${id}`
};
const newId = () => crypto.randomBytes(6).toString('hex');
const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id);

function createEquipmentStore(redisClient) {
  const kv = createKV(redisClient);
  const parse = (v) => (v ? JSON.parse(v) : null);

  async function getSite(scope, id) {
    if (!validId(id)) return null;
    return parse(await kv.hget(K.sites(scope), id));
  }
  async function saveSite(scope, site) {
    await kv.hset(K.sites(scope), site.id, JSON.stringify(site));
    return site;
  }
  async function touch(scope, site) { site.updatedAt = Date.now(); return saveSite(scope, site); }

  function siteInput(body, partial) {
    const name = clean(body.name, 80);
    const address = clean(body.address, 160);
    if (!partial && !name && !address) throw new EqError(400, 'bad_request', 'Enter a customer name or an address');
    const out = {};
    if (!partial || body.name !== undefined) out.name = name;
    if (!partial || body.address !== undefined) out.address = address;
    if (!partial || body.notes !== undefined) out.notes = clean(body.notes, 300);
    return out;
  }

  async function createSite(scope, body, user) {
    if (await kv.hlen(K.sites(scope)) >= MAX_SITES) throw new EqError(409, 'site_limit', `Customer limit reached (${MAX_SITES}).`);
    const now = Date.now();
    const site = { id: newId(), ...siteInput(body || {}), createdAt: now, updatedAt: now, createdBy: user.uid };
    return saveSite(scope, site);
  }

  async function updateSite(scope, id, body) {
    const site = await getSite(scope, id);
    if (!site) throw new EqError(404, 'not_found', 'Customer not found');
    Object.assign(site, siteInput(body || {}, true));
    if (!site.name && !site.address) throw new EqError(400, 'bad_request', 'Enter a customer name or an address');
    return touch(scope, site);
  }

  async function search(scope, q, limit = 20) {
    const all = Object.values(await kv.hgetall(K.sites(scope)) || {}).map((v) => JSON.parse(v));
    const terms = norm(q).split(' ').filter(Boolean);
    const hits = terms.length
      ? all.filter((s) => { const hay = norm(`${s.name} ${s.address}`); return terms.every((t) => hay.includes(t)); })
      : all;
    hits.sort((a, b) => b.updatedAt - a.updatedAt);
    return { total: hits.length, sites: hits.slice(0, limit) };
  }

  async function listUnits(scope, siteId) {
    return Object.values(await kv.hgetall(K.units(scope, siteId)) || {}).map((v) => JSON.parse(v)).sort((a, b) => a.createdAt - b.createdAt);
  }

  // Add or update a unit. Matches an existing unit by serial, else by model+position.
  async function upsertUnit(scope, siteId, body) {
    const site = await getSite(scope, siteId);
    if (!site) throw new EqError(404, 'not_found', 'Customer not found');
    body = body || {};
    const f = {};
    for (const [k, max] of Object.entries(UNIT_FIELDS)) { const v = clean(body[k], max); if (v) f[k] = v; }
    if (!f.model && !f.serial && !f.brand && !f.label) throw new EqError(400, 'bad_request', 'A unit needs at least a brand, model, serial or label');
    f.position = POSITIONS.has(body.position) ? body.position : guessPosition(f.equipmentType);
    const units = await listUnits(scope, siteId);
    const key = (s) => norm(s).replace(/ /g, '');
    let unit = (validId(body.id) && units.find((u) => u.id === body.id))
      || (f.serial && units.find((u) => u.serial && key(u.serial) === key(f.serial)))
      || (!f.serial && f.model && units.find((u) => !u.serial && u.model && key(u.model) === key(f.model) && u.position === f.position));
    const now = Date.now();
    if (unit) {
      Object.assign(unit, f, { updatedAt: now });
    } else {
      if (units.length >= MAX_UNITS) throw new EqError(409, 'unit_limit', `This customer already has ${MAX_UNITS} units on file.`);
      unit = { id: newId(), ...f, createdAt: now, updatedAt: now };
    }
    await kv.hset(K.units(scope, siteId), unit.id, JSON.stringify(unit));
    await touch(scope, site);
    return unit;
  }

  async function deleteUnit(scope, siteId, unitId) {
    if (!validId(unitId) || !await kv.hget(K.units(scope, siteId), unitId)) throw new EqError(404, 'not_found', 'Unit not found');
    await kv.hdel(K.units(scope, siteId), unitId);
  }

  async function listJobs(scope, siteId, limit = 50) {
    return (await kv.lrange(K.jobs(scope, siteId), 0, limit - 1)).map((v) => JSON.parse(v));
  }

  async function addJob(scope, siteId, body, user) {
    const site = await getSite(scope, siteId);
    if (!site) throw new EqError(404, 'not_found', 'Customer not found');
    body = body || {};
    const units = await listUnits(scope, siteId);
    const unitIds = Array.isArray(body.unitIds) ? body.unitIds.filter((id) => units.some((u) => u.id === id)).slice(0, MAX_UNITS) : [];
    const conf = ['high', 'medium', 'low'].includes(body.confidence) ? body.confidence : null;
    const job = {
      id: newId(), ts: Date.now(), techUid: user.uid, techName: clean(body.techName, 60) || null,
      unitIds, serviceId: clean(body.serviceId, 20) || null, service: clean(body.service, 40) || null,
      problem: clean(body.problem, 2000), cause: clean(body.cause, 400), confidence: conf,
      diagnosis: clean(body.diagnosis, 8000), readings: cleanFields(body.readings, READING_FIELDS),
      faultCode: clean(body.faultCode, 40) || null, notes: clean(body.notes, 1000),
      closeout: clean(body.closeout, 4000), reportId: clean(body.reportId, 40) || null
    };
    if (!job.problem && !job.diagnosis && !job.notes) throw new EqError(400, 'bad_request', 'Nothing to save');
    // Same report saved twice (e.g. after a follow-up) replaces the earlier copy.
    if (job.reportId) {
      const prev = (await listJobs(scope, siteId, MAX_JOBS)).find((j) => j.reportId === job.reportId);
      if (prev) { job.id = prev.id; await kv.lrem(K.jobs(scope, siteId), 0, JSON.stringify(prev)); }
    }
    await kv.lpush(K.jobs(scope, siteId), JSON.stringify(job));
    await kv.ltrim(K.jobs(scope, siteId), 0, MAX_JOBS - 1);
    await touch(scope, site);
    return job;
  }

  async function deleteJob(scope, siteId, jobId, { uid, isAdmin }) {
    const jobs = await listJobs(scope, siteId, MAX_JOBS);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new EqError(404, 'not_found', 'Job not found');
    if (!isAdmin && job.techUid !== uid) throw new EqError(403, 'forbidden', 'Only the tech who saved it or an admin can delete this job.');
    await kv.lrem(K.jobs(scope, siteId), 0, JSON.stringify(job));
  }

  async function getSiteFull(scope, id, jobLimit = 50) {
    const site = await getSite(scope, id);
    if (!site) return null;
    const [units, jobs] = await Promise.all([listUnits(scope, id), listJobs(scope, id, jobLimit)]);
    return { site, units, jobs };
  }

  async function deleteSite(scope, id) {
    if (!await getSite(scope, id)) throw new EqError(404, 'not_found', 'Customer not found');
    await kv.hdel(K.sites(scope), id);
    await kv.del(K.units(scope, id), K.jobs(scope, id));
  }

  // Remove everything in a scope (solo account deletion, or a company that no longer exists).
  async function deleteScope(scope) {
    const ids = Object.keys(await kv.hgetall(K.sites(scope)) || {});
    const keys = [K.sites(scope)];
    ids.forEach((id) => keys.push(K.units(scope, id), K.jobs(scope, id)));
    for (let i = 0; i < keys.length; i += 500) await kv.del(...keys.slice(i, i + 500));
    return ids.length;
  }

  // Account deletion inside a company: the company keeps its customer records,
  // but the departing tech's uid and name are removed from their jobs.
  async function anonymizeUser(scope, uid) {
    const ids = Object.keys(await kv.hgetall(K.sites(scope)) || {});
    let n = 0;
    for (const id of ids) {
      const raw = await kv.lrange(K.jobs(scope, id), 0, -1);
      for (let i = 0; i < raw.length; i++) {
        const j = JSON.parse(raw[i]);
        if (j.techUid === uid) { j.techUid = null; j.techName = FORMER; await kv.lset(K.jobs(scope, id), i, JSON.stringify(j)); n++; }
      }
      const site = await getSite(scope, id);
      if (site && site.createdBy === uid) { site.createdBy = null; await saveSite(scope, site); }
    }
    return n;
  }

  return { getSite, createSite, updateSite, search, listUnits, upsertUnit, deleteUnit, listJobs, addJob, deleteJob, getSiteFull, deleteSite, deleteScope, anonymizeUser };
}

function guessPosition(type) {
  const t = String(type || '').toLowerCase();
  if (/condens|heat ?pump|outdoor|compressor|package/.test(t)) return 'outdoor';
  if (/furnace|air ?handler|coil|indoor|fan coil|evaporator|boiler/.test(t)) return 'indoor';
  return 'other';
}

module.exports = { createEquipmentStore, EqError, K, guessPosition, MAX_JOBS, FORMER };

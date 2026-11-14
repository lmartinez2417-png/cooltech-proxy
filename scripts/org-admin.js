#!/usr/bin/env node
/**
 * Platform admin CLI for FixIt AI companies (orgs).
 * Talks straight to the production Redis — run it with Railway's env, e.g.:
 *   railway run node scripts/org-admin.js list
 *
 * Commands:
 *   list                              all companies
 *   show <orgId>                      company + members + this month's usage
 *   activate <orgId> | deactivate <orgId>
 *   seats <orgId> <n>                 set seat limit
 *   plan <orgId> <name>               set plan label (billing TODO)
 *   domain <orgId> <domain>           link a verified-email auto-join domain
 *   rotate <orgId>                    new invite code (old one stops working)
 *   bootstrap '<json>'                same JSON as ORG_BOOTSTRAP, e.g.
 *     '{"id":"infinity-air","name":"Infinity Air Heating and Cooling","domain":"infinityaircool.com","adminEmail":"leo@infinityaircool.com","seatLimit":25}'
 */
const { createOrgStore } = require('../orgs');

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (!process.env.REDIS_URL) {
    console.error('REDIS_URL is not set. Run with: railway run node scripts/org-admin.js ...');
    process.exit(1);
  }
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL);
  const store = createOrgStore(redis);
  const need = async (id) => {
    const o = await store.getOrg(id);
    if (!o) throw new Error(`No company with id "${id}"`);
    return o;
  };
  const show = (o) => console.log(JSON.stringify({ ...o, logo: o.logo ? '(set)' : null }, null, 2));
  try {
    switch (cmd) {
      case 'list':
        for (const o of await store.listAll()) console.log(`${o.id}\t${o.active ? 'ACTIVE ' : 'inactive'}\tseats ${o.seatLimit}\t${o.name}`);
        break;
      case 'show': {
        const o = await need(a);
        show(o);
        const usage = await store.monthUsage(o.id);
        for (const m of await store.listMembers(o.id)) console.log(`  ${m.role}\t${m.email || m.uid}\t${m.name || ''}\tthis month: ${usage[m.uid] || 0}`);
        break;
      }
      case 'activate': case 'deactivate':
        show(await store.update(await need(a), { active: cmd === 'activate' })); break;
      case 'seats': show(await store.update(await need(a), { seatLimit: b })); break;
      case 'plan': show(await store.update(await need(a), { plan: b })); break;
      case 'domain': show(await store.setDomain(await need(a), b)); break;
      case 'rotate': show(await store.rotateInvite(await need(a))); break;
      case 'bootstrap': show(await store.bootstrap(JSON.parse(a))); break;
      default:
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    }
  } finally {
    redis.disconnect();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });

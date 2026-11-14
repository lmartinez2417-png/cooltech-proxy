/**
 * Manufacturer literature links for fault-code lookups.
 * ─────────────────────────────────────────────────────
 * We NEVER link a specific manual page or document number (we can't verify
 * those). We only build web searches: one restricted to the manufacturer's own
 * site (for brands whose domain we're sure of), and one general search for the
 * model's installation / service literature. The tech opens the real document.
 */
const BRAND_DOMAINS = {
  carrier: 'carrier.com',
  bryant: 'bryant.com',
  payne: 'payne.com',
  trane: 'trane.com',
  'american standard': 'americanstandardair.com',
  lennox: 'lennox.com',
  goodman: 'goodmanmfg.com',
  amana: 'amana-hac.com',
  daikin: 'daikincomfort.com',
  rheem: 'rheem.com',
  ruud: 'ruud.com',
  york: 'york.com',
  mitsubishi: 'mitsubishicomfort.com',
  fujitsu: 'fujitsugeneral.com',
  lg: 'lghvac.com'
};

function brandKey(brand) {
  const b = String(brand || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!b) return null;
  return Object.keys(BRAND_DOMAINS).find((k) => b === k || b.startsWith(k + ' ') || b.includes(k)) || null;
}

const google = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

function literatureLinks({ brand, model, code }) {
  const links = [];
  const k = brandKey(brand);
  const m = String(model || '').trim();
  const c = String(code || '').trim();
  if (k) {
    links.push({
      kind: 'manufacturer',
      label: `Search ${brand.trim()} literature`,
      url: google(`${m ? m + ' ' : ''}${c ? c + ' ' : ''}fault code site:${BRAND_DOMAINS[k]}`)
    });
  }
  if (m || brand) {
    links.push({
      kind: 'manual',
      label: 'Find the installation / service manual',
      url: google(`${brand ? brand.trim() + ' ' : ''}${m} installation service manual pdf`.trim())
    });
  }
  return links;
}

module.exports = { BRAND_DOMAINS, brandKey, literatureLinks };

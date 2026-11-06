// Awin: syncs your Awin publisher account with the brands on Cribpicks.
// Matches each Awin program to a brand by website, then fills in network, join link, status (joined → approved,
// pending → applied, rejected → declined) and the program's stats (EPC, conversion rate, approval rate).
// The API token is stored in the database (Settings → Awin), never in the code.
import { fail, all, first, logActivity } from './util.js';

const API = 'https://api.awin.com';
// Shared hosts that many brands' "website" field can point at: never match on these.
const SHARED = /(^|\.)(amazon|walmart|target|etsy|ebay|shopify|myshopify|google|facebook|instagram|linktr|squarespace|wixsite|bigcartel)\./i;
// Site's root domain: ergobaby.com, or pigeon.com.my / brand.co.uk (country domains keep three parts).
const root = (d) => {
  const parts = String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').split('/')[0].split('.');
  const n = parts.length >= 3 && /^[a-z]{2}$/.test(parts.at(-1)) && /^(com|co|net|org|gov|ac|edu)$/.test(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join('.');
};
const STATUS = { joined: 'approved', pending: 'applied', rejected: 'declined' };

async function token(env) { return ((await first(env, `SELECT value FROM meta WHERE key='awin_token'`))?.value || '').trim(); }
async function awin(env, path, tok) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${tok || (await token(env))}` } });
  if (r.status === 401 || r.status === 403) throw fail('Awin turned the token down. Make a new one in Awin → Toolbox → API credentials and paste it in Settings.');
  if (r.status === 429) throw fail('Awin allows 20 requests a minute and that was used up. Try again in a minute.', 429);
  if (!r.ok) throw fail(`Awin error ${r.status}`, 502);
  return r.json();
}
const setMeta = (env, k, v) => env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(k, v).run();

export async function awinStatus(env) {
  const m = Object.fromEntries((await all(env, `SELECT key, value FROM meta WHERE key LIKE 'awin_%'`)).map((r) => [r.key, r.value]));
  return { set: Boolean(m.awin_token), publisher: m.awin_publisher || null, account: m.awin_account || null, lastSync: m.awin_last_sync || null,
    summary: m.awin_summary ? JSON.parse(m.awin_summary) : null };
}

export async function saveAwinToken(env, body) {
  const tok = String(body.token || '').trim();
  if (!tok) { await env.DB.prepare(`DELETE FROM meta WHERE key IN ('awin_token','awin_publisher','awin_account')`).run(); return { ok: true, removed: true }; }
  if (!/^[0-9a-f-]{30,40}$/i.test(tok)) throw fail('That doesn\'t look like an Awin API token (it looks like 6c4d…-…).');
  const acc = await awin(env, '/accounts', tok);
  const pub = (acc.accounts || []).find((a) => a.accountType === 'publisher');
  if (!pub) throw fail('That token works, but it has no publisher account.');
  await setMeta(env, 'awin_token', tok); await setMeta(env, 'awin_publisher', String(pub.accountId)); await setMeta(env, 'awin_account', pub.accountName || '');
  return { ok: true, account: pub.accountName, publisher: pub.accountId };
}

// Full sync: every US program and your relationship with it, matched to brands by website.
export async function syncAwin(env) {
  const tok = await token(env);
  if (!tok) throw fail('Add your Awin API token in Settings first.');
  const pid = (await first(env, `SELECT value FROM meta WHERE key='awin_publisher'`))?.value;
  const brands = await all(env, `SELECT id, name, domain, affiliate_status, affiliate_network, awin_id FROM brands WHERE COALESCE(domain,'')!=''`);
  const byDomain = {};
  for (const b of brands) { const d = root(b.domain); if (d && !SHARED.test(d + '.')) (byDomain[d] ||= []).push(b); }
  const progs = [];
  for (const rel of ['joined', 'pending', 'rejected', 'notjoined']) {
    const list = await awin(env, `/publishers/${pid}/programmes?relationship=${rel}&countryCode=US`, tok);
    for (const p of list || []) progs.push({ ...p, rel });
  }
  // Which programs claim each domain: a domain claimed by more than one program is ambiguous, so it's skipped.
  const claims = {};
  for (const p of progs) {
    const ds = new Set([...(p.validDomains || []).map((v) => root(v.domain)), root(p.displayUrl)].filter(Boolean));
    for (const d of ds) if (byDomain[d]) (claims[d] ||= new Map()).set(p.id, p);
  }
  let matched = 0, changed = 0;
  const counts = { joined: 0, pending: 0, rejected: 0, notjoined: 0 };
  const stmts = [];
  for (const [d, map] of Object.entries(claims)) {
    if (map.size !== 1) continue;
    const p = [...map.values()][0];
    for (const b of byDomain[d]) {
      matched++; counts[p.rel]++;
      const next = STATUS[p.rel] || (['none', 'found', 'no_program'].includes(b.affiliate_status) ? 'found' : b.affiliate_status);
      if (next !== b.affiliate_status || b.awin_id !== p.id || b.affiliate_network !== 'awin') changed++;
      stmts.push(env.DB.prepare(`UPDATE brands SET awin_id=?, affiliate_network='awin', affiliate_status=?,
          affiliate_url=COALESCE(affiliate_url, ?), affiliate_link=?, updated_at=CASE WHEN affiliate_status != ? THEN datetime('now') ELSE updated_at END WHERE id=?`)
        .bind(p.id, next, `https://ui.awin.com/merchant-profile/${p.id}`, p.rel === 'joined' ? p.clickThroughUrl || null : null, next, b.id));
      if (STATUS[p.rel] && STATUS[p.rel] !== b.affiliate_status)
        stmts.push(env.DB.prepare(`INSERT INTO activity (brand_id, kind, note) VALUES (?, 'affiliate', ?)`).bind(b.id, `Awin: ${p.rel === 'joined' ? 'approved' : p.rel} (${p.name})`));
    }
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  const summary = { programs: progs.length, matched, ...counts, at: new Date().toISOString() };
  await setMeta(env, 'awin_summary', JSON.stringify(summary)); await setMeta(env, 'awin_last_sync', summary.at);
  await fillStats(env, 8).catch(() => {}); // Awin allows 20 requests a minute; the rest fill in hourly
  return { ok: true, ...summary, changed };
}

// Program stats (EPC, conversion, approval rate, days to validate), a few at a time to stay within request limits.
export async function fillStats(env, n = 15) {
  const pid = (await first(env, `SELECT value FROM meta WHERE key='awin_publisher'`))?.value;
  const todo = await all(env, `SELECT id, awin_id, affiliate_status FROM brands WHERE awin_id IS NOT NULL AND awin_kpi IS NULL LIMIT ?`, n);
  for (const b of todo) {
    const rel = { approved: 'joined', applied: 'pending', declined: 'rejected' }[b.affiliate_status] || 'notjoined';
    const d = await awin(env, `/publishers/${pid}/programmedetails?advertiserId=${b.awin_id}&relationship=${rel}`);
    const k = d.kpi || {};
    const cr = (d.commissionRange || []).map((c) => (c.type === 'percentage' ? `${c.min === c.max ? c.min : `${c.min}–${c.max}`}%` : `$${c.min === c.max ? c.min : `${c.min}–${c.max}`}`)).join(', ');
    await env.DB.prepare(`UPDATE brands SET awin_kpi=?, commission=COALESCE(NULLIF(?, ''), commission), cookie_days=COALESCE(cookie_days, NULL) WHERE id=?`)
      .bind(JSON.stringify({ epc: k.epc ?? null, conversion: k.conversionRate ?? null, approval: k.approvalPercentage ?? null, validation_days: k.validationDays ?? null, pay_days: k.averagePaymentTime ?? null }), cr, b.id).run();
  }
  return todo.length;
}

// Earnings for the dashboard: clicks, sales and commission in the last 30 days.
export async function awinEarnings(env, { fresh = false } = {}) {
  // Cached for an hour so opening the dashboard doesn't use up Awin's 20-requests-a-minute allowance.
  const c = (await first(env, `SELECT value FROM meta WHERE key='awin_earnings'`))?.value;
  if (c && !fresh) { const j = JSON.parse(c); if (Date.now() - Date.parse(j.at) < 36e5) return j; }
  const out = await earningsNow(env);
  if (out) await setMeta(env, 'awin_earnings', JSON.stringify(out));
  return out;
}
async function earningsNow(env) {
  const pid = (await first(env, `SELECT value FROM meta WHERE key='awin_publisher'`))?.value;
  if (!pid) return null;
  const end = new Date(), start = new Date(Date.now() - 30 * 864e5);
  const day = (d) => d.toISOString().slice(0, 10);
  const rows = await awin(env, `/publishers/${pid}/reports/advertiser?startDate=${day(start)}&endDate=${day(end)}&region=US&timezone=America/New_York`);
  const sum = (k) => (rows || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return { clicks: sum('clicks'), sales: sum('totalNo'), commission: Math.round(((rows || []).reduce((a, r) => a + (Number(r.totalComm) || 0), 0)) * 100) / 100,
    top: (rows || []).sort((a, b) => (b.totalComm || 0) - (a.totalComm || 0)).slice(0, 5).map((r) => ({ name: r.advertiserName, clicks: r.clicks, commission: r.totalComm })),
    at: new Date().toISOString() };
}

// Hourly job: full sync every 6 hours, stats for a few more programs every hour.
export async function awinCron(env) {
  if (!(await token(env))) return;
  const last = (await first(env, `SELECT value FROM meta WHERE key='awin_last_sync'`))?.value;
  if (!last || Date.now() - Date.parse(last) > 6 * 36e5) await syncAwin(env);
  else await fillStats(env, 12);
}

// Shared helpers: database access, settings, responses.

export const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

export async function all(env, sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results || [];
}
export async function first(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}
export const setMetaStmt = (env, k, v) =>
  env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(k, v);
export const setMeta = (env, k, v) => setMetaStmt(env, k, v).run();
export async function getMeta(env, keys) {
  const rows = await all(env, `SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------- settings (editable in the app; wrangler.jsonc vars are only the defaults) ----------
export const SETTING_KEYS = {
  site_name: 'SITE_NAME',
  site_url: 'SITE_URL',
  sender_name: 'SENDER_NAME',
  sender_email: 'SENDER_EMAIL',
  business_address: 'BUSINESS_ADDRESS',
  daily_cap: 'DAILY_SEND_CAP',
  about: null, // what the site is and what Jen can honestly offer brands; Claude only uses facts from here
  own_emails: null, // other addresses of Jen's, so her own messages aren't logged as brand replies
  link_domains: null, // extra domains that count as links to us (e.g. the real domain before Site address switches to it)
  forward_to: null, // where mail arriving through Cloudflare Email Routing is forwarded (must be verified there)
};
const DEFAULT_ABOUT = `Baby Bodega is an independent baby gear comparison site, launching soon. It compares products side by side
across every baby gear category (strollers, car seats, cribs, feeding, nursery and more) using the manufacturers' own spec sheets,
with every spec sourced. It is run by Jen Cannizzo, a parent and digital marketer in New York. It is not live to the public yet,
so there are no traffic numbers to share. Plans: honest comparisons, a registry builder, and short TikTok videos showing the
products and the comparison tools.`;

let cfgCache = null;
export async function cfg(env, fresh = false) {
  if (cfgCache && !fresh && Date.now() - cfgCache.at < 30_000) return cfgCache.v;
  const m = await getMeta(env, Object.keys(SETTING_KEYS).map((k) => 'cfg_' + k));
  const v = {};
  for (const [k, envKey] of Object.entries(SETTING_KEYS)) {
    const saved = m['cfg_' + k];
    v[k] = (saved != null ? saved : (envKey ? env[envKey] : '') || '').trim();
  }
  if (!v.about) v.about = DEFAULT_ABOUT.replace(/\n/g, ' ');
  if (!v.site_name) v.site_name = 'Baby Bodega';
  if (!v.sender_name) v.sender_name = 'Jen Cannizzo';
  v.daily_cap = Number(v.daily_cap) || 15;
  cfgCache = { at: Date.now(), v };
  return v;
}
export function clearCfgCache() { cfgCache = null; }

export async function saveSettings(env, body) {
  const stmts = [];
  for (const k of Object.keys(SETTING_KEYS)) {
    if (body[k] === undefined) continue;
    let val = String(body[k] ?? '').trim().slice(0, 4000);
    if (k === 'sender_email' && val && !EMAIL_RE.test(val)) throw fail('The sending address doesn\'t look like an email.');
    if (k === 'site_url' && val && !/^https?:\/\//i.test(val)) val = 'https://' + val;
    if (k === 'daily_cap' && val && !(Number(val) > 0 && Number(val) <= 100)) throw fail('Daily limit should be 1 to 100.');
    stmts.push(setMetaStmt(env, 'cfg_' + k, val));
  }
  if (stmts.length) await env.DB.batch(stmts);
  clearCfgCache();
  return { ok: true, settings: await cfg(env, true) };
}

export const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
export const emailIn = (s) => ((s || '').match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase();

export function domainOf(website) {
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export function csvResponse(rows, filename, cols) {
  cols = cols || (rows.length ? Object.keys(rows[0]) : ['empty']);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  });
}

export const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Strip em/en dashes (Jen's emails never use them).
export const nodash = (t) => String(t || '').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');

export function localMidnightUTC(tz) {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = asUTC - now.getTime();
  const midnight = Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset;
  return new Date(midnight).toISOString().replace('T', ' ').slice(0, 19);
}
export async function sentToday(env) {
  const since = localMidnightUTC(env.TIMEZONE || 'America/New_York');
  const r = await first(env, `SELECT COUNT(*) n FROM messages WHERE status='sent' AND sent_at >= ?`, since);
  return r ? r.n : 0;
}

export async function logActivity(env, brandId, kind, note) {
  await env.DB.prepare(`INSERT INTO activity (brand_id, kind, note) VALUES (?, ?, ?)`).bind(brandId, kind, note || null).run();
}

// ---------- reply odds: how likely a brand is to answer (0-100, an estimate) ----------
// Small and mid-size brands answer far more often than big corporate brands. A published partnerships or
// affiliate email beats a press inbox, which beats a general inbox or a contact form. Brands that already
// run an affiliate program are actively looking for publishers. Research sharpens the estimate.
const CORPORATE = ['graco', 'baby jogger', 'nuk', 'maxi-cosi', 'safety 1st', 'quinny', 'chicco', 'evenflo', 'huggies', 'pampers', 'luvs',
  'similac', 'enfamil', 'gerber', 'philips avent', 'fisher-price', "johnson's", 'aveeno', 'desitin', 'playtex', 'tommee tippee', 'ingenuity',
  'summer infant', 'bright starts', 'baby einstein', 'medela', 'lansinoh', 'britax', 'boppy', 'carter\'s', 'munchkin', 'delta children'];
const SHARED_INBOX = /^(info|hello|hi|contact|support|help|customerservice|care|service|sales|team)@/;

export function replyOdds(b) {
  if (['replied', 'partner', 'declined', 'do_not_contact'].includes(b.status)) return null;
  let s = 45;
  if (b.kind === 'store_brand') s -= 25;
  const n = b.product_count || 0;
  s += n <= 2 ? 12 : n <= 5 ? 8 : n <= 15 ? 3 : n <= 30 ? -3 : -10;
  const nm = String(b.name || '').toLowerCase();
  if (CORPORATE.some((c) => new RegExp(`(^|[^a-z])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(nm))) s -= 15; // includes sub-brands like "babyGap by Delta Children"
  const r = parseJ(b.research, null);
  const email = String(b.contact_email || '').toLowerCase();
  const type = String(r?.email_type || b.contact_role || '').toLowerCase();
  if (email) {
    if (/partner|affiliate|influenc|collab/.test(type) || /^(partner|affiliate|influenc|collab)/.test(email)) s += 25;
    else if (/press|pr\b|media|marketing/.test(type) || /^(press|pr|media|marketing)@/.test(email)) s += 15;
    else if (SHARED_INBOX.test(email)) s += 5;
    else s += 18; // a person's own address
  } else if (b.contact_url || b.instagram) {
    s += 2;
  } else if (b.researched_at) {
    s -= 10; // looked and found no way in
  }
  if (b.affiliate_status === 'found' || b.affiliate_status === 'applied' || b.affiliate_status === 'approved') s += 10;
  if (b.affiliate_status === 'no_program') s -= 3;
  if (r?.parent_company && !String(r.parent_company).toLowerCase().includes(String(b.name || '').toLowerCase())) s -= 5;
  if (b.status === 'contacted') s -= 5; // already asked once, no answer yet
  return Math.max(3, Math.min(97, Math.round(s)));
}

export async function refreshOdds(env, id) {
  const rows = id
    ? await all(env, `SELECT * FROM brands WHERE id=?`, id)
    : await all(env, `SELECT id, name, kind, status, product_count, contact_email, contact_role, contact_url, instagram, research, researched_at, affiliate_status FROM brands`);
  const stmts = rows.map((b) => env.DB.prepare(`UPDATE brands SET reply_odds=? WHERE id=?`).bind(replyOdds(b), b.id));
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
}

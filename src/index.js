// Cribpicks brand outreach — Cloudflare Worker.
// Dashboard for asking baby gear brands for image permission, affiliate access, samples and features.

import UI from './ui.html';
import GUIDE from './guide.html';
import LOGO_PNG from './brand/cribpicks-logo.png';
import FAV32 from './brand/favicon-32.png';
import FAV192 from './brand/favicon-192.png';
import FAV512 from './brand/favicon-512.png';
import APPLE from './brand/apple-touch-icon.png';
import FAVICO from './brand/favicon.ico';
// Brand files (same as cribpicks.com/brand/). Served with long caching.
const BRAND_FILES = {
  '/brand/cribpicks-logo.png': [LOGO_PNG, 'image/png'], '/brand/favicon-32.png': [FAV32, 'image/png'],
  '/brand/favicon-192.png': [FAV192, 'image/png'], '/brand/favicon-512.png': [FAV512, 'image/png'],
  '/apple-touch-icon.png': [APPLE, 'image/png'], '/favicon.ico': [FAVICO, 'image/x-icon'],
};
import SCHEMA from '../schema.sql';
import SEED from './seed.json';
import { refreshOdds } from './util.js';
import { fail, all, first, json, csvResponse, cfg, saveSettings, setMeta, getMeta, parseJ, domainOf, EMAIL_RE, sentToday, logActivity } from './util.js';
import { sendMessage, checkReplies, gmailCreds, saveGmailClient, disconnectGmail, oauthStart, oauthCallback, sendBlocker,
  markAsked, recordReply, applyReplyEffects, classify, signature } from './gmail.js';
import { claudeKey, saveClaudeKey, researchBrand, draftEmail, rewriteMessage, draftAnswer, queueFollowups, ASKS } from './claude.js';
import { handleEmail } from './inbound.js';
import * as L from './links.js';
import * as C from './creators.js';
import { verifyEmail, verifyManual } from './verify.js';

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const statements = SCHEMA.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  // Columns added after launch.
  const cols = (await all(env, `PRAGMA table_info(brands)`)).map((c) => c.name);
  if (!cols.includes('reply_odds')) {
    await env.DB.prepare(`ALTER TABLE brands ADD COLUMN reply_odds INTEGER`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS brands_odds ON brands(reply_odds)`).run();
    await refreshOdds(env);
  }
  for (const t of ['brands', 'link_prospects']) {
    const c = (await all(env, `PRAGMA table_info(${t})`)).map((x) => x.name);
    if (!c.includes('email_check')) await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN email_check TEXT`).run();
  }
  const lpCols = (await all(env, `PRAGMA table_info(link_prospects)`)).map((x) => x.name);
  for (const [c, typ] of [['kind', "TEXT NOT NULL DEFAULT 'site'"], ['platform', 'TEXT'], ['handle', 'TEXT'], ['followers', 'INTEGER'],
    ['video_url', 'TEXT'], ['video_title', 'TEXT'], ['posted_on', 'TEXT'], ['products', 'TEXT'], ['followers_note', 'TEXT']])
    if (!lpCols.includes(c)) await env.DB.prepare(`ALTER TABLE link_prospects ADD COLUMN ${c} ${typ}`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS link_prospects_kind ON link_prospects(kind, status)`).run();
  for (const t of ['messages', 'replies']) {
    const c = (await all(env, `PRAGMA table_info(${t})`)).map((x) => x.name);
    if (!c.includes('prospect_id')) {
      await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN prospect_id INTEGER`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ${t}_prospect ON ${t}(prospect_id)`).run();
    }
  }
  // Renamed Baby Bodega -> Cribpicks (Oct 2026): update saved settings and stored page links once.
  if (!(await first(env, `SELECT 1 FROM meta WHERE key='renamed_cribpicks'`))) {
    const OLD = 'https://strollers.engagements-c1b.workers.dev', NEW = 'https://cribpicks.com';
    await env.DB.batch([
      env.DB.prepare(`UPDATE meta SET value='Cribpicks' WHERE key='cfg_site_name' AND value IN ('Baby Bodega','Nimbus Baby')`),
      env.DB.prepare(`UPDATE meta SET value=? WHERE key='cfg_site_url' AND (value LIKE '%engagements-c1b.workers.dev%' OR value LIKE '%babybodega.com%')`).bind(NEW),
      env.DB.prepare(`UPDATE meta SET value=replace(value, 'Baby Bodega', 'Cribpicks') WHERE key='cfg_about'`),
      env.DB.prepare(`UPDATE link_prospects SET target_url=replace(target_url, ?, ?) WHERE target_url LIKE ?`).bind(OLD, NEW, OLD + '%'),
      env.DB.prepare(`UPDATE link_prospects SET products=replace(products, ?, ?) WHERE products LIKE ?`).bind(OLD, NEW, '%' + OLD + '%'),
      env.DB.prepare(`UPDATE messages SET body=replace(replace(body, ?, ?), 'Baby Bodega', 'Cribpicks'), subject=replace(subject, 'Baby Bodega', 'Cribpicks') WHERE status='draft'`).bind(OLD, NEW),
      env.DB.prepare(`UPDATE creator_features SET product_urls=replace(product_urls, ?, ?) WHERE product_urls LIKE ?`).bind(OLD, NEW, '%' + OLD + '%'),
      env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('renamed_cribpicks', datetime('now'))`),
    ]);
  }
  // Name is Cribpicks with a lowercase p: fix anything saved as "CribPicks".
  if (!(await first(env, `SELECT 1 FROM meta WHERE key='renamed_cribpicks_lower'`))) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE meta SET value=replace(value, 'CribPicks', 'Cribpicks') WHERE key IN ('cfg_site_name','cfg_about','cfg_sender_name')`),
      env.DB.prepare(`UPDATE messages SET body=replace(body, 'CribPicks', 'Cribpicks'), subject=replace(subject, 'CribPicks', 'Cribpicks') WHERE status='draft'`),
      env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('renamed_cribpicks_lower', datetime('now'))`),
    ]);
  }
  schemaReady = true;
}

const html = (body) => new Response(body, {
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' },
});

function authorized(request, env) {
  // Cloudflare Access adds this header after you sign in. No header = the request skipped Access, so refuse it.
  const email = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  if (!email) return env.ALLOW_NO_ACCESS === 'true'; // local testing only
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(email);
}

const BRAND_STATUSES = ['research', 'ready', 'contacted', 'replied', 'partner', 'declined', 'skipped', 'do_not_contact'];
const ASK_STATES = {
  image_status: ['none', 'asked', 'replied', 'approved', 'declined'],
  affiliate_status: ['none', 'found', 'applied', 'approved', 'declined', 'no_program'],
  sample_status: ['none', 'asked', 'approved', 'declined', 'received'],
  collab_status: ['none', 'asked', 'approved', 'declined'],
  feed_status: ['none', 'asked', 'approved', 'declined'],
};
const MANIFEST = {
  name: 'Cribpicks Brands', short_name: 'Brands', start_url: '/', display: 'standalone',
  background_color: '#f8f4ea', theme_color: '#ece5d3',
  icons: [{ src: '/brand/favicon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/brand/favicon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/brand/favicon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
};

export default {
  async fetch(request, env, ctx) {
    if (!authorized(request, env)) return new Response('Forbidden', { status: 403 });
    await ensureSchema(env);
    const url = new URL(request.url);
    const path = url.pathname, method = request.method;
    const body = async () => (method === 'POST' ? request.json().catch(() => ({})) : {});
    try {
      if (method === 'GET' && (path === '/' || path === '/index.html')) return html(UI);
      if (BRAND_FILES[path]) return new Response(BRAND_FILES[path][0], { headers: { 'content-type': BRAND_FILES[path][1], 'cache-control': 'public, max-age=86400' } });
      if (path === '/icon.svg' || path === '/favicon.svg') return Response.redirect(new URL('/brand/favicon-192.png', url).href, 302);
      if (path === '/manifest.webmanifest') return new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/manifest+json' } });
      if (path === '/seed.json') return json(SEED);
      if (path === '/api/guide') return html(GUIDE);

      if (path === '/oauth/start') return await oauthStart(env, url);
      if (path === '/oauth/callback') return await oauthCallback(env, url);

      if (path === '/api/summary') return json(await summary(env));
      if (path === '/api/settings' && method === 'POST') return json(await saveSettings(env, await body()));
      if (path === '/api/settings/claude' && method === 'POST') return json(await saveClaudeKey(env, await body()));
      if (path === '/api/gmail/client' && method === 'POST') return json(await saveGmailClient(env, await body()));
      if (path === '/api/gmail/disconnect' && method === 'POST') return json(await disconnectGmail(env));
      if (path === '/api/import' && method === 'POST') return json(await importRows(env, await body()));
      if (path === '/api/import/finish' && method === 'POST') return json(await finishImport(env, await body()));

      if (path === '/api/today') return json(await today(env));
      if (path === '/api/filters') return json(await filters(env));
      if (path === '/api/brands' && method === 'GET') return json(await listBrands(env, url));
      if (path === '/api/brands' && method === 'POST') return json(await addBrand(env, await body()));
      if (path === '/api/research/next') return json(await researchCandidates(env, url));
      if (path === '/api/queue') return json(await queue(env));
      if (path === '/api/replies') return json(await listReplies(env, url));
      if (path === '/api/affiliates') return json(await affiliates(env));
      if (path === '/api/permissions') return json(await listPermissions(env));
      if (path === '/api/stats') return json(await stats(env));
      if (path === '/api/check-replies' && method === 'POST') return json(await checkReplies(env));
      if (path === '/api/verify' && method === 'POST') return json(await recheckEmails(env, await body()));
      if (path === '/api/verify/status') return json(await verifyStatus(env));

      // ---- creators ----
      if (path === '/api/creators/summary') return json(await C.creatorSummary(env));
      if (path === '/api/creators' && method === 'GET') { const u = new URL(url); u.searchParams.set('kind', 'creator'); return json(await L.listProspects(env, u)); }
      if (path === '/api/creators' && method === 'POST') return json(await C.addCreator(env, await body()));
      if (path === '/api/creators/find' && method === 'POST') return json(await C.findCreators(env, await body()));
      if (path === '/api/creators/features') return json(await C.listFeatures(env));
      if (path === '/api/creators/followers' && method === 'POST') return json(await C.lookupFollowers(env, await body()));
      if (path === '/api/export/creators.csv') return csvResponse(await C.exportCreators(env), 'creators.csv');
      if (path === '/api/export/creator-features.json') return json(await C.featuresForSite(env));
      {
        const cm = path.match(/^\/api\/creators\/(\d+)\/(research|draft|features)$/);
        if (cm && method === 'POST') {
          const id = Number(cm[1]);
          if (cm[2] === 'research') return json(await C.researchCreator(env, id));
          if (cm[2] === 'draft') return json(await C.draftCreatorNote(env, id, await body()));
          return json(await C.addFeature(env, id, await body()));
        }
        const fm = path.match(/^\/api\/creator-features\/(\d+)\/revoke$/);
        if (fm && method === 'POST') return json(await C.revokeFeature(env, Number(fm[1]), await body()));
      }

      // ---- backlinks ----
      if (path === '/api/links/summary') return json(await L.linkSummary(env));
      if (path === '/api/links/prospects' && method === 'GET') return json(await L.listProspects(env, url));
      if (path === '/api/links/prospects' && method === 'POST') return json(await L.addProspect(env, await body()));
      if (path === '/api/links/find' && method === 'POST') return json(await L.findProspects(env, await body()));
      if (path === '/api/links/import' && method === 'POST') return json(await L.importProspects(env, await body()));
      if (path === '/api/links/won' && method === 'GET') return json(await L.listLinks(env));
      if (path === '/api/links/won' && method === 'POST') return json(await L.addLink(env, await body()));
      if (path === '/api/export/link-prospects.csv') return csvResponse(await L.exportProspects(env), 'link-prospects.csv');
      if (path === '/api/export/links.csv') return csvResponse(await L.exportLinks(env), 'links.csv');

      let m;
      if ((m = path.match(/^\/api\/links\/prospects\/(\d+)(?:\/([a-z]+))?$/))) {
        const id = Number(m[1]), sub = m[2];
        if (!sub && method === 'GET') return json(await L.getProspect(env, id));
        if (!sub && method === 'POST') return json(await L.updateProspect(env, id, await body()));
        if (sub === 'research' && method === 'POST') return json(await L.researchProspect(env, id));
        if (sub === 'draft' && method === 'POST') return json(await L.draftPitch(env, id, await body()));
        if (sub === 'reply' && method === 'POST') return json(await L.logProspectReply(env, id, await body()));
      }
      if ((m = path.match(/^\/api\/links\/won\/(\d+)\/(check|delete)$/)) && method === 'POST')
        return json(m[2] === 'check' ? await L.checkLinkById(env, Number(m[1])) : await L.deleteLink(env, Number(m[1])));
      if ((m = path.match(/^\/api\/brands\/(\d+)\/to-link$/)) && method === 'POST') return json(await L.prospectFromBrand(env, Number(m[1])));

      if ((m = path.match(/^\/api\/brands\/(\d+)(?:\/([a-z-]+))?$/))) {
        const id = Number(m[1]), sub = m[2];
        if (!sub && method === 'GET') return json(await getBrand(env, id));
        if (!sub && method === 'POST') return json(await updateBrand(env, id, await body()));
        if (sub === 'research' && method === 'POST') return json(await researchBrand(env, id));
        if (sub === 'draft' && method === 'POST') return json(await draftEmail(env, id, await body()));
        if (sub === 'contacts' && method === 'POST') return json(await addContact(env, id, await body()));
        if (sub === 'activity' && method === 'POST') return json(await addActivity(env, id, await body()));
        if (sub === 'permissions' && method === 'POST') return json(await addPermission(env, id, await body()));
        if (sub === 'reply' && method === 'POST') return json(await logReply(env, id, await body()));
      }
      if ((m = path.match(/^\/api\/contacts\/(\d+)\/(delete|primary)$/)) && method === 'POST')
        return json(await contactAction(env, Number(m[1]), m[2]));
      if ((m = path.match(/^\/api\/permissions\/(\d+)\/revoke$/)) && method === 'POST')
        return json(await revokePermission(env, Number(m[1]), await body()));
      if ((m = path.match(/^\/api\/messages\/(\d+)(?:\/([a-z]+))?$/)) && method === 'POST') {
        const id = Number(m[1]), sub = m[2];
        if (!sub) return json(await updateMessage(env, id, await body()));
        if (sub === 'send') return json(await sendMessage(env, id));
        if (sub === 'manual') return json(await markManual(env, id, await body()));
        if (sub === 'skip') return json(await skipMessage(env, id));
        if (sub === 'rewrite') {
          const msg = await first(env, `SELECT * FROM messages WHERE id=?`, id);
          if (msg?.prospect_id && msg.status === 'draft') {
            const lp = await first(env, `SELECT kind FROM link_prospects WHERE id=?`, msg.prospect_id);
            return json(lp?.kind === 'creator' ? await C.rewriteCreatorNote(env, msg, await body()) : await L.rewritePitch(env, msg, await body()));
          }
          return json(await rewriteMessage(env, id, await body()));
        }
      }
      if ((m = path.match(/^\/api\/replies\/(\d+)(?:\/(answer))?$/)) && method === 'POST') {
        if (m[2] === 'answer') {
          const rep = await first(env, `SELECT * FROM replies WHERE id=?`, Number(m[1]));
          if (rep?.prospect_id && !rep.brand_id) return json(await L.answerPitchReply(env, rep, await body()));
          return json(await draftAnswer(env, Number(m[1]), await body()));
        }
        return json(await updateReply(env, Number(m[1]), await body()));
      }

      if (path === '/api/export/permissions.csv') return csvResponse(await exportPermissions(env), 'image-permissions.csv');
      if (path === '/api/export/brands.csv') return csvResponse(await exportBrands(env), 'brands.csv');
      if (path === '/api/export/affiliates.csv') return csvResponse(await affiliates(env, true), 'affiliate-programs.csv');
      if (path === '/api/export/contacts.csv') return csvResponse(await all(env,
        `SELECT b.name brand, c.name, c.email, c.role, c.note FROM contacts c JOIN brands b ON b.id=c.brand_id ORDER BY b.name`), 'brand-contacts.csv');

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil((async () => {
      await checkReplies(env).catch((e) => console.error('reply check failed', e));
      await queueFollowups(env).catch((e) => console.error('follow-ups failed', e));
      await L.queuePitchFollowups(env).catch((e) => console.error('pitch follow-ups failed', e));
      await L.checkDueLinks(env).catch((e) => console.error('link check failed', e));
    })());
  },

  async email(message, env, ctx) {
    await ensureSchema(env);
    await handleEmail(message, env, ctx);
  },
};

// ---------- summary + today ----------
async function summary(env) {
  const s = await cfg(env);
  const [brands, products, drafts, unread, g, key, m] = await Promise.all([
    first(env, `SELECT COUNT(*) n FROM brands`),
    first(env, `SELECT COUNT(*) n FROM products`),
    first(env, `SELECT COUNT(*) n FROM messages WHERE status='draft'`),
    first(env, `SELECT COUNT(*) n FROM replies WHERE handled=0 AND kind IN ('reply','optout')`),
    gmailCreds(env), claudeKey(env), getMeta(env, ['last_reply_check', 'last_import']),
  ]);
  return {
    settings: s, signature: signature(s), brands: brands.n, products: products.n, drafts: drafts.n, unread: unread.n,
    sentToday: await sentToday(env), sendBlocker: await sendBlocker(env),
    gmail: { connected: Boolean(g.refresh), clientSaved: Boolean(g.id && g.secret), fromEnv: Boolean(env.GMAIL_CLIENT_ID), account: g.account },
    claude: { set: Boolean(key), fromEnv: Boolean(env.ANTHROPIC_API_KEY), hint: key ? key.slice(0, 10) + '…' + key.slice(-4) : null },
    asks: ASKS, lastReplyCheck: m.last_reply_check || null, lastImport: m.last_import || null, seedCount: SEED.rows.length,
  };
}

async function today(env) {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: env.TIMEZONE || 'America/New_York' });
  const [replies, followups, nextUp, drafts, unmatched, linkFollowups] = await Promise.all([
    all(env, `SELECT r.id, r.brand_id, r.prospect_id, r.from_email, r.subject, r.snippet, r.kind, r.received_at, COALESCE(b.name, lp.name, lp.domain) brand, lp.kind lp_kind
        FROM replies r LEFT JOIN brands b ON b.id=r.brand_id LEFT JOIN link_prospects lp ON lp.id=r.prospect_id
        WHERE r.handled=0 AND r.kind IN ('reply','optout') AND (r.brand_id IS NOT NULL OR r.prospect_id IS NOT NULL)
        ORDER BY r.received_at DESC LIMIT 20`),
    all(env, `SELECT id, name, status, follow_up_on, follow_up_note, contact_email, contact_url FROM brands
        WHERE follow_up_on IS NOT NULL AND follow_up_on <= ? AND status NOT IN ('do_not_contact','declined','partner') ORDER BY follow_up_on LIMIT 25`, d),
    all(env, `SELECT id, name, score, reply_odds, product_count, max_price, domain, sections, status, contact_email, contact_url, kind, researched_at FROM brands b
        WHERE status IN ('research','ready') AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.brand_id=b.id AND m.status!='skipped')
        ORDER BY reply_odds DESC, score DESC LIMIT 10`),
    first(env, `SELECT COUNT(*) n FROM messages WHERE status='draft'`),
    first(env, `SELECT COUNT(*) n FROM replies WHERE brand_id IS NULL AND prospect_id IS NULL AND kind IN ('reply','optout')`),
    all(env, `SELECT id, COALESCE(name, domain) name, status, follow_up_on, contact_email FROM link_prospects
        WHERE follow_up_on IS NOT NULL AND follow_up_on <= ? AND status NOT IN ('do_not_contact','won','lost','skipped') ORDER BY follow_up_on LIMIT 25`, d),
  ]);
  return { date: d, replies, followups, linkFollowups, nextUp, drafts: drafts.n, unmatched: unmatched.n };
}

// ---------- product list import ----------
const COLMAP = {
  section: /^section$/i, type: /^(type|category)$/i, brand: /^brand$/i, name: /^(product|product name|name)$/i, model: /^model$/i,
  price: /price/i, status: /^status$/i, recall: /recall/i, maker_url: /maker|manufacturer|brand (page|url)/i, site_url: /site (page|url)|our page/i,
};
const RETAILER_HOSTS = ['walmart.com', 'target.com', 'ikea.com', 'crateandbarrel.com', 'crateandkids.com', 'potterybarnkids.com', 'pbteen.com',
  'westelm.com', 'costco.com', 'samsclub.com', 'kohls.com', 'wayfair.com', 'babylist.com', 'buybuybaby.com', 'rh.com', 'macys.com', 'nordstrom.com'];
const MARKETPLACE = /(^|\.)(amazon|walmart|target|ebay|etsy|wayfair|kohls|macys|nordstrom|costco|samsclub|babylist|buybuybaby|bestbuy)\./;

async function importRows(env, body) {
  const cols = Array.isArray(body.columns) ? body.columns : [];
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 600) : [];
  const idx = {};
  for (const [k, re] of Object.entries(COLMAP)) idx[k] = cols.findIndex((c) => re.test(String(c).trim()));
  if (idx.brand < 0 || idx.name < 0) throw fail('The file needs at least "Brand" and "Product" columns.');
  const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
  const clean = rows.map((r) => ({
    brand: get(r, 'brand').slice(0, 120), name: get(r, 'name').slice(0, 300), section: get(r, 'section') || null, type: get(r, 'type') || null,
    model: get(r, 'model') || null, price: Number(get(r, 'price').replace(/[$,]/g, '')) || null, status: get(r, 'status') || null,
    recall: /^(y|yes|true|1)/i.test(get(r, 'recall')) ? 1 : 0, maker_url: /^https?:\/\//.test(get(r, 'maker_url')) ? get(r, 'maker_url') : null,
    site_url: /^https?:\/\//.test(get(r, 'site_url')) ? get(r, 'site_url') : null,
  })).filter((r) => r.brand && r.name);
  const names = [...new Set(clean.map((r) => r.brand))];
  const before = (await first(env, `SELECT COUNT(*) n FROM brands`)).n;
  await env.DB.batch(names.map((n) => env.DB.prepare(`INSERT OR IGNORE INTO brands (name) VALUES (?)`).bind(n)));
  const ids = {};
  for (let i = 0; i < names.length; i += 90) {
    const part = names.slice(i, i + 90);
    for (const b of await all(env, `SELECT id, name FROM brands WHERE name IN (${part.map(() => '?').join(',')})`, ...part)) ids[b.name] = b.id;
  }
  const stmts = clean.map((r) => env.DB.prepare(
    `INSERT INTO products (brand_id, section, type, name, model, price, status, recall, maker_url, site_url, ukey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ukey) DO UPDATE SET brand_id=excluded.brand_id, section=excluded.section, type=excluded.type, name=excluded.name,
       model=excluded.model, price=COALESCE(excluded.price, products.price), status=excluded.status, recall=excluded.recall,
       maker_url=COALESCE(excluded.maker_url, products.maker_url), site_url=COALESCE(excluded.site_url, products.site_url), updated_at=datetime('now')`,
  ).bind(ids[r.brand], r.section, r.type, r.name, r.model, r.price, r.status, r.recall, r.maker_url, r.site_url,
    r.site_url || `${r.brand.toLowerCase()}|${r.name.toLowerCase()}`));
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  const after = (await first(env, `SELECT COUNT(*) n FROM brands`)).n;
  return { ok: true, products: clean.length, newBrands: after - before };
}

async function finishImport(env) {
  await env.DB.prepare(`UPDATE brands SET
      product_count=(SELECT COUNT(*) FROM products p WHERE p.brand_id=brands.id),
      avg_price=(SELECT AVG(price) FROM products p WHERE p.brand_id=brands.id AND price > 0),
      max_price=(SELECT MAX(price) FROM products p WHERE p.brand_id=brands.id),
      has_recall=COALESCE((SELECT MAX(recall) FROM products p WHERE p.brand_id=brands.id), 0),
      sections=(SELECT json_group_array(DISTINCT section) FROM products p WHERE p.brand_id=brands.id AND section IS NOT NULL)`).run();
  // Work out each brand's own website from its product pages (skipping store/marketplace links when the brand has its own site).
  const rows = await all(env, `SELECT b.id, b.name, b.website, b.kind, p.maker_url FROM brands b JOIN products p ON p.brand_id=b.id WHERE p.maker_url IS NOT NULL`);
  const hosts = new Map();
  for (const r of rows) {
    const h = domainOf(r.maker_url); if (!h) continue;
    if (!hosts.has(r.id)) hosts.set(r.id, { brand: r, counts: {} });
    const c = hosts.get(r.id).counts; c[h] = (c[h] || 0) + 1;
  }
  const stmts = [];
  for (const [id, { brand, counts }] of hosts) {
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([h]) => h);
    const own = ranked.find((h) => !MARKETPLACE.test('.' + h)) || null;
    const top = own || ranked[0];
    const root = top.split('.').slice(-2).join('.');
    // A retailer's own label (up&up → Target, Parent's Choice → Walmart, IKEA, Crate & Kids...): ask the retailer, not a brand team.
    if (!brand.website && own && !RETAILER_HOSTS.includes(root))
      stmts.push(env.DB.prepare(`UPDATE brands SET website=?, domain=? WHERE id=?`).bind(`https://${own}`, own.replace(/^www\./, ''), id));
    if (RETAILER_HOSTS.includes(root)) {
      stmts.push(env.DB.prepare(`UPDATE brands SET kind='store_brand' WHERE id=? AND kind='brand'`).bind(id));
      if (!brand.website) stmts.push(env.DB.prepare(`UPDATE brands SET website=?, domain=? WHERE id=?`).bind(`https://www.${root}`, root, id));
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  await scoreBrands(env);
  await refreshOdds(env);
  await setMeta(env, 'last_import', new Date().toISOString());
  const t = await first(env, `SELECT COUNT(*) b, SUM(product_count) p FROM brands`);
  return { ok: true, brands: t.b, products: t.p };
}

// Priority 0-100: more products on the site + pricier gear + big-ticket categories = more worth asking first.
const BIG_TICKET = ['Strollers', 'Car seats', 'Cribs', 'Crib mattresses', 'High chairs', 'Nursery furniture', 'Baby monitors',
  'Breast pumps & breastfeeding', 'Bassinets', 'Play yards', 'Carriers'];
async function scoreBrands(env) {
  const rows = await all(env, `SELECT id, product_count, max_price, sections FROM brands`);
  const stmts = rows.map((b) => {
    const count = Math.min(35, Math.round(9 * Math.log2((b.product_count || 0) + 1)));
    const p = b.max_price || 0;
    const price = p >= 1000 ? 30 : p >= 500 ? 25 : p >= 250 ? 19 : p >= 100 ? 13 : p > 0 ? 7 : 4;
    const secs = parseJ(b.sections, []);
    const big = secs.some((s) => BIG_TICKET.includes(s)) ? 15 : 5;
    const breadth = Math.min(5, secs.length);
    const raw = count + price + big + breadth; // max 85
    return env.DB.prepare(`UPDATE brands SET score=? WHERE id=?`).bind(Math.round((raw / 85) * 100), b.id);
  });
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
}

// ---------- brands ----------
async function filters(env) {
  const secs = await all(env, `SELECT section v, COUNT(DISTINCT brand_id) n FROM products WHERE section IS NOT NULL GROUP BY section ORDER BY section`);
  return { sections: secs, statuses: BRAND_STATUSES, asks: ASK_STATES };
}

async function listBrands(env, url) {
  const p = url.searchParams, where = [], params = [];
  if (p.get('status')) { where.push('status=?'); params.push(p.get('status')); }
  else if (p.get('hide_done') === '1') where.push(`status NOT IN ('do_not_contact','skipped','declined')`);
  if (p.get('section')) { where.push(`EXISTS (SELECT 1 FROM products x WHERE x.brand_id=b.id AND x.section=?)`); params.push(p.get('section')); }
  if (p.get('kind')) { where.push('kind=?'); params.push(p.get('kind')); }
  if (p.get('contact') === 'email') where.push(`contact_email IS NOT NULL AND contact_email!=''`);
  if (p.get('contact') === 'any') where.push(`(COALESCE(contact_email,'')!='' OR COALESCE(contact_url,'')!='')`);
  if (p.get('contact') === 'none') where.push(`COALESCE(contact_email,'')='' AND COALESCE(contact_url,'')=''`);
  if (p.get('researched') === '0') where.push('researched_at IS NULL');
  if (p.get('researched') === '1') where.push('researched_at IS NOT NULL');
  for (const col of Object.keys(ASK_STATES)) if (p.get(col)) { where.push(`${col}=?`); params.push(p.get(col)); }
  if (p.get('q')) {
    const q = `%${p.get('q')}%`;
    where.push(`(name LIKE ? OR domain LIKE ? OR contact_email LIKE ? OR notes LIKE ? OR EXISTS (SELECT 1 FROM products x WHERE x.brand_id=b.id AND x.name LIKE ?))`);
    params.push(q, q, q, q, q);
  }
  const sort = { odds: 'reply_odds IS NULL, reply_odds DESC, score DESC', score: 'score DESC, product_count DESC', name: 'name COLLATE NOCASE', products: 'product_count DESC', price: 'max_price IS NULL, max_price DESC',
    updated: 'updated_at DESC', follow_up: 'follow_up_on IS NULL, follow_up_on' }[p.get('sort')] || 'reply_odds IS NULL, reply_odds DESC, score DESC';
  // Name matches first when searching.
  const order = p.get('q') ? `(name LIKE ?) DESC, ${sort}` : sort;
  if (p.get('q')) params.push(`%${p.get('q')}%`);
  return all(env, `SELECT id, name, domain, website, kind, sections, product_count, max_price, has_recall, score, status, contact_name, contact_email,
      contact_url, reply_odds, email_check, image_status, affiliate_status, affiliate_network, sample_status, collab_status, feed_status, researched_at, follow_up_on, last_contacted_at
      FROM brands b ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 1000`, ...params);
}

async function getBrand(env, id) {
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!brand) throw fail('Brand not found', 404);
  const [products, contacts, messages, replies, permissions, activity] = await Promise.all([
    all(env, `SELECT * FROM products WHERE brand_id=? ORDER BY section, price IS NULL, price DESC`, id),
    all(env, `SELECT * FROM contacts WHERE brand_id=? ORDER BY id`, id),
    all(env, `SELECT * FROM messages WHERE brand_id=? AND status!='skipped' ORDER BY id`, id),
    all(env, `SELECT * FROM replies WHERE brand_id=? ORDER BY received_at`, id),
    all(env, `SELECT * FROM permissions WHERE brand_id=? ORDER BY granted_on DESC`, id),
    all(env, `SELECT * FROM activity WHERE brand_id=? ORDER BY id DESC LIMIT 50`, id),
  ]);
  return { brand, products, contacts, messages, replies, permissions, activity };
}

const TEXT_FIELDS = ['name', 'website', 'contact_name', 'contact_email', 'contact_role', 'contact_url', 'instagram', 'affiliate_network',
  'affiliate_url', 'commission', 'cookie_days', 'affiliate_notes', 'notes', 'follow_up_note', 'kind'];
async function updateBrand(env, id, body) {
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!brand) throw fail('Brand not found', 404);
  const sets = [], params = [], changed = [];
  if (body.status !== undefined) {
    if (!BRAND_STATUSES.includes(body.status)) throw fail('Unknown status');
    sets.push('status=?'); params.push(body.status); changed.push(`status → ${body.status.replace(/_/g, ' ')}`);
  }
  for (const [col, states] of Object.entries(ASK_STATES)) if (body[col] !== undefined) {
    if (!states.includes(body[col])) throw fail('Unknown value');
    sets.push(`${col}=?`); params.push(body[col]); changed.push(`${col.replace('_status', '')} → ${body[col].replace(/_/g, ' ')}`);
  }
  for (const k of TEXT_FIELDS) if (body[k] !== undefined) {
    let v = String(body[k] ?? '').trim().slice(0, 4000) || null;
    if (k === 'contact_email' && v) { v = v.toLowerCase(); if (!EMAIL_RE.test(v)) throw fail('That email address doesn\'t look right.'); }
    if (k === 'kind' && !['brand', 'store_brand'].includes(v)) throw fail('Unknown kind');
    if ((k === 'website' || k === 'contact_url' || k === 'affiliate_url') && v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    sets.push(`${k}=?`); params.push(v);
    if (k === 'website') { sets.push('domain=?'); params.push(v ? domainOf(v) : null); }
  }
  if (body.follow_up_on !== undefined) {
    const d = String(body.follow_up_on || '');
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw fail('Bad date');
    sets.push('follow_up_on=?'); params.push(d || null);
  }
  if (!sets.length) return { ok: true };
  sets.push(`updated_at=datetime('now')`);
  await env.DB.prepare(`UPDATE brands SET ${sets.join(', ')} WHERE id=?`).bind(...params, id).run();
  if (body.contact_email !== undefined) {
    const v = body.contact_email ? await verifyManual({ email: body.contact_email, siteDomain: brand.domain || brand.website, name: brand.name }) : null;
    await env.DB.prepare(`UPDATE brands SET email_check=? WHERE id=?`).bind(v ? JSON.stringify(v) : null, id).run();
  }
  if (body.contact_email) {
    await env.DB.prepare(`UPDATE messages SET to_email=? WHERE brand_id=? AND status='draft' AND (to_email IS NULL OR to_email='')`).bind(body.contact_email.toLowerCase(), id).run();
    if (brand.status === 'research') await env.DB.prepare(`UPDATE brands SET status='ready' WHERE id=?`).bind(id).run();
  }
  if (body.status === 'do_not_contact') {
    if (brand.contact_email) await env.DB.prepare(`INSERT OR IGNORE INTO suppression (email, domain, reason) VALUES (?, NULL, 'manual')`).bind(brand.contact_email.toLowerCase()).run();
    await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE brand_id=? AND status='draft'`).bind(id).run();
  }
  await refreshOdds(env, id);
  if (changed.length) await logActivity(env, id, 'update', changed.join(', '));
  return { ok: true };
}

async function addBrand(env, body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw fail('Add the brand name.');
  const ex = await first(env, `SELECT id FROM brands WHERE lower(name)=lower(?)`, name);
  if (ex) return { ok: true, id: ex.id, duplicate: true };
  const website = String(body.website || '').trim();
  const w = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null;
  const r = await env.DB.prepare(`INSERT INTO brands (name, website, domain, notes) VALUES (?, ?, ?, ?)`).bind(name, w, w ? domainOf(w) : null, body.notes || null).run();
  return { ok: true, id: r.meta.last_row_id };
}

async function researchCandidates(env, url) {
  const n = Math.min(25, Number(url.searchParams.get('n')) || 10);
  return all(env, `SELECT id, name FROM brands WHERE researched_at IS NULL AND status NOT IN ('do_not_contact','skipped','declined','partner')
    ORDER BY reply_odds DESC, score DESC LIMIT ?`, n);
}

// ---------- email checks ----------
// Re-check saved emails: one record ({kind, id}) or the next batch that has never been checked.
async function recheckEmails(env, body) {
  let rows = [];
  if (body.kind && body.id) {
    rows = body.kind === 'brand'
      ? await all(env, `SELECT 'brand' k, id, contact_email email, domain site, name, research, NULL pkind FROM brands WHERE id=?`, Number(body.id))
      : await all(env, `SELECT 'prospect' k, id, contact_email email, domain site, name, research, kind pkind FROM link_prospects WHERE id=?`, Number(body.id));
  } else {
    rows = [
      ...await all(env, `SELECT 'brand' k, id, contact_email email, domain site, name, research, NULL pkind FROM brands
        WHERE COALESCE(contact_email,'')!='' AND email_check IS NULL LIMIT 8`),
      ...await all(env, `SELECT 'prospect' k, id, contact_email email, domain site, name, research, kind pkind FROM link_prospects
        WHERE COALESCE(contact_email,'')!='' AND email_check IS NULL LIMIT 8`),
    ].slice(0, 10);
  }
  const out = { checked: 0, verified: 0, likely: 0, unverified: 0, bad: 0 };
  await Promise.all(rows.map(async (r) => {
    if (!r.email) return;
    const research = parseJ(r.research, {});
    const fromResearch = research.email && String(research.email).toLowerCase() === r.email.toLowerCase();
    const creator = r.pkind === 'creator';
    const v = fromResearch && research.email_source
      ? await verifyEmail({ email: r.email, sourceUrl: research.email_source, siteDomain: creator ? null : r.site, name: r.name, creator, seenOn: research.email_seen_on })
      : await verifyManual({ email: r.email, siteDomain: creator ? null : r.site, name: r.name, creator });
    await env.DB.prepare(`UPDATE ${r.k === 'brand' ? 'brands' : 'link_prospects'} SET email_check=? WHERE id=?`).bind(JSON.stringify(v), r.id).run();
    out.checked++; out[v.status]++;
  }));
  out.left = await verifyLeft(env);
  return out;
}
async function verifyLeft(env) {
  const a = await first(env, `SELECT COUNT(*) n FROM brands WHERE COALESCE(contact_email,'')!='' AND email_check IS NULL`);
  const b = await first(env, `SELECT COUNT(*) n FROM link_prospects WHERE COALESCE(contact_email,'')!='' AND email_check IS NULL`);
  return (a?.n || 0) + (b?.n || 0);
}
async function verifyStatus(env) {
  const rows = await all(env, `SELECT json_extract(email_check,'$.status') s, COUNT(*) n FROM brands WHERE COALESCE(contact_email,'')!='' GROUP BY 1
    UNION ALL SELECT json_extract(email_check,'$.status') s, COUNT(*) n FROM link_prospects WHERE COALESCE(contact_email,'')!='' GROUP BY 1`);
  const t = {}; for (const r of rows) t[r.s || 'unchecked'] = (t[r.s || 'unchecked'] || 0) + r.n;
  return t;
}

// ---------- contacts, activity, permissions, replies ----------
async function addContact(env, id, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw fail('That email address doesn\'t look right.');
  if (!email && !body.name) throw fail('Add a name or email.');
  await env.DB.prepare(`INSERT INTO contacts (brand_id, name, email, role, note) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, body.name || null, email || null, body.role || null, body.note || null).run();
  const b = await first(env, `SELECT contact_email, status FROM brands WHERE id=?`, id);
  if (email && !b.contact_email) await updateBrand(env, id, { contact_email: email, contact_name: body.name || '', contact_role: body.role || '' });
  return { ok: true };
}
async function contactAction(env, cid, action) {
  const c = await first(env, `SELECT * FROM contacts WHERE id=?`, cid);
  if (!c) throw fail('Contact not found', 404);
  if (action === 'delete') { await env.DB.prepare(`DELETE FROM contacts WHERE id=?`).bind(cid).run(); return { ok: true }; }
  await updateBrand(env, c.brand_id, { contact_email: c.email || '', contact_name: c.name || '', contact_role: c.role || '' });
  await env.DB.prepare(`UPDATE messages SET to_email=? WHERE brand_id=? AND status='draft'`).bind(c.email, c.brand_id).run();
  return { ok: true };
}

const ACTIVITY = { contact_form: 'Sent through their contact form', network_applied: 'Applied on the affiliate network', dm: 'Sent a DM',
  call: 'Called', sample_received: 'Sample arrived', note: 'Note', linkedin: 'Messaged on LinkedIn' };
async function addActivity(env, id, body) {
  const kind = ACTIVITY[body.kind] ? body.kind : 'note';
  const note = String(body.note || '').trim().slice(0, 1000);
  await logActivity(env, id, kind, note || ACTIVITY[kind]);
  const s = [];
  if (kind === 'contact_form' || kind === 'dm' || kind === 'linkedin')
    s.push(`status = CASE WHEN status IN ('research','ready') THEN 'contacted' ELSE status END`, `last_contacted_at=datetime('now')`,
      `follow_up_on = COALESCE(follow_up_on, date('now','+7 days'))`);
  if (kind === 'network_applied') s.push(`affiliate_status = CASE WHEN affiliate_status IN ('none','found') THEN 'applied' ELSE affiliate_status END`);
  if (kind === 'sample_received') s.push(`sample_status='received'`);
  if (s.length) await env.DB.prepare(`UPDATE brands SET ${s.join(', ')}, updated_at=datetime('now') WHERE id=?`).bind(id).run();
  return { ok: true };
}

async function addPermission(env, id, body) {
  const by = String(body.granted_by || '').trim(), on = String(body.granted_on || '').trim(), scope = String(body.scope || '').trim();
  if (!by || !scope) throw fail('Add who said yes and what they allowed, in their words.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw fail('Add the date of their email.');
  const exp = String(body.expires_on || '').trim();
  if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) throw fail('Bad expiry date');
  const uses = (Array.isArray(body.uses) ? body.uses : []).filter((u) => ['website', 'social', 'app', 'ads', 'email', 'print'].includes(u));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO permissions (brand_id, granted_by, granted_on, scope, uses, credit_line, link_back, expires_on, conditions, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, by.slice(0, 300), on, scope.slice(0, 4000), JSON.stringify(uses),
      String(body.credit_line || '').slice(0, 300) || null, body.link_back ? 1 : 0, exp || null, String(body.conditions || '').slice(0, 2000) || null,
      String(body.evidence || '').slice(0, 1000) || null),
    env.DB.prepare(`UPDATE brands SET image_status='approved', status = CASE WHEN status IN ('research','ready','contacted','replied') THEN 'partner' ELSE status END,
      follow_up_on=NULL, updated_at=datetime('now') WHERE id=?`).bind(id),
  ]);
  await logActivity(env, id, 'permission', `Image permission logged from ${by}`);
  return { ok: true };
}
async function revokePermission(env, pid, body) {
  const p = await first(env, `SELECT * FROM permissions WHERE id=?`, pid);
  if (!p) throw fail('Not found', 404);
  await env.DB.prepare(`UPDATE permissions SET revoked_on=COALESCE(revoked_on, date('now')), conditions=COALESCE(conditions || char(10), '') || ? WHERE id=?`)
    .bind(`Revoked: ${String(body.note || 'brand asked').slice(0, 500)}`, pid).run();
  const left = await first(env, `SELECT COUNT(*) n FROM permissions WHERE brand_id=? AND revoked_on IS NULL`, p.brand_id);
  if (!left.n) await env.DB.prepare(`UPDATE brands SET image_status='declined' WHERE id=?`).bind(p.brand_id).run();
  await logActivity(env, p.brand_id, 'permission', 'Image permission revoked. Take their images down.');
  return { ok: true };
}
async function listPermissions(env) {
  return all(env, `SELECT p.*, b.name brand FROM permissions p JOIN brands b ON b.id=p.brand_id ORDER BY p.revoked_on IS NOT NULL, p.granted_on DESC`);
}
async function exportPermissions(env) {
  return all(env, `SELECT b.name brand, b.domain, p.granted_by, p.granted_on, p.scope, p.uses, p.credit_line,
    CASE p.link_back WHEN 1 THEN 'yes' ELSE 'no' END link_back, p.expires_on, p.conditions, p.evidence, p.revoked_on, p.created_at logged_at
    FROM permissions p JOIN brands b ON b.id=p.brand_id ORDER BY b.name, p.granted_on`);
}

async function logReply(env, id, body) {
  const text = String(body.text || '').trim();
  if (!text) throw fail('Paste what they said.');
  const from = String(body.from_email || '').trim().toLowerCase() || null;
  const kind = ['reply', 'optout', 'bounce', 'auto'].includes(body.kind) ? body.kind : classify({ from, subject: '', snippet: text });
  await recordReply(env, { source: 'manual', extId: `manual-${crypto.randomUUID()}`, brandId: id, fromEmail: from, subject: String(body.subject || '').slice(0, 300),
    snippet: text.replace(/\s+/g, ' ').slice(0, 300), body: text, kind });
  return { ok: true };
}

async function listReplies(env, url) {
  const state = url.searchParams.get('state') || 'open';
  const where = state === 'unmatched' ? `r.brand_id IS NULL AND r.prospect_id IS NULL`
    : state === 'open' ? `r.handled=0 AND (r.brand_id IS NOT NULL OR r.prospect_id IS NOT NULL) AND r.kind IN ('reply','optout')` : '1=1';
  return all(env, `SELECT r.*, COALESCE(b.name, lp.name, lp.domain) brand, lp.kind lp_kind FROM replies r LEFT JOIN brands b ON b.id=r.brand_id
    LEFT JOIN link_prospects lp ON lp.id=r.prospect_id WHERE ${where} ORDER BY r.received_at DESC LIMIT 300`);
}
async function updateReply(env, rid, body) {
  const r = await first(env, `SELECT * FROM replies WHERE id=?`, rid);
  if (!r) throw fail('Reply not found', 404);
  if (body.brand_id) {
    const b = await first(env, `SELECT id FROM brands WHERE id=?`, Number(body.brand_id));
    if (!b) throw fail('Brand not found');
    await env.DB.prepare(`UPDATE replies SET brand_id=? WHERE id=?`).bind(b.id, rid).run();
    await applyReplyEffects(env, b.id, body.kind || r.kind, r.from_email);
    if (r.from_email && body.add_contact) await addContact(env, b.id, { email: r.from_email, note: 'From their reply' }).catch(() => {});
  }
  if (body.prospect_id) {
    const lp = await first(env, `SELECT id FROM link_prospects WHERE id=?`, Number(body.prospect_id));
    if (!lp) throw fail('Prospect not found');
    await env.DB.prepare(`UPDATE replies SET prospect_id=? WHERE id=?`).bind(lp.id, rid).run();
    await L.applyProspectReply(env, lp.id, body.kind || r.kind, r.from_email);
  }
  if (body.kind && ['reply', 'optout', 'bounce', 'auto'].includes(body.kind)) await env.DB.prepare(`UPDATE replies SET kind=? WHERE id=?`).bind(body.kind, rid).run();
  if (body.handled !== undefined) await env.DB.prepare(`UPDATE replies SET handled=? WHERE id=?`).bind(body.handled ? 1 : 0, rid).run();
  return { ok: true };
}

// ---------- drafts ----------
async function queue(env) {
  return all(env, `SELECT m.*, COALESCE(b.name, lp.name, lp.domain) brand, COALESCE(b.contact_name, lp.contact_name) contact_name,
      COALESCE(b.contact_url, lp.contact_url) contact_url, COALESCE(b.domain, lp.domain) domain, COALESCE(b.contact_email, lp.contact_email) owner_email, COALESCE(b.email_check, lp.email_check) email_check, b.product_count, b.sections, b.kind brand_kind, lp.tactic, lp.kind lp_kind, lp.platform, lp.handle, lp.url lp_url
    FROM messages m LEFT JOIN brands b ON b.id=m.brand_id AND m.brand_id > 0 LEFT JOIN link_prospects lp ON lp.id=m.prospect_id
    WHERE m.status='draft' AND (b.id IS NOT NULL OR lp.id IS NOT NULL)
    ORDER BY m.kind='reply' DESC, m.kind='followup' DESC, m.prospect_id IS NOT NULL, COALESCE(b.reply_odds, lp.odds, 0) DESC, m.id`);
}
async function updateMessage(env, id, body) {
  const msg = await first(env, `SELECT * FROM messages WHERE id=?`, id);
  if (!msg) throw fail('Message not found', 404);
  if (msg.status !== 'draft') throw fail('Only drafts can be edited');
  const to = String(body.to_email ?? msg.to_email ?? '').trim().toLowerCase();
  if (to && !EMAIL_RE.test(to)) throw fail('That email address doesn\'t look right.');
  await env.DB.prepare(`UPDATE messages SET subject=?, body=?, to_email=? WHERE id=?`)
    .bind(String(body.subject ?? msg.subject).slice(0, 200), String(body.body ?? msg.body).slice(0, 5000), to || null, id).run();
  return { ok: true };
}
async function skipMessage(env, id) {
  await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE id=? AND status='draft'`).bind(id).run();
  return { ok: true };
}
async function markManual(env, id, body) {
  const msg = await first(env, `SELECT * FROM messages WHERE id=?`, id);
  if (!msg) throw fail('Message not found', 404);
  if (msg.status !== 'draft') throw fail(`Already ${msg.status}`);
  const how = String(body.how || 'another inbox').slice(0, 200);
  await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET status='sent_manual', channel=?, sent_at=datetime('now') WHERE id=?`).bind(how, id),
    ...markAsked(env, msg),
  ]);
  if (msg.brand_id) await logActivity(env, msg.brand_id, 'email_manual', `Sent by hand (${how}): ${msg.subject}`);
  return { ok: true };
}

// ---------- affiliate programs ----------
async function affiliates(env, forExport = false) {
  return all(env, `SELECT ${forExport ? '' : 'id, '}name brand, domain, affiliate_status status, affiliate_network network, affiliate_url apply_url, commission, cookie_days,
      affiliate_notes notes, product_count, score FROM brands
    WHERE affiliate_status!='none' OR COALESCE(affiliate_network,'')!='' OR COALESCE(affiliate_url,'')!=''
    ORDER BY CASE affiliate_status WHEN 'approved' THEN 0 WHEN 'applied' THEN 1 WHEN 'found' THEN 2 ELSE 3 END, score DESC`);
}

// ---------- results ----------
async function stats(env) {
  const one = async (sql, ...p) => (await first(env, sql, ...p))?.n || 0;
  const [brands, contacted, replied, partners, declined, sent, sentManual] = await Promise.all([
    one(`SELECT COUNT(*) n FROM brands`),
    one(`SELECT COUNT(*) n FROM brands WHERE last_contacted_at IS NOT NULL`),
    one(`SELECT COUNT(DISTINCT brand_id) n FROM replies WHERE kind='reply' AND brand_id IS NOT NULL`),
    one(`SELECT COUNT(*) n FROM brands WHERE status='partner'`),
    one(`SELECT COUNT(*) n FROM brands WHERE status='declined'`),
    one(`SELECT COUNT(*) n FROM messages WHERE status='sent' AND brand_id > 0`),
    one(`SELECT COUNT(*) n FROM messages WHERE status='sent_manual' AND brand_id > 0`),
  ]);
  const asks = {};
  for (const col of Object.keys(ASK_STATES)) {
    asks[col] = Object.fromEntries((await all(env, `SELECT ${col} k, COUNT(*) n FROM brands GROUP BY ${col}`)).map((r) => [r.k, r.n]));
  }
  const permissions = await one(`SELECT COUNT(*) n FROM permissions WHERE revoked_on IS NULL AND (expires_on IS NULL OR expires_on >= date('now'))`);
  const expiring = await all(env, `SELECT p.id, b.name brand, p.expires_on FROM permissions p JOIN brands b ON b.id=p.brand_id
     WHERE p.revoked_on IS NULL AND p.expires_on IS NOT NULL AND p.expires_on <= date('now','+30 days') ORDER BY p.expires_on`);
  const byWeek = await all(env, `SELECT strftime('%Y-%W', m.sent_at) wk, MIN(date(m.sent_at)) start, COUNT(*) sent,
      COUNT(DISTINCT CASE WHEN r.kind='reply' THEN r.brand_id END) replied
    FROM messages m LEFT JOIN replies r ON r.brand_id=m.brand_id AND r.received_at >= m.sent_at
    WHERE m.status IN ('sent','sent_manual') AND m.kind='initial' AND m.brand_id > 0 AND m.sent_at >= datetime('now','-84 days') GROUP BY wk ORDER BY wk`);
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return { brands, contacted, replied, replyRate: rate(replied, contacted), partners, declined, sent, sentManual, asks, permissions, expiring, byWeek };
}

async function exportBrands(env) {
  return all(env, `SELECT name, website, kind, product_count, max_price, score, status, contact_name, contact_email, contact_role, contact_url, instagram,
    image_status, affiliate_status, affiliate_network, affiliate_url, commission, cookie_days, sample_status, collab_status, feed_status,
    last_contacted_at, follow_up_on, notes FROM brands ORDER BY score DESC`);
}

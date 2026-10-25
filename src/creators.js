// Creators: small YouTubers, TikTokers, Instagrammers and bloggers who posted registry or product videos about
// gear on the site. Invite them to check the comparison page for the products they covered and share it if it
// helps their viewers, and ask permission to feature them ("Recommended by creators") on those product pages.
// Creators are rows in link_prospects with kind='creator', so drafts, sending, replies and follow-ups are shared.
import { fail, all, first, cfg, parseJ, nodash, EMAIL_RE } from './util.js';
import { call, textOf, jsonOut, noThink, claudeKey, WRITE_MODEL, RESEARCH_MODEL, titleCase } from './claude.js';
import { ourPages, refreshProspectOdds } from './links.js';

export const PLATFORMS = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', blog: 'Blog', pinterest: 'Pinterest', other: 'Other' };

function normPlatform(s, url) {
  const t = `${s || ''} ${url || ''}`.toLowerCase();
  if (/youtu/.test(t)) return 'youtube';
  if (/tiktok/.test(t)) return 'tiktok';
  if (/instagram/.test(t)) return 'instagram';
  if (/pinterest/.test(t)) return 'pinterest';
  if (/blog|substack|wordpress|site|web/.test(t)) return 'blog';
  return 'other';
}
function normHandle(h, platform) {
  const raw = String(h || '').trim();
  if (platform === 'blog') return raw.replace(/^@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase().slice(0, 80);
  return raw.replace(/^https?:\/\/(www\.)?[^/]+\//, '').replace(/^@?/, '@').replace(/[/?].*$/, '').slice(0, 80);
}
function parseFollowers(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const m = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!m) return null;
  const f = (m[1] + (m[2] || '')).toLowerCase();
  const n = /k$/.test(f) ? Number(f.slice(0, -1)) * 1000 : /m$/.test(f) ? Number(f.slice(0, -1)) * 1e6 : Number(f);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// Products a finder run focuses on, and our page for each.
async function focusProducts(env, focusType, focus) {
  const s = await cfg(env);
  let origin = ''; try { origin = new URL(s.site_url).origin; } catch {}
  const fix = (u) => { if (!u || !origin) return u; try { const x = new URL(u); return origin + x.pathname; } catch { return u; } };
  let rows = [];
  if (focusType === 'brand') rows = await all(env, `SELECT p.id, p.name, p.site_url, b.name brand FROM products p JOIN brands b ON b.id=p.brand_id WHERE lower(b.name)=lower(?) ORDER BY p.price IS NULL, p.price DESC LIMIT 60`, focus);
  else if (focusType === 'category') rows = await all(env, `SELECT p.id, p.name, p.site_url, b.name brand FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.section=? ORDER BY b.reply_odds IS NULL, p.price IS NULL, p.price DESC LIMIT 60`, focus);
  else if (focusType === 'product') rows = await all(env, `SELECT p.id, p.name, p.site_url, b.name brand FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.name LIKE ? OR (b.name || ' ' || p.name) LIKE ? LIMIT 20`, `%${focus}%`, `%${focus}%`);
  return rows.map((r) => ({ id: r.id, name: r.name.toLowerCase().startsWith(r.brand.toLowerCase()) ? r.name : `${r.brand} ${r.name}`, url: fix(r.site_url) }));
}

// ---------- find creators with Claude + web search ----------
export async function findCreators(env, body) {
  const focusType = ['category', 'brand', 'product', 'registry'].includes(body.focus_type) ? body.focus_type : 'registry';
  const focus = String(body.focus || '').trim().slice(0, 120);
  if (focusType !== 'registry' && !focus) throw fail('Pick what to search for.');
  const platform = PLATFORMS[body.platform] ? body.platform : 'any';
  const s = await cfg(env);
  const products = focusType === 'registry' ? [] : await focusProducts(env, focusType, focus);
  if (focusType !== 'registry' && !products.length) throw fail('No products on the site match that. Pick another one.');
  const pages = await ourPages(env);
  const existing = (await all(env, `SELECT domain FROM link_prospects WHERE kind='creator' ORDER BY id DESC LIMIT 200`)).map((r) => r.domain);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 7 };
  const what = focusType === 'registry' ? 'baby registry videos or posts (registry must-haves, what I registered for, registry hauls)'
    : focusType === 'brand' ? `videos or posts reviewing or showing ${focus} products` : focusType === 'category' ? `videos or posts reviewing or comparing ${focus}`
    : `videos or posts reviewing ${focus}`;
  const system = `You find small content creators for ${s.site_name}, an independent baby gear comparison site. ${s.about}
Use web search to find up to 10 real creators who made ${what}${platform !== 'any' ? ` on ${PLATFORMS[platform]}` : ' on YouTube, TikTok, or Instagram (video creators, not blogs)'}.
Prefer small and mid-size creators (roughly 1,000 to 150,000 followers): parents and parents-to-be, not big media brands, retailers, or the
brands themselves. Prefer posts from the last two years. Skip anyone in exclude (platform/handle).
For each, give the specific video or post you found. video_url must be the creator's own post (e.g. youtube.com/watch?v=..., tiktok.com/@handle/video/...,
instagram.com/reel/...), never a search, discover, hashtag or tag page; use null if you don't have the exact post. If products is given, list the ids of the products from it they featured (only ones
you have evidence for). Give follower or subscriber counts only if you saw them; otherwise null. Give a contact email only if you saw it
published (YouTube About page, bio, link-in-bio page, or their site). Never guess one.
Return ONLY JSON, no prose:
{"creators": [{"platform": "youtube|tiktok|instagram|blog|pinterest", "handle": "@...", "name": "creator or channel name",
"profile_url": "...", "video_url": "...", "video_title": "...", "posted_on": "YYYY-MM-DD or null", "followers": "a plain number like 24800, or null",
"product_ids": [], "why": "one plain sentence", "contact_email": null, "contact_url": null}]}`;
  const messages = [{ role: 'user', content: JSON.stringify({ focus: focusType === 'registry' ? 'baby registry' : focus, products: products.map(({ id, name }) => ({ id, name })),
    exclude: existing }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 4500, system, tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out || !Array.isArray(out.creators)) throw fail('Claude came back without a usable list. Try again or change the focus.', 502);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const added = []; let dupes = 0, skipped = 0;
  for (const c of out.creators.slice(0, 12)) {
    const matched = (c.product_ids || []).map((id) => byId[id]).filter(Boolean);
    const target = matched[0]?.url || (focusType === 'registry' ? pages[0]?.url : products[0]?.url) || pages[0]?.url;
    const r = await insertCreator(env, { ...c, products: matched, target_url: target }, 'claude');
    if (r.ok) added.push(r.id); else if (r.duplicate) dupes++; else skipped++;
  }
  return { ok: true, added: added.length, duplicates: dupes, skipped, ids: added };
}

const BAD_POST = /\/(discover|tag|tags|explore|search|hashtag|results)(\/|\?|$)|[?&](q|search_query)=/i;
async function insertCreator(env, c, source) {
  if (BAD_POST.test(String(c.video_url || ''))) c = { ...c, video_url: null };
  if (BAD_POST.test(String(c.profile_url || ''))) c = { ...c, profile_url: null };
  const platform = normPlatform(c.platform, c.profile_url || c.video_url);
  const handle = normHandle(c.handle || c.profile_url || c.name, platform);
  if (!handle || handle === '@') return { skipped: 'no handle' };
  const key = `${platform}/${handle.toLowerCase()}`;
  const ex = await first(env, `SELECT id FROM link_prospects WHERE domain=?`, key);
  if (ex) return { duplicate: true, id: ex.id };
  const url = /^https?:\/\//.test(String(c.profile_url || '')) ? c.profile_url : /^https?:\/\//.test(String(c.video_url || '')) ? c.video_url : `https://www.google.com/search?q=${encodeURIComponent(handle + ' ' + platform)}`;
  const email = EMAIL_RE.test(String(c.contact_email || '')) ? String(c.contact_email).toLowerCase() : null;
  const posted = /^\d{4}-\d{2}-\d{2}$/.test(String(c.posted_on || '')) ? c.posted_on : null;
  const r = await env.DB.prepare(`INSERT INTO link_prospects (kind, tactic, url, domain, name, platform, handle, followers, video_url, video_title, posted_on, products,
      why, target_url, contact_email, contact_url, status, source, notes)
    VALUES ('creator', 'creator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(url.slice(0, 1000), key, String(c.name || handle).slice(0, 200), platform, handle,
    parseFollowers(c.followers), /^https?:\/\//.test(String(c.video_url || '')) ? c.video_url.slice(0, 1000) : null, String(c.video_title || '').slice(0, 300) || null, posted,
    JSON.stringify((c.products || []).map(({ id, name, url: u }) => ({ id, name, url: u }))), String(c.why || '').slice(0, 1000) || null, c.target_url || null,
    email, /^https?:\/\//.test(String(c.contact_url || '')) ? c.contact_url.slice(0, 500) : null, email ? 'ready' : 'found', source, String(c.notes || '').slice(0, 2000) || null).run();
  await refreshProspectOdds(env, r.meta.last_row_id);
  return { ok: true, id: r.meta.last_row_id };
}

export async function addCreator(env, body) {
  const r = await insertCreator(env, { ...body, followers: body.followers }, 'manual');
  if (r.skipped) throw fail('Add their handle or profile link.');
  return r;
}

// ---------- contact research ----------
export async function researchCreator(env, id) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=? AND kind='creator'`, id);
  if (!p) throw fail('Creator not found', 404);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 4 };
  const system = `You find how to reach a content creator for a friendly collaboration note. Use web search.
Find: their published business or collaboration email (YouTube About page, Instagram/TikTok bio, link-in-bio page like Linktree or Beacons,
or their website). ONLY an address you actually saw published; never guess. Also: their link-in-bio or website URL, their first name if they
use it publicly, follower or subscriber count if shown, other platforms they're on, and whether they work with a talent manager or agency.
Be quick: 2 to 4 searches.
followers is a plain number (their largest platform's count, e.g. 24800) or null; put any detail about it in notes. email_source is the URL where you saw the email.
Return ONLY JSON: {"first_name": null, "email": null, "email_source": null, "contact_url": null, "followers": null,
"other_platforms": [], "manager": null, "notes": "one or two plain sentences on the best way to reach them", "sources": []}`;
  const messages = [{ role: 'user', content: JSON.stringify({ platform: p.platform, handle: p.handle, name: p.name, profile: p.url, video: p.video_url }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 1800, system, tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out) throw fail('Claude came back without usable results. Try again.', 502);
  const cited = [];
  for (const b of data.content || []) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x.url) cited.push(x.url);
  out.sources = [...new Set([...(out.sources || []), ...cited])].slice(0, 10);
  const email = EMAIL_RE.test(out.email || '') ? out.email.toLowerCase() : null;
  const sets = [], params = [];
  const fill = (col, val) => { if (val && !p[col]) { sets.push(`${col}=?`); params.push(String(val).slice(0, 500)); } };
  fill('contact_email', email);
  fill('contact_name', out.first_name);
  fill('contact_url', out.contact_url);
  const f = parseFollowers(out.followers);
  if (f != null && p.followers == null) { sets.push('followers=?'); params.push(f); }
  if (p.status === 'found' && (email || p.contact_email)) sets.push(`status='ready'`);
  sets.push('research=?', `researched_at=datetime('now')`, `updated_at=datetime('now')`);
  params.push(JSON.stringify({ ...out, model }));
  await env.DB.prepare(`UPDATE link_prospects SET ${sets.join(', ')} WHERE id=?`).bind(...params, id).run();
  await refreshProspectOdds(env, id);
  return { ok: true, research: out, foundEmail: email };
}

// ---------- the note (email or DM) ----------
export const CREATOR_ASKS = {
  share: 'Invite them to look at the comparison page for the products they covered, and if they find it helpful, share it with their viewers (a link in their description, bio, or a story).',
  feature: 'Ask permission to feature them on that product page as "Recommended by creators": their name, handle, and a link to their video, with a short quote only if they want to give one.',
  embed: 'Ask permission to show their video on that product page (embedded, credited, linking to their channel).',
};

const NOTE_SYSTEM = (s, channel) => `You write a short, friendly ${channel === 'dm' ? 'direct message (Instagram or TikTok DM)' : 'email'} from Jen Cannizzo, who runs ${s.site_name},
an independent baby gear comparison site, to a small content creator who made a video or post about baby gear. Write AS Jen, first person.
Voice: a warm fellow parent, genuine, casual, not salesy. Creators get lots of brand pitches, so be specific and easy to say yes or no to.

ABOUT THE SITE (the ONLY facts you may use about it): ${s.about}

HOW IT IS BUILT
1. "Hi <first name>," if contact_first_name is given, otherwise "Hi there,"${channel === 'dm' ? ' or "Hi!"' : ''}.
2. One specific, genuine line about their video or post (use video_title or why_it_fits). Never invent details about the video.
3. Say the site covers the products they showed (name one or two from products_they_featured if given) and give our page (target_url) once.
4. The asks, in plain words, in the order given. Make clear each is optional and they can say no.
5. A no-pressure close.

RULES
- ${channel === 'dm' ? '35 to 70 words, 2 or 3 very short paragraphs' : '70 to 140 words, 3 or 4 short paragraphs'}. Plain text, no emojis, no hashtags, no bullet points.
- Never offer money, free products, or affiliate commission unless jens_note says to. Never imply they already endorse the site.
- Never ask them to change what they said about a product or to say anything specific. Their opinion is theirs.
- Never mention SEO, backlinks, or followers counts. Be honest that the site is launching soon if the about text says so.
- Never use em dashes or en dashes.
- No signature, sign-off or name at the end. ${channel === 'dm' ? 'This is a DM, so there is no signature at all.' : 'The signature is added automatically.'}
SUBJECT (email only): Title Case, 3 to 8 words, about their video (e.g. "Loved Your Registry Video"). For a DM, subject is "DM".
Return ONLY JSON: {"subject": "...", "body": "..."}`;

async function noteFacts(env, p) {
  const prods = parseJ(p.products, []);
  return {
    platform: p.platform, creator: p.name, handle: p.handle, contact_first_name: (p.contact_name || '').split(' ')[0] || null,
    video_title: p.video_title, video_url: p.video_url, why_it_fits: p.why, products_they_featured: prods.map((x) => x.name).slice(0, 4),
    target_url: p.target_url || prods[0]?.url || (await ourPages(env))[0]?.url, notes_from_jen: p.notes ? String(p.notes).slice(0, 500) : null,
  };
}

function templateNote(s, p, f, asks, channel) {
  const hi = f.contact_first_name ? `Hi ${f.contact_first_name},` : 'Hi there,';
  const prod = f.products_they_featured[0];
  const ask = [asks.includes('share') && 'If you find it helpful, I\'d love for you to share it with your viewers.',
    asks.includes('feature') && 'I\'d also love to feature your video on that page as a creator recommendation, credited to you, if you\'re open to it.',
    asks.includes('embed') && 'Would you be OK with us showing your video on that page, credited and linked to your channel?'].filter(Boolean).join(' ');
  const body = [hi, '', `I loved your ${f.video_title ? `"${f.video_title}"` : 'video'}${prod ? ` and your take on the ${prod}` : ''}.`, '',
    `I'm Jen, a parent building ${s.site_name}, a free site that compares baby gear side by side from the makers' spec sheets. ${f.target_url ? `Here's the page: ${f.target_url}` : ''}`.trim(), '',
    ask, '', 'No pressure at all either way!'].join('\n');
  return { subject: channel === 'dm' ? 'DM' : titleCase(`Loved Your ${PLATFORMS[p.platform] || ''} Video`.replace(/\s+/g, ' ')), body };
}

export async function draftCreatorNote(env, id, body) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=? AND kind='creator'`, id);
  if (!p) throw fail('Creator not found', 404);
  if (p.status === 'do_not_contact') throw fail('This creator is marked do not contact.');
  const asks = (Array.isArray(body.asks) ? body.asks : ['share', 'feature']).filter((a) => CREATOR_ASKS[a]);
  if (!asks.length) throw fail('Pick at least one thing to ask.');
  const channel = body.channel === 'dm' && p.platform !== 'blog' ? 'dm' : 'email';
  const s = await cfg(env);
  const f = await noteFacts(env, p);
  let out, model = 'template';
  if (await claudeKey(env)) {
    model = WRITE_MODEL(env);
    const data = await call(env, { model, max_tokens: 900, ...noThink(model), system: NOTE_SYSTEM(s, channel),
      messages: [{ role: 'user', content: JSON.stringify({ ...f, asks: asks.map((a) => CREATOR_ASKS[a]), jens_note: String(body.note || '').slice(0, 500) || null }) }] });
    out = jsonOut(textOf(data));
    if (!out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  } else out = templateNote(s, p, f, asks, channel);
  const subject = channel === 'dm' ? `${PLATFORMS[p.platform] || 'Social'} DM to ${p.handle}` : titleCase(nodash(out.subject || 'Loved Your Video')).slice(0, 200);
  await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE prospect_id=? AND status='draft' AND kind='initial'`).bind(id).run();
  const r = await env.DB.prepare(`INSERT INTO messages (brand_id, prospect_id, kind, asks, to_email, subject, body, model, channel) VALUES (0, ?, 'initial', ?, ?, ?, ?, ?, ?)`)
    .bind(id, JSON.stringify(asks), channel === 'dm' ? null : p.contact_email || null, subject, nodash(out.body).slice(0, 5000), model, channel === 'dm' ? 'dm' : null).run();
  if (f.target_url && !p.target_url) await env.DB.prepare(`UPDATE link_prospects SET target_url=? WHERE id=?`).bind(f.target_url, id).run();
  return { ok: true, id: r.meta.last_row_id, model };
}

export async function rewriteCreatorNote(env, msg, body) {
  const feedback = String(body.feedback || '').trim().slice(0, 1000);
  if (!feedback) throw fail('Tell Claude what to change.');
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=?`, msg.prospect_id);
  const s = await cfg(env);
  const channel = msg.channel === 'dm' ? 'dm' : 'email';
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 900, ...noThink(model),
    system: NOTE_SYSTEM(s, channel) + `\n\nYOU ARE NOW EDITING an existing draft. Apply Jen's feedback exactly and keep the rules above. Return the same JSON shape.`,
    messages: [{ role: 'user', content: JSON.stringify({ ...(await noteFacts(env, p)), asks: parseJ(msg.asks, []).map((a) => CREATOR_ASKS[a]).filter(Boolean),
      current_subject: body.subject ?? msg.subject, current_body: body.body ?? msg.body, jens_feedback: feedback }) }] });
  const out = jsonOut(textOf(data));
  if (!out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  const subject = channel === 'dm' ? msg.subject : titleCase(nodash(out.subject || msg.subject)).slice(0, 200), text = nodash(out.body).slice(0, 5000);
  await env.DB.prepare(`UPDATE messages SET subject=?, body=?, model=? WHERE id=?`).bind(subject, text, model + '+feedback', msg.id).run();
  return { ok: true, subject, body: text };
}

// ---------- the written record of what they agreed to ----------
export async function addFeature(env, id, body) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=? AND kind='creator'`, id);
  if (!p) throw fail('Creator not found', 404);
  const kind = ['shared', 'feature', 'embed'].includes(body.kind) ? body.kind : null;
  if (!kind) throw fail('Pick what they agreed to.');
  const perm = String(body.permission_text || '').trim();
  if (kind !== 'shared' && !perm) throw fail('Paste what they said, in their own words. That is your permission record.');
  const on = String(body.granted_on || '').trim();
  if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) throw fail('Bad date');
  let url = String(body.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const pages = (Array.isArray(body.product_urls) ? body.product_urls : String(body.product_urls || '').split(/[\s,]+/)).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x));
  await env.DB.prepare(`INSERT INTO creator_features (prospect_id, kind, url, quote, product_urls, permission_text, granted_by, granted_on, credit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, kind, url || (kind === 'embed' ? p.video_url : null), String(body.quote || '').slice(0, 1000) || null,
    JSON.stringify(pages.length ? pages : [p.target_url].filter(Boolean)), perm.slice(0, 4000) || null, String(body.granted_by || p.handle).slice(0, 300),
    on || new Date().toISOString().slice(0, 10), String(body.credit || `${p.handle} on ${PLATFORMS[p.platform] || p.platform}`).slice(0, 200)).run();
  await env.DB.prepare(`UPDATE link_prospects SET status='won', follow_up_on=NULL, odds=NULL, updated_at=datetime('now') WHERE id=?`).bind(id).run();
  return { ok: true };
}
export async function revokeFeature(env, fid, body) {
  const f = await first(env, `SELECT * FROM creator_features WHERE id=?`, fid);
  if (!f) throw fail('Not found', 404);
  await env.DB.prepare(`UPDATE creator_features SET revoked_on=COALESCE(revoked_on, date('now')), permission_text=COALESCE(permission_text || char(10), '') || ? WHERE id=?`)
    .bind(`Revoked: ${String(body.note || 'they asked').slice(0, 500)}`, fid).run();
  return { ok: true };
}

export async function creatorSummary(env) {
  const [byStatus, byPlatform, feats, sections, brands, contacted, replied] = await Promise.all([
    all(env, `SELECT status k, COUNT(*) n FROM link_prospects WHERE kind='creator' GROUP BY status`),
    all(env, `SELECT platform k, COUNT(*) n FROM link_prospects WHERE kind='creator' GROUP BY platform`),
    all(env, `SELECT kind k, COUNT(*) n FROM creator_features WHERE revoked_on IS NULL GROUP BY kind`),
    all(env, `SELECT section v, COUNT(*) n FROM products WHERE section IS NOT NULL GROUP BY section ORDER BY section`),
    all(env, `SELECT name v, product_count n FROM brands WHERE product_count > 0 ORDER BY name COLLATE NOCASE`),
    first(env, `SELECT COUNT(*) n FROM link_prospects WHERE kind='creator' AND last_contacted_at IS NOT NULL`),
    first(env, `SELECT COUNT(DISTINCT r.prospect_id) n FROM replies r JOIN link_prospects p ON p.id=r.prospect_id WHERE p.kind='creator' AND r.kind='reply'`),
  ]);
  const o = (rows) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  return { contacted: contacted?.n || 0, replied: replied?.n || 0, statuses: o(byStatus), platforms: o(byPlatform), features: o(feats), platformNames: PLATFORMS, asks: CREATOR_ASKS, sections, brands };
}

export async function listFeatures(env) {
  return all(env, `SELECT f.*, p.name creator, p.handle, p.platform, p.url profile_url FROM creator_features f JOIN link_prospects p ON p.id=f.prospect_id
    ORDER BY f.revoked_on IS NOT NULL, f.id DESC`);
}

// For the comparison site: only active "feature" and "embed" permissions.
export async function featuresForSite(env) {
  const rows = await all(env, `SELECT f.*, p.name creator, p.handle, p.platform, p.url profile_url FROM creator_features f JOIN link_prospects p ON p.id=f.prospect_id
    WHERE f.revoked_on IS NULL AND f.kind IN ('feature','embed') ORDER BY f.id`);
  return rows.map((r) => ({ creator: r.creator, handle: r.handle, platform: r.platform, profile_url: r.profile_url, kind: r.kind, video_url: r.url,
    quote: r.quote, credit: r.credit, pages: parseJ(r.product_urls, []), granted_on: r.granted_on }));
}

export async function exportCreators(env) {
  return all(env, `SELECT name, platform, handle, followers, url profile_url, video_title, video_url, posted_on, status, odds, contact_name, contact_email,
    contact_url, target_url, products, why, notes, last_contacted_at FROM link_prospects WHERE kind='creator' ORDER BY odds DESC`);
}

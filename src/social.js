// Grow: accounts for @thecribpicks to follow and engage with, post ideas from the catalog, and a daily plan.
import { fail, all, first, cfg, parseJ } from './util.js';
import { call, textOf, jsonOut, noThink, RESEARCH_MODEL, WRITE_MODEL } from './claude.js';
import { ourPages } from './links.js';

export const SOCIAL_PLATFORMS = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', pinterest: 'Pinterest' };
export const CATEGORIES = {
  creator: 'Baby gear creators', brand: 'Brands on the site', community: 'Parenting & registry accounts',
  expert: 'Experts (CPSTs, lactation, sleep, pediatric)', local: 'New York parent accounts',
};
const STATUSES = ['to_follow', 'followed', 'skipped'];
const normHandle = (h) => {
  const s = String(h || '').trim().replace(/^https?:\/\/(www\.)?[^/]+\//, '').replace(/[/?#].*$/, '').replace(/^@?/, '@');
  return s.length > 1 ? s.slice(0, 60) : null;
};
const profileUrl = (platform, handle) => {
  const h = handle.replace(/^@/, '');
  return { tiktok: `https://www.tiktok.com/@${h}`, instagram: `https://www.instagram.com/${h}/`, youtube: `https://www.youtube.com/@${h}`, pinterest: `https://www.pinterest.com/${h}/` }[platform] || null;
};
// Priority: smaller accounts in your niche notice you; people you're pitching benefit from a warm-up follow.
function priorityOf(t) {
  let p = { creator: 70, expert: 60, community: 55, local: 55, brand: 45 }[t.category] || 50;
  const f = Number(t.followers) || 0;
  if (f) p += f < 10000 ? 15 : f < 50000 ? 8 : f < 250000 ? 0 : -12;
  if (t.source === 'creators') p += 10; // you're pitching them: follow first so your name is familiar
  return Math.max(1, Math.min(99, p));
}

async function upsert(env, t) {
  const handle = normHandle(t.handle);
  const platform = SOCIAL_PLATFORMS[t.platform] ? t.platform : null;
  if (!handle || !platform) return { skipped: true };
  const row = { ...t, handle, platform };
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO social_targets (platform, handle, name, url, followers, category, why, source, ref_id, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(platform, handle, String(t.name || '').slice(0, 120) || null,
    profileUrl(platform, handle), Number.isFinite(Number(t.followers)) && t.followers !== null && t.followers !== '' ? Math.round(Number(t.followers)) : null,
    CATEGORIES[t.category] ? t.category : 'community', String(t.why || '').slice(0, 400) || null, t.source || 'manual', t.ref_id || null, priorityOf(row)).run();
  return r.meta.changes ? { ok: true, id: r.meta.last_row_id } : { duplicate: true };
}

// Pull in handles you already have: brand Instagrams and creators from the Creators tab.
export async function syncTargets(env) {
  let added = 0;
  for (const b of await all(env, `SELECT id, name, instagram, product_count FROM brands WHERE COALESCE(instagram,'')!='' AND status NOT IN ('do_not_contact','skipped')`)) {
    const r = await upsert(env, { platform: 'instagram', handle: b.instagram, name: b.name, category: 'brand', why: `${b.product_count} of their products are on Cribpicks.`, source: 'brands', ref_id: b.id });
    if (r.ok) added++;
  }
  for (const c of await all(env, `SELECT id, name, platform, handle, followers, url, video_title FROM link_prospects WHERE kind='creator' AND status NOT IN ('do_not_contact','skipped') AND platform IN ('tiktok','instagram','youtube','pinterest')`)) {
    const r = await upsert(env, { platform: c.platform, handle: c.handle, name: c.name, url: c.url, followers: c.followers, category: 'creator',
      why: c.video_title ? `Posted "${String(c.video_title).slice(0, 80)}". On your Creators list.` : 'On your Creators list.', source: 'creators', ref_id: c.id });
    if (r.ok) added++;
  }
  return { ok: true, added };
}

export async function findTargets(env, body) {
  const platform = SOCIAL_PLATFORMS[body.platform] ? body.platform : 'tiktok';
  const category = CATEGORIES[body.category] ? body.category : 'community';
  const topic = String(body.topic || '').trim().slice(0, 120) || 'baby gear, registries and new-parent life';
  const s = await cfg(env);
  const existing = (await all(env, `SELECT handle FROM social_targets WHERE platform=? ORDER BY id DESC LIMIT 300`, platform)).map((r) => r.handle);
  const what = {
    creator: 'parent creators who post baby gear reviews, registry videos, hauls and comparisons',
    brand: 'baby gear brands (strollers, car seats, nursery, feeding) and their official accounts',
    community: 'parenting, pregnancy and registry accounts with engaged audiences of expecting and new parents',
    expert: 'certified child passenger safety technicians (CPSTs), lactation consultants, pediatric sleep consultants, pediatric nurses and doulas who post educational content',
    local: 'parent and family accounts in New York State, especially the Capital Region (Albany, Saratoga, Schenectady, Troy): moms groups, family events, local kids businesses',
  }[category];
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };
  const system = `You help ${s.site_name} (${s.about}) grow its new ${SOCIAL_PLATFORMS[platform]} account by finding accounts worth following and engaging with.
Find 15 real, active ${SOCIAL_PLATFORMS[platform]} accounts: ${what}. Topic focus: ${topic}.
Prefer small and mid-size accounts (about 1,000 to 100,000 followers) that post at least monthly and get comments: those are the ones that
notice new followers and whose audiences are expecting or new parents. Include a few bigger ones only if they're central to the niche.
Skip handles in exclude, spam/giveaway accounts, and anything not clearly about babies, pregnancy or parenting.
Give follower counts only if you saw them. why: one plain sentence on why following them helps (shared audience, posts about products on our site, etc.).
Return ONLY JSON: {"accounts": [{"handle": "@...", "name": "...", "url": "...", "followers": 12000, "why": "..."}]}`;
  const messages = [{ role: 'user', content: JSON.stringify({ platform, category, topic, exclude: existing }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 5000, system, tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out || !Array.isArray(out.accounts)) throw fail('Claude came back without a usable list. Try again or change the focus.', 502);
  let added = 0, dupes = 0;
  for (const a of out.accounts.slice(0, 25)) {
    const f = String(a.followers ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([km])?/i);
    const followers = f ? Math.round(Number(f[1]) * (f[2]?.toLowerCase() === 'm' ? 1e6 : f[2]?.toLowerCase() === 'k' ? 1e3 : 1)) : null;
    const r = await upsert(env, { ...a, followers, platform, category, source: 'claude' });
    if (r.ok) added++; else if (r.duplicate) dupes++;
  }
  return { ok: true, added, duplicates: dupes };
}

export async function addTarget(env, body) {
  const r = await upsert(env, { ...body, source: 'manual' });
  if (r.skipped) throw fail('Add a platform and handle.');
  return r;
}

export async function listTargets(env, url) {
  const p = url.searchParams, where = [], params = [];
  if (p.get('status')) { where.push('status=?'); params.push(p.get('status')); } else where.push(`status!='skipped'`);
  if (p.get('platform')) { where.push('platform=?'); params.push(p.get('platform')); }
  if (p.get('category')) { where.push('category=?'); params.push(p.get('category')); }
  if (p.get('q')) { const q = `%${p.get('q')}%`; where.push('(handle LIKE ? OR name LIKE ? OR why LIKE ?)'); params.push(q, q, q); }
  return all(env, `SELECT * FROM social_targets WHERE ${where.join(' AND ')} ORDER BY status='to_follow' DESC, priority DESC, id LIMIT 600`, ...params);
}

// Today's list: a safe number of new follows (new accounts get limited for mass-following), plus accounts to engage with again.
export async function today(env, url) {
  const platform = SOCIAL_PLATFORMS[url.searchParams.get('platform')] ? url.searchParams.get('platform') : null;
  const n = Math.min(40, Number(url.searchParams.get('n')) || 15);
  const pf = platform ? ' AND platform=?' : '';
  const args = platform ? [platform] : [];
  const [follow, engage, counts] = await Promise.all([
    all(env, `SELECT * FROM social_targets WHERE status='to_follow'${pf} ORDER BY priority DESC, id LIMIT ?`, ...args, n),
    all(env, `SELECT * FROM social_targets WHERE status='followed'${pf} AND (engaged_on IS NULL OR engaged_on <= date('now','-7 days'))
      ORDER BY follows_back DESC, category='creator' DESC, priority DESC LIMIT 8`, ...args),
    all(env, `SELECT status, COUNT(*) n, SUM(follows_back) back, SUM(CASE WHEN followed_on >= date('now','-7 days') THEN 1 ELSE 0 END) week,
      SUM(CASE WHEN followed_on = date('now') THEN 1 ELSE 0 END) today FROM social_targets GROUP BY status`),
  ]);
  const c = Object.fromEntries(counts.map((r) => [r.status, r]));
  return { follow, engage, stats: { to_follow: c.to_follow?.n || 0, followed: c.followed?.n || 0, follow_backs: c.followed?.back || 0,
    this_week: c.followed?.week || 0, today: c.followed?.today || 0 } };
}

export async function updateTarget(env, id, body) {
  const t = await first(env, `SELECT * FROM social_targets WHERE id=?`, id);
  if (!t) throw fail('Not found', 404);
  const sets = [], params = [];
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw fail('Unknown status');
    sets.push('status=?'); params.push(body.status);
    if (body.status === 'followed' && !t.followed_on) sets.push(`followed_on=date('now')`);
  }
  if (body.engaged) sets.push(`engaged_on=date('now')`);
  if (body.follows_back !== undefined) { sets.push('follows_back=?'); params.push(body.follows_back ? 1 : 0); }
  if (body.notes !== undefined) { sets.push('notes=?'); params.push(String(body.notes).slice(0, 1000) || null); }
  if (body.followers !== undefined) {
    const m = String(body.followers ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([km])?/i);
    const n = m ? Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1e6 : m[2]?.toLowerCase() === 'k' ? 1e3 : 1)) : null;
    sets.push('followers=?'); params.push(n);
  }
  if (!sets.length) return { ok: true };
  await env.DB.prepare(`UPDATE social_targets SET ${sets.join(', ')} WHERE id=?`).bind(...params, id).run();
  const u = await first(env, `SELECT * FROM social_targets WHERE id=?`, id);
  await env.DB.prepare(`UPDATE social_targets SET priority=? WHERE id=?`).bind(priorityOf(u), id).run();
  return { ok: true };
}

// ---------- post ideas ----------
export const PILLARS = {
  compare: 'Side by side: two or three products people actually choose between, the differences that matter',
  spec: 'One spec explained: what a number on the box means in real life (fold size, weight limit, harness slots)',
  registry: 'Registry help: what to register for by category, what to skip, what to buy later',
  myth: 'Myth vs fact: a common gear belief checked against the makers\' own specs',
  behind: 'Behind the site: how Cribpicks checks specs, a feature of the site, a new category added',
  trend: 'Trending format: a popular TikTok/Reels format applied to baby gear (POV, rating, "things I\'d buy again")',
};
export async function generateIdeas(env, body) {
  const platform = SOCIAL_PLATFORMS[body.platform] ? body.platform : 'tiktok';
  const count = Math.max(3, Math.min(10, Number(body.count) || 7));
  const focus = String(body.focus || '').trim().slice(0, 120);
  const s = await cfg(env);
  const pages = await ourPages(env);
  const secs = await all(env, `SELECT section, COUNT(*) n FROM products WHERE section IS NOT NULL GROUP BY section ORDER BY n DESC`);
  const sample = await all(env, `SELECT p.name, p.section, b.name brand FROM products p JOIN brands b ON b.id=p.brand_id
    WHERE p.price IS NOT NULL ${focus ? `AND (p.section LIKE ? OR b.name LIKE ? OR p.name LIKE ?)` : ''} ORDER BY RANDOM() LIMIT 40`, ...(focus ? [`%${focus}%`, `%${focus}%`, `%${focus}%`] : []));
  const recent = (await all(env, `SELECT title FROM social_ideas ORDER BY id DESC LIMIT 40`)).map((r) => r.title);
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 4000, ...noThink(model),
    system: `You plan short-form videos for ${s.site_name}'s ${SOCIAL_PLATFORMS[platform]} (@thecribpicks). ${s.about}
Audience: expecting and new parents building a registry or replacing gear. Goal: follows and visits to the site.
Write ${count} distinct video ideas, mixing these pillars: ${Object.entries(PILLARS).map(([k, v]) => `${k} (${v})`).join('; ')}.
Use the real products and categories given. NEVER state a spec number, price, weight or safety claim: say what to compare and have the video
show the numbers on the Cribpicks page (link_url from our_pages). Never say "safest" or give safety advice; car seat ideas must point to the
manual and a certified CPST. No paid-ranking language. The owner stays anonymous: no face required, voiceover or text-on-screen formats.
hook: the first 2 seconds of on-screen text or voiceover, under 12 words, specific. outline: 3 to 6 short beats. caption: 1 to 2 sentences,
ends with a question to get comments. hashtags: 4 to 6, mixing niche (#babyregistry) and specific (#strollercomparison). No dashes.
Avoid repeating these existing ideas: ${JSON.stringify(recent)}.
Return ONLY JSON: {"ideas": [{"pillar": "compare", "title": "...", "hook": "...", "outline": ["...", "..."], "caption": "...", "hashtags": ["#..."], "link_url": "..."}]}`,
    messages: [{ role: 'user', content: JSON.stringify({ focus: focus || null, categories: secs.slice(0, 30), products: sample, our_pages: pages.slice(0, 40) }) }] });
  const out = jsonOut(textOf(data));
  if (!out || !Array.isArray(out.ideas)) throw fail('Claude returned something unexpected. Try again.', 502);
  const nd = (t) => String(t || '').replace(/\s*[—–]\s*/g, ', ');
  let added = 0;
  for (const i of out.ideas.slice(0, count)) {
    if (!i.title) continue;
    await env.DB.prepare(`INSERT INTO social_ideas (platform, pillar, title, hook, outline, caption, hashtags, link_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(platform, PILLARS[i.pillar] ? i.pillar : null, nd(i.title).slice(0, 200), nd(i.hook).slice(0, 200), JSON.stringify((i.outline || []).map(nd).slice(0, 8)),
        nd(i.caption).slice(0, 600), (i.hashtags || []).map((h) => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).slice(0, 8).join(' '),
        /^https?:\/\//.test(String(i.link_url || '')) ? i.link_url : null).run();
    added++;
  }
  return { ok: true, added };
}
export async function listIdeas(env, url) {
  const st = url.searchParams.get('status');
  return all(env, `SELECT * FROM social_ideas ${st ? 'WHERE status=?' : `WHERE status!='skipped'`} ORDER BY CASE status WHEN 'planned' THEN 0 WHEN 'idea' THEN 1 ELSE 2 END, planned_on, id DESC LIMIT 200`, ...(st ? [st] : []));
}
export async function updateIdea(env, id, body) {
  const sets = [], params = [];
  if (body.status && ['idea', 'planned', 'posted', 'skipped'].includes(body.status)) { sets.push('status=?'); params.push(body.status); }
  if (body.planned_on !== undefined) { const d = String(body.planned_on || ''); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw fail('Bad date'); sets.push('planned_on=?'); params.push(d || null); }
  if (body.posted_url !== undefined) { sets.push('posted_url=?'); params.push(String(body.posted_url || '').slice(0, 500) || null); }
  if (!sets.length) return { ok: true };
  await env.DB.prepare(`UPDATE social_ideas SET ${sets.join(', ')} WHERE id=?`).bind(...params, id).run();
  return { ok: true };
}
export async function socialSummary(env) {
  const [byCat, byPlat, ideas, posted] = await Promise.all([
    all(env, `SELECT category k, COUNT(*) n FROM social_targets WHERE status!='skipped' GROUP BY category`),
    all(env, `SELECT platform k, COUNT(*) n FROM social_targets WHERE status!='skipped' GROUP BY platform`),
    all(env, `SELECT status k, COUNT(*) n FROM social_ideas GROUP BY status`),
    first(env, `SELECT COUNT(*) n FROM social_ideas WHERE status='posted' AND date(created_at) >= date('now','-7 days')`),
  ]);
  const o = (r) => Object.fromEntries(r.map((x) => [x.k, x.n]));
  return { categories: CATEGORIES, platforms: SOCIAL_PLATFORMS, pillars: PILLARS, byCategory: o(byCat), byPlatform: o(byPlat), ideas: o(ideas), postedThisWeek: posted?.n || 0 };
}

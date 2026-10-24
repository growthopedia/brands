// Backlinks: find sites that might link to the comparison site, pitch them, and check that won links stay live.
// Pitches are rows in `messages` with brand_id = 0 and prospect_id set, so they share drafts, sending,
// the daily limit, reply checking and forwarding with brand emails.
import { fail, all, first, cfg, parseJ, nodash, domainOf, EMAIL_RE } from './util.js';
import { call, textOf, jsonOut, noThink, claudeKey, WRITE_MODEL, RESEARCH_MODEL, titleCase } from './claude.js';

export const TACTICS = {
  resource: {
    name: 'Resource pages',
    find: 'Pages that list helpful links and tools for expecting and new parents: "new parent resources", "baby registry resources", "helpful links" pages on parenting sites, and resource pages on doula, midwife, lactation consultant, childbirth class, pediatric and parenting-coach sites.',
    pitch: 'Suggest adding our page to the resource list on their page. Name their page by its title. One sentence on why it helps their readers: free side-by-side comparisons from the makers\' own spec sheets, no sign-up.',
    base: 46,
  },
  roundup: {
    name: 'Gear roundups & bloggers',
    find: 'Independent parenting and baby gear blogs and writers (not big publishers) with articles like "best strollers", "stroller comparison", "car seat guide", "registry must-haves", where a side-by-side spec comparison would help their readers.',
    pitch: 'Compliment one specific thing in their article. Offer our comparison page as a handy reference for their readers or a source for exact specs (weights, fold sizes, limits). Never ask them to change their picks or replace another link.',
    base: 30,
  },
  guest: {
    name: 'Guest posts',
    find: 'Parenting, pregnancy and family blogs that publicly accept guest posts or contributors ("write for us", "contribute", "submit a post") and cover baby gear, registries, or new-parent life.',
    pitch: 'Propose two or three specific, useful article ideas that fit their site (for example how to compare stroller fold sizes, which car seat specs actually matter). Not promotional. Ask whether they take contributions and what their guidelines are.',
    base: 45,
  },
  expert: {
    name: 'Journalists & expert quotes',
    find: 'Journalists and writers who covered baby gear (strollers, car seats, registries, nursery) in the last 12 months for news sites, regional papers, parenting magazines or newsletters, and who could use spec data or a parent quote.',
    pitch: 'Offer something concrete they could use: spec data from the comparison site (for example lightest travel strollers by weight, smallest folds) or a quick quote. Under 120 words.',
    base: 25,
  },
  organization: {
    name: 'Parent groups & local orgs',
    find: 'Parent groups, family resource centers, hospital and birth-center new-parent pages, childbirth educators, library family pages, and family magazines in New York State (Capital Region first) that list resources for families.',
    pitch: 'Offer the free comparison tool as a resource for their families. Plain and friendly, community tone.',
    base: 48,
  },
  mention: {
    name: 'Unlinked mentions',
    find: 'Pages that mention the site by name but do not link to it.',
    pitch: 'Thank them for the mention and ask if they would add a link so readers can find it.',
    base: 70,
  },
  partner: {
    name: 'Partner brands',
    find: null,
    pitch: 'This brand already works with Jen. Thank them, and ask whether they would link to their comparison page on our site from a press, "as seen on", or where-to-compare page.',
    base: 60,
  },
  competitor: {
    name: 'Competitor links (imported)',
    find: null,
    pitch: 'This page links to similar baby gear sites. Lead with why our page helps their readers. Never mention or criticize other sites.',
    base: 30,
  },
  other: { name: 'Other', find: null, pitch: 'Lead with why our page helps their readers.', base: 35 },
};

const SKIP_DOMAINS = /(^|\.)(amazon|walmart|target|ebay|etsy|wayfair|reddit|facebook|instagram|pinterest|youtube|tiktok|twitter|x|threads|linkedin|quora|babylist|babygearlab|wikipedia|google|apple)\.(com|org|net|co)$/;
const PROSPECT_STATUSES = ['found', 'ready', 'pitched', 'replied', 'won', 'lost', 'skipped', 'do_not_contact'];
const SHARED_INBOX = /^(info|hello|hi|contact|support|help|editor|editors|team|admin|office|tips|news|submissions|press)@/;

// ---------- reply odds ----------
export function prospectOdds(p) {
  if (['replied', 'won', 'lost', 'skipped', 'do_not_contact'].includes(p.status)) return null;
  let s = (TACTICS[p.tactic] || TACTICS.other).base;
  const email = String(p.contact_email || '').toLowerCase();
  if (email) s += SHARED_INBOX.test(email) ? 8 : 16;
  else if (p.contact_url) s += 3;
  else if (p.researched_at) s -= 10;
  const a = Number(p.authority);
  if (a >= 70) s -= 12; else if (a >= 50) s -= 5; else if (a > 0 && a < 30) s += 5;
  if (p.status === 'pitched') s -= 5;
  return Math.max(3, Math.min(97, Math.round(s)));
}
async function refreshProspectOdds(env, id) {
  const rows = id ? await all(env, `SELECT * FROM link_prospects WHERE id=?`, id) : await all(env, `SELECT * FROM link_prospects`);
  const stmts = rows.map((p) => env.DB.prepare(`UPDATE link_prospects SET odds=? WHERE id=?`).bind(prospectOdds(p), p.id));
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
}

// ---------- our pages (what a prospect could link to) ----------
export async function ourPages(env) {
  const s = await cfg(env);
  let origin = '';
  try { origin = new URL(s.site_url).origin; } catch { return []; }
  const rows = await all(env, `SELECT site_url, section FROM products WHERE site_url IS NOT NULL`);
  const bySeg = {};
  for (const r of rows) {
    let seg; try { seg = new URL(r.site_url).pathname.split('/').filter(Boolean)[0]; } catch { continue; }
    if (!seg) continue;
    bySeg[seg] ||= {}; bySeg[seg][r.section || seg] = (bySeg[seg][r.section || seg] || 0) + 1;
  }
  const pages = [{ url: `${origin}/`, label: 'Home page (every category)' }, { url: `${origin}/compare/`, label: 'Compare tool (any 2-3 products)' }];
  for (const [seg, secs] of Object.entries(bySeg).sort()) {
    const label = Object.entries(secs).sort((a, b) => b[1] - a[1])[0][0];
    pages.push({ url: `${origin}/${seg}/`, label });
  }
  return pages;
}

// The domains a link must point at to count (site address + any extra domains in Settings).
async function ourHosts(env) {
  const s = await cfg(env);
  const hosts = new Set();
  for (const u of [s.site_url, ...String(s.link_domains || '').split(',')]) {
    const h = domainOf(String(u || '').trim()); if (h) hosts.add(h);
  }
  return hosts;
}
export async function prelaunchWarning(env) {
  const s = await cfg(env);
  const h = domainOf(s.site_url || '') || '';
  if (!h) return 'Add the site address in Settings first.';
  if (/\.(workers|pages)\.dev$/.test(h)) return `Settings → Site address is ${h}. Links pointing there won't count for the real domain, so build the list now and pitch once the real domain is live.`;
  return null;
}

// ---------- list / get / update ----------
export async function listProspects(env, url) {
  const p = url.searchParams, where = [], params = [];
  if (p.get('status')) { where.push('status=?'); params.push(p.get('status')); }
  else if (p.get('hide_done') !== '0') where.push(`status NOT IN ('skipped','do_not_contact','lost')`);
  if (p.get('tactic')) { where.push('tactic=?'); params.push(p.get('tactic')); }
  if (p.get('contact') === 'email') where.push(`COALESCE(contact_email,'')!=''`);
  if (p.get('contact') === 'none') where.push(`COALESCE(contact_email,'')='' AND COALESCE(contact_url,'')=''`);
  if (p.get('q')) { const q = `%${p.get('q')}%`; where.push('(name LIKE ? OR domain LIKE ? OR page_title LIKE ? OR notes LIKE ?)'); params.push(q, q, q, q); }
  const sort = { odds: 'odds IS NULL, odds DESC, authority DESC', authority: 'authority IS NULL, authority DESC', newest: 'id DESC',
    name: 'COALESCE(name, domain) COLLATE NOCASE', follow_up: 'follow_up_on IS NULL, follow_up_on' }[p.get('sort')] || 'odds IS NULL, odds DESC, authority DESC';
  return all(env, `SELECT id, url, domain, name, page_title, tactic, why, target_url, authority, contact_name, contact_email, contact_url, status, odds,
    researched_at, follow_up_on, last_contacted_at FROM link_prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT 1000`, ...params);
}

export async function getProspect(env, id) {
  const prospect = await first(env, `SELECT * FROM link_prospects WHERE id=?`, id);
  if (!prospect) throw fail('Prospect not found', 404);
  const [messages, replies, links] = await Promise.all([
    all(env, `SELECT * FROM messages WHERE prospect_id=? AND status!='skipped' ORDER BY id`, id),
    all(env, `SELECT * FROM replies WHERE prospect_id=? ORDER BY received_at`, id),
    all(env, `SELECT * FROM links WHERE prospect_id=? ORDER BY id`, id),
  ]);
  return { prospect, messages, replies, links };
}

const P_TEXT = ['name', 'url', 'page_title', 'why', 'target_url', 'contact_name', 'contact_email', 'contact_url', 'notes', 'tactic'];
export async function updateProspect(env, id, body) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=?`, id);
  if (!p) throw fail('Prospect not found', 404);
  const sets = [], params = [];
  if (body.status !== undefined) {
    if (!PROSPECT_STATUSES.includes(body.status)) throw fail('Unknown status');
    sets.push('status=?'); params.push(body.status);
  }
  for (const k of P_TEXT) if (body[k] !== undefined) {
    let v = String(body[k] ?? '').trim().slice(0, 4000) || null;
    if (k === 'contact_email' && v) { v = v.toLowerCase(); if (!EMAIL_RE.test(v)) throw fail('That email address doesn\'t look right.'); }
    if (k === 'tactic' && !TACTICS[v]) throw fail('Unknown tactic');
    if (['url', 'target_url', 'contact_url'].includes(k) && v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    sets.push(`${k}=?`); params.push(v);
  }
  if (body.authority !== undefined) {
    const a = body.authority === '' || body.authority == null ? null : Math.round(Number(body.authority));
    if (a != null && !(a >= 0 && a <= 100)) throw fail('Authority should be 0 to 100.');
    sets.push('authority=?'); params.push(a);
  }
  if (body.follow_up_on !== undefined) {
    const d = String(body.follow_up_on || '');
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw fail('Bad date');
    sets.push('follow_up_on=?'); params.push(d || null);
  }
  if (!sets.length) return { ok: true };
  sets.push(`updated_at=datetime('now')`);
  await env.DB.prepare(`UPDATE link_prospects SET ${sets.join(', ')} WHERE id=?`).bind(...params, id).run();
  if (body.contact_email) {
    await env.DB.prepare(`UPDATE messages SET to_email=? WHERE prospect_id=? AND status='draft' AND (to_email IS NULL OR to_email='')`).bind(body.contact_email.toLowerCase(), id).run();
    await env.DB.prepare(`UPDATE link_prospects SET status='ready' WHERE id=? AND status='found'`).bind(id).run();
  }
  if (body.status === 'do_not_contact') {
    if (p.contact_email) await env.DB.prepare(`INSERT OR IGNORE INTO suppression (email, domain, reason) VALUES (?, NULL, 'manual')`).bind(p.contact_email.toLowerCase()).run();
    await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE prospect_id=? AND status='draft'`).bind(id).run();
  }
  await refreshProspectOdds(env, id);
  return { ok: true };
}

async function insertProspect(env, x, source) {
  let url = String(x.url || '').trim();
  if (!url) return { skipped: 'no url' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const domain = domainOf(url);
  if (!domain) return { skipped: 'bad url' };
  if (SKIP_DOMAINS.test(domain)) return { skipped: 'retailer or social site' };
  const hosts = await ourHosts(env);
  if (hosts.has(domain)) return { skipped: 'our own site' };
  const ex = await first(env, `SELECT id FROM link_prospects WHERE domain=?`, domain);
  if (ex) return { duplicate: true, id: ex.id };
  const email = EMAIL_RE.test(String(x.contact_email || '')) ? String(x.contact_email).toLowerCase() : null;
  const tactic = TACTICS[x.tactic] ? x.tactic : 'other';
  const authority = Number(x.authority) >= 0 && Number(x.authority) <= 100 && String(x.authority ?? '') !== '' ? Math.round(Number(x.authority)) : null;
  const r = await env.DB.prepare(`INSERT INTO link_prospects (url, domain, name, page_title, tactic, why, target_url, authority, contact_name, contact_email, contact_url, status, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(url.slice(0, 1000), domain, String(x.name || '').slice(0, 200) || null,
    String(x.page_title || '').slice(0, 300) || null, tactic, String(x.why || '').slice(0, 1000) || null, String(x.target_url || '').slice(0, 500) || null,
    authority, String(x.contact_name || '').slice(0, 200) || null, email, /^https?:\/\//.test(String(x.contact_url || '')) ? x.contact_url.slice(0, 500) : null,
    email || x.contact_url ? 'ready' : 'found', source, String(x.notes || '').slice(0, 2000) || null).run();
  await refreshProspectOdds(env, r.meta.last_row_id);
  return { ok: true, id: r.meta.last_row_id };
}

export async function addProspect(env, body) {
  const r = await insertProspect(env, body, 'manual');
  if (r.skipped) throw fail(`Not added: ${r.skipped}.`);
  return r;
}

// A brand you already work with becomes a link prospect.
export async function prospectFromBrand(env, brandId) {
  const b = await first(env, `SELECT * FROM brands WHERE id=?`, brandId);
  if (!b) throw fail('Brand not found', 404);
  if (!b.website) throw fail('Add the brand\'s website first.');
  const pages = await ourPages(env);
  const r = await insertProspect(env, { url: b.website, name: b.name, tactic: 'partner', contact_name: b.contact_name, contact_email: b.contact_email,
    contact_url: b.contact_url, why: `${b.product_count} of their products are on the site.`, target_url: pages[0]?.url, notes: `From brand outreach (brand #${b.id}).` }, 'brand');
  if (r.skipped) throw fail(`Not added: ${r.skipped}.`);
  return r;
}

// ---------- import a list (Ahrefs, Semrush, Moz or any CSV with a URL column) ----------
const IMPORT_COLS = {
  url: /^(referring page url|source url|url|page url|referring page|link url|referring domain|domain|website)$/i,
  title: /^(referring page title|page title|title|source title)$/i,
  authority: /^(domain rating|dr|da|domain authority|authority score|as|ascore|page authority|ur)$/i,
  email: /^(email|contact email|e-mail)$/i,
  name: /^(name|site|site name|publication)$/i,
};
export async function importProspects(env, body) {
  const cols = (body.columns || []).map((c) => String(c).trim());
  const idx = Object.fromEntries(Object.entries(IMPORT_COLS).map(([k, re]) => [k, cols.findIndex((c) => re.test(c))]));
  if (idx.url < 0) throw fail('The file needs a URL column (e.g. "Referring page URL", "Source url", "URL" or "Domain").');
  const tactic = TACTICS[body.tactic] ? body.tactic : 'competitor';
  let added = 0, dupes = 0, skipped = 0;
  for (const r of (body.rows || []).slice(0, 500)) {
    const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
    const out = await insertProspect(env, { url: get('url'), page_title: get('title'), authority: get('authority'), contact_email: get('email'),
      name: get('name'), tactic }, 'import');
    if (out.ok) added++; else if (out.duplicate) dupes++; else skipped++;
  }
  return { ok: true, added, duplicates: dupes, skipped };
}

// ---------- find prospects with Claude + web search ----------
export async function findProspects(env, body) {
  const tactic = TACTICS[body.tactic]?.find ? body.tactic : 'resource';
  const t = TACTICS[tactic];
  const s = await cfg(env);
  const topic = String(body.topic || '').trim().slice(0, 200) || 'baby gear in general';
  const existing = (await all(env, `SELECT domain FROM link_prospects ORDER BY id DESC LIMIT 200`)).map((r) => r.domain);
  const pages = await ourPages(env);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 6 };
  const system = `You find link-building prospects for ${s.site_name}, an independent baby gear comparison site. ${s.about}
Use web search to find up to 10 real, currently live pages that fit this tactic:
${t.find}
Topic focus: ${topic}.${tactic === 'mention' ? `\nThe site's name is "${s.site_name}". Only include pages that mention it by name and do not already link to it.` : ''}
Skip: retailers and marketplaces, social media, forums, Wikipedia, sites in exclude_domains, and big publishers that never add outside links
(Wirecutter, BabyGearLab, Babylist, What to Expect, The Bump, Healthline) unless the tactic is journalists.
Prefer small and mid-size independent sites that are clearly active (posted or updated in the last two years).
For each, pick the single best page of ours for them to link to from our_pages (use its exact url).
Only give a contact email you actually saw published for that site. Never guess one.
Return ONLY JSON, no prose:
{"prospects": [{"url": "the exact page", "name": "site name", "page_title": "...", "why": "one plain sentence on why it fits",
"target_url": "one of our_pages", "contact_email": null, "contact_url": null, "contact_name": null}]}`;
  const messages = [{ role: 'user', content: JSON.stringify({ tactic: t.name, topic, our_pages: pages.slice(0, 40), exclude_domains: existing }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 4000, system, tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out || !Array.isArray(out.prospects)) throw fail('Claude came back without a usable list. Try again or change the topic.', 502);
  const added = [];
  let dupes = 0, skipped = 0;
  for (const x of out.prospects.slice(0, 12)) {
    const r = await insertProspect(env, { ...x, tactic }, 'claude');
    if (r.ok) added.push(r.id); else if (r.duplicate) dupes++; else skipped++;
  }
  return { ok: true, added: added.length, duplicates: dupes, skipped, ids: added };
}

// ---------- contact research for one prospect ----------
export async function researchProspect(env, id) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=?`, id);
  if (!p) throw fail('Prospect not found', 404);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 4 };
  const system = `You find the right contact at a website for a polite link or contribution request. Use web search on the site given.
Find: the site's name; the author of the page if named; a published email for the editor, owner, author, or general contact
(ONLY an address you actually saw published, never a guess or a pattern); the contact page; a "write for us" or contributor
guidelines page if one exists; whether they accept guest posts; and the site's Instagram if obvious. Be quick: 2 to 4 searches.
contact_role is 1 to 3 words.
Return ONLY JSON: {"name": null, "contact_name": null, "contact_role": null, "email": null, "email_source": null, "contact_url": null,
"write_for_us_url": null, "accepts_guest_posts": "yes|no|unknown", "notes": "one or two plain sentences on the best way in", "sources": []}`;
  const messages = [{ role: 'user', content: JSON.stringify({ site: p.domain, page: p.url, page_title: p.page_title }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 2000, system, tools: [tool], messages, ...noThink(model) });
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
  fill('name', out.name);
  fill('contact_email', email);
  if (email && !SHARED_INBOX.test(email)) fill('contact_name', out.contact_name);
  else if (!email) fill('contact_name', out.contact_name);
  fill('contact_url', out.write_for_us_url && p.tactic === 'guest' ? out.write_for_us_url : out.contact_url || out.write_for_us_url);
  if (p.status === 'found' && (email || p.contact_email || out.contact_url || out.write_for_us_url || p.contact_url)) sets.push(`status='ready'`);
  sets.push('research=?', `researched_at=datetime('now')`, `updated_at=datetime('now')`);
  params.push(JSON.stringify({ ...out, model }));
  await env.DB.prepare(`UPDATE link_prospects SET ${sets.join(', ')} WHERE id=?`).bind(...params, id).run();
  await refreshProspectOdds(env, id);
  return { ok: true, research: out, foundEmail: email };
}

// ---------- the pitch ----------
const PITCH_SYSTEM = (s, tactic) => `You write short, friendly emails for Jen Cannizzo, who runs ${s.site_name}, an independent baby gear comparison site.
Jen sends each one herself after reading it. Voice: warm, direct, plain spoken, a parent who knows her stuff. The reader gets lots of
pitches, so be brief, specific, and make it easy to say yes or no.

ABOUT THE SITE (the ONLY facts you may use about it): ${s.about}

WHAT THIS EMAIL DOES: ${TACTICS[tactic].pitch}

HOW IT IS BUILT
1. "Hi <first name>," if contact_first_name is given, otherwise "Hi there,".
2. One specific, genuine line about their page or site using the facts given (their page title or why it fits). Never invent facts.
3. The ask, in plain words, with our page's address written out once (target_url) so they can see it.
4. A no-pressure close, e.g. "No worries if it's not a fit."

RULES
- 70 to 150 words. 3 or 4 short paragraphs. Plain text, no bullet points, no emojis. The only link is target_url.
- Never offer money, gifts, free products, or a link back in exchange for a link. Never mention SEO, backlinks, dofollow, rankings,
  domain authority, or "link juice". Never criticize other sites.
- Be honest that the site is launching soon if the about text says so. Never invent traffic, readers, or credentials.
- Never use em dashes or en dashes. Use commas or periods.
- No signature, sign-off, name, address, or unsubscribe line. They are added automatically.
- Apply jens_note if given.
SUBJECT: Title Case, 3 to 8 words, plain and specific to them (e.g. "A Resource for Your Registry Page"). No puns, no "Re:".
Return ONLY JSON: {"subject": "...", "body": "..."}`;

async function pitchFacts(env, p) {
  const pages = await ourPages(env);
  const target = p.target_url || pages[0]?.url || null;
  return {
    their_site: p.name || p.domain, their_page: p.url, their_page_title: p.page_title || null, why_it_fits: p.why || null,
    contact_first_name: (p.contact_name || '').split(' ')[0] || null, target_url: target,
    target_page_is: pages.find((x) => x.url === target)?.label || null, notes_from_jen: p.notes ? String(p.notes).slice(0, 500) : null,
  };
}

function templatePitch(s, p, f) {
  const hi = f.contact_first_name ? `Hi ${f.contact_first_name},` : 'Hi there,';
  const lines = {
    resource: `I came across your page${f.their_page_title ? ` "${f.their_page_title}"` : ''} and love how much you share with new and expecting parents.`,
    guest: `I've been reading ${f.their_site} and would love to contribute a practical piece on comparing baby gear, if you take outside posts.`,
  };
  return {
    subject: titleCase(p.tactic === 'guest' ? `Article Idea for ${f.their_site}` : `A Free Resource for Your Readers`),
    body: [hi, '', lines[p.tactic] || lines.resource, '',
      `I'm Jen, and I'm building ${s.site_name}, a free site that lines baby gear up side by side using the makers' own spec sheets. ${f.target_url ? `This page might be useful for your readers: ${f.target_url}` : ''}`.trim(), '',
      p.tactic === 'guest' ? 'Would you be open to a pitch? Happy to send a couple of ideas.' : 'Would you consider adding it? No worries if it\'s not a fit.'].join('\n'),
  };
}

export async function draftPitch(env, id, body) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=?`, id);
  if (!p) throw fail('Prospect not found', 404);
  if (p.status === 'do_not_contact') throw fail('This site is marked do not contact.');
  const s = await cfg(env);
  const f = await pitchFacts(env, p);
  let out, model = 'template';
  if (await claudeKey(env)) {
    model = WRITE_MODEL(env);
    const data = await call(env, { model, max_tokens: 1000, ...noThink(model), system: PITCH_SYSTEM(s, TACTICS[p.tactic] ? p.tactic : 'other'),
      messages: [{ role: 'user', content: JSON.stringify({ ...f, jens_note: String(body.note || '').slice(0, 500) || null }) }] });
    out = jsonOut(textOf(data));
    if (!out?.subject || !out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  } else out = templatePitch(s, p, f);
  await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE prospect_id=? AND status='draft' AND kind='initial'`).bind(id).run();
  const r = await env.DB.prepare(`INSERT INTO messages (brand_id, prospect_id, kind, asks, to_email, subject, body, model) VALUES (0, ?, 'initial', '["link"]', ?, ?, ?, ?)`)
    .bind(id, p.contact_email || null, titleCase(nodash(out.subject)).slice(0, 200), nodash(out.body).slice(0, 5000), model).run();
  if (f.target_url && !p.target_url) await env.DB.prepare(`UPDATE link_prospects SET target_url=? WHERE id=?`).bind(f.target_url, id).run();
  return { ok: true, id: r.meta.last_row_id, model };
}

export async function rewritePitch(env, msg, body) {
  const feedback = String(body.feedback || '').trim().slice(0, 1000);
  if (!feedback) throw fail('Tell Claude what to change.');
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=?`, msg.prospect_id);
  const s = await cfg(env);
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 1000, ...noThink(model),
    system: PITCH_SYSTEM(s, TACTICS[p.tactic] ? p.tactic : 'other') + `\n\nYOU ARE NOW EDITING an existing draft. Apply Jen's feedback exactly and keep the rules above. Return the same JSON shape.`,
    messages: [{ role: 'user', content: JSON.stringify({ ...(await pitchFacts(env, p)), current_subject: body.subject ?? msg.subject, current_body: body.body ?? msg.body, jens_feedback: feedback }) }] });
  const out = jsonOut(textOf(data));
  if (!out?.subject || !out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  const subject = titleCase(nodash(out.subject)).slice(0, 200), text = nodash(out.body).slice(0, 5000);
  await env.DB.prepare(`UPDATE messages SET subject=?, body=?, model=? WHERE id=?`).bind(subject, text, model + '+feedback', msg.id).run();
  return { ok: true, subject, body: text };
}

export async function answerPitchReply(env, rep, body) {
  const p = await first(env, `SELECT * FROM link_prospects WHERE id=?`, rep.prospect_id);
  const last = await first(env, `SELECT subject, body FROM messages WHERE prospect_id=? AND status IN ('sent','sent_manual') ORDER BY id DESC LIMIT 1`, p.id);
  const s = await cfg(env);
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 1000, ...noThink(model),
    system: `You write Jen Cannizzo's answer to a website owner or writer who replied to her ${s.site_name} email. Write AS Jen, in first person ("I"),
never about her in third person. Voice: warm, brief, plain, no em or en dashes.
ABOUT THE SITE (only facts you may use): ${s.about}
Answer exactly what they asked. If they added the link, thank them warmly. If they asked for payment, a paid placement, or a link swap, politely
decline in one friendly sentence ("I don't pay for or trade links") and thank them anyway. If they asked for guest post ideas, give two or three short, specific ones.
Never invent facts. 30 to 120 words. No sign-off and no name at the end: the signature is added automatically.
Return ONLY JSON: {"body": "..."}`,
    messages: [{ role: 'user', content: JSON.stringify({ their_site: p.name || p.domain, our_page: p.target_url, jens_last_email: last ? `${last.subject}\n\n${last.body}` : null,
      their_reply: rep.body || rep.snippet, jens_note: String(body.note || '').slice(0, 500) || null }) }] });
  const out = jsonOut(textOf(data));
  if (!out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  const subject = rep.subject ? (/^re:/i.test(rep.subject) ? rep.subject : `Re: ${rep.subject}`) : `Re: ${p.name || p.domain}`;
  const r = await env.DB.prepare(`INSERT INTO messages (brand_id, prospect_id, kind, asks, to_email, subject, body, model) VALUES (0, ?, 'reply', '[]', ?, ?, ?, ?)`)
    .bind(p.id, rep.from_email || p.contact_email, subject.slice(0, 200), nodash(out.body).slice(0, 5000), model).run();
  await env.DB.prepare(`UPDATE replies SET handled=1 WHERE id=?`).bind(rep.id).run();
  return { ok: true, id: r.meta.last_row_id };
}

// After a pitch goes out (Gmail or by hand).
export function markPitched(env, msg) {
  return [env.DB.prepare(`UPDATE link_prospects SET status = CASE WHEN status IN ('found','ready','skipped') THEN 'pitched' ELSE status END,
    last_contacted_at=datetime('now'), updated_at=datetime('now'), follow_up_on = COALESCE(follow_up_on, date('now','+7 days')),
    odds = CASE WHEN odds IS NULL THEN NULL ELSE MAX(3, odds - 5) END WHERE id=?`).bind(msg.prospect_id)];
}

// What a reply does to a prospect.
export async function applyProspectReply(env, prospectId, kind, fromEmail) {
  const stmts = [];
  if (kind !== 'auto') stmts.push(env.DB.prepare(`UPDATE messages SET status='skipped' WHERE prospect_id=? AND status='draft' AND kind='followup'`).bind(prospectId));
  if (kind === 'reply') {
    stmts.push(env.DB.prepare(`UPDATE link_prospects SET status='replied', follow_up_on=NULL, updated_at=datetime('now') WHERE id=? AND status IN ('found','ready','pitched','skipped')`).bind(prospectId));
  } else if (kind === 'optout') {
    stmts.push(env.DB.prepare(`UPDATE link_prospects SET status='do_not_contact', follow_up_on=NULL, updated_at=datetime('now') WHERE id=?`).bind(prospectId));
    if (fromEmail) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO suppression (email, domain, reason) VALUES (?, ?, 'optout')`).bind(fromEmail, fromEmail.split('@')[1]));
    stmts.push(env.DB.prepare(`UPDATE messages SET status='skipped' WHERE prospect_id=? AND status='draft'`).bind(prospectId));
  } else if (kind === 'bounce') {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO suppression (email, domain, reason) SELECT lower(contact_email), NULL, 'bounce' FROM link_prospects WHERE id=? AND contact_email IS NOT NULL`).bind(prospectId));
    stmts.push(env.DB.prepare(`UPDATE link_prospects SET notes = COALESCE(notes || char(10), '') || 'Email bounced: ' || COALESCE(contact_email,'') || '. Find a new contact.',
      contact_email=NULL, status = CASE WHEN status='pitched' THEN 'found' ELSE status END WHERE id=?`).bind(prospectId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await refreshProspectOdds(env, prospectId);
}

export async function logProspectReply(env, id, body) {
  const text = String(body.text || '').trim();
  if (!text) throw fail('Paste what they said.');
  const { recordReply, classify } = await import('./gmail.js');
  const from = String(body.from_email || '').trim().toLowerCase() || null;
  const kind = ['reply', 'optout', 'bounce', 'auto'].includes(body.kind) ? body.kind : classify({ from, subject: '', snippet: text });
  await recordReply(env, { source: 'manual', extId: `manual-${crypto.randomUUID()}`, prospectId: id, fromEmail: from, snippet: text.replace(/\s+/g, ' ').slice(0, 300), body: text, kind });
  return { ok: true };
}

// Hourly: one polite follow-up 7 days after a pitch with no answer.
export async function queuePitchFollowups(env) {
  const due = await all(env, `SELECT p.id, p.contact_name, p.contact_email, m.subject, m.to_email FROM link_prospects p
      JOIN messages m ON m.prospect_id=p.id AND m.kind='initial' AND m.status IN ('sent','sent_manual')
     WHERE p.status='pitched' AND m.sent_at <= datetime('now','-7 days')
       AND NOT EXISTS (SELECT 1 FROM messages f WHERE f.prospect_id=p.id AND f.kind='followup')
       AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.prospect_id=p.id AND r.kind IN ('reply','optout')) LIMIT 20`);
  for (const p of due) {
    if (!(p.to_email || p.contact_email)) continue;
    const hi = p.contact_name ? `Hi ${p.contact_name.split(' ')[0]},` : 'Hi there,';
    await env.DB.prepare(`INSERT INTO messages (brand_id, prospect_id, kind, asks, to_email, subject, body, model) VALUES (0, ?, 'followup', '["link"]', ?, ?, ?, 'template')`)
      .bind(p.id, p.to_email || p.contact_email, /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`,
        `${hi}\n\nJust floating this back up in case it got buried. Totally fine if it's not a fit.\n\nThank you!`).run();
  }
  return { queued: due.length };
}

// ---------- won links + live checking ----------
export async function addLink(env, body) {
  let src = String(body.source_url || '').trim();
  if (!/^https?:\/\//i.test(src)) src = 'https://' + src;
  if (!domainOf(src)) throw fail('That page address doesn\'t look right.');
  const pid = body.prospect_id ? Number(body.prospect_id) : null;
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO links (prospect_id, brand_id, source_url, notes) VALUES (?, ?, ?, ?)`)
    .bind(pid, body.brand_id ? Number(body.brand_id) : null, src.slice(0, 1000), String(body.notes || '').slice(0, 1000) || null).run();
  if (pid) await env.DB.prepare(`UPDATE link_prospects SET status='won', follow_up_on=NULL, odds=NULL, updated_at=datetime('now') WHERE id=?`).bind(pid).run();
  const link = await first(env, `SELECT * FROM links WHERE source_url=?`, src.slice(0, 1000));
  const checked = await checkLink(env, link);
  return { ok: true, id: link.id, duplicate: !ins.meta.changes, ...checked };
}

export async function deleteLink(env, id) {
  await env.DB.prepare(`DELETE FROM links WHERE id=?`).bind(id).run();
  return { ok: true };
}

export async function listLinks(env) {
  return all(env, `SELECT l.*, p.name prospect_name, p.domain prospect_domain FROM links l LEFT JOIN link_prospects p ON p.id=l.prospect_id
    ORDER BY CASE l.status WHEN 'missing' THEN 0 WHEN 'error' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, l.id DESC`);
}

export async function checkLink(env, link) {
  const hosts = await ourHosts(env);
  let status, target = null, anchor = null, rel = null, err = null;
  try {
    const res = await fetch(link.source_url, {
      redirect: 'follow', signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinkCheck/1.0; checks that a link is still on the page)', accept: 'text/html,*/*' },
    });
    if (res.status === 404 || res.status === 410) { status = 'missing'; err = `Page is gone (${res.status})`; }
    else if (!res.ok) { status = 'error'; err = `The page answered ${res.status}`; }
    else {
      const html = (await res.text()).slice(0, 3_000_000);
      const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html))) {
        const attrs = m[1];
        const href = (attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || [])
          .slice(2).find((x) => x != null);
        if (!href) continue;
        let h; try { h = domainOf(new URL(href, link.source_url).href); } catch { continue; }
        if (!h || ![...hosts].some((o) => h === o || h.endsWith('.' + o))) continue;
        target = new URL(href, link.source_url).href;
        anchor = m[2].replace(/<img[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, '[image: $1]').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || '[image]';
        const r = (attrs.match(/\brel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
        const parts = r.toLowerCase().split(/\s+/).filter((x) => ['nofollow', 'sponsored', 'ugc'].includes(x));
        rel = parts.length ? parts.join(' ') : 'follow';
        break;
      }
      status = target ? 'live' : 'missing';
      if (!target) err = hosts.size ? `No link to ${[...hosts].join(' or ')} in the page's HTML (pages built with JavaScript can hide links from this check)` : 'Set the site address in Settings';
    }
  } catch (e) {
    status = 'error'; err = e.name === 'TimeoutError' ? 'The page took too long to load' : `Couldn't load the page: ${e.message}`;
  }
  const wasLive = link.status === 'live';
  await env.DB.prepare(`UPDATE links SET status=?, target_url=COALESCE(?, target_url), anchor=COALESCE(?, anchor), rel=COALESCE(?, rel), last_error=?,
      last_checked_at=datetime('now'), first_seen_at = CASE WHEN ?='live' THEN COALESCE(first_seen_at, datetime('now')) ELSE first_seen_at END,
      lost_at = CASE WHEN ?='missing' AND ? THEN datetime('now') WHEN ?='live' THEN NULL ELSE lost_at END WHERE id=?`)
    .bind(status, target, anchor, rel, err, status, status, wasLive ? 1 : 0, status, link.id).run();
  return { status, target, anchor, rel, error: err };
}

export async function checkLinkById(env, id) {
  const link = await first(env, `SELECT * FROM links WHERE id=?`, id);
  if (!link) throw fail('Link not found', 404);
  return { ok: true, ...(await checkLink(env, link)) };
}

// Hourly job: re-check links not checked in the last day (a few per run).
export async function checkDueLinks(env, limit = 15) {
  const due = await all(env, `SELECT * FROM links WHERE last_checked_at IS NULL OR last_checked_at <= datetime('now','-1 day') ORDER BY last_checked_at LIMIT ?`, limit);
  for (const l of due) await checkLink(env, l).catch(() => {});
  return { checked: due.length };
}

// ---------- overview ----------
export async function linkSummary(env) {
  const [byStatus, byTactic, links, warn, lost] = await Promise.all([
    all(env, `SELECT status k, COUNT(*) n FROM link_prospects GROUP BY status`),
    all(env, `SELECT tactic k, COUNT(*) n FROM link_prospects GROUP BY tactic`),
    all(env, `SELECT status, rel, COUNT(*) n FROM links GROUP BY status, rel`),
    prelaunchWarning(env),
    first(env, `SELECT COUNT(*) n FROM links WHERE status!='live' AND lost_at IS NOT NULL`),
  ]);
  return {
    prospects: Object.fromEntries(byStatus.map((r) => [r.k, r.n])), tactics: Object.fromEntries(byTactic.map((r) => [r.k, r.n])),
    links, lost: lost?.n || 0, warning: warn, tacticInfo: Object.fromEntries(Object.entries(TACTICS).map(([k, v]) => [k, { name: v.name, findable: Boolean(v.find) }])),
    pages: await ourPages(env), hosts: [...(await ourHosts(env))],
  };
}

export async function exportProspects(env) {
  return all(env, `SELECT name, domain, url, page_title, tactic, status, odds, authority, contact_name, contact_email, contact_url, target_url, why, notes,
    last_contacted_at, follow_up_on FROM link_prospects ORDER BY odds DESC`);
}
export async function exportLinks(env) {
  return all(env, `SELECT source_url, target_url, anchor, rel, status, first_seen_at, last_checked_at, lost_at, last_error, notes FROM links ORDER BY id`);
}

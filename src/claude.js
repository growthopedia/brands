// Claude in the app: research a brand on the web, write the email, rewrite it from feedback, answer a reply.
import { fail, first, all, cfg, setMeta, parseJ, nodash, EMAIL_RE, logActivity, refreshOdds } from './util.js';
import { verifyEmail } from './verify.js';
import { FORM_ATTEMPT, triedEmails, attemptLog, nextAttempt } from './attempts.js';

const API = 'https://api.anthropic.com/v1/messages';
export const WRITE_MODEL = (env) => env.WRITE_MODEL || 'claude-sonnet-5-5';
export const RESEARCH_MODEL = (env) => env.RESEARCH_MODEL || 'claude-sonnet-5-5';
// Sonnet/Opus think before answering by default, which can use up a short reply.
export const noThink = (model) => (/sonnet|opus/.test(model) ? { thinking: { type: 'between_tools' } } : {});

export async function claudeKey(env) {
  const fromEnv = (env.ANTHROPIC_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return ((await first(env, `SELECT value FROM meta WHERE key='anthropic_api_key'`))?.value || '').trim();
}

export async function saveClaudeKey(env, body) {
  const key = String(body.key || '').trim();
  if (!key) { await env.DB.prepare(`DELETE FROM meta WHERE key='anthropic_api_key'`).run(); return { ok: true, removed: true }; }
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw fail('That doesn\'t look like a Claude key (they start with sk-ant-).');
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
  });
  if (r.status === 401 || r.status === 403) throw fail('Anthropic rejected that key. Check you copied the whole thing.');
  await setMeta(env, 'anthropic_api_key', key);
  return { ok: true };
}

export async function call(env, payload) {
  const key = await claudeKey(env);
  if (!key) throw fail('Add your Claude key in Settings first.', 503);
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw fail('Claude rejected the API key. Update it in Settings.', 502);
  if (!r.ok) throw fail(`Claude error: ${data.error?.message || r.status}`, 502);
  return data;
}
export const textOf = (data) => (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
export function jsonOut(text) {
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : ''); } catch { return null; }
}

// ---------- facts about a brand that Claude may use ----------
// The brand's page on the live site: the first of their product pages that actually loads (some categories were cut at launch).
async function brandPage(env, brandId) {
  const s = await cfg(env);
  let origin; try { origin = new URL(s.site_url).origin; } catch { return null; }
  const rows = await all(env, `SELECT site_url FROM products WHERE brand_id=? AND site_url IS NOT NULL ORDER BY price IS NULL, price DESC LIMIT 4`, brandId);
  for (const r of rows) {
    let url; try { const u = new URL(r.site_url); url = origin + u.pathname; } catch { continue; }
    try { const res = await fetch(url, { method: 'HEAD', redirect: 'follow' }); if (res.ok) return url; } catch {}
  }
  return null;
}

// link: include the brand's page URL. First emails skip it while the domain is new (Settings → Link in first emails);
// replies and follow-ups always include it.
async function brandFacts(env, brand, { link = false } = {}) {
  const products = await all(env, `SELECT name, type, section, price FROM products WHERE brand_id=? ORDER BY price IS NULL, price DESC LIMIT 10`, brand.id);
  return {
    their_page_on_our_site: link ? await brandPage(env, brand.id) : null,
    brand: brand.name,
    website: brand.domain || null,
    is_store_brand: brand.kind === 'store_brand',
    products_on_our_site: brand.product_count,
    sections: parseJ(brand.sections, []),
    example_products: products.map((p) => p.name),
    contact_first_name: (brand.contact_name || '').split(' ')[0] || null,
    contact_role: brand.contact_role || null,
    has_past_recall_on_site: Boolean(brand.has_recall),
    notes_from_jen: brand.notes ? String(brand.notes).slice(0, 600) : null,
  };
}

// ---------- research ----------
const RESEARCH_SYSTEM = `You research baby gear brands for Jen, who is building a baby gear comparison website.
Use web search to find, for the brand given:
1. A real, published email for press/PR, marketing, partnerships, influencer or affiliate requests. Prefer, in order:
   partnerships/affiliate > PR/press/media > marketing > general info/hello. ONLY return an email you actually saw published
   (on the brand's site, a press page, or the parent company's media page). Never guess or build an address from a pattern.
2. The brand's contact form or press/media page URL, if there is one.
3. Whether the brand has an affiliate program, which network runs it (Impact, Awin, CJ, AvantLink, Rakuten, Partnerize,
   ShareASale (now part of Awin), Amazon only, or in-house), the page to apply, and the commission and cookie length only
   if published.
4. The brand's main Instagram handle.
5. The parent company, if any (e.g. Newell Brands, Dorel, Artsana). Big parent companies often handle press centrally.
contact_name: only a person's name published together with that exact email, and current. A shared inbox (press@, info@) gets null.
contact_role: 1 to 3 words (e.g. "PR", "Partnerships", "Affiliate team").
ACCURACY RULES (very important):
- email_source must be the exact URL of the page where you saw the email written out. The app will open that page and check the address
  is really on it, so never cite a page that doesn't show it.
- Prefer addresses on the brand's own current website domain. Treat addresses that only appear in press releases or articles more than
  two years old, or on an old/other domain, as stale: report them in notes, not as email.
- Never guess or build an address from a pattern (like press@ + domain). If you didn't see it written, email is null.
- email_seen_on: the date shown on or for that page if any (YYYY-MM-DD), else null.
Be quick: 2 to 5 searches. If something isn't findable, use null. Do not invent anything.
Return ONLY JSON, no prose:
{"email": null, "email_type": "partnerships|affiliate|press|marketing|general|null", "contact_name": null, "contact_role": null,
 "email_source": null, "email_seen_on": null, "contact_url": null, "affiliate": "yes|no|unknown", "affiliate_network": null, "affiliate_url": null,
 "commission": null, "cookie_days": null, "instagram": null, "parent_company": null, "press_kit_url": null,
 "notes": "one or two plain sentences on the best way in", "sources": ["url", "..."]}`;

const NETWORKS = ['impact', 'awin', 'cj', 'avantlink', 'rakuten', 'partnerize', 'amazon', 'in_house', 'other'];
function normNetwork(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/impact/.test(t)) return 'impact';
  if (/awin|shareasale/.test(t)) return 'awin';
  if (/\bcj\b|commission junction/.test(t)) return 'cj';
  if (/avant/.test(t)) return 'avantlink';
  if (/rakuten|linkshare/.test(t)) return 'rakuten';
  if (/partnerize/.test(t)) return 'partnerize';
  if (/amazon/.test(t)) return 'amazon';
  if (/in.?house|direct|own/.test(t)) return 'in_house';
  return 'other';
}

const RETRY_RULES = `
THIS IS A RETRY. already_tried_no_reply lists addresses Jen already emailed (with a follow-up) and never heard back from, or that bounced.
Find a DIFFERENT published way in: another team's address (partnerships, marketing, PR agency of record, influencer/creator program),
a named person in brand marketing or PR whose own address is published, or the parent company's media contact.
Never return an address from already_tried_no_reply. If nothing new is published, email is null and say so in notes.`;

const FORM_SYSTEM = `You help Jen, who runs a baby gear comparison website, reach a brand that hasn't answered three emails.
Find the best web FORM on the brand's own site (or its parent company's) to send a partnership/PR message through. Prefer, in order:
a creator/influencer/affiliate/partnership application or inquiry form > a press/media inquiry form > the general contact form.
Skip customer-support-only forms (order issues, returns, warranty claims) unless nothing else exists, and say so.
Only return a URL you actually opened that has a form on it (or a page that clearly links to one). List the fields the form asks for.
Be quick: 2 to 5 searches.
Return ONLY JSON: {"form_url": null, "form_kind": "partnership|creator|affiliate|press|contact|support", "form_title": null,
 "fields": ["Name", "Email", "Message"], "has_subject_field": false, "message_limit": null, "notes": "one sentence", "sources": ["url"]}`;

export async function researchBrand(env, id) {
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!brand) throw fail('Brand not found', 404);
  if ((brand.attempt || 1) >= FORM_ATTEMPT) return researchForm(env, brand);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  const tried = triedEmails(brand);
  const messages = [{ role: 'user', content: JSON.stringify({ brand: brand.name, website: brand.website || brand.domain, example_products: (await brandFacts(env, brand)).example_products.slice(0, 4),
    ...(tried.length ? { already_tried_no_reply: tried } : {}) }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 2500, system: RESEARCH_SYSTEM + (tried.length ? RETRY_RULES : ''), tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out) throw fail('Claude came back without usable results. Try again.', 502);
  const cited = [];
  for (const b of data.content || []) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const s of b.content) if (s.url) cited.push(s.url);
  out.sources = [...new Set([...(out.sources || []), ...cited])].slice(0, 12);
  const searches = data.usage?.server_tool_use?.web_search_requests || 0;

  // Check the address before saving it: on the cited page, domain takes mail, matches the brand.
  let email = EMAIL_RE.test(out.email || '') ? out.email.toLowerCase() : null;
  let check = null;
  if (email) {
    check = await verifyEmail({ email, sourceUrl: out.email_source, siteDomain: brand.domain || brand.website, name: brand.name, seenOn: out.email_seen_on });
    out.email_check = check;
    const sup = await first(env, `SELECT reason FROM suppression WHERE email=?`, email);
    if (check.status === 'bad' || sup) { out.rejected_email = email; out.rejected_why = sup ? `on the do-not-contact list (${sup.reason})` : check.note; email = null; }
  }
  if (email && tried.includes(email)) { out.rejected_email = email; out.rejected_why = 'already tried with no reply'; email = null; }
  const net = normNetwork(out.affiliate_network);
  const sets = [], p = [];
  const fill = (col, val) => { if (val && !brand[col]) { sets.push(`${col}=?`); p.push(String(val).slice(0, 500)); } };
  fill('contact_email', email);
  if (email && !brand.contact_email) { sets.push('email_check=?'); p.push(JSON.stringify(check)); }
  if (email) {
    const shared = /^(press|pr|media|info|hello|hi|contact|support|marketing|partners?(hips)?|affiliates?|collab|team|sales|customerservice|care)@/.test(email);
    if (!shared) fill('contact_name', out.contact_name);
    const role = String(out.contact_role || '').length <= 30 ? out.contact_role : out.email_type;
    fill('contact_role', role || out.email_type);
  }
  fill('contact_url', out.contact_url);
  fill('instagram', out.instagram ? String(out.instagram).replace(/^https?:\/\/(www\.)?instagram\.com\//, '@').replace(/\/$/, '') : null);
  fill('affiliate_network', net);
  fill('affiliate_url', out.affiliate_url);
  fill('commission', out.commission);
  fill('cookie_days', out.cookie_days);
  if (brand.affiliate_status === 'none') {
    if (out.affiliate === 'yes') { sets.push(`affiliate_status='found'`); }
    else if (out.affiliate === 'no') { sets.push(`affiliate_status='no_program'`); }
  }
  if (brand.status === 'research' && (email || brand.contact_email || out.contact_url || brand.contact_url)) sets.push(`status='ready'`);
  sets.push(`research=?`, `researched_at=datetime('now')`, `updated_at=datetime('now')`);
  p.push(JSON.stringify({ ...out, model, searches }));
  await env.DB.prepare(`UPDATE brands SET ${sets.join(', ')} WHERE id=?`).bind(...p, id).run();
  if (email && !(await first(env, `SELECT 1 FROM contacts WHERE brand_id=? AND lower(email)=?`, id, email)))
    await env.DB.prepare(`INSERT INTO contacts (brand_id, name, email, role, note) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, out.contact_name || null, email, (String(out.contact_role || '').length <= 30 ? out.contact_role : null) || out.email_type || null, out.email_source ? `Found at ${out.email_source}` : 'Found by Claude').run();
  await refreshOdds(env, id);
  await logActivity(env, id, 'research', `Claude researched${tried.length ? ` for attempt ${brand.attempt}` : ''} (${searches} searches)${email ? `, found ${email}` : ', no new email published'}`);
  return { ok: true, research: out, foundEmail: email, check };
}

// Attempt 4: find their form instead of an email.
async function researchForm(env, brand) {
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  const messages = [{ role: 'user', content: JSON.stringify({ brand: brand.name, website: brand.website || brand.domain, emails_already_tried: triedEmails(brand) }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 1500, system: FORM_SYSTEM, tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out) throw fail('Claude came back without usable results. Try again.', 502);
  const url = /^https?:\/\//.test(String(out.form_url || '')) ? String(out.form_url).slice(0, 500) : null;
  const prev = parseJ(brand.research, {}) || {};
  await env.DB.prepare(`UPDATE brands SET contact_url=COALESCE(?, contact_url), status=?, research=?, researched_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .bind(url, url ? 'ready' : brand.status, JSON.stringify({ ...prev, form: out }), brand.id).run();
  await logActivity(env, brand.id, 'research', url ? `Attempt 4: found their ${out.form_kind || 'contact'} form` : 'Attempt 4: no form found');
  if (!url) await nextAttempt(env, brand.id, 'no form found');
  await refreshOdds(env, brand.id);
  return { ok: true, research: out, form: url };
}

// ---------- the email ----------
export const ASKS = {
  images: 'Permission to use their official product images (from their site or press kit) on our comparison pages, with credit and a link back. Ask if they have a media kit, image library, or product feed.',
  affiliate: 'Whether they run an affiliate program and the best way to join, or who to talk to about one.',
  samples: 'Whether they would send a sample for hands-on testing and a short video. The review stays independent.',
  collab: 'Interest in being featured in short TikTok and social videos showing their products and our comparison tools.',
  feed: 'Spec sheets or a product data feed so our specs stay accurate, and an invite for their team to flag anything we got wrong.',
  products: 'Which of their other products they would like added to the site, so their full line is covered (we can add new and upcoming products too).',
};

const RETRY_EMAIL_RULES = `

THIS IS A RETRY (attempt.number). attempt.earlier_attempts lists addresses Jen already emailed with no reply.
- Open with one plain line saying she reached out to [that team, e.g. "your press inbox"] in [month] and is trying to reach the right person.
  Never sound annoyed or guilt-trip. Don't say "following up" (this person never got the first email).
- Then a shorter version of the pitch: 80 to 130 words total. Same asks.
- Subject: fresh and specific, not "Re:" and not "Following up".`;

const FORM_RULES = (s, form) => `

THIS GOES INTO A WEBSITE FORM (${form?.form_kind || 'contact'} form${form?.fields?.length ? `; fields: ${form.fields.join(', ')}` : ''}), not an email.
Jen already emailed three addresses with no reply. Forms strip signatures, so end the message with: Jen, ${s.site_name}, ${s.site_url}${s.sender_email ? `, ${s.sender_email}` : ''}.
- Start with "Hi," or "Hi <brand name> team,". One line on who Jen is, one line that she's tried email and wanted to try here.
- 70 to 120 words${form?.message_limit ? `, and under ${form.message_limit} characters` : ''}. Plain text.
- subject: a short subject for the form's subject or topic field.`;

const WRITE_SYSTEM = (s) => `You write short partnership emails for Jen Cannizzo, who runs ${s.site_name}, an independent baby gear comparison site.
Jen sends each one herself after reading it. It must sound like her: warm, direct, plain spoken, a parent who knows her stuff.
The reader is a brand marketing, PR, or partnerships person who gets a lot of pitches. Make it easy to say yes.

ABOUT THE SITE (the ONLY facts you may use about it): ${s.about}

HOW THE EMAIL IS BUILT
1. "Hi <first name>," if contact_first_name is given, otherwise "Hi there,".
2. One line on who Jen is and what the site is. Introduce her as just "Jen" ("I'm Jen, a parent and..."), never her last name.
3. One specific line about this brand using the facts given: how many of their products the site already covers and one or two by
   name, or the categories they're in. Never invent facts.
4. The asks, in the order given, in plain words. One ask gets a short paragraph. Several asks get one sentence each, written as
   normal sentences ("I'd also love to know..."), never as a list.
5. An easy close that offers a choice: "Is this something you handle, or is there someone better to ask?"

RULES
- 110 to 180 words. 3 to 5 short paragraphs. Plain text, no bullet points, no emojis.
- The site is live. If their_page_on_our_site is given, include that one link in step 3 so they can see their product ("You can see it here: <url>").
  If it is null, include no links at all: say where their product is in words ("already in our Cribs section"). No other links. Never invent traffic, followers, audience size, or partners; the about text says what's true.
- Never offer better placement, scores or rankings in exchange for anything. Comparisons stay independent. Do not promise coverage.
- If is_store_brand is true, the brand belongs to a retailer: write to the retailer's partnerships or affiliate team.
- Never mention recalls.
- Never use em dashes or en dashes. Use commas or periods.
- Banned words: leverage, synergy, solutions, elevate, boost, amazing opportunity, circle back, touch base, reach out.
- No signature, sign-off name, address, or unsubscribe line. They are added automatically.
- Apply notes_from_jen and jens_note if given.
- If rereach is given, this brand already knows Jen. Skip the introduction: open by thanking them for what they already said yes to
  (rereach.already_approved), share rereach.site_traffic only if it is given and word for word, then ask for the open items. If an item is in
  rereach.said_no_before, acknowledge it lightly ("I know the timing wasn't right before"). 80 to 140 words. Subject mentions the brand and
  ${s.site_name}, no "Re:".

SUBJECT LINE: Title Case, 4 to 8 words, includes the brand name, plain and clear. Examples:
"Using ${'<Brand>'} Images on ${s.site_name}", "${'<Brand>'} and ${s.site_name} Partnership Question", "Featuring ${'<Brand>'} on ${s.site_name}".
No puns, no clickbait, no "Re:".

Return ONLY JSON: {"subject": "...", "body": "..."}`;

const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'at', 'by', 'in', 'of', 'on', 'to', 'as', 'with', 'vs']);
export function titleCase(str) {
  const words = String(str || '').trim().split(/(\s+)/);
  const idx = words.map((w, i) => (w.trim() ? i : -1)).filter((i) => i >= 0);
  return words.map((w, i) => {
    if (!w.trim() || /[A-Z]/.test(w.slice(1))) return w;
    if (SMALL.has(w.toLowerCase()) && i !== idx[0] && i !== idx[idx.length - 1]) return w.toLowerCase();
    return w.replace(/^([^A-Za-z]*)([a-z])/, (m, a, c) => a + c.toUpperCase());
  }).join('');
}

export function templateEmail(s, brand, facts, asks) {
  const hi = facts.contact_first_name ? `Hi ${facts.contact_first_name},` : 'Hi there,';
  const ex = facts.example_products.slice(0, 2).join(' and ');
  const lines = {
    images: `Could we use your official product images on our comparison pages? We'd credit ${brand.name} and link back to your site. If you have a media kit or image library, that would be perfect.`,
    affiliate: `I'd also love to know if you run an affiliate program, and the best way to join.`,
    samples: `If you're open to it, I'd love a sample to test hands-on for a short video. The comparison itself stays independent.`,
    collab: `We're also making short TikTok videos showing products side by side, and I'd love to feature yours.`,
    feed: `If you have spec sheets or a product feed, I'd use them to keep every number accurate, and your team is welcome to flag anything we got wrong.`,
    products: `Are there other ${brand.name} products you'd like added? I'm happy to cover your full line, including anything new or coming soon.`,
  };
  const body = [
    hi, '',
    `I'm Jen, and I run ${s.site_name}, an independent baby gear comparison site that lines products up side by side using the makers' own spec sheets.`, '',
    `We already cover ${facts.products_on_our_site} ${brand.name} product${facts.products_on_our_site === 1 ? '' : 's'}${ex ? `, including the ${ex}` : ''}.${facts.their_page_on_our_site ? ` You can see it here: ${facts.their_page_on_our_site}` : ''}`, '',
    asks.map((a) => lines[a]).filter(Boolean).join(' '), '',
    `Is this something you handle, or is there someone better to ask?`,
  ].join('\n');
  return { subject: titleCase(asks[0] === 'images' ? `Using ${brand.name} Images on ${s.site_name}` : `${brand.name} and ${s.site_name} Partnership Question`), body };
}

export async function draftEmail(env, id, body) {
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!brand) throw fail('Brand not found', 404);
  if (brand.status === 'do_not_contact') throw fail('This brand is marked do not contact.');
  const asks = (Array.isArray(body.asks) ? body.asks : ['images', 'products']).filter((a) => ASKS[a]);
  if (!asks.length) throw fail('Pick at least one thing to ask for.');
  const s = await cfg(env);
  const n = brand.attempt || 1, isForm = n >= FORM_ATTEMPT && !body.rereach;
  const facts = await brandFacts(env, brand, { link: s.link_first === '1' || !!body.rereach || n > 1 });
  // Retry context: which addresses already went unanswered, so the email can say so briefly.
  const tries = n > 1 && !body.rereach ? attemptLog(brand).map((a) => ({ to: a.to, month: a.first_sent ? new Date(a.first_sent).toLocaleString('en-US', { month: 'long' }) : null, result: a.result })) : null;
  const form = isForm ? (parseJ(brand.research, {})?.form || {}) : null;
  if (isForm && !brand.contact_url) throw fail('Find their form first: press Research.');
  let out, model = 'template';
  if (await claudeKey(env)) {
    model = WRITE_MODEL(env);
    const NAMES = { image_status: 'using their product images', affiliate_status: 'affiliate access', sample_status: 'product samples',
      collab_status: 'social features', feed_status: 'spec sheets / data' };
    const yes = { image_status: ['approved'], affiliate_status: ['approved'], sample_status: ['approved', 'received'], collab_status: ['approved'], feed_status: ['approved'] };
    const rereach = body.rereach ? {
      already_approved: Object.keys(yes).filter((c) => yes[c].includes(brand[c])).map((c) => NAMES[c]),
      said_no_before: Object.keys(yes).filter((c) => brand[c] === 'declined').map((c) => NAMES[c]),
      site_traffic: s.traffic || null,
    } : null;
    const data = await call(env, { model, max_tokens: 1200, ...noThink(model), system: WRITE_SYSTEM(s) + (isForm ? FORM_RULES(s, form) : tries ? RETRY_EMAIL_RULES : ''),
      messages: [{ role: 'user', content: JSON.stringify({ ...facts, asks: asks.map((a) => ASKS[a]), rereach, attempt: tries ? { number: n, earlier_attempts: tries } : null,
        jens_note: String(body.note || '').slice(0, 500) || null }) }] });
    out = jsonOut(textOf(data));
    if (!out?.subject || !out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  } else {
    out = templateEmail(s, brand, facts, asks);
    if (tries) out.body = out.body.replace(/^(Hi[^\n]*\n\n)/, `$1I reached out to ${tries.map((t) => t.to).filter(Boolean).join(' and ')} earlier and didn't hear back, so I'm trying here in case you're the right person.\n\n`);
    if (isForm) out.body = `${out.body}\n\nJen\n${s.site_name} · ${s.site_url}${s.sender_email ? ' · ' + s.sender_email : ''}`;
  }
  // One open draft per brand: replace the old draft instead of stacking them.
  await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE brand_id=? AND status='draft' AND kind IN ('initial','form')`).bind(id).run();
  if (body.rereach) await env.DB.prepare(`UPDATE brands SET rereach_on=NULL, attempt=1, status=CASE WHEN status='skipped' THEN 'ready' ELSE status END WHERE id=?`).bind(id).run();
  const r = await env.DB.prepare(`INSERT INTO messages (brand_id, kind, asks, to_email, subject, body, model, channel, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, isForm ? 'form' : 'initial', JSON.stringify(asks), isForm ? null : brand.contact_email || null, titleCase(nodash(out.subject)).slice(0, 200),
      nodash(out.body).slice(0, isForm && form?.message_limit ? Math.max(200, Number(form.message_limit)) : 5000), model, isForm ? 'form' : null, body.rereach ? 1 : n).run();
  return { ok: true, id: r.meta.last_row_id, model };
}

export async function rewriteMessage(env, id, body) {
  const feedback = String(body.feedback || '').trim().slice(0, 1000);
  if (!feedback) throw fail('Tell Claude what to change.');
  const msg = await first(env, `SELECT * FROM messages WHERE id=?`, id);
  if (!msg || msg.status !== 'draft') throw fail('Only drafts can be rewritten.');
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, msg.brand_id);
  const s = await cfg(env);
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 1200, ...noThink(model),
    system: WRITE_SYSTEM(s) + `\n\nYOU ARE NOW EDITING an existing draft. Apply Jen's feedback exactly and keep the rules above. Return the same JSON shape.`,
    messages: [{ role: 'user', content: JSON.stringify({ ...(await brandFacts(env, brand, { link: msg.kind !== 'initial' || s.link_first === '1' })), asks: parseJ(msg.asks, []).map((a) => ASKS[a]).filter(Boolean),
      current_subject: body.subject ?? msg.subject, current_body: body.body ?? msg.body, jens_feedback: feedback }) }] });
  const out = jsonOut(textOf(data));
  if (!out?.subject || !out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  const subject = titleCase(nodash(out.subject)).slice(0, 200), text = nodash(out.body).slice(0, 5000);
  await env.DB.prepare(`UPDATE messages SET subject=?, body=?, model=? WHERE id=?`).bind(subject, text, model + '+feedback', id).run();
  return { ok: true, subject, body: text };
}

// Answer a brand's reply. Creates a draft in the same thread.
export async function draftAnswer(env, replyId, body) {
  const rep = await first(env, `SELECT * FROM replies WHERE id=?`, replyId);
  if (!rep || !rep.brand_id) throw fail('Assign this reply to a brand first.');
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, rep.brand_id);
  const lastSent = await first(env, `SELECT subject, body FROM messages WHERE brand_id=? AND status IN ('sent','sent_manual') ORDER BY id DESC LIMIT 1`, brand.id);
  const s = await cfg(env);
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 1200, ...noThink(model),
    system: `You write Jen Cannizzo's answer to a brand that replied to her ${s.site_name} partnership email. Write AS Jen, in first person ("I"), never about her in third person. Voice: warm, brief, plain, no em or en dashes,
no signature. ABOUT THE SITE (only facts you may use): ${s.about}
Answer exactly what they asked. If their_page_on_our_site is given, include that link once (e.g. "Here's the page so you can see it: <url>"),
since this is a reply and links are welcome now. No other links. If they granted image permission, thank them and confirm the terms back in one sentence so there's a clear
written record (what images, where, credit line). If they asked for traffic numbers, say honestly the site just launched and offer to
send numbers once there's a month or two of data. Don't re-introduce the site; they already know it. Never invent facts or promise placement. 30 to 110 words.
No sign-off, no "Thanks, Jen", no name at the end: the signature is added automatically.
Return ONLY JSON: {"subject": "Re: ...", "body": "..."}`,
    messages: [{ role: 'user', content: JSON.stringify({ brand: brand.name, their_page_on_our_site: await brandPage(env, brand.id), jens_last_email: lastSent ? `${lastSent.subject}\n\n${lastSent.body}` : null,
      their_reply: rep.body || rep.snippet, their_email: rep.from_email, jens_note: String(body.note || '').slice(0, 500) || null }) }] });
  const out = jsonOut(textOf(data));
  if (!out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  const subject = rep.subject ? (/^re:/i.test(rep.subject) ? rep.subject : `Re: ${rep.subject}`) : (out.subject || `Re: ${brand.name}`);
  const r = await env.DB.prepare(`INSERT INTO messages (brand_id, kind, asks, to_email, subject, body, model) VALUES (?, 'reply', '[]', ?, ?, ?, ?)`)
    .bind(brand.id, rep.from_email || brand.contact_email, subject.slice(0, 200), nodash(out.body).slice(0, 5000), model).run();
  await env.DB.prepare(`UPDATE replies SET handled=1 WHERE id=?`).bind(replyId).run();
  return { ok: true, id: r.meta.last_row_id };
}

// Hourly: a polite follow-up draft for brands contacted 7+ days ago with no reply (only one per brand).
export async function queueFollowups(env) {
  const due = await all(env, `SELECT b.id, b.name, b.contact_name, b.contact_email, b.attempt, m.subject, m.asks, m.to_email FROM brands b
      JOIN messages m ON m.brand_id=b.id AND m.kind='initial' AND m.status='sent' AND COALESCE(m.attempt,1)=COALESCE(b.attempt,1)
     WHERE b.status='contacted' AND m.sent_at <= datetime('now','-7 days')
       AND NOT EXISTS (SELECT 1 FROM messages f WHERE f.brand_id=b.id AND f.kind='followup' AND COALESCE(f.attempt,1)=COALESCE(b.attempt,1))
       AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.brand_id=b.id AND r.kind IN ('reply','optout'))
     LIMIT 20`);
  for (const b of due) {
    const hi = b.contact_name ? `Hi ${b.contact_name.split(' ')[0]},` : 'Hi there,';
    const page = await brandPage(env, b.id);
    const text = `${hi}\n\nJust floating this back to the top of your inbox in case it got buried.${page ? ` Here's the page on our site so you can see how it looks: ${page}` : ''}\n\nHappy to work with whoever handles partnerships or PR, if that's someone else.\n\nThank you!`;
    await env.DB.prepare(`INSERT INTO messages (brand_id, kind, asks, to_email, subject, body, model, attempt) VALUES (?, 'followup', ?, ?, ?, ?, 'template', ${Number(b.attempt) || 1})`)
      .bind(b.id, b.asks || '[]', b.to_email || b.contact_email, /^re:/i.test(b.subject) ? b.subject : `Re: ${b.subject}`, text).run();
  }
  return { queued: due.length };
}

// Reads a brand's email and fills in the permission form. The scope must be their exact words: anything Claude
// can't quote straight from the email is dropped, and the person logging it checks every field before saving.
export async function extractPermission(env, body) {
  const text = String(body.text || '').trim().slice(0, 12000);
  if (text.length < 20) throw fail('Paste their whole email, including the From line and date if you have them.');
  const s = await cfg(env);
  const model = WRITE_MODEL(env);
  const data = await call(env, { model, max_tokens: 1500, ...noThink(model),
    system: `You read an email a brand sent to ${s.sender_name} at ${s.site_name} and pull out what they agreed to about using their product images.
Brand: ${String(body.brand || '').slice(0, 120)}. Today is ${new Date().toISOString().slice(0, 10)}.
Rules: scope must be copied word for word from the email: the sentence(s) where they say yes and what to. Never paraphrase it.
granted_by: the sender's name and email if shown (signature or From line), else what is shown. granted_on: the email's date as YYYY-MM-DD if shown, else null.
uses: only places they allowed or clearly implied (website, social, app, email, ads, print). If they just say "yes you can use our images" for the site, use ["website"].
credit_line, link_back, expires_on, conditions: only if they stated them. is_yes: true only if they clearly gave permission; false if they declined,
asked questions, or said maybe. note: one short sentence on anything unclear or worth checking.
Return ONLY JSON: {"is_yes": true, "granted_by": "", "granted_on": null, "scope": "", "uses": ["website"], "credit_line": null, "link_back": false, "expires_on": null, "conditions": null, "note": ""}`,
    messages: [{ role: 'user', content: text }] });
  const out = jsonOut(textOf(data));
  if (!out) throw fail('Claude returned something unexpected. Try again or fill it in by hand.', 502);
  // Compare loosely: Gmail pastes add "> " quote marks, line breaks and curly quotes.
  const norm = (x) => String(x || '').replace(/^\s*>+\s?/gm, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  const scopeOk = out.scope && norm(text).includes(norm(out.scope));
  const date = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);
  return {
    is_yes: !!out.is_yes,
    granted_by: String(out.granted_by || '').slice(0, 300),
    granted_on: date(out.granted_on),
    scope: scopeOk ? String(out.scope).trim() : '',
    scope_missing: !scopeOk,
    uses: (Array.isArray(out.uses) ? out.uses : []).filter((u) => ['website', 'social', 'app', 'ads', 'email', 'print'].includes(u)),
    credit_line: out.credit_line ? String(out.credit_line).slice(0, 300) : '',
    link_back: !!out.link_back,
    expires_on: date(out.expires_on),
    conditions: out.conditions ? String(out.conditions).slice(0, 2000) : '',
    note: String(out.note || '').slice(0, 300),
  };
}

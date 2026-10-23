// Claude in the app: research a brand on the web, write the email, rewrite it from feedback, answer a reply.
import { fail, first, all, cfg, setMeta, parseJ, nodash, EMAIL_RE, logActivity } from './util.js';

const API = 'https://api.anthropic.com/v1/messages';
const WRITE_MODEL = (env) => env.WRITE_MODEL || 'claude-sonnet-5-5';
const RESEARCH_MODEL = (env) => env.RESEARCH_MODEL || 'claude-sonnet-5-5';
// Sonnet/Opus think before answering by default, which can use up a short reply.
const noThink = (model) => (/sonnet|opus/.test(model) ? { thinking: { type: 'between_tools' } } : {});

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

async function call(env, payload) {
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
const textOf = (data) => (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
function jsonOut(text) {
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : ''); } catch { return null; }
}

// ---------- facts about a brand that Claude may use ----------
async function brandFacts(env, brand) {
  const products = await all(env, `SELECT name, type, section, price FROM products WHERE brand_id=? ORDER BY price IS NULL, price DESC LIMIT 10`, brand.id);
  return {
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
Be quick: 2 to 5 searches. If something isn't findable, use null. Do not invent anything.
Return ONLY JSON, no prose:
{"email": null, "email_type": "partnerships|affiliate|press|marketing|general|null", "contact_name": null, "contact_role": null,
 "email_source": null, "contact_url": null, "affiliate": "yes|no|unknown", "affiliate_network": null, "affiliate_url": null,
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

export async function researchBrand(env, id) {
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!brand) throw fail('Brand not found', 404);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  const messages = [{ role: 'user', content: JSON.stringify({ brand: brand.name, website: brand.website || brand.domain, example_products: (await brandFacts(env, brand)).example_products.slice(0, 4) }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 2500, system: RESEARCH_SYSTEM, tools: [tool], messages, ...noThink(model) });
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

  // Fill only empty fields. Never overwrite what Jen typed.
  const email = EMAIL_RE.test(out.email || '') ? out.email.toLowerCase() : null;
  const net = normNetwork(out.affiliate_network);
  const sets = [], p = [];
  const fill = (col, val) => { if (val && !brand[col]) { sets.push(`${col}=?`); p.push(String(val).slice(0, 500)); } };
  fill('contact_email', email);
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
  await logActivity(env, id, 'research', `Claude researched (${searches} searches)${email ? `, found ${email}` : ', no email published'}`);
  return { ok: true, research: out, foundEmail: email };
}

// ---------- the email ----------
export const ASKS = {
  images: 'Permission to use their official product images (from their site or press kit) on our comparison pages, with credit and a link back. Ask if they have a media kit, image library, or product feed.',
  affiliate: 'Whether they run an affiliate program and the best way to join, or who to talk to about one.',
  samples: 'Whether they would send a sample for hands-on testing and a short video. The review stays independent.',
  collab: 'Interest in being featured in short TikTok and social videos showing their products and our comparison tools.',
  feed: 'Spec sheets or a product data feed so our specs stay accurate, and an invite for their team to flag anything we got wrong.',
};

const WRITE_SYSTEM = (s) => `You write short partnership emails for Jen Cannizzo, who runs ${s.site_name}, an independent baby gear comparison site.
Jen sends each one herself after reading it. It must sound like her: warm, direct, plain spoken, a parent who knows her stuff.
The reader is a brand marketing, PR, or partnerships person who gets a lot of pitches. Make it easy to say yes.

ABOUT THE SITE (the ONLY facts you may use about it): ${s.about}

HOW THE EMAIL IS BUILT
1. "Hi <first name>," if contact_first_name is given, otherwise "Hi there,".
2. One line on who Jen is and what the site is.
3. One specific line about this brand using the facts given: how many of their products the site already covers and one or two by
   name, or the categories they're in. Never invent facts.
4. The asks, in the order given, in plain words. One ask gets a short paragraph. Several asks get one sentence each, written as
   normal sentences ("I'd also love to know..."), never as a list.
5. An easy close that offers a choice: "Is this something you handle, or is there someone better to ask?"

RULES
- 110 to 180 words. 3 to 5 short paragraphs. Plain text, no bullet points, no links, no emojis.
- Be honest that the site is launching soon if the about text says so. Never invent traffic, followers, audience size, or partners.
- Never offer better placement, scores or rankings in exchange for anything. Comparisons stay independent. Do not promise coverage.
- If is_store_brand is true, the brand belongs to a retailer: write to the retailer's partnerships or affiliate team.
- Never mention recalls.
- Never use em dashes or en dashes. Use commas or periods.
- Banned words: leverage, synergy, solutions, elevate, boost, amazing opportunity, circle back, touch base, reach out.
- No signature, sign-off name, address, or unsubscribe line. They are added automatically.
- Apply notes_from_jen and jens_note if given.

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
    images: `Could we use your official product images on those pages? We'd credit ${brand.name} and link back to your site. If you have a media kit or image library, that would be perfect.`,
    affiliate: `I'd also love to know if you run an affiliate program, and the best way to join.`,
    samples: `If you're open to it, I'd love a sample to test hands-on for a short video. The comparison itself stays independent.`,
    collab: `We're also making short TikTok videos showing products side by side, and I'd love to feature yours.`,
    feed: `If you have spec sheets or a product feed, I'd use them to keep every number accurate, and your team is welcome to flag anything we got wrong.`,
  };
  const body = [
    hi, '',
    `I'm Jen, and I'm building ${s.site_name}, an independent baby gear comparison site that lines products up side by side using the makers' own spec sheets. We're launching soon.`, '',
    `We already cover ${facts.products_on_our_site} ${brand.name} product${facts.products_on_our_site === 1 ? '' : 's'}${ex ? `, including the ${ex}` : ''}.`, '',
    asks.map((a) => lines[a]).filter(Boolean).join(' '), '',
    `Is this something you handle, or is there someone better to ask?`,
  ].join('\n');
  return { subject: titleCase(asks[0] === 'images' ? `Using ${brand.name} Images on ${s.site_name}` : `${brand.name} and ${s.site_name} Partnership Question`), body };
}

export async function draftEmail(env, id, body) {
  const brand = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!brand) throw fail('Brand not found', 404);
  if (brand.status === 'do_not_contact') throw fail('This brand is marked do not contact.');
  const asks = (Array.isArray(body.asks) ? body.asks : ['images', 'affiliate']).filter((a) => ASKS[a]);
  if (!asks.length) throw fail('Pick at least one thing to ask for.');
  const s = await cfg(env);
  const facts = await brandFacts(env, brand);
  let out, model = 'template';
  if (await claudeKey(env)) {
    model = WRITE_MODEL(env);
    const data = await call(env, { model, max_tokens: 1200, ...noThink(model), system: WRITE_SYSTEM(s),
      messages: [{ role: 'user', content: JSON.stringify({ ...facts, asks: asks.map((a) => ASKS[a]), jens_note: String(body.note || '').slice(0, 500) || null }) }] });
    out = jsonOut(textOf(data));
    if (!out?.subject || !out?.body) throw fail('Claude returned something unexpected. Try again.', 502);
  } else {
    out = templateEmail(s, brand, facts, asks);
  }
  // One open draft per brand: replace the old draft instead of stacking them.
  await env.DB.prepare(`UPDATE messages SET status='skipped' WHERE brand_id=? AND status='draft' AND kind='initial'`).bind(id).run();
  const r = await env.DB.prepare(`INSERT INTO messages (brand_id, kind, asks, to_email, subject, body, model) VALUES (?, 'initial', ?, ?, ?, ?, ?)`)
    .bind(id, JSON.stringify(asks), brand.contact_email || null, titleCase(nodash(out.subject)).slice(0, 200), nodash(out.body).slice(0, 5000), model).run();
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
    messages: [{ role: 'user', content: JSON.stringify({ ...(await brandFacts(env, brand)), asks: parseJ(msg.asks, []).map((a) => ASKS[a]).filter(Boolean),
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
    system: `You help Jen Cannizzo answer a brand that replied to her ${s.site_name} partnership email. Voice: warm, brief, plain, no em or en dashes,
no signature. ABOUT THE SITE (only facts you may use): ${s.about}
Answer exactly what they asked. If they granted image permission, thank them and confirm the terms back in one sentence so there's a clear
written record (what images, where, credit line). If they asked for traffic numbers, say honestly the site is launching soon and offer to
send numbers after launch. Don't re-introduce the site; they already know it. Never invent facts or promise placement. 30 to 110 words.
No sign-off, no "Thanks, Jen", no name at the end: the signature is added automatically.
Return ONLY JSON: {"subject": "Re: ...", "body": "..."}`,
    messages: [{ role: 'user', content: JSON.stringify({ brand: brand.name, jens_last_email: lastSent ? `${lastSent.subject}\n\n${lastSent.body}` : null,
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
  const due = await all(env, `SELECT b.id, b.name, b.contact_name, b.contact_email, m.subject, m.asks, m.to_email FROM brands b
      JOIN messages m ON m.brand_id=b.id AND m.kind='initial' AND m.status='sent'
     WHERE b.status='contacted' AND m.sent_at <= datetime('now','-7 days')
       AND NOT EXISTS (SELECT 1 FROM messages f WHERE f.brand_id=b.id AND f.kind='followup')
       AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.brand_id=b.id AND r.kind IN ('reply','optout'))
     LIMIT 20`);
  for (const b of due) {
    const hi = b.contact_name ? `Hi ${b.contact_name.split(' ')[0]},` : 'Hi there,';
    const text = `${hi}\n\nJust floating this back to the top of your inbox in case it got buried. Happy to work with whoever handles partnerships or PR, if that's someone else.\n\nThank you!`;
    await env.DB.prepare(`INSERT INTO messages (brand_id, kind, asks, to_email, subject, body, model) VALUES (?, 'followup', ?, ?, ?, ?, 'template')`)
      .bind(b.id, b.asks || '[]', b.to_email || b.contact_email, /^re:/i.test(b.subject) ? b.subject : `Re: ${b.subject}`, text).run();
  }
  return { queued: due.length };
}

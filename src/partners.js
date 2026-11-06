// Partners: one contact card per brand you have a relationship with (they replied, said yes, or offered something).
// Claude finds the people (LinkedIn profile links, titles, published phone); you can add a photo by pasting the image link
// or uploading it. LinkedIn doesn't allow apps to pull profile photos, so nothing is scraped from it.
import { fail, all, first, parseJ, cfg, logActivity } from './util.js';
import { call, textOf, jsonOut, noThink, RESEARCH_MODEL } from './claude.js';

const YES = { image_status: ['approved'], affiliate_status: ['approved'], sample_status: ['approved', 'received'], collab_status: ['approved'], feed_status: ['approved'] };
const yesSql = Object.entries(YES).map(([c, v]) => `${c} IN (${v.map((x) => `'${x}'`).join(',')})`).join(' OR ');
const offeredSql = Object.keys(YES).map((c) => `${c}='offered'`).join(' OR ');

// Hourly: someone new wrote back → look up their LinkedIn and photo page (a few at a time).
export async function autoFindPeople(env, claudeKey) {
  if (!(await claudeKey(env))) return { checked: 0 };
  const due = await all(env, `SELECT b.id FROM brands b WHERE b.partner_checked_at IS NULL AND COALESCE(b.contact_name,'')!=''
      AND EXISTS (SELECT 1 FROM replies r WHERE r.brand_id=b.id AND r.kind='reply' AND r.received_at >= datetime('now','-30 days')) LIMIT 4`);
  for (const d of due) await findPeople(env, d.id).catch((e) => console.error('people lookup failed', d.id, e.message));
  return { checked: due.length };
}

export async function listPartners(env) {
  return all(env, `SELECT b.id, b.name, b.domain, b.website, b.status, b.contact_name, b.contact_role, b.contact_email, b.contact_phone, b.contact_linkedin,
      b.contact_photo, b.partner_people, b.partner_checked_at, b.notes, b.product_count, b.sections, b.attempt,
      b.image_status, b.affiliate_status, b.sample_status, b.collab_status, b.feed_status, b.affiliate_network,
      (SELECT MAX(sent_at) FROM messages m WHERE m.brand_id=b.id AND m.status IN ('sent','sent_manual')) last_sent,
      (SELECT MAX(received_at) FROM replies r WHERE r.brand_id=b.id AND r.kind='reply') last_reply
    FROM brands b WHERE b.status != 'do_not_contact' AND (b.status IN ('replied','partner') OR ${yesSql} OR ${offeredSql})
    ORDER BY COALESCE((SELECT MAX(received_at) FROM replies r WHERE r.brand_id=b.id AND r.kind='reply'), b.updated_at) DESC`);
}

const PEOPLE_SYSTEM = `You help Jen, who runs Cribpicks (a baby gear comparison website), keep a contact card for a brand she works with.
Find, using web search:
1. The LinkedIn profile URL of the person she's in touch with (contact.name / contact.email), plus their current title.
2. Up to 3 other people at the brand who handle marketing, PR, partnerships, affiliate or influencer programs, with their LinkedIn URLs and titles.
3. The brand's own LinkedIn company page URL, and a phone number only if it's published on the brand's site or the contact's email signature (given).
4. photo_page: a public page (NOT LinkedIn) that shows this exact person's headshot with their name next to it: the brand's team/about page,
   a press release, a podcast or conference speaker page. null unless you're sure it's the same person.
RULES: Only give a LinkedIn URL you actually saw in search results, in the form https://www.linkedin.com/in/... or /company/....
The person must currently work at this brand (or its parent company). If unsure it's the same person, leave it null.
Never guess an email address. Be quick: 3 to 5 searches.
Return ONLY JSON: {"contact": {"name": null, "title": null, "linkedin": null, "photo_page": null}, "company_linkedin": null, "phone": null,
 "people": [{"name": "", "title": "", "linkedin": "", "why": "one short line"}], "notes": "one sentence", "sources": ["url"]}`;

const LI = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/(in|company)\/[^\s?#]+\/?$/i;

export async function findPeople(env, id) {
  const b = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!b) throw fail('Brand not found', 404);
  // The latest reply often has a signature with name, title and phone.
  const sig = await first(env, `SELECT body FROM replies WHERE brand_id=? AND kind='reply' ORDER BY received_at DESC LIMIT 1`, id);
  const model = RESEARCH_MODEL(env);
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  const messages = [{ role: 'user', content: JSON.stringify({ brand: b.name, website: b.website || b.domain,
    contact: { name: b.contact_name, title: b.contact_role, email: b.contact_email }, their_last_email_signature: String(sig?.body || '').slice(-1200) || null }) }];
  let data, text = '';
  for (let i = 0; i < 3; i++) {
    data = await call(env, { model, max_tokens: 2000, system: PEOPLE_SYSTEM, tools: [tool], messages, ...noThink(model) });
    text += textOf(data);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = jsonOut(text);
  if (!out) throw fail('Claude came back without usable results. Try again.', 502);
  const li = (u) => (LI.test(String(u || '').trim()) ? String(u).trim() : null);
  const people = (Array.isArray(out.people) ? out.people : []).filter((p) => p?.name).slice(0, 4)
    .map((p) => ({ name: String(p.name).slice(0, 80), title: String(p.title || '').slice(0, 120), linkedin: li(p.linkedin), why: String(p.why || '').slice(0, 160) }));
  const phone = String(out.phone || '').replace(/[^\d+()\-. x]/g, '').trim().slice(0, 40) || null;
  await env.DB.prepare(`UPDATE brands SET contact_linkedin=COALESCE(contact_linkedin, ?), contact_name=COALESCE(contact_name, ?),
      contact_role=COALESCE(contact_role, ?), contact_phone=COALESCE(contact_phone, ?), partner_people=?, partner_checked_at=datetime('now') WHERE id=?`)
    .bind(li(out.contact?.linkedin), out.contact?.name || null, out.contact?.title || null, phone,
      JSON.stringify({ people, company_linkedin: li(out.company_linkedin),
        photo_page: /^https:\/\//.test(String(out.contact?.photo_page || '')) && !/linkedin\.com/i.test(out.contact.photo_page) ? String(out.contact.photo_page).slice(0, 400) : null, notes: String(out.notes || '').slice(0, 300), sources: (out.sources || []).slice(0, 6) }), id).run();
  await logActivity(env, id, 'research', `Claude looked up people${li(out.contact?.linkedin) ? ' and found the contact\'s LinkedIn' : ''} (${people.length} other ${people.length === 1 ? 'person' : 'people'})`);
  return { ok: true };
}

// Photo: from an image link you paste (e.g. right-click a LinkedIn photo → Copy image address) or an uploaded file.
// Stored in the database as a small image, so it doesn't break when the original link expires.
export async function savePhoto(env, id, body) {
  let dataUrl = null;
  if (body.data) {
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(body.data)) throw fail('That file isn\'t an image.');
    dataUrl = body.data;
  } else if (body.url) {
    let u; try { u = new URL(body.url); } catch { throw fail('Paste an image link that starts with https://'); }
    if (u.protocol !== 'https:') throw fail('Paste an image link that starts with https://');
    const r = await fetch(u.toString(), { headers: { accept: 'image/*' } });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) throw fail('That link didn\'t return an image. On LinkedIn, right-click the photo and choose "Copy image address".');
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 400_000) throw fail('That image is too big. Use a smaller one (under 400 KB).');
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    dataUrl = `data:${type.split(';')[0]};base64,${btoa(bin)}`;
  } else if (body.clear) {
    dataUrl = null;
  } else throw fail('Paste an image link or choose a file.');
  if (dataUrl && dataUrl.length > 560_000) throw fail('That image is too big. Use a smaller one (under 400 KB).');
  await env.DB.prepare(`UPDATE brands SET contact_photo=? WHERE id=?`).bind(dataUrl, id).run();
  return { ok: true };
}

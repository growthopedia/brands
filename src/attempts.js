// Attempts: when a brand goes quiet, try again with a different address, then their website form.
//
//   Attempt 1, 2, 3: an email (plus one follow-up) to a different published address each time.
//   Attempt 4: their contact / press / partnership form, filled in by hand.
//   No answer to the form: the brand moves to Re-reach for 3 months.
//
// A brand moves to the next attempt 7 days after the follow-up went out with no reply (or 14 days after the first email if the
// follow-up was never sent), straight away if the email bounces, and 21 days after the form was sent. Automatic replies (out of
// office, "we received your message", ticket numbers) don't count as a reply. Any real reply, from anyone at the company, stops it.
import { all, first, parseJ, logActivity, refreshOdds, cfg } from './util.js';
import { verifyManual } from './verify.js';

export const FORM_ATTEMPT = 4;
const WAIT_AFTER_FOLLOWUP = 7, WAIT_NO_FOLLOWUP = 14, WAIT_AFTER_FORM = 21, REREACH_AFTER_FORM = 91;

export const attemptLog = (b) => parseJ(b.attempts_log, []);
// Every address already tried for this brand (so research and auto-reply leads never reuse one).
export const triedEmails = (b) => attemptLog(b).map((a) => a.to).filter((t) => t && t.includes('@')).map((t) => t.toLowerCase());

const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Hourly: move quiet brands to their next attempt.
export async function advanceAttempts(env) {
  const rows = await all(env, `SELECT b.id, MAX(m.sent_at) last_sent, MIN(m.sent_at) first_sent,
      SUM(CASE WHEN m.kind='followup' THEN 1 ELSE 0 END) followups, SUM(CASE WHEN m.kind='form' THEN 1 ELSE 0 END) forms
    FROM brands b JOIN messages m ON m.brand_id=b.id AND COALESCE(m.attempt,1)=COALESCE(b.attempt,1)
      AND m.status IN ('sent','sent_manual') AND m.kind IN ('initial','followup','form')
    WHERE b.status='contacted'
      AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.brand_id=b.id AND r.kind IN ('reply','optout'))
    GROUP BY b.id`);
  const now = Date.now(), days = (t) => (now - Date.parse(String(t).replace(' ', 'T') + 'Z')) / 864e5;
  let moved = 0;
  for (const r of rows) {
    const due = r.forms ? days(r.last_sent) >= WAIT_AFTER_FORM
      : r.followups ? days(r.last_sent) >= WAIT_AFTER_FOLLOWUP
      : days(r.first_sent) >= WAIT_NO_FOLLOWUP;
    if (due) { await nextAttempt(env, r.id, r.forms ? 'no reply to the form' : 'no reply'); moved++; }
  }
  return { moved };
}

// Close the current attempt and set up the next one. result: 'no reply' | 'bounced' | 'no reply to the form' | 'no form found'.
export async function nextAttempt(env, id, result) {
  const b = await first(env, `SELECT * FROM brands WHERE id=?`, id);
  if (!b) return;
  const n = b.attempt || 1;
  const sent = await first(env, `SELECT MIN(sent_at) first_sent, MAX(sent_at) last_sent FROM messages
    WHERE brand_id=? AND COALESCE(attempt,1)=? AND status IN ('sent','sent_manual')`, id, n);
  const log = attemptLog(b);
  log.push({ n, via: n >= FORM_ATTEMPT ? 'form' : 'email', to: n >= FORM_ATTEMPT ? b.contact_url : b.contact_email,
    first_sent: sent?.first_sent?.slice(0, 10) || null, last_sent: sent?.last_sent?.slice(0, 10) || null, result });
  const stmts = [env.DB.prepare(`UPDATE messages SET status='skipped' WHERE brand_id=? AND status='draft'`).bind(id)];
  if (b.contact_email) stmts.push(env.DB.prepare(`UPDATE contacts SET note = COALESCE(note || ' · ', '') || ? WHERE brand_id=? AND lower(email)=?`)
    .bind(`${result} (attempt ${n})`, id, b.contact_email.toLowerCase()));

  if (n >= FORM_ATTEMPT || result === 'no form found') {
    // Out of attempts: park it on Re-reach.
    stmts.push(env.DB.prepare(`UPDATE brands SET attempts_log=?, status='skipped', rereach_on=?, updated_at=datetime('now') WHERE id=?`)
      .bind(JSON.stringify(log), addDays(REREACH_AFTER_FORM), id));
    await env.DB.batch(stmts);
    await logActivity(env, id, 'attempt', `${result === 'no form found' ? 'No contact form found' : 'No reply to the form'}. Moved to Re-reach for 3 months.`);
    await refreshOdds(env, id);
    return { parked: true };
  }

  const next = n + 1;
  // An address someone gave in an automatic reply ("for press, contact ...") is the best next try.
  const tried = new Set([...triedEmails({ attempts_log: JSON.stringify(log) }), String(b.contact_email || '').toLowerCase()]);
  let lead = null;
  if (next < FORM_ATTEMPT) {
    for (const l of parseJ(b.leads, [])) {
      if (tried.has(l.email) || (await first(env, `SELECT 1 FROM suppression WHERE email=?`, l.email))) continue;
      const chk = await verifyManual({ email: l.email, siteDomain: b.domain || b.website, name: b.name });
      if (chk.status !== 'bad') { lead = { ...l, check: chk }; break; }
    }
  }
  stmts.push(env.DB.prepare(`UPDATE brands SET attempts_log=?, attempt=?, contact_email=?, contact_name=NULL, contact_role=?, email_check=?,
      status=?, follow_up_on=NULL, updated_at=datetime('now') WHERE id=?`)
    .bind(JSON.stringify(log), next, lead?.email || null, lead ? 'From their auto-reply' : null, lead ? JSON.stringify(lead.check) : null,
      lead ? 'ready' : 'research', id));
  await env.DB.batch(stmts);
  const what = next >= FORM_ATTEMPT ? 'Next: find their contact form.' : lead ? `Next: ${lead.email} (named in their auto-reply).` : 'Next: research a different address.';
  await logActivity(env, id, 'attempt', `Attempt ${n} to ${b.contact_email || 'them'}: ${result}. Now attempt ${next}. ${what}`);
  await refreshOdds(env, id);
  return { attempt: next, lead: lead?.email || null };
}

// Automatic replies sometimes name someone else to contact. Keep those addresses for the next attempt.
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export async function harvestLeads(env, brandId, fromEmail, text) {
  const b = await first(env, `SELECT id, contact_email, leads, attempts_log, domain FROM brands WHERE id=?`, brandId);
  if (!b || !text) return;
  const s = await cfg(env);
  const own = new Set([s.sender_email, ...String(s.own_emails || '').split(',')].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
  const skip = new Set([...own, String(fromEmail || '').toLowerCase(), String(b.contact_email || '').toLowerCase(), ...triedEmails(b)]);
  const leads = parseJ(b.leads, []);
  const found = [];
  for (const e of new Set((String(text).match(EMAIL_IN_TEXT) || []).map((x) => x.toLowerCase().replace(/[.,;:]+$/, '')))) {
    if (skip.has(e) || /no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|unsubscribe|support@zendesk|@(zendesk|gorgias|freshdesk|helpscout|intercom)\./.test(e)) continue;
    if (leads.some((l) => l.email === e)) continue;
    leads.push({ email: e, from: 'auto-reply', seen: new Date().toISOString().slice(0, 10) });
    found.push(e);
  }
  if (!found.length) return;
  await env.DB.prepare(`UPDATE brands SET leads=? WHERE id=?`).bind(JSON.stringify(leads.slice(-8)), brandId).run();
  await logActivity(env, brandId, 'lead', `Their auto-reply mentioned ${found.join(', ')}. Saved for the next attempt.`);
}

// Who actually wrote back: display name from the From line, else the name under their sign-off, else first.last@ in the address.
// Also picks up the title on the line under the name ("Marketing Manager").
const SIGNOFF = /^(thanks|thank you|thanks so much|many thanks|best|best regards|kind regards|warm regards|warmly|regards|cheers|sincerely|all the best|xo|talk soon|thanks and best regards|thank you and best regards)[,!.]*$/i;
const NAME_LINE = /^[A-Z][a-zA-Z'’.-]+(?: [A-Z][a-zA-Z'’.-]+){0,3}$/;
export function whoReplied({ fromHeader, fromEmail, text }) {
  const disp = String(fromHeader || '').match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  let name = disp && /\s/.test(disp) && !/@/.test(disp) && !/(team|support|info|marketing|press|pr|customer|service|hello)\b/i.test(disp) ? disp : null;
  let title = null;
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/ /g, ' ').trim());
  const cut = lines.findIndex((l) => /^On .+wrote:$/.test(l) || /^-{2,} ?Original Message/i.test(l) || /^From: /.test(l) || l.startsWith('>'));
  const body = cut > 0 ? lines.slice(0, cut) : lines;
  for (let i = body.length - 1; i >= 0; i--) {
    if (!SIGNOFF.test(body[i])) continue;
    const rest = body.slice(i + 1).filter(Boolean);
    if (rest[0] && NAME_LINE.test(rest[0])) {
      if (!name) name = rest[0];
      if (rest[1] && rest[1].length <= 60 && !/[@\d]|https?:/.test(rest[1]) && /[a-z]/i.test(rest[1]) && rest[1].toLowerCase() !== (name || '').toLowerCase()) title = rest[1];
    }
    break;
  }
  if (!name && fromEmail) {
    const local = String(fromEmail).split('@')[0];
    if (/^[a-z]+[._-][a-z]+$/i.test(local) && !/(press|media|info|hello|team|support|partner|market|pr)/i.test(local)) name = local.split(/[._-]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  return { name, title };
}

// A real reply: the person who answered becomes the brand's contact (name, title, email), so the card and any next email go to them.
export async function setContactFromReply(env, brandId, { fromHeader, fromEmail, text }) {
  if (!brandId || !fromEmail || !fromEmail.includes('@')) return null;
  const s = await cfg(env);
  const own = [s.sender_email, ...String(s.own_emails || '').split(',')].map((x) => String(x || '').trim().toLowerCase());
  if (own.includes(fromEmail.toLowerCase())) return null;
  const who = whoReplied({ fromHeader, fromEmail, text });
  const before = await first(env, `SELECT contact_email, contact_name FROM brands WHERE id=?`, brandId);
  const newPerson = String(before?.contact_email || '').toLowerCase() !== fromEmail.toLowerCase()
    || (who.name && before?.contact_name && who.name.toLowerCase() !== before.contact_name.toLowerCase());
  if (newPerson) await env.DB.prepare(`UPDATE brands SET contact_linkedin=NULL, contact_photo=NULL, partner_checked_at=NULL WHERE id=?`).bind(brandId).run();
  await env.DB.prepare(`UPDATE brands SET contact_email=?, contact_name=COALESCE(?, CASE WHEN lower(COALESCE(contact_email,''))=? THEN contact_name ELSE NULL END),
      contact_role=COALESCE(?, CASE WHEN lower(COALESCE(contact_email,''))=? THEN contact_role ELSE NULL END) WHERE id=?`)
    .bind(fromEmail.toLowerCase(), who.name, fromEmail.toLowerCase(), who.title, fromEmail.toLowerCase(), brandId).run();
  return { ...who, newPerson };
}

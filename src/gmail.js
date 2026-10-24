// Gmail: send approved emails and pick up replies, bounces and opt-outs.
import { fail, first, all, setMeta, setMetaStmt, getMeta, cfg, EMAIL_RE, emailIn, sentToday, logActivity, refreshOdds } from './util.js';
import { markPitched, applyProspectReply } from './links.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
let tokenCache = { token: null, exp: 0 };

// Gmail login comes from Cloudflare secrets if set, otherwise from Settings → Connect Gmail (saved in the database).
export async function gmailCreds(env) {
  const m = await getMeta(env, ['gmail_client_id', 'gmail_client_secret', 'gmail_refresh_token', 'gmail_account']);
  const useEnv = Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET);
  return {
    id: useEnv ? env.GMAIL_CLIENT_ID : m.gmail_client_id,
    secret: useEnv ? env.GMAIL_CLIENT_SECRET : m.gmail_client_secret,
    refresh: m.gmail_refresh_token || null,
    account: m.gmail_account || null,
  };
}

async function accessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const c = await gmailCreds(env);
  if (!c.refresh || !c.id || !c.secret) throw fail('Gmail is not connected yet. Settings → Connect Gmail.', 503);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: c.refresh, grant_type: 'refresh_token' }),
  });
  const data = await r.json();
  if (!r.ok) throw fail(`Gmail sign-in failed: ${data.error_description || data.error}. Reconnect Gmail in Settings.`, 502);
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// ---------- Connect Gmail (OAuth in the browser) ----------
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

export async function saveGmailClient(env, body) {
  const id = String(body.client_id || '').trim();
  const secret = String(body.client_secret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) throw fail('The Client ID should end in .apps.googleusercontent.com');
  if (!/^GOCSPX-[\w-]{10,}$/.test(secret)) throw fail('The Client secret should start with GOCSPX-');
  await env.DB.batch([setMetaStmt(env, 'gmail_client_id', id), setMetaStmt(env, 'gmail_client_secret', secret)]);
  return { ok: true };
}

export async function disconnectGmail(env) {
  await env.DB.prepare(`DELETE FROM meta WHERE key IN ('gmail_refresh_token','gmail_account')`).run();
  tokenCache = { token: null, exp: 0 };
  return { ok: true };
}

const base = (url) => (/^(localhost|127\.)/.test(url.hostname) ? url.origin : `https://${url.host}`);

export async function oauthStart(env, url) {
  const c = await gmailCreds(env);
  if (!c.id || !c.secret) throw fail('Save the Google Client ID and secret in Settings first.');
  const state = crypto.randomUUID();
  await setMeta(env, 'oauth_state', `${state}|${Date.now()}`);
  const s = await cfg(env);
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.id, redirect_uri: `${base(url)}/oauth/callback`, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', state, login_hint: s.sender_email || '',
  });
  return Response.redirect(auth, 302);
}

export async function oauthCallback(env, url) {
  const back = (msg) => Response.redirect(`${base(url)}/?gmail=${encodeURIComponent(msg)}#today`, 302);
  if (url.searchParams.get('error')) return back(`Google said: ${url.searchParams.get('error')}`);
  const saved = (await first(env, `SELECT value FROM meta WHERE key='oauth_state'`))?.value || '';
  const [state, at] = saved.split('|');
  if (!state || state !== url.searchParams.get('state') || Date.now() - Number(at) > 15 * 60_000)
    return back('That sign-in link expired. Click Connect Gmail again.');
  const c = await gmailCreds(env);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: c.id, client_secret: c.secret,
      redirect_uri: `${base(url)}/oauth/callback`, grant_type: 'authorization_code',
    }),
  });
  const tok = await r.json();
  if (!r.ok || !tok.refresh_token) return back(`Google didn't return a login: ${tok.error_description || tok.error || 'no refresh token'}`);
  const prof = await fetch(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${tok.access_token}` } })
    .then((x) => x.json()).catch(() => ({}));
  const account = (prof.emailAddress || '').toLowerCase();
  const s = await cfg(env);
  if (s.sender_email && account && account !== s.sender_email.toLowerCase())
    return back(`You signed in as ${account}. Click Connect Gmail again and choose ${s.sender_email}.`);
  await env.DB.batch([
    setMetaStmt(env, 'gmail_refresh_token', tok.refresh_token),
    setMetaStmt(env, 'gmail_account', account),
    env.DB.prepare(`DELETE FROM meta WHERE key='oauth_state'`),
  ]);
  tokenCache = { token: tok.access_token, exp: Date.now() + tok.expires_in * 1000 };
  return back('connected');
}

async function gmail(env, path, init = {}) {
  const token = await accessToken(env);
  const r = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(`Gmail error: ${data.error?.message || r.status}`, 502);
  return data;
}

// ---------- building the email ----------
function b64(bytes) { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); }
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`);

export function signature(s) {
  const site = (s.site_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const lines = ['', '--', s.sender_name, site ? `${s.site_name} | ${site}` : s.site_name];
  if (s.business_address) lines.push(s.business_address);
  lines.push('', `If you'd rather not hear from me, reply "unsubscribe" and I won't email again.`);
  return lines.join('\n');
}

function buildRaw(s, { to, subject, body, inReplyTo }) {
  const headers = [
    `From: ${encodeHeader(s.sender_name)} <${s.sender_email}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    `List-Unsubscribe: <mailto:${s.sender_email}?subject=unsubscribe>`,
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  const text = `${body.trim()}\n${signature(s)}\n`.replace(/\r?\n/g, '\r\n');
  return b64url(new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n${text}`));
}

// Why sending is off, or null when it's ready.
export async function sendBlocker(env) {
  const s = await cfg(env);
  if (!s.sender_email) return 'Add the sending address (your new inbox) in Settings.';
  if (!s.business_address) return 'Add a mailing address in Settings. US law (CAN-SPAM) requires one in every business email.';
  const g = await gmailCreds(env);
  if (!g.refresh) return 'Connect Gmail in Settings.';
  return null;
}

export async function sendMessage(env, id) {
  const block = await sendBlocker(env);
  if (block) throw fail(`Not sent. ${block} Or use "Copy" and "I sent it myself".`);
  const s = await cfg(env);
  const msg = await first(env, `SELECT * FROM messages WHERE id=?`, id);
  if (!msg) throw fail('Message not found', 404);
  if (msg.status !== 'draft') throw fail(`Already ${msg.status}`);
  const to = (msg.to_email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw fail('Add a valid email address before sending.');
  const owner = msg.prospect_id
    ? await first(env, `SELECT status FROM link_prospects WHERE id=?`, msg.prospect_id)
    : await first(env, `SELECT status FROM brands WHERE id=?`, msg.brand_id);
  if (!owner) throw fail(msg.prospect_id ? 'Prospect not found' : 'Brand not found', 404);
  if (owner.status === 'do_not_contact') throw fail('This one is marked do not contact.');
  const sup = await first(env, `SELECT reason FROM suppression WHERE email=? OR (domain IS NOT NULL AND domain=? AND reason='optout')`, to, to.split('@')[1]);
  if (sup) throw fail(`Not sent: this address is on the do-not-contact list (${sup.reason}).`);
  if ((await sentToday(env)) >= s.daily_cap) throw fail(`Daily limit of ${s.daily_cap} reached. Resets at midnight.`);

  const claim = await env.DB.prepare(`UPDATE messages SET status='sending' WHERE id=? AND status='draft'`).bind(id).run();
  if (!claim.meta.changes) throw fail('Already being sent');

  let inReplyTo = null, threadId = null;
  if (msg.kind !== 'initial') { // follow-ups and answers to their reply stay in the same thread
    const orig = await first(env, `SELECT thread_id, rfc_message_id FROM messages WHERE ${msg.prospect_id ? 'prospect_id' : 'brand_id'}=? AND kind='initial' AND status='sent' ORDER BY id LIMIT 1`, msg.prospect_id || msg.brand_id);
    if (orig) { inReplyTo = orig.rfc_message_id; threadId = orig.thread_id; }
  }
  try {
    const raw = buildRaw(s, { to, subject: msg.subject, body: msg.body, inReplyTo });
    const sent = await gmail(env, '/messages/send', { method: 'POST', body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
    let rfcId = null;
    try {
      const meta = await gmail(env, `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
      rfcId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value || null;
    } catch { /* not fatal */ }
    await env.DB.batch([
      env.DB.prepare(`UPDATE messages SET status='sent', channel='gmail', gmail_id=?, thread_id=?, rfc_message_id=?, sent_at=datetime('now'), to_email=?, error=NULL WHERE id=?`)
        .bind(sent.id, sent.threadId, rfcId, to, id),
      ...markAsked(env, msg),
    ]);
    return { ok: true };
  } catch (err) {
    await env.DB.prepare(`UPDATE messages SET status='draft', error=? WHERE id=?`).bind(err.message, id).run();
    throw err;
  }
}

// After any send (Gmail or by hand): brand moves to contacted, each requested ask moves to "asked".
export function markAsked(env, msg) {
  if (msg.prospect_id) return markPitched(env, msg);
  let asks = [];
  try { asks = JSON.parse(msg.asks || '[]'); } catch {}
  const col = { images: 'image_status', samples: 'sample_status', collab: 'collab_status', feed: 'feed_status' };
  const stmts = [
    env.DB.prepare(`UPDATE brands SET status = CASE WHEN status IN ('research','ready','skipped') THEN 'contacted' ELSE status END,
      last_contacted_at=datetime('now'), updated_at=datetime('now'),
      follow_up_on = CASE WHEN follow_up_on IS NULL THEN date('now','+7 days') ELSE follow_up_on END WHERE id=?`).bind(msg.brand_id),
  ];
  for (const a of asks) {
    if (col[a]) stmts.push(env.DB.prepare(`UPDATE brands SET ${col[a]}='asked' WHERE id=? AND ${col[a]}='none'`).bind(msg.brand_id));
    if (a === 'affiliate') stmts.push(env.DB.prepare(`UPDATE brands SET affiliate_status='applied' WHERE id=? AND affiliate_status IN ('none','found')`).bind(msg.brand_id));
  }
  return stmts;
}

// ---------- replies ----------
const OPTOUT_RE = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|do not (email|contact)|don'?t (email|contact) me|opt[ -]?out)\b/i;
const AUTO_RE = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (my|the) (desk|office)|on vacation|delivery status notification|ticket (#|number)|we('ve| have) received your (message|request|email))/i;

export function classify({ from, subject, snippet, headers = {} }) {
  const f = (from || '').toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery (subsystem|system)/.test(f)) return 'bounce';
  if (/delivery status notification|undeliverable|delivery (has )?failed|returned mail/i.test(subject || '')) return 'bounce';
  const auto = (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') || headers['x-autoreply'] ||
    headers['x-autorespond'] || /^(auto_reply|bulk|junk)$/i.test(headers['precedence'] || '');
  if (OPTOUT_RE.test(`${subject} ${snippet}`)) return 'optout';
  if (auto || AUTO_RE.test(`${subject} ${String(snippet || '').slice(0, 200)}`)) return 'auto';
  return 'reply';
}

// Save one reply and update the brand. Used by Gmail checking, forwarded mail and manual logging.
export async function recordReply(env, r) {
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO replies (brand_id, prospect_id, message_id, source, ext_id, thread_id, from_email, subject, snippet, body, kind, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(r.brandId || null, r.prospectId || null, r.messageId || null, r.source, r.extId || null, r.threadId || null, r.fromEmail || null,
    (r.subject || '').slice(0, 300), (r.snippet || '').slice(0, 500), (r.body || '').slice(0, 20000), r.kind,
    r.receivedAt || new Date().toISOString().replace('T', ' ').slice(0, 19)).run();
  if (!ins.meta.changes) return false;
  if (r.brandId) await applyReplyEffects(env, r.brandId, r.kind, r.fromEmail);
  else if (r.prospectId) await applyProspectReply(env, r.prospectId, r.kind, r.fromEmail);
  return true;
}

// What a reply does to the brand: stops follow-ups, moves status, honors opt-outs, clears bounced addresses.
export async function applyReplyEffects(env, brandId, kind, fromEmail) {
  const r = { brandId, kind, fromEmail };
  const stmts = [];
  if (r.kind !== 'auto')
    stmts.push(env.DB.prepare(`UPDATE messages SET status='skipped' WHERE brand_id=? AND status='draft' AND kind='followup'`).bind(r.brandId));
  if (r.kind === 'reply') {
    stmts.push(env.DB.prepare(`UPDATE brands SET status='replied', follow_up_on=NULL, updated_at=datetime('now')
      WHERE id=? AND status IN ('research','ready','contacted','skipped')`).bind(r.brandId));
    stmts.push(env.DB.prepare(`UPDATE brands SET image_status='replied' WHERE id=? AND image_status='asked'`).bind(r.brandId));
  } else if (r.kind === 'optout') {
    stmts.push(env.DB.prepare(`UPDATE brands SET status='do_not_contact', follow_up_on=NULL, updated_at=datetime('now') WHERE id=?`).bind(r.brandId));
    if (r.fromEmail) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO suppression (email, domain, reason) VALUES (?, ?, 'optout')`).bind(r.fromEmail, r.fromEmail.split('@')[1]));
    stmts.push(env.DB.prepare(`UPDATE messages SET status='skipped' WHERE brand_id=? AND status='draft'`).bind(r.brandId));
  } else if (r.kind === 'bounce') {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO suppression (email, domain, reason)
      SELECT lower(contact_email), NULL, 'bounce' FROM brands WHERE id=? AND contact_email IS NOT NULL`).bind(r.brandId));
    stmts.push(env.DB.prepare(`UPDATE brands SET notes = COALESCE(notes || char(10), '') || 'Email bounced: ' || COALESCE(contact_email,'') ||
      '. Find a new contact.', contact_email=NULL, status = CASE WHEN status='contacted' THEN 'research' ELSE status END WHERE id=?`).bind(r.brandId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await refreshOdds(env, brandId);
}

export async function checkReplies(env) {
  const g = await gmailCreds(env);
  if (!g.refresh) return { skipped: 'Gmail not connected' };
  const sent = await all(env, `SELECT id, brand_id, prospect_id, thread_id, kind FROM messages
     WHERE status='sent' AND thread_id IS NOT NULL AND sent_at >= datetime('now','-150 days')`);
  const byThread = new Map();
  for (const m of sent) if (!byThread.has(m.thread_id) || m.kind === 'initial') byThread.set(m.thread_id, m);
  if (!byThread.size) { await setMeta(env, 'last_reply_check', new Date().toISOString()); return { checked: 0, found: 0 }; }
  const s = await cfg(env);
  const own = new Set([s.sender_email.toLowerCase(), ...s.own_emails.toLowerCase().split(',').map((x) => x.trim())].filter(Boolean));
  const list = await gmail(env, `/messages?maxResults=200&q=${encodeURIComponent('newer_than:3d -in:sent -in:drafts')}`);
  let found = 0;
  for (const item of list.messages || []) {
    if (!byThread.has(item.threadId)) continue;
    if (await first(env, `SELECT 1 FROM replies WHERE ext_id=?`, item.id)) continue;
    const msg = await gmail(env, `/messages/${item.id}?format=metadata` +
      ['From', 'Subject', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence'].map((h) => `&metadataHeaders=${h}`).join(''));
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    const fromEmail = emailIn(headers.from);
    if (own.has(fromEmail)) continue;
    const orig = byThread.get(item.threadId);
    const ok = await recordReply(env, {
      source: 'gmail', extId: item.id, threadId: item.threadId, brandId: orig.brand_id || null, prospectId: orig.prospect_id || null, messageId: orig.id, fromEmail,
      subject: headers.subject, snippet: msg.snippet, kind: classify({ from: headers.from, subject: headers.subject, snippet: msg.snippet, headers }),
      receivedAt: new Date(Number(msg.internalDate) || Date.now()).toISOString().replace('T', ' ').slice(0, 19),
    });
    if (ok) found++;
  }
  await setMeta(env, 'last_reply_check', new Date().toISOString());
  return { checked: byThread.size, found };
}

export { logActivity };

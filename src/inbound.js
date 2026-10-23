// Incoming email from Cloudflare Email Routing (new domain → "Send to a Worker" → brands).
// Every message is forwarded on to your real inbox (Settings → Forward copies to), and anything from a brand
// is logged as a reply on that brand. Mail that can't be matched lands in Replies → Unmatched for you to assign.
import PostalMime from 'postal-mime';
import { cfg, first, getMeta } from './util.js';
import { classify, recordReply } from './gmail.js';

export async function handleEmail(message, env, ctx) {
  const m = await getMeta(env, ['cfg_forward_to']);
  const forwardTo = (m.cfg_forward_to || '').trim();
  // Forward first so you never miss mail, even if logging fails.
  if (forwardTo) {
    try { await message.forward(forwardTo); } catch (e) { console.error('forward failed (is the address verified in Email Routing?)', e); }
  }
  try {
    const email = await PostalMime.parse(message.raw);
    const fromEmail = (email.from?.address || message.from || '').toLowerCase();
    const s = await cfg(env);
    const own = new Set([s.sender_email, ...s.own_emails.split(','), forwardTo].map((x) => (x || '').trim().toLowerCase()).filter(Boolean));
    if (own.has(fromEmail)) return;

    const headers = Object.fromEntries((email.headers || []).map((h) => [h.key.toLowerCase(), h.value]));
    const text = (email.text || stripHtml(email.html || '')).trim();
    const snippet = text.replace(/\s+/g, ' ').slice(0, 300);

    // Match: thread headers → known contact email → brand domain.
    let brandId = null, messageId = null;
    const refs = `${email.inReplyTo || ''} ${email.references || ''}`.match(/<[^>]+>/g) || [];
    for (const ref of refs) {
      const msg = await first(env, `SELECT id, brand_id FROM messages WHERE rfc_message_id=?`, ref);
      if (msg) { brandId = msg.brand_id; messageId = msg.id; break; }
    }
    if (!brandId && fromEmail) {
      const b = await first(env, `SELECT id FROM brands WHERE lower(contact_email)=?
        UNION SELECT brand_id FROM contacts WHERE lower(email)=? LIMIT 1`, fromEmail, fromEmail);
      if (b) brandId = b.id;
    }
    if (!brandId && fromEmail.includes('@')) {
      const dom = fromEmail.split('@')[1];
      const parts = dom.split('.');
      const root = parts.slice(-2).join('.');
      const b = await first(env, `SELECT id FROM brands WHERE domain=? OR domain=? OR ? LIKE '%.' || domain ORDER BY product_count DESC LIMIT 1`, dom, root, dom);
      if (b) brandId = b.id;
    }
    await recordReply(env, {
      source: 'forward', extId: email.messageId || `${fromEmail}|${headers.date || Date.now()}`, brandId, messageId, fromEmail,
      subject: email.subject || '', snippet, body: text.slice(0, 20000),
      kind: classify({ from: `${email.from?.name || ''} <${fromEmail}>`, subject: email.subject, snippet, headers }),
    });
  } catch (e) {
    console.error('inbound email logging failed', e);
  }
}

function stripHtml(h) {
  return String(h).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

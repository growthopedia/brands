// Checks an email address before anyone sends to it:
//   1. on_page — the page Claude cited actually contains the address (catches guesses and stale memory)
//   2. mx      — the domain has mail servers (DNS-over-HTTPS lookup); no MX = mail can't be delivered
//   3. domain  — the address is on the same domain as the brand/site (or clearly the same name)
// Result: { status: 'verified' | 'likely' | 'unverified' | 'bad', checks, note, checked_at }
import { domainOf } from './util.js';

const rootOf = (d) => String(d || '').toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function mxLookup(domain) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    if (j.Status === 3) return { ok: false, why: 'domain does not exist' };
    const mx = (j.Answer || []).filter((a) => a.type === 15).map((a) => String(a.data).split(' ').pop().replace(/\.$/, ''));
    if (mx.length) return { ok: true, mx: mx.slice(0, 3) };
    // No MX: mail falls back to an A record only in theory; treat as unable to receive.
    return { ok: false, why: 'no mail servers for this domain' };
  } catch {
    return { ok: null, why: 'lookup failed' };
  }
}

function deobfuscate(html) {
  return String(html)
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@').replace(/&#0*46;|&#x0*2e;/gi, '.')
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.')
    .replace(/%40/g, '@');
}

async function onPage(email, url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: null, why: 'no source page given' };
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ContactCheck/1.0)', accept: 'text/html,*/*' },
    });
    if (!r.ok) return { ok: null, why: `source page answered ${r.status}` };
    const text = deobfuscate((await r.text()).slice(0, 3_000_000)).toLowerCase();
    if (text.includes(email)) return { ok: true };
    return { ok: false, why: 'address not found on the source page' };
  } catch (e) {
    return { ok: null, why: e.name === 'TimeoutError' ? 'source page timed out' : 'source page could not be loaded' };
  }
}

function domainMatch(email, siteDomain, name) {
  const ed = email.split('@')[1] || '';
  const free = /^(gmail|yahoo|outlook|hotmail|icloud|aol|proton|protonmail|me|live)\./.test(ed);
  if (!siteDomain && !name) return { ok: null, free };
  if (siteDomain && rootOf(ed) === rootOf(siteDomain)) return { ok: true, free };
  const key = nameKey(name), edKey = nameKey(ed.split('.')[0]);
  if (key && edKey && (edKey.includes(key) || key.includes(edKey)) && key.length >= 4) return { ok: 'close', free };
  return { ok: false, free, why: `different domain than ${siteDomain || 'the brand'}` };
}

export async function verifyEmail({ email, sourceUrl, siteDomain, name, creator = false, seenOn = null }) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  const domain = email.split('@')[1];
  const [mx, page] = await Promise.all([mxLookup(domain), onPage(email, sourceUrl)]);
  const dm = creator ? { ok: null } : domainMatch(email, siteDomain ? domainOf(siteDomain) || siteDomain : null, name);
  const stale = /^\d{4}-\d{2}-\d{2}$/.test(String(seenOn || '')) && seenOn < new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);
  let status, note;
  if (mx.ok === false) { status = 'bad'; note = `Can't receive mail: ${mx.why}.`; }
  else if (page.ok === true && stale) { status = 'likely'; note = `On the cited page, but that page is from ${seenOn}, so it may be out of date.`; }
  else if (page.ok === true && (dm.ok === true || creator)) { status = 'verified'; note = 'Found on the cited page, and the domain takes mail.'; }
  else if (page.ok === true && dm.ok === 'close') { status = 'likely'; note = `On the cited page, but on ${domain}, not the brand's own site${siteDomain ? ` (${domainOf(siteDomain) || siteDomain})` : ''}. Could be an old domain.`; }
  else if (page.ok === true) { status = 'likely'; note = `On the cited page, but ${dm.why || 'on a different domain'}.`; }
  else if (dm.ok === true && mx.ok) { status = 'likely'; note = page.ok === false ? 'On the brand\'s own domain, but not found on the cited page. It may have been removed.' : `On the brand's own domain (${page.why}).`; }
  else { status = 'unverified'; note = (creator ? [page.why] : [page.why, dm.why]).filter(Boolean).join('; ') + '.'; }
  return { status, note, checks: { mx: mx.ok, on_page: page.ok, domain: dm.ok }, mx: mx.mx || null, source: sourceUrl || null, checked_at: new Date().toISOString() };
}

// Manual entries (no source page): only domain and mail-server checks.
export async function verifyManual({ email, siteDomain, name, creator = false }) {
  const v = await verifyEmail({ email, sourceUrl: null, siteDomain, name, creator });
  if (v && v.status === 'unverified' && v.checks.mx) v.note = 'Entered by you. The domain takes mail.';
  return v;
}

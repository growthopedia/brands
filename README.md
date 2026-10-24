# Baby Bodega brand outreach

Asks baby gear brands for **image permission, affiliate access, samples, TikTok features and spec data**, and keeps the
written record of every yes. Also a **backlink builder**: finds link prospects, writes pitches, and checks won links stay live. One card per brand on the site, ranked by how likely each brand is to reply, then by value.

- **App:** https://brands.thecannizzos.com (behind Cloudflare Access)
- **How to use it:** the **Guide** tab in the app (`src/guide.html`)
- Every push to `main` redeploys through Cloudflare Workers Builds.

| File | What it is |
|---|---|
| `src/index.js` | The Worker: pages, brand data, product import, hourly job, incoming email |
| `src/claude.js` | Claude: web research for contacts and affiliate programs, writing and rewriting emails, answering replies |
| `src/gmail.js` | Sending through Gmail, reply checking, opt-outs and bounces |
| `src/links.js` | Backlinks: prospect finder (Claude + web search), contact research, pitches, list import, live-link checker |
| `src/inbound.js` | Mail arriving through Cloudflare Email Routing: filed on the right brand, copy forwarded to you |
| `src/ui.html` | The dashboard |
| `schema.sql` | Database tables (created automatically) |
| `data/products.csv` → `src/seed.json` | Built-in product list. `python3 tools/build_seed.py` rebuilds the seed after replacing the CSV, or upload the CSV in Settings |

## Setup
1. **Database:** D1 `brands` (ID already in `wrangler.jsonc`). Tables create themselves.
2. **Deploy:** Cloudflare → Workers → `brands` → Settings → Build → connect `growthopedia/brands`, deploy command `npx wrangler deploy`.
3. **Access:** Zero Trust → Access → Applications → `brands.thecannizzos.com` (and the workers.dev address, if you use it) → allow your email.
   The app refuses any request that didn't come through Access.
4. **Claude key:** app → Settings → Claude key. Stored in the database, not in this repo.
5. **Sending** (once the new domain, LLC and inbox exist): Guide → "Turning on sending".
6. **Replies by forwarding:** Guide → "Replies".

## Built-in rules
Nothing sends without approval · daily send cap · mailing address and unsubscribe line required (CAN-SPAM) · "unsubscribe" replies
are do-not-contact forever · bounced addresses are cleared · Claude only uses published emails and the facts in Settings → About ·
emails never offer placement or rankings in exchange for anything · image permissions are never deleted (revoking keeps the record).

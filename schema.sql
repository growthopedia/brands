-- Brand outreach database. The Worker creates these tables automatically (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  domain TEXT,
  kind TEXT NOT NULL DEFAULT 'brand',              -- brand | store_brand (a retailer's own label: Target, Walmart, IKEA...)
  sections TEXT,                                   -- JSON array of site sections the brand appears in
  product_count INTEGER NOT NULL DEFAULT 0,
  avg_price REAL,
  max_price REAL,
  has_recall INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,                -- 0-100 priority (more products, pricier gear = more worth it)
  status TEXT NOT NULL DEFAULT 'research',
  -- research -> ready -> contacted -> replied -> partner | declined ; also skipped, do_not_contact
  contact_name TEXT,
  contact_email TEXT,
  contact_role TEXT,
  contact_url TEXT,                                -- contact form / press page when there's no email
  instagram TEXT,
  image_status TEXT NOT NULL DEFAULT 'none',       -- none | asked | replied | approved | declined
  affiliate_status TEXT NOT NULL DEFAULT 'none',   -- none | found | applied | approved | declined | no_program
  affiliate_network TEXT,                          -- impact | awin | cj | avantlink | rakuten | partnerize | amazon | in_house | other
  affiliate_url TEXT,                              -- where to apply
  commission TEXT,                                 -- as published, e.g. "8%"
  cookie_days TEXT,
  affiliate_notes TEXT,
  sample_status TEXT NOT NULL DEFAULT 'none',      -- none | asked | approved | declined | received
  collab_status TEXT NOT NULL DEFAULT 'none',      -- none | asked | approved | declined (TikTok / social features)
  feed_status TEXT NOT NULL DEFAULT 'none',        -- none | asked | approved | declined (spec sheets / product data / image feed)
  research TEXT,                                   -- JSON from Claude web research
  researched_at TEXT,
  notes TEXT,
  follow_up_on TEXT,
  follow_up_note TEXT,
  last_contacted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS brands_status ON brands(status);
CREATE INDEX IF NOT EXISTS brands_score ON brands(score);
CREATE INDEX IF NOT EXISTS brands_domain ON brands(domain);
CREATE INDEX IF NOT EXISTS brands_email ON brands(contact_email);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL,
  section TEXT,
  type TEXT,
  name TEXT NOT NULL,
  model TEXT,
  price REAL,
  status TEXT,
  recall INTEGER NOT NULL DEFAULT 0,
  maker_url TEXT,
  site_url TEXT,
  ukey TEXT NOT NULL UNIQUE,                       -- site_url, or brand|name when there is no site page
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS products_brand ON products(brand_id);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL,
  name TEXT,
  email TEXT,
  role TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS contacts_brand ON contacts(brand_id);
CREATE INDEX IF NOT EXISTS contacts_email ON contacts(email);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'initial',            -- initial | followup
  asks TEXT,                                       -- JSON array: images, affiliate, samples, collab, feed
  to_email TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',            -- draft | sending | sent | sent_manual | skipped
  channel TEXT,                                    -- gmail | manual (contact form, DM, other inbox)
  gmail_id TEXT,
  thread_id TEXT,
  rfc_message_id TEXT,
  error TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS messages_brand ON messages(brand_id, status);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER,
  message_id INTEGER,
  source TEXT NOT NULL DEFAULT 'gmail',            -- gmail | forward (Cloudflare Email Routing) | manual
  ext_id TEXT UNIQUE,                              -- Gmail id or Message-ID header
  thread_id TEXT,
  from_email TEXT,
  subject TEXT,
  snippet TEXT,
  body TEXT,
  kind TEXT NOT NULL DEFAULT 'reply',              -- reply | bounce | optout | auto
  handled INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS replies_brand ON replies(brand_id);
CREATE INDEX IF NOT EXISTS replies_thread ON replies(thread_id);

-- Written permission to use images: the legal record. Rows are never deleted (revoking sets revoked_on).
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL,
  granted_by TEXT NOT NULL,                        -- name + email of the person who said yes
  granted_on TEXT NOT NULL,                        -- date of their email
  scope TEXT NOT NULL,                             -- what they allowed, in their own words
  uses TEXT,                                       -- JSON: website, social, app, ads, email
  credit_line TEXT,
  link_back INTEGER NOT NULL DEFAULT 0,
  expires_on TEXT,
  conditions TEXT,
  evidence TEXT,                                   -- Gmail link, message id, or where the email is saved
  revoked_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS permissions_brand ON permissions(brand_id);

-- Everything done outside email: contact forms, network applications, DMs, calls, samples received.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_brand ON activity(brand_id);

CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY,
  domain TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- ---------- Backlinks ----------
-- Sites that might link to the comparison site. Pitches reuse the messages table (brand_id = 0, prospect_id set).
CREATE TABLE IF NOT EXISTS link_prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,                               -- the page that would link (or the site's home page)
  domain TEXT NOT NULL UNIQUE,                     -- one prospect per site
  name TEXT,                                       -- site or publication name
  page_title TEXT,
  tactic TEXT NOT NULL DEFAULT 'resource',         -- resource | roundup | guest | expert | organization | mention | partner | competitor | other
  why TEXT,                                        -- why it fits, in plain words
  target_url TEXT,                                 -- our page to suggest
  authority INTEGER,                               -- optional DR/DA you paste in from Ahrefs/Semrush/Moz
  contact_name TEXT,
  contact_email TEXT,
  contact_url TEXT,                                -- contact form, "write for us" or tips page
  status TEXT NOT NULL DEFAULT 'found',
  -- found -> ready -> pitched -> replied -> won | lost ; also skipped, do_not_contact
  odds INTEGER,                                    -- 0-100 estimate of how likely they answer
  source TEXT,                                     -- claude | import | manual
  research TEXT,                                   -- JSON from Claude
  researched_at TEXT,
  notes TEXT,
  follow_up_on TEXT,
  last_contacted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS link_prospects_status ON link_prospects(status);
CREATE INDEX IF NOT EXISTS link_prospects_email ON link_prospects(contact_email);

-- Links you've earned. The hourly job re-checks each one about once a day.
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER,
  brand_id INTEGER,
  source_url TEXT NOT NULL UNIQUE,                 -- the page that links to us
  target_url TEXT,                                 -- where it points (filled in by the checker)
  anchor TEXT,
  rel TEXT,                                        -- follow | nofollow | sponsored | ugc (combined as found)
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | live | missing | error
  last_error TEXT,
  first_seen_at TEXT,
  last_checked_at TEXT,
  lost_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS links_checked ON links(last_checked_at);

-- ---------- Creators ----------
-- Creators live in link_prospects with kind='creator' (columns added by migration: kind, platform, handle,
-- followers, video_url, video_title, posted_on, products). This table is the written record of what each
-- creator agreed to: sharing the site, being featured as "recommended by", or having their video embedded.
-- Rows are never deleted; revoking sets revoked_on.
CREATE TABLE IF NOT EXISTS creator_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                              -- shared | feature | embed
  url TEXT,                                        -- their post/video (shared or embedded)
  quote TEXT,                                      -- exact words we may show (feature)
  product_urls TEXT,                               -- JSON: our pages it goes on
  permission_text TEXT,                            -- what they agreed to, in their own words
  granted_by TEXT,
  granted_on TEXT,
  credit TEXT,                                     -- how to credit them, e.g. "@mamareviews on TikTok"
  revoked_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS creator_features_prospect ON creator_features(prospect_id);

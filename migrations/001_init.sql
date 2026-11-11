-- The Second Source: iteration 1 schema.

-- Conditional-GET cache for feeds (ETag / Last-Modified), so unchanged feeds
-- cost the outlet one cheap 304.
CREATE TABLE feed_cache (
  url            TEXT PRIMARY KEY,
  etag           TEXT,
  last_modified  TEXT,
  last_status    INTEGER,
  fetched_at     TEXT NOT NULL
);

-- One sweep of the whole pipeline.
CREATE TABLE sweeps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  summary     TEXT            -- JSON counters, written at the end
);

-- An event is one real-world happening; it is also the story's lifecycle.
-- status: waiting | working | held | printed | spiked | retracted
CREATE TABLE events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  label            TEXT NOT NULL,         -- working title (first report's headline)
  desk             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting','working','held','printed','spiked','retracted')),
  status_reason    TEXT,                  -- machine code, e.g. expired_unconfirmed
  status_note      TEXT,                  -- plain-English one-liner
  outlet_count     INTEGER NOT NULL DEFAULT 0,  -- independent outlets (wire copies merged)
  facts_stale      INTEGER NOT NULL DEFAULT 1,  -- reports changed since last fact check
  recheck_count    INTEGER NOT NULL DEFAULT 0,
  fail_count       INTEGER NOT NULL DEFAULT 0,  -- failed pipeline steps; spiked after 3
  last_checked_at  TEXT,
  headline         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,         -- waiting events expire after WAITING_TTL_HOURS
  printed_at       TEXT
);
CREATE INDEX events_status ON events(status);
CREATE INDEX events_printed ON events(printed_at);

-- A report is one article at one outlet. We keep the headline, the feed's own
-- short summary and the link. Article body text is NEVER stored: it is
-- fetched, used for claim extraction inside a sweep, and dropped.
CREATE TABLE reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id     TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  feed_desk     TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  sort_status   TEXT NOT NULL DEFAULT 'new'
                CHECK (sort_status IN ('new','grouped','discarded')),
  discard_note  TEXT,
  event_id      INTEGER REFERENCES events(id),
  -- filled by the Fact Checker once the article has been read
  text_source   TEXT CHECK (text_source IN ('article','feed_summary')),
  wire_agency   TEXT,           -- e.g. PTI, ANI when the copy is agency copy
  fingerprint   TEXT,           -- MinHash signature of the text (not the text)
  claims_at     TEXT
);
CREATE INDEX reports_event ON reports(event_id);
CREATE INDEX reports_sort ON reports(sort_status, published_at);

-- Claims as each individual report states them (our paraphrase).
CREATE TABLE report_claims (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES reports(id),
  text       TEXT NOT NULL
);
CREATE INDEX report_claims_report ON report_claims(report_id);

-- The fact sheet: one row per claim considered for the event.
-- status 'corroborated' rows are the fact sheet proper; 'conflicting' rows are
-- kept for the record and are never given to the Rewrite Desk.
CREATE TABLE fact_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  text        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('corroborated','conflicting')),
  created_at  TEXT NOT NULL
);
CREATE INDEX fact_claims_event ON fact_claims(event_id);

CREATE TABLE fact_claim_support (
  fact_claim_id  INTEGER NOT NULL REFERENCES fact_claims(id) ON DELETE CASCADE,
  report_id      INTEGER NOT NULL REFERENCES reports(id),
  PRIMARY KEY (fact_claim_id, report_id)
);

-- Angles live in their own table: iteration 3 adds reader-specific angles.
CREATE TABLE angles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  angle_key   TEXT NOT NULL DEFAULT 'general',
  label       TEXT NOT NULL DEFAULT 'General',
  body        TEXT NOT NULL,
  word_count  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (event_id, angle_key)
);

-- Press Room rules.
CREATE TABLE desk_rules (
  desk  TEXT PRIMARY KEY,
  rule  TEXT NOT NULL DEFAULT 'auto' CHECK (rule IN ('auto','review'))
);
INSERT INTO desk_rules (desk, rule) VALUES
  ('india','auto'), ('world','auto'), ('business','auto'), ('sport','auto'), ('entertainment','auto');

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('presses_stopped', '0');

-- The run log. Every stage writes a row here; the admin console reads it.
-- event_id is NULL for sweep-wide steps (Wire Scout, the Desk Sorter summary).
CREATE TABLE steps (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_id           INTEGER REFERENCES sweeps(id),
  event_id           INTEGER REFERENCES events(id),
  agent              TEXT NOT NULL CHECK (agent IN
                     ('Wire Scout','Desk Sorter','Fact Checker','Rewrite Desk','Copy Editor','Picture Desk','Press Room')),
  status             TEXT NOT NULL CHECK (status IN ('ok','skipped','failed')),
  started_at         TEXT NOT NULL,
  ended_at           TEXT NOT NULL,
  note               TEXT NOT NULL,
  model              TEXT,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  llm_calls          INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0
);
CREATE INDEX steps_event ON steps(event_id);
CREATE INDEX steps_sweep ON steps(sweep_id);

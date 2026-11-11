-- Iteration 2: fact roles, queue priority, live stage, the feed byline,
-- and the tables the newsroom console works through.

-- core (what happened) | supporting | background
ALTER TABLE fact_claims ADD COLUMN role TEXT NOT NULL DEFAULT 'supporting';

ALTER TABLE events ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;   -- 1 = sent to the desk by an editor
ALTER TABLE events ADD COLUMN current_agent TEXT;                    -- the agent working on it right now
ALTER TABLE events ADD COLUMN retracted_at TEXT;

-- Byline as the feed gives it (dc:creator). Lets wire copy be recognised for
-- outlets we read from the feed only.
ALTER TABLE reports ADD COLUMN byline TEXT;

-- "Send a story to the desk": a link or a topic from an editor.
CREATE TABLE submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  input        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('link','topic')),
  desk         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','done')),
  -- matched | no_match | rejected | failed   (what happened to the story itself is read from its event)
  outcome      TEXT,
  note         TEXT,
  event_id     INTEGER REFERENCES events(id),
  picked_at    TEXT,
  finished_at  TEXT
);
CREATE INDEX submissions_status ON submissions(status);

-- Requests from the console to the worker (the two are separate processes).
CREATE TABLE worker_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('sweep_now')),
  created_at  TEXT NOT NULL,
  picked_at   TEXT,
  note        TEXT
);

-- Everything an editor (or the audit) does, with its time.
CREATE TABLE admin_actions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL DEFAULT 'editor',
  action    TEXT NOT NULL,
  event_id  INTEGER REFERENCES events(id),
  detail    TEXT
);
CREATE INDEX admin_actions_event ON admin_actions(event_id);

CREATE TABLE admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

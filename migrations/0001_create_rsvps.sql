CREATE TABLE rsvps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  guest_names   TEXT    NOT NULL DEFAULT '[]',
  party_size    INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  user_agent    TEXT,
  ip_country    TEXT
);

CREATE INDEX idx_rsvps_created_at ON rsvps(created_at DESC);

CREATE TABLE lanterns (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  role        TEXT,
  msg         TEXT    NOT NULL,
  media_key   TEXT,
  media_type  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  user_agent  TEXT,
  ip_country  TEXT
);

CREATE INDEX idx_lanterns_created_at ON lanterns(created_at DESC);

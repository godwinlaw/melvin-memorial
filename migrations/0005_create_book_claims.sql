CREATE TABLE book_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     TEXT    NOT NULL,
  book_title  TEXT    NOT NULL,
  book_author TEXT    NOT NULL,
  format      TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  email       TEXT,
  address     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  user_agent  TEXT,
  ip_country  TEXT
);

CREATE INDEX idx_book_claims_created_at ON book_claims(created_at DESC);

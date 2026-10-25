-- Схема базы Cloudflare D1 для «Закулисье Майнкрафта Вики».
-- Выполните целиком в консоли D1 (Dashboard → Storage & Databases → D1 → ваша база → Console).

CREATE TABLE IF NOT EXISTS authors (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  avatar     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  article_title TEXT NOT NULL,
  review_title  TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('ai', 'user')),
  reviewer_name TEXT NOT NULL,
  body          TEXT NOT NULL,
  c1            INTEGER NOT NULL CHECK (c1 BETWEEN 1 AND 10),
  c2            INTEGER NOT NULL CHECK (c2 BETWEEN 1 AND 10),
  c3            INTEGER NOT NULL CHECK (c3 BETWEEN 1 AND 10),
  c4            INTEGER NOT NULL CHECK (c4 BETWEEN 1 AND 10),
  c_atm         INTEGER NOT NULL CHECK (c_atm BETWEEN 1 AND 10),
  score         INTEGER NOT NULL CHECK (score BETWEEN 1 AND 90),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_status  ON reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_article ON reviews (article_title COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS rate_limit (
  kind    TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate ON rate_limit (kind, ip_hash, ts);

INSERT OR IGNORE INTO authors (id, name, avatar, created_at)
VALUES ('a1', 'Неизвестный Автор', '', 0);

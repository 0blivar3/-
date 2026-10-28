-- Схема базы Cloudflare D1 для «Закулисье Майнкрафта Вики» (версия 2: с аккаунтами).
-- ДЛЯ НОВОЙ ПУСТОЙ БАЗЫ: выполните целиком в консоли D1.
-- Если база уже работает с версией 1, используйте migrations/002_accounts.sql (этот файл не нужен).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  username_key  TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  social_links  TEXT NOT NULL DEFAULT '{}',
  favorite_author_ids TEXT NOT NULL DEFAULT '[]',
  favorite_articles TEXT NOT NULL DEFAULT '[]',
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS authors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  avatar        TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  updated_at    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_owner ON authors (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reviews (
  id               TEXT PRIMARY KEY,
  article_title    TEXT NOT NULL,
  review_title     TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  reviewer_kind    TEXT NOT NULL CHECK (reviewer_kind IN ('ai', 'user')),
  reviewer_name    TEXT NOT NULL,
  reviewer_user_id TEXT,
  body             TEXT NOT NULL,
  c1               INTEGER NOT NULL CHECK (c1 BETWEEN 1 AND 10),
  c2               INTEGER NOT NULL CHECK (c2 BETWEEN 1 AND 10),
  c3               INTEGER NOT NULL CHECK (c3 BETWEEN 1 AND 10),
  c4               INTEGER NOT NULL CHECK (c4 BETWEEN 1 AND 10),
  c_atm            INTEGER NOT NULL CHECK (c_atm BETWEEN 1 AND 10),
  score            INTEGER NOT NULL CHECK (score BETWEEN 1 AND 90),
  has_review       INTEGER NOT NULL DEFAULT 1 CHECK (has_review IN (0, 1)),
  has_score        INTEGER NOT NULL DEFAULT 1 CHECK (has_score IN (0, 1)),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_status  ON reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_article ON reviews (article_title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_reviews_user    ON reviews (reviewer_user_id);

CREATE TABLE IF NOT EXISTS rate_limit (
  kind    TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate ON rate_limit (kind, ip_hash, ts);

CREATE TABLE IF NOT EXISTS article_dates (
  article_key   TEXT PRIMARY KEY,
  article_title TEXT NOT NULL,
  created_date  TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO authors (id, name, avatar, created_at)
VALUES ('a1', 'Неизвестный Автор', '', 0);

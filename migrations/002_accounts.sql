-- Миграция 002: аккаунты пользователей, профили, расширенные карточки авторов.
-- ДЛЯ УЖЕ РАБОТАЮЩЕЙ БАЗЫ (версия 1). Выполните ОДИН РАЗ в консоли D1.
-- Существующие рецензии и авторы сохраняются.
-- Если консоль не принимает всё сразу, выполняйте по одной команде (каждая заканчивается «;»).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  username_key  TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

ALTER TABLE authors ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE authors ADD COLUMN owner_user_id TEXT;
ALTER TABLE authors ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN reviewer_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_owner ON authors (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews (reviewer_user_id);

-- Даты создания статей для «Закулисье Майнкрафта Вики».
-- Выполнить один раз в существующей базе Cloudflare D1 перед развёртыванием кода.
CREATE TABLE IF NOT EXISTS article_dates (
  article_key   TEXT PRIMARY KEY,
  article_title TEXT NOT NULL,
  created_date  TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

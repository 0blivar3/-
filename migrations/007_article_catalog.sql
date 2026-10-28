-- Каталог статей с автором, датой создания и ссылкой на страницу в ЗМВ.
-- Выполнить один раз в уже работающей базе Cloudflare D1 перед обновлением кода.
CREATE TABLE IF NOT EXISTS articles (
  article_key   TEXT PRIMARY KEY,
  article_title TEXT NOT NULL UNIQUE COLLATE NOCASE,
  author_id     TEXT NOT NULL,
  created_date  TEXT NOT NULL,
  wiki_url      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Article catalog upgrades: safe single-author backfill plus bounded cover images.
ALTER TABLE articles ADD COLUMN cover_image TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS article_authors (
  article_key TEXT NOT NULL REFERENCES articles(article_key) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_key, author_id)
);
CREATE INDEX IF NOT EXISTS idx_article_authors_author ON article_authors(author_id, article_key);
INSERT OR IGNORE INTO article_authors (article_key, author_id, position)
SELECT article_key, author_id, 0 FROM articles;

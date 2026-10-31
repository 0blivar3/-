import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION = (ROOT / 'migrations/009_article_collaborators_images.sql').read_text()


class ArticleCollaboratorsMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.executescript('''
            CREATE TABLE authors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE articles (
              article_key TEXT PRIMARY KEY,
              article_title TEXT NOT NULL UNIQUE COLLATE NOCASE,
              author_id TEXT NOT NULL,
              created_date TEXT NOT NULL,
              wiki_url TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            INSERT INTO authors VALUES ('a1', 'Первый автор');
            INSERT INTO authors VALUES ('a2', 'Второй автор');
            INSERT INTO articles VALUES ('level-0', 'Уровень 0', 'a1', '2020-01-01', 'https://minecraft-backrooms.fandom.com/wiki/Level_0', 1);
        ''')

    def tearDown(self):
        self.db.close()

    def test_backfills_existing_author_and_supports_collaborators(self):
        self.db.executescript(MIGRATION)
        self.assertEqual(self.db.execute('SELECT author_id FROM article_authors WHERE article_key = ?', ('level-0',)).fetchone(), ('a1',))
        self.db.execute('INSERT INTO article_authors(article_key, author_id, position) VALUES (?, ?, ?)', ('level-0', 'a2', 1))
        self.assertEqual(self.db.execute('SELECT author_id FROM article_authors WHERE article_key = ? ORDER BY position', ('level-0',)).fetchall(), [('a1',), ('a2',)])
        self.assertEqual(self.db.execute('SELECT article_title, author_id, created_date FROM articles').fetchone(), ('Уровень 0', 'a1', '2020-01-01'))

    def test_cover_image_is_empty_for_existing_articles(self):
        self.db.executescript(MIGRATION)
        self.assertEqual(self.db.execute('SELECT cover_image FROM articles WHERE article_key = ?', ('level-0',)).fetchone(), ('',))


if __name__ == '__main__':
    unittest.main()

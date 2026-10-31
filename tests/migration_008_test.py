import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "008_ratings_notifications.sql"


class RatingMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE users (id TEXT PRIMARY KEY);
            CREATE TABLE reviews (
              id TEXT PRIMARY KEY,
              score INTEGER NOT NULL,
              has_score INTEGER NOT NULL DEFAULT 1,
              c1 INTEGER NOT NULL DEFAULT 5,
              c2 INTEGER NOT NULL DEFAULT 6,
              c3 INTEGER NOT NULL DEFAULT 7,
              c4 INTEGER NOT NULL DEFAULT 8,
              c_atm INTEGER NOT NULL DEFAULT 9
            );
            INSERT INTO reviews (id, score, has_score) VALUES ('low', 0, 1);
            INSERT INTO reviews (id, score, has_score) VALUES ('middle', 45, 1);
            INSERT INTO reviews (id, score, has_score) VALUES ('high', 90, 1);
            INSERT INTO reviews (id, score, has_score) VALUES ('review-only', 40, 0);
        """)

    def tearDown(self):
        self.db.close()

    def test_converts_only_scored_reviews_and_preserves_source_rows(self):
        originals = self.db.execute("SELECT * FROM reviews ORDER BY id").fetchall()
        sql = MIGRATION.read_text(encoding="utf-8")
        self.db.executescript(sql)
        ratings = dict(self.db.execute("SELECT review_id, rating FROM review_ratings"))
        self.assertEqual(ratings, {"low": 0, "middle": 50, "high": 100})
        self.assertEqual(self.db.execute("SELECT * FROM reviews ORDER BY id").fetchall(), originals)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM reviews").fetchone()[0], 4)

    def test_is_safe_to_run_twice(self):
        sql = MIGRATION.read_text(encoding="utf-8")
        self.db.executescript(sql)
        self.db.execute("UPDATE review_ratings SET rating = 71 WHERE review_id = 'middle'")
        self.db.executescript(sql)
        self.assertEqual(self.db.execute("SELECT rating FROM review_ratings WHERE review_id = 'middle'").fetchone()[0], 71)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM review_ratings").fetchone()[0], 3)

    def test_review_likes_notifications_are_deduplicated(self):
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO users (id) VALUES ('author'), ('liker')")
        event = ("like-1", "author", "review_liked", "middle", "Заголовок", "liker", "Игрок", 1234)
        sql = "INSERT OR IGNORE INTO notifications (id, user_id, type, review_id, review_title, actor_user_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        self.db.execute(sql, event)
        self.db.execute(sql, ("like-2", *event[1:]))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM notifications").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()

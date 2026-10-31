import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION = (ROOT / 'migrations/010_admin_dashboard.sql').read_text()


class AdminDashboardMigrationTest(unittest.TestCase):
    def test_creates_indexed_site_log_and_accepts_events(self):
        db = sqlite3.connect(':memory:')
        db.executescript(MIGRATION)
        db.execute('INSERT INTO site_logs (id, category, message, created_at) VALUES (?, ?, ?, ?)', ('event-1', 'Каталог', 'Добавлена статья', 1))
        self.assertEqual(db.execute('SELECT actor FROM site_logs WHERE id = ?', ('event-1',)).fetchone(), ('Система',))
        self.assertIn('idx_site_logs_created', {row[1] for row in db.execute('PRAGMA index_list(site_logs)')})
        db.executescript(MIGRATION)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM site_logs').fetchone(), (1,))
        db.close()


if __name__ == '__main__':
    unittest.main()

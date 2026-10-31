-- Обновление 2.2: оценки 0–100 и уведомления.
-- Безопасный повторный запуск: таблицы/индексы создаются условно,
-- преобразование старых оценок выполняется только при отсутствии новой записи.
-- Старые поля c1..c_atm и score намеренно не изменяются.

CREATE TABLE IF NOT EXISTS review_ratings (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 100)
);

INSERT OR IGNORE INTO review_ratings (review_id, rating)
SELECT id, MIN(100, MAX(0, CAST(ROUND(score * 100.0 / 90.0) AS INTEGER)))
FROM reviews
WHERE COALESCE(has_score, 1) = 1;

CREATE TABLE IF NOT EXISTS review_decisions (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('rejected')),
  decided_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('review_approved', 'review_rejected', 'review_liked')),
  review_id TEXT NOT NULL,
  review_title TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_like_once
  ON notifications (user_id, type, review_id, actor_user_id)
  WHERE type = 'review_liked';
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_review_once
  ON notifications (user_id, type, review_id)
  WHERE type IN ('review_approved', 'review_rejected');

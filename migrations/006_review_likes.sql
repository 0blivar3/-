-- Лайки публичных пользовательских рецензий. У одного аккаунта — не больше одного лайка на рецензию.
CREATE TABLE IF NOT EXISTS review_likes (
  review_id  TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (review_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_review_likes_user ON review_likes (user_id);

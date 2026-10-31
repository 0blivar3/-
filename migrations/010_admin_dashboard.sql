-- Administrative activity log used by the protected dashboard.
CREATE TABLE IF NOT EXISTS site_logs (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'Система',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_logs_created ON site_logs(created_at DESC);

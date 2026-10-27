-- Version 4: let users submit a rating without a written review, or a review without a score.
-- Run once against the existing Cloudflare D1 database before deploying this version.
ALTER TABLE reviews ADD COLUMN has_review INTEGER NOT NULL DEFAULT 1 CHECK (has_review IN (0, 1));
ALTER TABLE reviews ADD COLUMN has_score INTEGER NOT NULL DEFAULT 1 CHECK (has_score IN (0, 1));

-- Version 3: social links and favorite content in user profiles.
-- Run once against the existing Cloudflare D1 database before deploying this version.
ALTER TABLE users ADD COLUMN social_links TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN favorite_author_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN favorite_articles TEXT NOT NULL DEFAULT '[]';

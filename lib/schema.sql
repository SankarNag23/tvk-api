-- TVK Database Schema
-- LOCAL SQLite database for curated content (committed to repo)
-- Members are stored in TURSO (remote) for persistence

-- ============================================
-- HERO CAROUSEL IMAGES (High-quality landscape)
-- ============================================
CREATE TABLE IF NOT EXISTS hero_images (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  thumbnail_url TEXT,
  title TEXT NOT NULL,
  title_ta TEXT,
  alt_text TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  width INTEGER NOT NULL CHECK(width >= 1280),
  height INTEGER NOT NULL CHECK(height >= 720),
  aspect_ratio REAL,
  subject TEXT DEFAULT 'vijay' CHECK(subject IN ('vijay', 'tvk', 'sengottaiyan', 'bussy_anand', 'rally', 'event')),
  quality_score INTEGER DEFAULT 50 CHECK(quality_score >= 0 AND quality_score <= 100),
  status TEXT DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'hidden', 'featured')),
  display_order INTEGER DEFAULT 0,
  published_at TEXT,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  CHECK(aspect_ratio >= 1.3)
);

CREATE INDEX IF NOT EXISTS idx_hero_active ON hero_images(status, quality_score DESC, display_order);
CREATE INDEX IF NOT EXISTS idx_hero_subject ON hero_images(subject);

-- ============================================
-- NEWS ARTICLES
-- ============================================

-- News articles from RSS feeds
CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT UNIQUE NOT NULL,
  image_url TEXT,
  source TEXT NOT NULL,
  language TEXT DEFAULT 'en' CHECK(language IN ('en', 'ta')),
  category TEXT DEFAULT 'general' CHECK(category IN ('rally', 'announcement', 'event', 'interview', 'opinion', 'general')),
  relevance_score INTEGER DEFAULT 50 CHECK(relevance_score >= 0 AND relevance_score <= 100),
  status TEXT DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'hidden', 'featured')),
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Media items (images and videos)
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('image', 'video')),
  url TEXT UNIQUE NOT NULL,
  thumbnail_url TEXT,
  title TEXT,
  description TEXT,
  source TEXT NOT NULL,
  embed_url TEXT,
  relevance_score INTEGER DEFAULT 50 CHECK(relevance_score >= 0 AND relevance_score <= 100),
  status TEXT DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'hidden', 'featured')),
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Twitter/X posts
CREATE TABLE IF NOT EXISTS tweets (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  author_handle TEXT,
  author_avatar TEXT,
  url TEXT UNIQUE NOT NULL,
  media_urls TEXT,
  likes INTEGER DEFAULT 0,
  retweets INTEGER DEFAULT 0,
  relevance_score INTEGER DEFAULT 50 CHECK(relevance_score >= 0 AND relevance_score <= 100),
  status TEXT DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'hidden', 'featured')),
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Member registrations
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  membership_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  district TEXT NOT NULL,
  message TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'active')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Curation run logs
CREATE TABLE IF NOT EXISTS curation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  items_fetched INTEGER DEFAULT 0,
  items_added INTEGER DEFAULT 0,
  items_updated INTEGER DEFAULT 0,
  items_skipped INTEGER DEFAULT 0,
  errors TEXT,
  started_at TEXT,
  completed_at TEXT
);

-- Settings/configuration (for static images, feature flags, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_news_status ON news(status);
CREATE INDEX IF NOT EXISTS idx_news_language ON news(language);
CREATE INDEX IF NOT EXISTS idx_news_category ON news(category);
CREATE INDEX IF NOT EXISTS idx_news_score ON news(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_status ON media(status);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_score ON media(relevance_score DESC);

CREATE INDEX IF NOT EXISTS idx_tweets_status ON tweets(status);
CREATE INDEX IF NOT EXISTS idx_tweets_published ON tweets(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_district ON members(district);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);

-- Triggers for updated_at
CREATE TRIGGER IF NOT EXISTS news_updated_at
  AFTER UPDATE ON news
  FOR EACH ROW
BEGIN
  UPDATE news SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS media_updated_at
  AFTER UPDATE ON media
  FOR EACH ROW
BEGIN
  UPDATE media SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS members_updated_at
  AFTER UPDATE ON members
  FOR EACH ROW
BEGIN
  UPDATE members SET updated_at = datetime('now') WHERE id = NEW.id;
END;

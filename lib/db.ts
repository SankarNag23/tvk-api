/**
 * Turso Database Client for TVK API
 *
 * Uses @libsql/client for serverless-compatible SQLite (Turso)
 * All tables: hero_images, news, media, tweets, members, curation_logs, settings
 *
 * Setup:
 * 1. Create Turso account: https://turso.tech
 * 2. Create database: turso db create tvk-content
 * 3. Get URL: turso db show tvk-content --url
 * 4. Create token: turso db tokens create tvk-content
 * 5. Add to Vercel: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
 */

import { createClient, type Client, type ResultSet } from '@libsql/client'

// Singleton client
let client: Client | null = null

// Initialize Turso client
export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL?.trim()
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim()

    if (!url || !authToken) {
      throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set')
    }

    client = createClient({ url, authToken })
  }
  return client
}

// Close connection (for cleanup)
export function closeDB(): void {
  if (client) {
    client.close()
    client = null
  }
}

// Initialize database schema
export async function initDB(): Promise<void> {
  const db = getTurso()

  // Hero images table (4K/HD for carousel)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS hero_images (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      thumbnail_url TEXT,
      title TEXT NOT NULL,
      title_ta TEXT,
      alt_text TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      aspect_ratio REAL,
      subject TEXT DEFAULT 'vijay',
      quality_score INTEGER DEFAULT 50,
      status TEXT DEFAULT 'approved',
      display_order INTEGER DEFAULT 0,
      published_at TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // News articles
  await db.execute(`
    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT UNIQUE NOT NULL,
      image_url TEXT,
      source TEXT NOT NULL,
      language TEXT DEFAULT 'en',
      category TEXT DEFAULT 'general',
      relevance_score INTEGER DEFAULT 50,
      status TEXT DEFAULT 'approved',
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Media items (images and videos)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      thumbnail_url TEXT,
      title TEXT,
      description TEXT,
      source TEXT NOT NULL,
      embed_url TEXT,
      width INTEGER,
      height INTEGER,
      relevance_score INTEGER DEFAULT 50,
      status TEXT DEFAULT 'approved',
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Twitter/X posts
  await db.execute(`
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
      relevance_score INTEGER DEFAULT 50,
      status TEXT DEFAULT 'approved',
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Curation logs
  await db.execute(`
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
    )
  `)

  // Settings
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      description TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_hero_status ON hero_images(status, quality_score DESC)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_news_status ON news(status, published_at DESC)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_media_status ON media(status, relevance_score DESC)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tweets_status ON tweets(status, published_at DESC)`)

  console.log('Database schema initialized')
}

// ============== HERO IMAGES ==============

export interface HeroImage {
  id: string
  url: string
  thumbnail_url?: string
  title: string
  title_ta?: string
  alt_text?: string
  source: string
  source_url?: string
  width: number
  height: number
  aspect_ratio?: number
  subject: string
  quality_score: number
  status: string
  display_order: number
  published_at?: string
  expires_at?: string
  created_at?: string
  updated_at?: string
}

export async function insertHeroImage(image: Omit<HeroImage, 'created_at' | 'updated_at' | 'aspect_ratio'>): Promise<boolean> {
  const db = getTurso()
  try {
    const aspectRatio = image.width / image.height
    await db.execute({
      sql: `INSERT INTO hero_images (id, url, thumbnail_url, title, title_ta, alt_text, source, source_url, width, height, aspect_ratio, subject, quality_score, status, display_order, published_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              title = excluded.title,
              quality_score = MAX(hero_images.quality_score, excluded.quality_score),
              updated_at = datetime('now')`,
      args: [
        image.id, image.url, image.thumbnail_url || null, image.title, image.title_ta || null,
        image.alt_text || null, image.source, image.source_url || null, image.width, image.height,
        aspectRatio, image.subject, image.quality_score, image.status, image.display_order,
        image.published_at || null, image.expires_at || null
      ]
    })
    return true
  } catch (err) {
    console.error('Error inserting hero image:', err)
    return false
  }
}

export async function getHeroImages(options: {
  limit?: number
  subject?: string
  activeOnly?: boolean
} = {}): Promise<HeroImage[]> {
  const db = getTurso()
  const { limit = 15, subject, activeOnly = true } = options

  let sql = 'SELECT * FROM hero_images WHERE 1=1'
  const args: any[] = []

  if (activeOnly) {
    sql += ` AND status IN ('approved', 'featured')`
    sql += ` AND (expires_at IS NULL OR expires_at > datetime('now'))`
  }

  if (subject) {
    sql += ' AND subject = ?'
    args.push(subject)
  }

  sql += ' ORDER BY display_order ASC, quality_score DESC, created_at DESC LIMIT ?'
  args.push(limit)

  const result = await db.execute({ sql, args })
  return result.rows.map(row => rowToHeroImage(row))
}

export async function heroImageExists(url: string): Promise<boolean> {
  const db = getTurso()
  const result = await db.execute({ sql: 'SELECT 1 FROM hero_images WHERE url = ?', args: [url] })
  return result.rows.length > 0
}

export async function cleanupExpiredHeroImages(): Promise<number> {
  const db = getTurso()
  const result = await db.execute({
    sql: `DELETE FROM hero_images WHERE expires_at < datetime('now') AND status != 'featured'`,
    args: []
  })
  return result.rowsAffected
}

function rowToHeroImage(row: any): HeroImage {
  return {
    id: row.id as string,
    url: row.url as string,
    thumbnail_url: row.thumbnail_url as string | undefined,
    title: row.title as string,
    title_ta: row.title_ta as string | undefined,
    alt_text: row.alt_text as string | undefined,
    source: row.source as string,
    source_url: row.source_url as string | undefined,
    width: row.width as number,
    height: row.height as number,
    aspect_ratio: row.aspect_ratio as number | undefined,
    subject: row.subject as string,
    quality_score: row.quality_score as number,
    status: row.status as string,
    display_order: row.display_order as number,
    published_at: row.published_at as string | undefined,
    expires_at: row.expires_at as string | undefined,
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  }
}

// ============== NEWS ==============

export interface NewsItem {
  id: string
  title: string
  description?: string
  url: string
  image_url?: string
  source: string
  language: string
  category: string
  relevance_score: number
  status: string
  published_at?: string
  created_at?: string
  updated_at?: string
}

export async function insertNews(news: Omit<NewsItem, 'created_at' | 'updated_at'>): Promise<boolean> {
  const db = getTurso()
  try {
    await db.execute({
      sql: `INSERT INTO news (id, title, description, url, image_url, source, language, category, relevance_score, status, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              title = excluded.title,
              description = excluded.description,
              image_url = COALESCE(excluded.image_url, news.image_url),
              relevance_score = excluded.relevance_score,
              updated_at = datetime('now')`,
      args: [
        news.id, news.title, news.description || null, news.url, news.image_url || null,
        news.source, news.language, news.category, news.relevance_score, news.status,
        news.published_at || null
      ]
    })
    return true
  } catch (err) {
    console.error('Error inserting news:', err)
    return false
  }
}

export async function getNews(options: {
  limit?: number
  offset?: number
  language?: string
  category?: string
  status?: string
} = {}): Promise<NewsItem[]> {
  const db = getTurso()
  const { limit = 20, offset = 0, language, category, status = 'approved' } = options

  let sql = `SELECT * FROM news WHERE status IN ('approved', 'featured')`
  const args: any[] = []

  if (language) {
    sql += ' AND language = ?'
    args.push(language)
  }
  if (category) {
    sql += ' AND category = ?'
    args.push(category)
  }

  sql += ' ORDER BY published_at DESC, relevance_score DESC LIMIT ? OFFSET ?'
  args.push(limit, offset)

  const result = await db.execute({ sql, args })
  return result.rows.map(row => rowToNewsItem(row))
}

export async function newsUrlExists(url: string): Promise<boolean> {
  const db = getTurso()
  const result = await db.execute({ sql: 'SELECT 1 FROM news WHERE url = ?', args: [url] })
  return result.rows.length > 0
}

function rowToNewsItem(row: any): NewsItem {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    url: row.url as string,
    image_url: row.image_url as string | undefined,
    source: row.source as string,
    language: row.language as string,
    category: row.category as string,
    relevance_score: row.relevance_score as number,
    status: row.status as string,
    published_at: row.published_at as string | undefined,
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  }
}

// ============== MEDIA ==============

export interface MediaItem {
  id: string
  type: 'image' | 'video'
  url: string
  thumbnail_url?: string
  title?: string
  description?: string
  source: string
  embed_url?: string
  width?: number
  height?: number
  relevance_score: number
  status: string
  published_at?: string
  created_at?: string
  updated_at?: string
}

export async function insertMedia(media: Omit<MediaItem, 'created_at' | 'updated_at'>): Promise<boolean> {
  const db = getTurso()
  try {
    await db.execute({
      sql: `INSERT INTO media (id, type, url, thumbnail_url, title, description, source, embed_url, width, height, relevance_score, status, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              title = COALESCE(excluded.title, media.title),
              thumbnail_url = COALESCE(excluded.thumbnail_url, media.thumbnail_url),
              relevance_score = excluded.relevance_score,
              updated_at = datetime('now')`,
      args: [
        media.id, media.type, media.url, media.thumbnail_url || null, media.title || null,
        media.description || null, media.source, media.embed_url || null,
        media.width || null, media.height || null, media.relevance_score, media.status,
        media.published_at || null
      ]
    })
    return true
  } catch (err) {
    console.error('Error inserting media:', err)
    return false
  }
}

export async function getMedia(options: {
  limit?: number
  offset?: number
  type?: 'image' | 'video'
  status?: string
} = {}): Promise<MediaItem[]> {
  const db = getTurso()
  const { limit = 20, offset = 0, type } = options

  let sql = `SELECT * FROM media WHERE status IN ('approved', 'featured')`
  const args: any[] = []

  if (type) {
    sql += ' AND type = ?'
    args.push(type)
  }

  sql += ' ORDER BY relevance_score DESC, published_at DESC LIMIT ? OFFSET ?'
  args.push(limit, offset)

  const result = await db.execute({ sql, args })
  return result.rows.map(row => rowToMediaItem(row))
}

export async function mediaUrlExists(url: string): Promise<boolean> {
  const db = getTurso()
  const result = await db.execute({ sql: 'SELECT 1 FROM media WHERE url = ?', args: [url] })
  return result.rows.length > 0
}

function rowToMediaItem(row: any): MediaItem {
  return {
    id: row.id as string,
    type: row.type as 'image' | 'video',
    url: row.url as string,
    thumbnail_url: row.thumbnail_url as string | undefined,
    title: row.title as string | undefined,
    description: row.description as string | undefined,
    source: row.source as string,
    embed_url: row.embed_url as string | undefined,
    width: row.width as number | undefined,
    height: row.height as number | undefined,
    relevance_score: row.relevance_score as number,
    status: row.status as string,
    published_at: row.published_at as string | undefined,
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  }
}

// ============== TWEETS ==============

export interface TweetItem {
  id: string
  text: string
  author: string
  author_handle?: string
  author_avatar?: string
  url: string
  media_urls?: string
  likes: number
  retweets: number
  relevance_score: number
  status: string
  published_at?: string
  created_at?: string
}

export async function insertTweet(tweet: Omit<TweetItem, 'created_at'>): Promise<boolean> {
  const db = getTurso()
  try {
    await db.execute({
      sql: `INSERT INTO tweets (id, text, author, author_handle, author_avatar, url, media_urls, likes, retweets, relevance_score, status, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              likes = excluded.likes,
              retweets = excluded.retweets`,
      args: [
        tweet.id, tweet.text, tweet.author, tweet.author_handle || null, tweet.author_avatar || null,
        tweet.url, tweet.media_urls || null, tweet.likes, tweet.retweets, tweet.relevance_score,
        tweet.status, tweet.published_at || null
      ]
    })
    return true
  } catch (err) {
    console.error('Error inserting tweet:', err)
    return false
  }
}

export async function getTweets(options: {
  limit?: number
  offset?: number
} = {}): Promise<TweetItem[]> {
  const db = getTurso()
  const { limit = 20, offset = 0 } = options

  const result = await db.execute({
    sql: `SELECT * FROM tweets WHERE status IN ('approved', 'featured') ORDER BY published_at DESC, likes DESC LIMIT ? OFFSET ?`,
    args: [limit, offset]
  })
  return result.rows.map(row => ({
    id: row.id as string,
    text: row.text as string,
    author: row.author as string,
    author_handle: row.author_handle as string | undefined,
    author_avatar: row.author_avatar as string | undefined,
    url: row.url as string,
    media_urls: row.media_urls as string | undefined,
    likes: row.likes as number,
    retweets: row.retweets as number,
    relevance_score: row.relevance_score as number,
    status: row.status as string,
    published_at: row.published_at as string | undefined,
    created_at: row.created_at as string | undefined,
  }))
}

export async function tweetExists(id: string): Promise<boolean> {
  const db = getTurso()
  const result = await db.execute({ sql: 'SELECT 1 FROM tweets WHERE id = ?', args: [id] })
  return result.rows.length > 0
}

// ============== CURATION LOGS ==============

export interface CurationLog {
  run_id: string
  source: string
  items_fetched: number
  items_added: number
  items_updated: number
  items_skipped: number
  errors?: string
  started_at: string
  completed_at?: string
}

export async function logCurationRun(log: CurationLog): Promise<boolean> {
  const db = getTurso()
  try {
    await db.execute({
      sql: `INSERT INTO curation_logs (run_id, source, items_fetched, items_added, items_updated, items_skipped, errors, started_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        log.run_id, log.source, log.items_fetched, log.items_added, log.items_updated,
        log.items_skipped, log.errors || null, log.started_at, log.completed_at || null
      ]
    })
    return true
  } catch (err) {
    console.error('Error logging curation run:', err)
    return false
  }
}

export async function getLastCurationTime(): Promise<string | null> {
  const db = getTurso()
  const result = await db.execute({ sql: 'SELECT MAX(completed_at) as last_run FROM curation_logs', args: [] })
  return result.rows[0]?.last_run as string | null
}

// ============== SETTINGS ==============

export async function getSetting(key: string): Promise<string | null> {
  const db = getTurso()
  const result = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] })
  return result.rows[0]?.value as string | null
}

export async function setSetting(key: string, value: string, description?: string): Promise<boolean> {
  const db = getTurso()
  try {
    await db.execute({
      sql: `INSERT INTO settings (key, value, description) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [key, value, description || null]
    })
    return true
  } catch (err) {
    console.error('Error setting value:', err)
    return false
  }
}

// ============== CLEANUP ==============

export async function cleanupOldContent(daysOld: number = 30, minScore: number = 60): Promise<{ news: number; media: number; tweets: number }> {
  const db = getTurso()
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysOld)
  const cutoff = cutoffDate.toISOString()

  const newsResult = await db.execute({
    sql: `DELETE FROM news WHERE published_at < ? AND relevance_score < ? AND status != 'featured'`,
    args: [cutoff, minScore]
  })

  const mediaResult = await db.execute({
    sql: `DELETE FROM media WHERE published_at < ? AND relevance_score < ? AND status != 'featured'`,
    args: [cutoff, minScore]
  })

  const tweetsResult = await db.execute({
    sql: `DELETE FROM tweets WHERE published_at < ? AND status != 'featured'`,
    args: [cutoff]
  })

  return {
    news: newsResult.rowsAffected,
    media: mediaResult.rowsAffected,
    tweets: tweetsResult.rowsAffected
  }
}

// ============== STATISTICS ==============

export async function getStats(): Promise<{
  hero_images: number
  news: number
  media: number
  tweets: number
  last_curation: string | null
}> {
  const db = getTurso()

  const heroResult = await db.execute({ sql: `SELECT COUNT(*) as count FROM hero_images WHERE status IN ('approved', 'featured')`, args: [] })
  const newsResult = await db.execute({ sql: `SELECT COUNT(*) as count FROM news WHERE status IN ('approved', 'featured')`, args: [] })
  const mediaResult = await db.execute({ sql: `SELECT COUNT(*) as count FROM media WHERE status IN ('approved', 'featured')`, args: [] })
  const tweetsResult = await db.execute({ sql: `SELECT COUNT(*) as count FROM tweets WHERE status IN ('approved', 'featured')`, args: [] })
  const lastCuration = await getLastCurationTime()

  return {
    hero_images: heroResult.rows[0]?.count as number || 0,
    news: newsResult.rows[0]?.count as number || 0,
    media: mediaResult.rows[0]?.count as number || 0,
    tweets: tweetsResult.rows[0]?.count as number || 0,
    last_curation: lastCuration
  }
}

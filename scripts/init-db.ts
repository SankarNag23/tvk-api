#!/usr/bin/env npx ts-node

/**
 * Initialize TVK Database
 * Run: npx ts-node scripts/init-db.ts
 */

import { initDB, setSetting, getDB, closeDB } from '../lib/db'

// Official TVK images to seed
const TVK_STATIC_IMAGES = [
  {
    id: 'tvk-logo',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/TVK_Logo.svg/800px-TVK_Logo.svg.png',
    title: 'TVK Official Logo',
    title_ta: 'தமிழக வெற்றிக் கழகம் சின்னம்',
  },
  {
    id: 'vijay-portrait-1',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/Vijay_in_2014.jpg/440px-Vijay_in_2014.jpg',
    title: 'Thalapathy Vijay',
    title_ta: 'தளபதி விஜய்',
  },
  {
    id: 'tvk-flag',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/TVK_Logo.svg/400px-TVK_Logo.svg.png',
    title: 'TVK Party Flag',
    title_ta: 'தவெக கொடி',
  },
]

// Default settings
const DEFAULT_SETTINGS = {
  'curation.min_score': '50',
  'curation.max_news': '50',
  'curation.max_media': '100',
  'curation.max_tweets': '50',
  'curation.cleanup_days': '30',
  'twitter.apify_actor': 'apidojo/twitter-scraper',
  'twitter.accounts': JSON.stringify(['TVKVijayHQ', 'TVKOfficial']),
}

async function main() {
  console.log('Initializing TVK Database...\n')

  // Initialize schema
  console.log('1. Creating database schema...')
  initDB()
  console.log('   Schema created successfully.\n')

  // Seed settings
  console.log('2. Seeding default settings...')
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    setSetting(key, value, `Default setting: ${key}`)
    console.log(`   Set: ${key}`)
  }
  console.log('')

  // Seed static images
  console.log('3. Seeding static TVK images...')
  setSetting('static.images', JSON.stringify(TVK_STATIC_IMAGES), 'Official TVK images for gallery')
  console.log(`   Added ${TVK_STATIC_IMAGES.length} static images.\n`)

  // Insert static images into media table
  console.log('4. Adding static images to media table...')
  const db = getDB()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO media (id, type, url, thumbnail_url, title, source, relevance_score, status, published_at)
    VALUES (?, 'image', ?, ?, ?, 'TVK Official', 100, 'featured', datetime('now'))
  `)

  for (const img of TVK_STATIC_IMAGES) {
    stmt.run(img.id, img.url, img.url, img.title)
    console.log(`   Added: ${img.title}`)
  }
  console.log('')

  // Show stats
  console.log('5. Database statistics:')
  const newsCount = db.prepare('SELECT COUNT(*) as c FROM news').get() as { c: number }
  const mediaCount = db.prepare('SELECT COUNT(*) as c FROM media').get() as { c: number }
  const tweetsCount = db.prepare('SELECT COUNT(*) as c FROM tweets').get() as { c: number }
  const membersCount = db.prepare('SELECT COUNT(*) as c FROM members').get() as { c: number }
  const settingsCount = db.prepare('SELECT COUNT(*) as c FROM settings').get() as { c: number }

  console.log(`   News:     ${newsCount.c}`)
  console.log(`   Media:    ${mediaCount.c}`)
  console.log(`   Tweets:   ${tweetsCount.c}`)
  console.log(`   Members:  ${membersCount.c}`)
  console.log(`   Settings: ${settingsCount.c}`)

  closeDB()
  console.log('\nDatabase initialization complete!')
  console.log('Database file: data/tvk.db')
}

main().catch(console.error)

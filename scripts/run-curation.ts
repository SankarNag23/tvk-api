#!/usr/bin/env npx ts-node

/**
 * Run Curation Locally
 * This script runs the curation process and updates the SQLite database.
 * Run: npx ts-node scripts/run-curation.ts
 *
 * Requires environment variables:
 * - GROQ_API_KEY
 * - APIFY_API_KEY (optional, for Twitter)
 */

import { initDB, closeDB, insertNews, insertMedia, insertTweet, newsUrlExists, mediaUrlExists, tweetExists, logCurationRun, cleanupOldContent, getSetting } from '../lib/db'

// Load environment from .env.local
import { config } from 'dotenv'
config({ path: '.env.local' })

const GROQ_API_KEY = process.env.GROQ_API_KEY

if (!GROQ_API_KEY) {
  console.error('ERROR: GROQ_API_KEY environment variable is required')
  process.exit(1)
}

// News RSS sources
const NEWS_SOURCES = [
  { name: 'TVK Vijay News', rss: 'https://news.google.com/rss/search?q=%22TVK%22+%22Vijay%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'TVK Tamil', rss: 'https://news.google.com/rss/search?q=%22தமிழக+வெற்றிக்+கழகம்%22&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
  { name: 'Vijay Politics', rss: 'https://news.google.com/rss/search?q=%22Tamilaga+Vettri+Kazhagam%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
]

// YouTube channels
const YOUTUBE_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
]

const TVK_KEYWORDS = [
  'tvk', 'tamilaga vettri', 'தமிழக வெற்றி', 'தவெக',
  'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
  'vijay party', 'vijay politics', 'விஜய் கட்சி',
]

function isTVKRelated(text: string): boolean {
  const lowerText = text.toLowerCase()
  return TVK_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase())) ||
    ((lowerText.includes('vijay') || lowerText.includes('விஜய்')) &&
     ['party', 'politics', 'rally', 'speech', 'கட்சி', 'அரசியல்'].some(ctx => lowerText.includes(ctx)))
}

function detectLanguage(text: string): 'ta' | 'en' {
  return /[\u0B80-\u0BFF]/.test(text) ? 'ta' : 'en'
}

function categorizeNews(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes('rally') || lower.includes('பேரணி')) return 'rally'
  if (lower.includes('announce') || lower.includes('அறிவிப்பு')) return 'announcement'
  if (lower.includes('interview') || lower.includes('பேட்டி')) return 'interview'
  if (lower.includes('event') || lower.includes('நிகழ்வு')) return 'event'
  return 'general'
}

async function scoreWithAI(items: { title: string }[]): Promise<number[]> {
  const scores: number[] = []

  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5)
    const prompt = `Score each news item for TVK relevance (0-100):
${batch.map((item, idx) => `${idx + 1}. "${item.title}"`).join('\n')}
Respond ONLY with JSON array: [score1, score2, ...]`

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 100,
        }),
      })

      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content || '[]'
      const match = content.match(/\[[\d,\s]+\]/)
      const batchScores = match ? JSON.parse(match[0]) : batch.map(() => 50)
      scores.push(...batchScores)
    } catch {
      scores.push(...batch.map(() => 50))
    }
  }

  return scores
}

async function main() {
  console.log('Starting TVK Curation...\n')
  const startedAt = new Date().toISOString()
  const runId = `curation-${Date.now()}`

  initDB()

  const stats = {
    news: { fetched: 0, added: 0, skipped: 0 },
    media: { fetched: 0, added: 0, skipped: 0 },
  }
  const errors: string[] = []

  // Fetch news
  console.log('1. Fetching news from RSS feeds...')
  const newsItems: any[] = []

  for (const source of NEWS_SOURCES) {
    try {
      const response = await fetch(source.rss, {
        headers: { 'User-Agent': 'TVK-Curation-Bot/2.0' },
      })

      if (!response.ok) {
        errors.push(`${source.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []

      for (const item of items.slice(0, 15)) {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                   || item.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const link = item.match(/<link>([^<]+)<\/link>/)?.[1] || ''
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || ''
        const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                         || item.match(/<description>([^<]*)<\/description>/)?.[1] || ''

        newsItems.push({
          title: title.replace(/<[^>]*>/g, '').trim(),
          description: description.replace(/<[^>]*>/g, '').substring(0, 500),
          url: link.trim(),
          source: source.name,
          lang: source.lang,
          pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        })
      }

      console.log(`   ${source.name}: fetched ${items.length} items`)
    } catch (err: any) {
      errors.push(`${source.name}: ${err.message}`)
      console.log(`   ${source.name}: ERROR - ${err.message}`)
    }
  }

  stats.news.fetched = newsItems.length
  console.log(`   Total news fetched: ${newsItems.length}\n`)

  // Score with AI
  console.log('2. Scoring news with AI...')
  const scores = await scoreWithAI(newsItems)
  console.log(`   Scored ${scores.length} items\n`)

  // Insert news
  console.log('3. Inserting news into database...')
  const minScore = parseInt(getSetting('curation.min_score') || '50')

  for (let i = 0; i < newsItems.length; i++) {
    const item = newsItems[i]
    const score = scores[i] || 50

    if (!isTVKRelated(`${item.title} ${item.description}`) || score < minScore) {
      stats.news.skipped++
      continue
    }

    if (newsUrlExists(item.url)) {
      stats.news.skipped++
      continue
    }

    const success = insertNews({
      id: `news-${Date.now()}-${i}`,
      title: item.title,
      description: item.description,
      url: item.url,
      source: item.source,
      language: item.lang || detectLanguage(item.title),
      category: categorizeNews(item.title),
      relevance_score: score,
      status: score >= 80 ? 'approved' : 'pending',
      published_at: item.pubDate,
    })

    if (success) stats.news.added++
    else stats.news.skipped++
  }

  console.log(`   Added: ${stats.news.added}, Skipped: ${stats.news.skipped}\n`)

  // Fetch YouTube videos
  console.log('4. Fetching YouTube videos...')

  for (const channel of YOUTUBE_CHANNELS) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      const response = await fetch(rssUrl)

      if (!response.ok) continue

      const text = await response.text()
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 10)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        if (!isTVKRelated(title)) continue

        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId) continue

        stats.media.fetched++
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`

        if (mediaUrlExists(videoUrl)) {
          stats.media.skipped++
          continue
        }

        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''

        const success = insertMedia({
          id: `vid-${videoId}`,
          type: 'video',
          url: videoUrl,
          thumbnail_url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          title: title.trim(),
          source: channel.name,
          embed_url: `https://www.youtube.com/embed/${videoId}`,
          relevance_score: 80,
          status: 'approved',
          published_at: published,
        })

        if (success) stats.media.added++
        else stats.media.skipped++
      }

      console.log(`   ${channel.name}: processed`)
    } catch (err: any) {
      errors.push(`YouTube ${channel.name}: ${err.message}`)
    }
  }

  console.log(`   Videos added: ${stats.media.added}\n`)

  // Cleanup
  console.log('5. Cleaning up old content...')
  const cleanup = cleanupOldContent(30, minScore)
  console.log(`   Cleaned: ${cleanup.news} news, ${cleanup.media} media\n`)

  // Log run
  logCurationRun({
    run_id: runId,
    source: 'local',
    items_fetched: stats.news.fetched + stats.media.fetched,
    items_added: stats.news.added + stats.media.added,
    items_updated: 0,
    items_skipped: stats.news.skipped + stats.media.skipped,
    errors: errors.length > 0 ? JSON.stringify(errors) : undefined,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
  })

  closeDB()

  console.log('=== Curation Complete ===')
  console.log(`News: ${stats.news.added} added, ${stats.news.skipped} skipped`)
  console.log(`Media: ${stats.media.added} added, ${stats.media.skipped} skipped`)
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`)
  }
}

main().catch(err => {
  console.error('Curation failed:', err)
  process.exit(1)
})

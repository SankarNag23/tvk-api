import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  initDB,
  insertMedia,
  mediaUrlExists,
  insertNews,
  newsUrlExists,
  cleanupOldContent,
  logCurationRun
} from '../lib/db'

/**
 * POST /api/curate-media
 * Web scrapes YouTube videos and RSS news for TVK
 * Subjects: Vijay, Sengottaiyan, Bussy Anand, TVK party
 * Filter: POSITIVE news only, Tamil content preferred
 * Runs every 4 hours via GitHub Action
 */

interface ScrapedMedia {
  type: 'video' | 'news' | 'image'
  url: string
  thumbnail_url?: string
  embed_url?: string
  title: string
  description?: string
  source: string
  published_at?: string
}

// Keywords to EXCLUDE (negative/opposition/irrelevant content)
const NEGATIVE_KEYWORDS = [
  // Political Opposition
  'dmk', 'admk', 'aiadmk', 'bjp', 'congress', 'pmk',
  'stalin', 'edappadi', 'eps', 'ops', 'annamalai', 'seeman',
  // Negative Sentiment
  'against', 'oppose', 'criticize', 'attack', 'slam', 'fail', 'flop', 'controversy',
  'arrest', 'case', 'complaint', 'troll', 'mock', 'defeat', 'scam', 'scandal',
  // Other Famous People named Vijay
  'vijay sethupathi', 'vijay devarakonda', 'vijay antony',
  // Irrelevant Topics (e.g., sports)
  'cricket', 'football', 'sports', 'match', 'score', 'goal', 'century', 'bowling', 'batting', 'ipl',
]

// Tamil news RSS feeds
const RSS_FEEDS = [
  { name: 'Google News TVK', url: 'https://news.google.com/rss/search?q=TVK+Vijay+party&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Google News Tamil TVK', url: 'https://news.google.com/rss/search?q=தவெக+விஜய்&hl=ta&gl=IN&ceid=IN:ta' },
  { name: 'Google News Tamilaga Vettri', url: 'https://news.google.com/rss/search?q=Tamilaga+Vettri+Kazhagam&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Google News Sengottaiyan', url: 'https://news.google.com/rss/search?q=Sengottaiyan+TVK&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Google News Bussy Anand', url: 'https://news.google.com/rss/search?q=Bussy+Anand+TVK&hl=en-IN&gl=IN&ceid=IN:en' },
]

// YouTube channels for Tamil news
const YOUTUBE_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
  { name: 'News18 Tamil', channelId: 'UCat88i6_rELqI_prwvjspRA' },
  { name: 'Puthiya Thalaimurai', channelId: 'UCt1XTn2EmBXLk7bB5OV2N3g' },
  { name: 'Kalaignar TV', channelId: 'UCjt8u9a1vU0J6xsqAE8knSg' },
  { name: 'Jaya Plus', channelId: 'UCuOeZgvvUP0gSoIyoSFvPEw' },
]

// Check if content is TVK-related and positive
function isValidContent(text: string): boolean {
  const lower = text.toLowerCase()

  // Tier 1: Strong, specific keywords that are unambiguously about the party.
  const hasSpecificTVKKeyword = lower.includes('tvk') ||
                                lower.includes('தவெக') ||
                                lower.includes('tamilaga vettri') ||
                                lower.includes('sengottaiyan') ||
                                lower.includes('செங்கோட்டையன்') ||
                                lower.includes('bussy anand') ||
                                lower.includes('புஸ்ஸி');

  // Tier 2: The ambiguous keyword "Vijay" requires additional context to be considered valid.
  const hasVijay = lower.includes('vijay') || lower.includes('விஜய்');
  const hasPoliticalContext = lower.includes('party') ||
                              lower.includes('political') ||
                              lower.includes('leader') ||
                              lower.includes('kazhagam') ||
                              lower.includes('arivu') || // For words like அறிக்கை (announcement)
                              lower.includes('thalaivar') || // Leader
                              lower.includes('actor vijay') || // Differentiates from other Vijays
                              lower.includes('tamil');

  // A news item is considered relevant if it has a specific TVK keyword OR the keyword "Vijay" with political context.
  const isRelevant = hasSpecificTVKKeyword || (hasVijay && hasPoliticalContext);

  if (!isRelevant) return false

  // Must NOT contain any of the negative or irrelevant keywords.
  const hasNegative = NEGATIVE_KEYWORDS.some(kw => lower.includes(kw))
  if (hasNegative) return false

  return true
}

// Scrape YouTube videos via RSS
async function scrapeYouTubeVideos(): Promise<ScrapedMedia[]> {
  const videos: ScrapedMedia[] = []

  for (const channel of YOUTUBE_CHANNELS) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TVK-Bot/1.0)' }
      })

      if (!response.ok) continue

      const xml = await response.text()
      const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 15)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]

        if (!videoId || !isValidContent(title)) continue

        videos.push({
          type: 'video',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail_url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          embed_url: `https://www.youtube.com/embed/${videoId}`,
          title: title.trim(),
          source: channel.name,
          published_at: published,
        })
      }

      await new Promise(r => setTimeout(r, 300))
    } catch (error) {
      console.error(`YouTube ${channel.name} error:`, error)
    }
  }

  return videos
}

// Scrape news from RSS feeds
async function scrapeRSSNews(): Promise<ScrapedMedia[]> {
  const news: ScrapedMedia[] = []

  for (const feed of RSS_FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TVK-Bot/1.0)' }
      })

      if (!response.ok) continue

      const xml = await response.text()
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []

      for (const item of items.slice(0, 15)) {
        const title = item.match(/<title>(?:<!\[CDATA\[)?([^\]<]*)(?:\]\]>)?<\/title>/)?.[1] || ''
        const link = item.match(/<link>([^<]*)<\/link>/)?.[1] || ''
        const description = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || ''
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]

        // Extract image from content or media tags
        const imageMatch = item.match(/(?:url|src)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i) ||
                          item.match(/<media:content[^>]+url=["']([^"']+)/i) ||
                          item.match(/<enclosure[^>]+url=["']([^"']+)/i)

        if (!link || !isValidContent(title + ' ' + description)) continue

        // Add news item
        news.push({
          type: 'news',
          url: link.trim(),
          thumbnail_url: imageMatch?.[1],
          title: title.trim().replace(/<[^>]*>/g, '').replace(/&amp;/g, '&'),
          description: description.replace(/<[^>]*>/g, '').substring(0, 300),
          source: feed.name,
          published_at: pubDate ? new Date(pubDate).toISOString() : undefined,
        })

        // Also add image as separate media if found and valid
        if (imageMatch?.[1] && imageMatch[1].startsWith('http')) {
          news.push({
            type: 'image',
            url: imageMatch[1],
            title: title.trim().replace(/<[^>]*>/g, ''),
            source: feed.name,
            published_at: pubDate ? new Date(pubDate).toISOString() : undefined,
          })
        }
      }

      await new Promise(r => setTimeout(r, 300))
    } catch (error) {
      console.error(`RSS ${feed.name} error:`, error)
    }
  }

  return news
}

// Validate media URL is accessible
async function validateUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    return response.ok
  } catch {
    return false
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  // Allow GET for testing
  if (req.method === 'POST') {
    const authKey = req.headers.authorization?.replace('Bearer ', '')
    const expectedKey = process.env.CURATION_API_KEY
    if (expectedKey && authKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const runId = `media-${Date.now()}`
  const startedAt = new Date().toISOString()
  const stats = { videos: 0, news: 0, images: 0, added_news: 0, added_media: 0, skipped: 0, exists: 0 }

  try {
    console.log('Starting media curation:', runId)
    await initDB()

    // Cleanup old media
    const cleaned = await cleanupOldContent()

    // Scrape all sources
    console.log('Scraping YouTube videos...')
    const videos = await scrapeYouTubeVideos()
    stats.videos = videos.length

    console.log('Scraping RSS news...')
    const newsItems = await scrapeRSSNews()
    stats.news = newsItems.filter(m => m.type === 'news').length
    stats.images = newsItems.filter(m => m.type === 'image').length

    const allMedia = [...videos, ...newsItems]
    console.log(`Total scraped: ${allMedia.length} items`)

    // Deduplicate
    const uniqueMedia = Array.from(
      new Map(allMedia.map(m => [m.url, m])).values()
    )

    // Validate and insert into the correct tables
    for (const item of uniqueMedia) {
      // Validate URL (skip for YouTube - known good)
      if (!item.url.includes('youtube.com') && !item.url.includes('youtu.be')) {
        if (!(await validateUrl(item.url))) {
          stats.skipped++
          continue
        }
      }

      if (item.type === 'news') {
        if (await newsUrlExists(item.url)) {
          stats.exists++
          continue
        }
        const success = await insertNews({
          id: `news-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          title: item.title,
          description: item.description,
          url: item.url,
          image_url: item.thumbnail_url, // Correct mapping
          source: item.source,
          language: item.title.match(/[\u0B80-\u0BFF]/) ? 'ta' : 'en', // Basic Tamil check
          category: 'general', // Or implement categorization logic
          relevance_score: 80,
          status: 'approved',
          published_at: item.published_at,
        })
        if (success) stats.added_news++
      } else { // 'image' or 'video'
        if (await mediaUrlExists(item.url)) {
          stats.exists++
          continue
        }
        const success = await insertMedia({
          id: `${item.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: item.type as 'image' | 'video',
          url: item.url,
          thumbnail_url: item.thumbnail_url,
          embed_url: item.embed_url,
          title: item.title,
          description: item.description,
          source: item.source,
          relevance_score: 80,
          status: 'approved',
          published_at: item.published_at,
        })
        if (success) stats.added_media++
      }
    }

    const totalAdded = stats.added_news + stats.added_media
    await logCurationRun({
      run_id: runId,
      source: 'media',
      items_fetched: allMedia.length,
      items_added: totalAdded,
      items_updated: 0,
      items_skipped: stats.skipped,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(200).json({
      success: true,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      stats,
      cleaned,
      message: `Added ${totalAdded} items (${stats.added_news} news, ${stats.added_media} media)`,
    })

  } catch (error) {
    console.error('Media curation error:', error)
    return res.status(500).json({
      success: false,
      runId,
      error: 'Media curation failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
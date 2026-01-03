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

// Google News RSS feeds for TVK-specific news
const RSS_FEEDS = [
  { name: 'TVK Vijay News', url: 'https://news.google.com/rss/search?q=TVK+Vijay+party&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'TVK Tamil News', url: 'https://news.google.com/rss/search?q=தமிழக+வெற்றி+கழகம்&hl=ta&gl=IN&ceid=IN:ta' },
  { name: 'Vijay Political', url: 'https://news.google.com/rss/search?q=Vijay+political+party+Tamil&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Tamilaga Vettri', url: 'https://news.google.com/rss/search?q=Tamilaga+Vettri+Kazhagam&hl=en-IN&gl=IN&ceid=IN:en' },
]

// TVK-themed fallback images for news without OG images
const TVK_FALLBACK_IMAGES = [
  'https://pbs.twimg.com/profile_images/1820095725199663104/F-sJsNxg_400x400.jpg', // TVK logo
  'https://pbs.twimg.com/media/GXhQZ6jWQAApzPd?format=jpg&name=medium', // Vijay speech
  'https://pbs.twimg.com/media/GXhQZ6hXMAA6XBd?format=jpg&name=medium', // TVK rally
  'https://pbs.twimg.com/media/GYG1aBVWIAAU1hO?format=jpg&name=medium', // TVK event
  'https://pbs.twimg.com/media/GXi9RcgXcAAXKY2?format=jpg&name=medium', // Vijay meeting
]

// Decode Google News URL to get actual article URL
function decodeGoogleNewsUrl(url: string): string | null {
  try {
    // Google News URLs contain base64 encoded article URLs
    // Format: https://news.google.com/rss/articles/CBMi...
    const match = url.match(/articles\/([A-Za-z0-9_-]+)/)
    if (!match) return url

    const encoded = match[1]
    // Try to decode - Google uses modified base64
    const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')

    // Extract URL from decoded string (usually starts with http)
    const urlMatch = decoded.match(/(https?:\/\/[^\s"'<>]+)/i)
    return urlMatch?.[1] || url
  } catch {
    return url
  }
}

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

// Fetch OG metadata (image, description) from actual article URL
async function fetchOGMetadata(url: string): Promise<{ image?: string; description?: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    })

    if (!response.ok) return {}

    const html = await response.text()

    // Extract OG image
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
                    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]

    // Extract OG description
    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                   html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1] ||
                   html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]

    return {
      image: ogImage?.startsWith('http') ? ogImage : undefined,
      description: ogDesc?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').substring(0, 300),
    }
  } catch {
    return {}
  }
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

      for (const item of items.slice(0, 8)) { // Limit per feed for speed
        const title = item.match(/<title>(?:<!\[CDATA\[)?([^\]<]*)(?:\]\]>)?<\/title>/)?.[1] || ''
        let link = item.match(/<link>([^<]*)<\/link>/)?.[1] || ''
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]

        if (!link || !isValidContent(title)) continue

        // Decode Google News URL to get real article URL
        const realUrl = decodeGoogleNewsUrl(link.trim())
        if (realUrl && realUrl !== link) {
          console.log(`Decoded URL: ${realUrl.substring(0, 60)}...`)
          link = realUrl
        }

        // Fetch OG metadata from actual article
        const ogData = await fetchOGMetadata(link)

        // Use OG image or fallback to TVK-themed images
        const imageUrl = ogData.image || TVK_FALLBACK_IMAGES[news.length % TVK_FALLBACK_IMAGES.length]

        if (ogData.image) {
          console.log(`Found: ${title.substring(0, 40)}... with OG image`)
        } else {
          console.log(`Found: ${title.substring(0, 40)}... using fallback image`)
        }

        // Add news item with image (OG or fallback)
        news.push({
          type: 'news',
          url: link,
          thumbnail_url: imageUrl,
          title: title.trim().replace(/<[^>]*>/g, '').replace(/&amp;/g, '&'),
          description: ogData.description || title,
          source: feed.name,
          published_at: pubDate ? new Date(pubDate).toISOString() : undefined,
        })

        // Only add as separate image if we got a real OG image (not fallback)
        if (ogData.image) {
          news.push({
            type: 'image',
            url: ogData.image,
            title: title.trim().replace(/<[^>]*>/g, ''),
            source: feed.name,
            published_at: pubDate ? new Date(pubDate).toISOString() : undefined,
          })
        }

        // Delay between fetches
        await new Promise(r => setTimeout(r, 200))
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
        const exists = await newsUrlExists(item.url)
        // Use UPSERT - insert or update existing items (to add images to items without them)
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
        if (success) {
          if (exists) {
            stats.exists++ // Updated existing
          } else {
            stats.added_news++ // Added new
          }
        }
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
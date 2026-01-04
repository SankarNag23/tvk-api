import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  initDB,
  insertMedia,
  mediaUrlExists,
  insertNews,
  newsUrlExists,
  cleanupOldContent,
  logCurationRun,
  getTurso
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
  // Financial crimes / fraud
  'trading', 'moneylaundering', 'money laundering', 'fraud', 'cheat', 'cheating',
  'ponzi', 'investment scam', 'fake', 'forgery', 'bribe', 'corruption',
  // Other Famous People named Vijay
  'vijay sethupathi', 'vijay devarakonda', 'vijay antony',
  // Irrelevant Topics (e.g., sports)
  'cricket', 'football', 'sports', 'match', 'score', 'goal', 'century', 'bowling', 'batting', 'ipl',
  // Tamil negative words
  'மோசடி', 'ஊழல்', 'கைது', 'புகார்', 'தோல்வி',
]

// Direct Tamil news RSS feeds (more reliable than Google News)
const RSS_FEEDS = [
  // Tamil news sites with direct RSS
  { name: 'Dinamalar', url: 'https://www.dinamalar.com/rss/rssfeeds.asp?cat=ta' },
  { name: 'Dinakaran', url: 'https://www.dinakaran.com/feed' },
  { name: 'Vikatan', url: 'https://www.vikatan.com/rss/tamilnadu' },
  { name: 'Puthiyathalaimurai', url: 'https://www.puthiyathalaimurai.com/feeds/news/tamilnadu' },
  // Google News as fallback
  { name: 'Google TVK', url: 'https://news.google.com/rss/search?q=TVK+Vijay+Tamilaga+Vettri&hl=ta&gl=IN&ceid=IN:ta' },
]

// TVK-themed fallback images for news without OG images
const TVK_FALLBACK_IMAGES = [
  'https://pbs.twimg.com/profile_images/1820095725199663104/F-sJsNxg_400x400.jpg', // TVK logo
  'https://pbs.twimg.com/media/GXhQZ6jWQAApzPd?format=jpg&name=medium', // Vijay speech
  'https://pbs.twimg.com/media/GXhQZ6hXMAA6XBd?format=jpg&name=medium', // TVK rally
  'https://pbs.twimg.com/media/GYG1aBVWIAAU1hO?format=jpg&name=medium', // TVK event
  'https://pbs.twimg.com/media/GXi9RcgXcAAXKY2?format=jpg&name=medium', // Vijay meeting
]

// Follow Google News redirect to get actual article URL
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  try {
    // If not a Google News URL, return as-is
    if (!url.includes('news.google.com')) return url

    // Follow the redirect to get actual URL
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual', // Don't auto-follow, we want the redirect URL
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })

    // Check for redirect
    const location = response.headers.get('location')
    if (location && location.startsWith('http')) {
      console.log(`Resolved: ${url.substring(0, 40)}... -> ${location.substring(0, 50)}...`)
      return location
    }

    // Try to extract from response body (some Google News pages have JS redirects)
    const html = await response.text()
    const urlMatch = html.match(/href="(https?:\/\/(?!news\.google)[^"]+)"/i)
    if (urlMatch?.[1]) {
      return urlMatch[1]
    }

    return url
  } catch (error) {
    console.error('Failed to resolve Google News URL:', error)
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

    // Filter out Google News images (they're just logos, not article images)
    let validImage = ogImage?.startsWith('http') ? ogImage : undefined
    if (validImage && (
      validImage.includes('lh3.googleusercontent.com') ||
      validImage.includes('gstatic.com/gnews') ||
      validImage.includes('google.com/favicon')
    )) {
      validImage = undefined // Force fallback to TVK images
    }

    // Filter out Google's generic description and HTML
    let validDesc = ogDesc?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').substring(0, 300)
    if (validDesc && (
      validDesc.includes('Comprehensive up-to-date news coverage') ||
      validDesc.includes('<a href=') ||
      validDesc.includes('Google News') ||
      validDesc.startsWith('<')
    )) {
      validDesc = undefined // Will use title as description
    }

    return {
      image: validImage,
      description: validDesc,
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
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]

        // Get the link from RSS - use Google link for click-through (it redirects properly)
        const link = item.match(/<link>([^<]*)<\/link>/)?.[1]?.trim() || ''
        if (!link) continue

        // Validate title content
        if (!isValidContent(title)) continue

        // Check URL for negative keywords
        const urlLower = link.toLowerCase()
        const hasNegativeUrl = NEGATIVE_KEYWORDS.some(kw => urlLower.includes(kw.replace(' ', '')))
        if (hasNegativeUrl) {
          console.log(`Skipped (negative URL): ${link.substring(0, 50)}...`)
          continue
        }

        // For Google News URLs, we can't reliably fetch OG metadata
        // Use TVK fallback images and title as description
        let ogData: { image?: string; description?: string } = {}
        if (!link.includes('news.google.com')) {
          // Only try to fetch OG metadata for non-Google URLs
          ogData = await fetchOGMetadata(link)
        }

        // Also check OG description for negative content
        if (ogData.description && !isValidContent(ogData.description)) {
          console.log(`Skipped (negative description): ${title.substring(0, 40)}...`)
          continue
        }

        // Use OG image or fallback to TVK-themed images
        const imageUrl = ogData.image || TVK_FALLBACK_IMAGES[news.length % TVK_FALLBACK_IMAGES.length]

        if (ogData.image) {
          console.log(`Found: ${title.substring(0, 40)}... with OG image`)
        } else {
          console.log(`Found: ${title.substring(0, 40)}... using fallback image`)
        }

        // Check for duplicates by URL before adding
        const isDuplicate = news.some(n => n.url === link)
        if (isDuplicate) {
          console.log(`Skipped (duplicate): ${title.substring(0, 40)}...`)
          continue
        }

        // Clean title - remove source suffix (e.g., "Title - SourceName" -> "Title")
        let cleanTitle = title.trim().replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
        const sourceSeparator = cleanTitle.lastIndexOf(' - ')
        if (sourceSeparator > 20) {
          cleanTitle = cleanTitle.substring(0, sourceSeparator)
        }

        // Use clean title as description if no OG description
        const description = ogData.description || cleanTitle

        // Add news item with image (OG or fallback)
        news.push({
          type: 'news',
          url: link,
          thumbnail_url: imageUrl,
          title: cleanTitle,
          description: description,
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

    // Clean up news with Google logos or bad descriptions
    const db = getTurso()
    const badDataCleanup = await db.execute({
      sql: `DELETE FROM news WHERE
            image_url LIKE '%lh3.googleusercontent.com%' OR
            image_url LIKE '%gstatic.com/gnews%' OR
            description LIKE '%Comprehensive up-to-date news coverage%' OR
            description LIKE '%<a href=%' OR
            description LIKE '%&lt;a href=%'`,
      args: []
    })
    console.log(`Cleaned ${badDataCleanup.rowsAffected} news items with bad Google data`)

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

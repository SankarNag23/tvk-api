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
// Using verified working URLs from hero-images and reliable sources
const TVK_FALLBACK_IMAGES = [
  'https://wallpaperaccess.com/full/14775373.jpg', // Vijay portrait
  'https://rajkaran.in/wp-content/uploads/2025/02/vijay.jpg', // Vijay TVK
  'https://media.assettype.com/gulfnews/2025-04-12/ohhjomle/202504123375215.jpg', // TVK event
  'https://wallpaperaccess.com/full/14775373.jpg', // Vijay portrait (repeat for variety)
  'https://rajkaran.in/wp-content/uploads/2025/02/vijay.jpg', // Vijay TVK (repeat)
]

// Decode base64url (URL-safe base64) to bytes
function base64urlDecode(str: string): Uint8Array {
  // Convert base64url to standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  // Add padding if needed
  while (base64.length % 4) base64 += '='

  // Decode base64 to binary string
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Extract URL from protobuf-like structure
function extractUrlFromBytes(bytes: Uint8Array): string | null {
  // Look for "http" in the decoded bytes and extract the URL
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const text = decoder.decode(bytes)

  // Find http:// or https:// URLs in the decoded content
  const urlMatch = text.match(/https?:\/\/[^\x00-\x1f\x7f-\x9f"<>\s]+/g)
  if (urlMatch && urlMatch.length > 0) {
    // Return the first non-Google URL found
    for (const url of urlMatch) {
      if (!url.includes('google.com') && !url.includes('gstatic.com')) {
        // Clean up the URL (remove any trailing garbage)
        const cleanUrl = url.replace(/[\x00-\x1f\x7f-\x9f]+.*$/, '')
        return cleanUrl
      }
    }
  }
  return null
}

// Decode Google News article URL to get actual article URL
function decodeGoogleNewsUrl(googleUrl: string): string | null {
  try {
    // Extract the encoded part from URLs like:
    // https://news.google.com/rss/articles/CBMi...
    // https://news.google.com/stories/...

    const match = googleUrl.match(/\/articles\/([A-Za-z0-9_-]+)/) ||
                  googleUrl.match(/\/stories\/([A-Za-z0-9_-]+)/)

    if (!match) return null

    const encoded = match[1]
    const bytes = base64urlDecode(encoded)
    const articleUrl = extractUrlFromBytes(bytes)

    if (articleUrl) {
      console.log(`Decoded Google News: ${articleUrl.substring(0, 60)}...`)
      return articleUrl
    }

    return null
  } catch (error) {
    console.error('Failed to decode Google News URL:', error)
    return null
  }
}

// Follow Google News redirect to get actual article URL
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  try {
    // If not a Google News URL, return as-is
    if (!url.includes('news.google.com')) return url

    // First try to decode the URL directly (faster)
    const decodedUrl = decodeGoogleNewsUrl(url)
    if (decodedUrl) {
      return decodedUrl
    }

    // Fallback: Follow the redirect to get actual URL
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })

    // Check final URL after redirects
    if (response.url && !response.url.includes('news.google.com')) {
      console.log(`Resolved via redirect: ${response.url.substring(0, 60)}...`)
      return response.url
    }

    // Try to extract from response body
    const html = await response.text()

    // Look for data-url or href attributes with actual article URLs
    const dataUrlMatch = html.match(/data-url="(https?:\/\/(?!news\.google)[^"]+)"/i) ||
                         html.match(/href="(https?:\/\/(?!news\.google|google\.com)[^"]+)"/i) ||
                         html.match(/"(https?:\/\/(?!news\.google|google\.com|gstatic)[^"]+\.(?:com|in|net|org)\/[^"]+)"/i)

    if (dataUrlMatch?.[1]) {
      console.log(`Extracted from HTML: ${dataUrlMatch[1].substring(0, 60)}...`)
      return dataUrlMatch[1]
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

    // Filter out Google News images and other non-article images
    let validImage = ogImage?.startsWith('http') ? ogImage : undefined
    if (validImage) {
      const imgLower = validImage.toLowerCase()
      // Reject Google-related images (logos, not article images)
      if (imgLower.includes('lh3.googleusercontent.com') ||
          imgLower.includes('gstatic.com') ||
          imgLower.includes('google.com/favicon') ||
          imgLower.includes('google.com/images')) {
        console.log(`Rejected Google image: ${validImage.substring(0, 50)}...`)
        validImage = undefined
      }
      // Accept images from known good sources
      else if (imgLower.includes('dinamalar') ||
               imgLower.includes('vikatan') ||
               imgLower.includes('samayam') ||
               imgLower.includes('thehindu') ||
               imgLower.includes('indiatoday') ||
               imgLower.includes('ndtv') ||
               imgLower.includes('news18') ||
               imgLower.includes('asianetnews') ||
               imgLower.includes('deccanherald') ||
               imgLower.includes('newindianexpress') ||
               imgLower.includes('oneindia') ||
               imgLower.includes('cloudfront') ||
               imgLower.includes('amazonaws') ||
               imgLower.includes('wp.com') ||
               imgLower.includes('wordpress')) {
        console.log(`Found good OG image: ${validImage.substring(0, 60)}...`)
      }
      // For other images, check if they look like valid article images
      else if (validImage.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        console.log(`Found article image: ${validImage.substring(0, 60)}...`)
      } else {
        console.log(`Unknown image source, keeping: ${validImage.substring(0, 60)}...`)
      }
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

        // Get the link from RSS
        const rawLink = item.match(/<link>([^<]*)<\/link>/)?.[1]?.trim() || ''
        if (!rawLink) continue

        // Validate title content
        if (!isValidContent(title)) continue

        // Resolve Google News URLs to get actual article URL
        let articleUrl = rawLink
        let displayLink = rawLink // Keep original for click-through (better tracking)

        if (rawLink.includes('news.google.com')) {
          const resolved = await resolveGoogleNewsUrl(rawLink)
          if (resolved && resolved !== rawLink) {
            articleUrl = resolved
            console.log(`Google News resolved: ${rawLink.substring(0, 40)}... -> ${articleUrl.substring(0, 50)}...`)
          }
        }

        // Check URL for negative keywords
        const urlLower = articleUrl.toLowerCase()
        const hasNegativeUrl = NEGATIVE_KEYWORDS.some(kw => urlLower.includes(kw.replace(' ', '')))
        if (hasNegativeUrl) {
          console.log(`Skipped (negative URL): ${articleUrl.substring(0, 50)}...`)
          continue
        }

        // Fetch OG metadata from the actual article URL (not Google News URL)
        let ogData: { image?: string; description?: string } = {}
        if (!articleUrl.includes('news.google.com')) {
          ogData = await fetchOGMetadata(articleUrl)
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
        const isDuplicate = news.some(n => n.url === rawLink || n.url === articleUrl)
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
        // Use rawLink for click-through (Google News or direct) - it redirects properly
        news.push({
          type: 'news',
          url: rawLink,
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

    // Clean up news with bad images, fallback images, or bad descriptions
    // Also remove items with fallback images so they can be re-fetched with real OG images
    const db = getTurso()
    const badDataCleanup = await db.execute({
      sql: `DELETE FROM news WHERE
            image_url LIKE '%lh3.googleusercontent.com%' OR
            image_url LIKE '%gstatic.com/gnews%' OR
            image_url LIKE '%pbs.twimg.com%' OR
            image_url LIKE '%wallpaperaccess.com%' OR
            image_url LIKE '%rajkaran.in%' OR
            image_url LIKE '%assettype.com/gulfnews%' OR
            description LIKE '%Comprehensive up-to-date news coverage%' OR
            description LIKE '%<a href=%' OR
            description LIKE '%&lt;a href=%'`,
      args: []
    })
    console.log(`Cleaned ${badDataCleanup.rowsAffected} news items with bad/fallback images`)

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

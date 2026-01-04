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

// Direct Tamil news RSS feeds - prioritize those with direct URLs and OG images
const RSS_FEEDS = [
  // Google News searches for TVK-specific content (most relevant)
  { name: 'Google TVK Tamil', url: 'https://news.google.com/rss/search?q=TVK+Vijay+Tamilaga+Vettri&hl=ta&gl=IN&ceid=IN:ta' },
  { name: 'Google Vijay Politics', url: 'https://news.google.com/rss/search?q=Vijay+politics+2026&hl=en-IN&gl=IN&ceid=IN:en' },

  // Direct Tamil news RSS with politics sections
  { name: 'Dinamalar Politics', url: 'https://www.dinamalar.com/rss/rssfeeds.asp?cat=po' },
  { name: 'Dinamalar TN', url: 'https://www.dinamalar.com/rss/rssfeeds.asp?cat=ta' },
  { name: 'Vikatan Politics', url: 'https://www.vikatan.com/rss/politics' },
  { name: 'Vikatan TN', url: 'https://www.vikatan.com/rss/tamilnadu' },
  { name: 'Puthiyathalaimurai', url: 'https://www.puthiyathalaimurai.com/feeds/news/politics' },

  // English Tamil news
  { name: 'Hindu TN', url: 'https://www.thehindu.com/news/national/tamil-nadu/feeder/default.rss' },
  { name: 'NDTV Chennai', url: 'https://feeds.feedburner.com/ndtv/TNPy' },
  { name: 'Indian Express TN', url: 'https://indianexpress.com/section/cities/chennai/feed/' },
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

  // Use Buffer for Node.js environment (Vercel serverless)
  try {
    const buffer = Buffer.from(base64, 'base64')
    return new Uint8Array(buffer)
  } catch (e) {
    // Fallback for browser environment
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
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
      console.log(`Decoded URL: ${decodedUrl.substring(0, 70)}...`)
      return decodedUrl
    }

    console.log(`Decoder failed, trying redirect for: ${url.substring(0, 50)}...`)

    // Try with manual redirect following to handle consent pages
    let currentUrl = url
    for (let i = 0; i < 5; i++) { // Max 5 redirects
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual', // Handle redirects manually
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ta;q=0.8',
          'Cache-Control': 'no-cache',
        },
      })

      // Check for redirect
      const location = response.headers.get('location')
      if (location) {
        // Make absolute URL if relative
        const nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href
        if (!nextUrl.includes('news.google.com') && !nextUrl.includes('consent.google.com')) {
          console.log(`Redirect resolved: ${nextUrl.substring(0, 70)}...`)
          return nextUrl
        }
        currentUrl = nextUrl
        continue
      }

      // No redirect, check response body for JS redirect
      const html = await response.text()

      // Look for meta refresh redirect
      const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>\s]+)/i)
      if (metaRefresh?.[1]) {
        const refreshUrl = metaRefresh[1].replace(/&amp;/g, '&')
        if (!refreshUrl.includes('news.google.com')) {
          console.log(`Meta refresh resolved: ${refreshUrl.substring(0, 70)}...`)
          return refreshUrl
        }
      }

      // Look for article URL in data attributes or JSON
      const articleMatch = html.match(/data-n-au="([^"]+)"/i) || // Google News article URL attribute
                           html.match(/"url"\s*:\s*"(https?:\/\/(?!news\.google|google\.com)[^"]+)"/i) ||
                           html.match(/window\.location\.replace\s*\(\s*["']([^"']+)["']\s*\)/i) ||
                           html.match(/href="(https?:\/\/(?!news\.google|google\.com|consent\.google)[^"]+\.(com|in|net|org)\/[^"]+)"/i)

      if (articleMatch?.[1]) {
        const extractedUrl = articleMatch[1].replace(/\\u002F/g, '/').replace(/&amp;/g, '&')
        console.log(`Extracted from body: ${extractedUrl.substring(0, 70)}...`)
        return extractedUrl
      }

      break // No more redirects to follow
    }

    console.log(`Could not resolve: ${url.substring(0, 50)}...`)
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

    // Filter out logos and icons, but accept article images (even from Google CDN)
    let validImage = ogImage?.startsWith('http') ? ogImage : undefined
    if (validImage) {
      const imgLower = validImage.toLowerCase()

      // Reject specific logo/icon patterns (NOT all Google images)
      const isLogo = imgLower.includes('/favicon') ||
                     imgLower.includes('/logo') ||
                     imgLower.includes('/icon') ||
                     imgLower.includes('gstatic.com/gnews') ||  // Google News logo
                     imgLower.includes('google.com/images/branding') ||
                     imgLower.endsWith('.ico') ||
                     imgLower.includes('=s0-w50') ||  // Tiny thumbnails
                     imgLower.includes('=s0-w100')

      if (isLogo) {
        console.log(`Rejected logo/icon: ${validImage.substring(0, 50)}...`)
        validImage = undefined
      }
      // Accept larger Google-hosted images (they host actual article images)
      else if (imgLower.includes('lh3.googleusercontent.com') && imgLower.includes('=s0-w')) {
        // Check if it's a decent size (>200px)
        const sizeMatch = imgLower.match(/=s0-w(\d+)/)
        if (sizeMatch && parseInt(sizeMatch[1]) >= 200) {
          console.log(`Found Google-hosted article image: ${validImage.substring(0, 60)}...`)
        } else {
          console.log(`Rejected small thumbnail: ${validImage.substring(0, 50)}...`)
          validImage = undefined
        }
      }
      // Accept images with proper extensions
      else if (validImage.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        console.log(`Found article image: ${validImage.substring(0, 60)}...`)
      }
      // Accept other URLs that look like images
      else {
        console.log(`Keeping image: ${validImage.substring(0, 60)}...`)
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
        const link = item.match(/<link>(?:<!\[CDATA\[)?([^\]<]*)(?:\]\]>)?<\/link>/)?.[1]?.trim() || ''
        if (!link) continue

        // Validate title content (Step 3: Filter)
        if (!isValidContent(title)) continue

        // Check URL for negative keywords
        const urlLower = link.toLowerCase()
        const hasNegativeUrl = NEGATIVE_KEYWORDS.some(kw => urlLower.includes(kw.replace(' ', '')))
        if (hasNegativeUrl) {
          console.log(`Skipped (negative URL): ${link.substring(0, 50)}...`)
          continue
        }

        // Extract image directly from RSS (the RIGHT way!)
        // 1. <media:content url="..."> (Media RSS)
        // 2. <media:thumbnail url="...">
        // 3. <enclosure url="..." type="image/...">
        // 4. <img src="..."> in description
        let imageUrl: string | undefined
        let description: string | undefined

        // Try media:content first (most common in news RSS)
        const mediaContent = item.match(/<media:content[^>]+url=["']([^"']+)["']/i)
        if (mediaContent?.[1]) {
          imageUrl = mediaContent[1]
          console.log(`Found media:content image: ${imageUrl.substring(0, 60)}...`)
        }

        // Try media:thumbnail
        if (!imageUrl) {
          const mediaThumbnail = item.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)
          if (mediaThumbnail?.[1]) {
            imageUrl = mediaThumbnail[1]
            console.log(`Found media:thumbnail: ${imageUrl.substring(0, 60)}...`)
          }
        }

        // Try enclosure with image type
        if (!imageUrl) {
          const enclosure = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i) ||
                           item.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]+url=["']([^"']+)["']/i)
          if (enclosure?.[1]) {
            imageUrl = enclosure[1]
            console.log(`Found enclosure image: ${imageUrl.substring(0, 60)}...`)
          }
        }

        // Try img src in description
        if (!imageUrl) {
          const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)
          if (descMatch?.[1]) {
            const imgInDesc = descMatch[1].match(/<img[^>]+src=["']([^"']+)["']/i)
            if (imgInDesc?.[1]) {
              imageUrl = imgInDesc[1]
              console.log(`Found img in description: ${imageUrl.substring(0, 60)}...`)
            }
          }
        }

        // Get description from RSS
        const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)
        if (descMatch?.[1]) {
          // Strip HTML tags from description
          description = descMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().substring(0, 300)
        }

        // Check description for negative content
        if (description && !isValidContent(description)) {
          console.log(`Skipped (negative description): ${title.substring(0, 40)}...`)
          continue
        }

        // Use RSS image or fallback to TVK-themed images
        const finalImageUrl = imageUrl || TVK_FALLBACK_IMAGES[news.length % TVK_FALLBACK_IMAGES.length]

        if (imageUrl) {
          console.log(`Found: ${title.substring(0, 40)}... with RSS image`)
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

        // Use RSS description or clean title as fallback
        const finalDescription = description || cleanTitle

        // Add news item with image (RSS or fallback)
        news.push({
          type: 'news',
          url: link,
          thumbnail_url: finalImageUrl,
          title: cleanTitle,
          description: finalDescription,
          source: feed.name,
          published_at: pubDate ? new Date(pubDate).toISOString() : undefined,
        })

        // Only add as separate image if we got a real RSS image (not fallback)
        if (imageUrl) {
          news.push({
            type: 'image',
            url: imageUrl,
            title: cleanTitle,
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
      badDataCleaned: badDataCleanup.rowsAffected,
      message: `Added ${totalAdded} items (${stats.added_news} news, ${stats.added_media} media). Cleaned ${badDataCleanup.rowsAffected} bad/fallback items.`,
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

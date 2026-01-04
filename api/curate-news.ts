import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertNews, newsUrlExists, addRssSource, updateRssSourceFetched, getRssSources, cleanupOldNews, logCurationRun } from '../lib/db'

// Default RSS sources - Tamil news channels covering politics/cinema
const DEFAULT_RSS_SOURCES = [
  // Google News RSS for TVK-specific searches (most reliable for TVK content)
  { name: 'Google News - TVK', url: 'https://news.google.com/rss/search?q=TVK+தமிழக+வெற்றி&hl=ta&gl=IN&ceid=IN:ta', category: 'tvk' },
  { name: 'Google News - Vijay Politics', url: 'https://news.google.com/rss/search?q=விஜய்+அரசியல்+TVK&hl=ta&gl=IN&ceid=IN:ta', category: 'tvk' },
  { name: 'Google News - Thalapathy Vijay', url: 'https://news.google.com/rss/search?q=தளபதி+விஜய்+கட்சி&hl=ta&gl=IN&ceid=IN:ta', category: 'tvk' },
  { name: 'Google News - Sengottaiyan', url: 'https://news.google.com/rss/search?q=செங்கோட்டையன்+TVK&hl=ta&gl=IN&ceid=IN:ta', category: 'tvk' },

  // Tamil News - Politics (broader coverage)
  { name: 'News18 Tamil - TN', url: 'https://tamil.news18.com/rss/tamilnadu.xml', category: 'politics' },
  { name: 'News18 Tamil - Politics', url: 'https://tamil.news18.com/rss/politics.xml', category: 'politics' },
  { name: 'News18 Tamil - Cinema', url: 'https://tamil.news18.com/rss/movies.xml', category: 'cinema' },
]

// Keywords to match (English and Tamil)
const TVK_KEYWORDS = [
  // English keywords
  'tvk', 'tamilaga vettri kazhagam', 'vijay', 'actor vijay', 'thalapathy',
  'sengottaiyan', 'bussy anand', 'bussy ananth', 'tvk it wing',
  // Tamil keywords
  'விஜய்', 'தளபதி', 'தமிழக வெற்றிக் கழகம்', 'செங்கொட்டையன்',
  'பஸ்ஸி ஆனந்த்', 'டிவிகே', 'வெற்றிக் கழகம்'
]

// Negative sentiment words to filter out
const NEGATIVE_KEYWORDS = [
  // English
  'arrest', 'death', 'dead', 'kill', 'murder', 'accident', 'tragedy', 'scandal',
  'corruption', 'scam', 'fraud', 'attack', 'violence', 'protest against', 'failure',
  'defeated', 'loss', 'crisis', 'controversy', 'allegation', 'accused', 'criminal',
  // Tamil negative words
  'கைது', 'மரணம்', 'இறப்பு', 'கொலை', 'விபத்து', 'ஊழல்', 'மோசடி', 'தாக்குதல்',
  'வன்முறை', 'தோல்வி', 'சர்ச்சை', 'குற்றச்சாட்டு'
]

// Positive sentiment indicators
const POSITIVE_KEYWORDS = [
  // English
  'launch', 'announce', 'success', 'win', 'victory', 'support', 'rally', 'meet',
  'celebration', 'inaugurat', 'welcome', 'join', 'growth', 'progress', 'achieve',
  'campaign', 'speech', 'address', 'promise', 'vision', 'plan', 'initiative',
  // Tamil positive words
  'வெற்றி', 'தொடக்கம்', 'அறிவிப்பு', 'ஆதரவு', 'பேரணி', 'கூட்டம்', 'விழா',
  'வரவேற்பு', 'இணைவு', 'வளர்ச்சி', 'முன்னேற்றம்', 'சாதனை', 'பிரச்சாரம்',
  'உரை', 'திட்டம்', 'முயற்சி'
]

interface RssItem {
  title: string
  link: string
  description?: string
  pubDate?: string
  imageUrl?: string
  source: string
}

// Fetch og:image from article page
async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TVK-Bot/1.0)',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow'
    })

    if (!response.ok) return null

    const html = await response.text()

    // Extract og:image
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)

    if (ogImage) return ogImage[1]

    // Try twitter:image
    const twitterImage = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)

    if (twitterImage) return twitterImage[1]

    return null
  } catch {
    return null
  }
}

// Extract image URL from RSS item using multiple methods
function extractImageUrl(item: any, content: string): string | null {
  // Method 1: media:content
  if (item['media:content']?.$?.url) {
    return item['media:content'].$.url
  }

  // Method 2: media:thumbnail
  if (item['media:thumbnail']?.$?.url) {
    return item['media:thumbnail'].$.url
  }

  // Method 3: enclosure with image type
  if (item.enclosure?.$?.url && item.enclosure.$.type?.includes('image')) {
    return item.enclosure.$.url
  }

  // Method 4: image tag
  if (item.image?.url) {
    return item.image.url
  }

  // Method 5: Extract from description HTML
  const descMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i)
  if (descMatch) {
    return descMatch[1]
  }

  // Method 6: og:image or similar in content
  const ogMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i)
  if (ogMatch) {
    return ogMatch[0]
  }

  return null
}

// Check if content matches TVK keywords
function matchesKeywords(text: string): string[] {
  const lowerText = text.toLowerCase()
  const matched: string[] = []

  for (const keyword of TVK_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      matched.push(keyword)
    }
  }

  return matched
}

// Calculate sentiment score (-1 to 1)
function calculateSentiment(text: string): number {
  const lowerText = text.toLowerCase()
  let score = 0

  // Check negative keywords
  for (const keyword of NEGATIVE_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      score -= 0.3
    }
  }

  // Check positive keywords
  for (const keyword of POSITIVE_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      score += 0.2
    }
  }

  // Clamp between -1 and 1
  return Math.max(-1, Math.min(1, score))
}

// Parse RSS feed
async function parseRssFeed(url: string, sourceName: string): Promise<RssItem[]> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TVK-Bot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: AbortSignal.timeout(10000)
    })

    if (!response.ok) {
      console.log(`RSS fetch failed for ${sourceName}: ${response.status}`)
      return []
    }

    const xmlText = await response.text()
    const items: RssItem[] = []

    // Simple XML parsing for RSS items
    const itemMatches = xmlText.match(/<item>([\s\S]*?)<\/item>/gi) || []

    for (const itemXml of itemMatches.slice(0, 20)) { // Limit to 20 items per feed
      const title = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim()
      const link = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1]?.trim()
      const description = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim()
      const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim()

      if (!title || !link) continue

      // Extract image from various locations
      let imageUrl: string | null = null

      // media:content
      const mediaContent = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i)
      if (mediaContent) imageUrl = mediaContent[1]

      // media:thumbnail
      if (!imageUrl) {
        const mediaThumbnail = itemXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)
        if (mediaThumbnail) imageUrl = mediaThumbnail[1]
      }

      // enclosure
      if (!imageUrl) {
        const enclosure = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)
        if (enclosure) imageUrl = enclosure[1]
      }

      // img src in description
      if (!imageUrl && description) {
        const imgSrc = description.match(/<img[^>]+src=["']([^"']+)["']/i)
        if (imgSrc) imageUrl = imgSrc[1]
      }

      // Direct image URL pattern
      if (!imageUrl) {
        const directImg = itemXml.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i)
        if (directImg) imageUrl = directImg[0]
      }

      items.push({
        title: title.replace(/<[^>]+>/g, '').trim(),
        link,
        description: description?.replace(/<[^>]+>/g, '').substring(0, 500),
        pubDate,
        imageUrl: imageUrl || undefined,
        source: sourceName
      })
    }

    return items
  } catch (error) {
    console.error(`Error parsing RSS ${sourceName}:`, error)
    return []
  }
}

// Generate unique ID
function generateId(): string {
  return `news_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // Only allow POST with API key
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Verify API key
  const authHeader = req.headers.authorization
  const apiKey = process.env.CURATION_API_KEY

  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const runId = `news_${Date.now()}`
  const startedAt = new Date().toISOString()

  try {
    await initDB()

    // Always sync default RSS sources (in case they changed)
    console.log('Syncing default RSS sources...')
    for (const source of DEFAULT_RSS_SOURCES) {
      await addRssSource(source)
    }

    // Get active RSS sources
    const rssSources = await getRssSources(true)
    console.log(`Fetching from ${rssSources.length} RSS sources...`)

    let totalFetched = 0
    let totalAdded = 0
    let totalSkipped = 0
    const errors: string[] = []

    // Process each RSS source
    for (const source of rssSources) {
      try {
        console.log(`Fetching: ${source.name}`)
        const items = await parseRssFeed(source.url, source.name)
        totalFetched += items.length

        await updateRssSourceFetched(source.url)

        for (const item of items) {
          // Check if already exists
          if (await newsUrlExists(item.link)) {
            totalSkipped++
            continue
          }

          const fullText = `${item.title} ${item.description || ''}`

          // For TVK category sources (Google News searches), skip keyword check
          // since they're already pre-filtered by search query
          let matchedKeywords: string[] = []
          if (source.category === 'tvk') {
            // Auto-assign keywords based on content
            matchedKeywords = ['TVK']
            if (fullText.toLowerCase().includes('vijay') || fullText.includes('விஜய்')) {
              matchedKeywords.push('Vijay')
            }
          } else {
            // For general news sources, require keyword matching
            matchedKeywords = matchesKeywords(fullText)
            if (matchedKeywords.length === 0) {
              totalSkipped++
              continue
            }
          }

          // Try to fetch og:image if no image in RSS
          let imageUrl = item.imageUrl
          if (!imageUrl) {
            console.log(`Fetching og:image for: ${item.title.substring(0, 40)}...`)
            imageUrl = await fetchOgImage(item.link) || undefined
          }

          // Skip if still no image
          if (!imageUrl) {
            console.log(`No image found: ${item.title.substring(0, 40)}...`)
            totalSkipped++
            continue
          }

          // Calculate sentiment
          const sentimentScore = calculateSentiment(fullText)

          // Skip negative news (sentiment < -0.2)
          if (sentimentScore < -0.2) {
            console.log(`Skipping negative: ${item.title.substring(0, 40)}...`)
            totalSkipped++
            continue
          }

          // Calculate relevance score (50-100)
          const relevanceScore = Math.min(100, 50 + (matchedKeywords.length * 10) + (sentimentScore * 20))

          // Insert into database
          const success = await insertNews({
            id: generateId(),
            title: item.title,
            description: item.description,
            url: item.link,
            image_url: imageUrl,
            source_name: source.name,
            source_url: source.url,
            published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            keywords_matched: matchedKeywords.join(','),
            sentiment_score: sentimentScore,
            relevance_score: Math.round(relevanceScore),
            status: 'approved'
          })

          if (success) {
            totalAdded++
            console.log(`Added: ${item.title.substring(0, 50)}... [${matchedKeywords.join(', ')}]`)
          }
        }
      } catch (sourceError: any) {
        errors.push(`${source.name}: ${sourceError.message}`)
        console.error(`Error with ${source.name}:`, sourceError)
      }
    }

    // Cleanup old news (older than 7 days)
    const cleanedUp = await cleanupOldNews(7)
    console.log(`Cleaned up ${cleanedUp} old news items`)

    // Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'news',
      items_fetched: totalFetched,
      items_added: totalAdded,
      items_updated: 0,
      items_skipped: totalSkipped,
      errors: errors.length > 0 ? errors.join('; ') : undefined,
      started_at: startedAt,
      completed_at: new Date().toISOString()
    })

    return res.status(200).json({
      success: true,
      run_id: runId,
      stats: {
        sources_processed: rssSources.length,
        items_fetched: totalFetched,
        items_added: totalAdded,
        items_skipped: totalSkipped,
        cleaned_up: cleanedUp
      },
      errors: errors.length > 0 ? errors : undefined
    })

  } catch (error: any) {
    console.error('Curation error:', error)

    await logCurationRun({
      run_id: runId,
      source: 'news',
      items_fetched: 0,
      items_added: 0,
      items_updated: 0,
      items_skipped: 0,
      errors: error.message,
      started_at: startedAt,
      completed_at: new Date().toISOString()
    })

    return res.status(500).json({
      error: 'Curation failed',
      message: error.message
    })
  }
}

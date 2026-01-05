import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertNews, newsUrlExists, syncRssSources, updateRssSourceFetched, getRssSources, cleanupOldNews, clearAllNews, logCurationRun } from '../lib/db'

// RSS Sources - Working Tamil news sources for TVK coverage
const DEFAULT_RSS_SOURCES = [
  // The Hindu Tamil Nadu - has media:content images, English content about TN politics
  { name: 'The Hindu - Tamil Nadu', url: 'https://www.thehindu.com/news/national/tamil-nadu/feeder/default.rss', category: 'politics' },

  // News18 Tamil - has embedded images, Tamil content
  { name: 'News18 Tamil - TN', url: 'https://tamil.news18.com/commonfeeds/v1/tam/rss/tamil-nadu.xml', category: 'politics' },
  { name: 'News18 Tamil - Politics', url: 'https://tamil.news18.com/commonfeeds/v1/tam/rss/politics.xml', category: 'politics' },

  // Google News RSS - TVK specific searches (returns historical results, needs og:image fetch)
  { name: 'Google News - TVK', url: 'https://news.google.com/rss/search?q=%22TVK%22+OR+%22%E0%AE%A4%E0%AE%B5%E0%AF%86%E0%AE%95%22+OR+%22Tamilaga+Vettri+Kazhagam%22&hl=ta&gl=IN&ceid=IN:ta', category: 'google' },
  { name: 'Google News - Vijay Politics', url: 'https://news.google.com/rss/search?q=%E0%AE%B5%E0%AE%BF%E0%AE%9C%E0%AE%AF%E0%AF%8D+%E0%AE%95%E0%AE%9F%E0%AF%8D%E0%AE%9A%E0%AE%BF+OR+%E0%AE%A4%E0%AE%B3%E0%AE%AA%E0%AE%A4%E0%AE%BF+%E0%AE%85%E0%AE%B0%E0%AE%9A%E0%AE%BF%E0%AE%AF%E0%AE%B2%E0%AF%8D&hl=ta&gl=IN&ceid=IN:ta', category: 'google' },
  { name: 'Google News - TVK English', url: 'https://news.google.com/rss/search?q=%22Tamilaga+Vettri+Kazhagam%22+OR+%22TVK+party%22+OR+%22Vijay+political%22&hl=en-IN&gl=IN&ceid=IN:en', category: 'google' },
]

// Groq API configuration
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'

// AI Agent: Analyze article for TVK relevance and sentiment using Groq
interface AIAnalysisResult {
  about_tvk: boolean
  positive_for_tvk: boolean
  relevance_score: number
  reasoning: string
}

async function analyzeWithAI(title: string, description: string): Promise<AIAnalysisResult | null> {
  const groqApiKey = process.env.GROQ_API_KEY
  if (!groqApiKey) {
    console.log('GROQ_API_KEY not set, skipping AI analysis')
    return null
  }

  const prompt = `You are an AI news curator for TVK (Tamilaga Vettri Kazhagam), a Tamil Nadu political party led by actor Vijay.

Analyze this news article:
Title: ${title}
Description: ${description || 'No description available'}

IMPORTANT CONTEXT:
- TVK = Tamilaga Vettri Kazhagam = தமிழக வெற்றிக் கழகம் = தவெக
- Key people: Vijay (விஜய், Thalapathy), Sengottaiyan (செங்கொட்டையன்), Bussy Ananth (பஸ்ஸி ஆனந்த்)
- TVK IT Wing = TVK's digital/social media team

Answer these questions:
1. Is this article PRIMARILY ABOUT TVK, Vijay's political activities, TVK IT Wing, Sengottaiyan, or Bussy Ananth?
   - Must be the MAIN SUBJECT, not just a passing mention
   - For Vijay: ONLY political news (party, politics, elections), NOT movie/cinema news

2. Is this article POSITIVE or NEUTRAL for TVK/Vijay politically?
   - POSITIVE: Rally success, new members, announcements, achievements, support
   - NEUTRAL: Factual reporting without negative spin
   - NEGATIVE: Criticism, controversy, scandals, failures, attacks, opposition criticism
   - Words like "விமர்சி" (criticize), "தாக்கு" (attack), "சர்ச்சை" (controversy) indicate NEGATIVE

Return ONLY a JSON object (no markdown, no explanation):
{"about_tvk": true/false, "positive_for_tvk": true/false, "relevance_score": 0-100, "reasoning": "brief explanation"}`

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 200
      }),
      signal: AbortSignal.timeout(10000)
    })

    if (!response.ok) {
      console.log(`Groq API error: ${response.status}`)
      return null
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim()

    if (!content) {
      console.log('Empty response from Groq')
      return null
    }

    // Parse JSON response
    try {
      // Remove any markdown code blocks if present
      const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim()
      const result = JSON.parse(jsonStr)
      return {
        about_tvk: Boolean(result.about_tvk),
        positive_for_tvk: Boolean(result.positive_for_tvk),
        relevance_score: Math.min(100, Math.max(0, Number(result.relevance_score) || 0)),
        reasoning: String(result.reasoning || '')
      }
    } catch (parseError) {
      console.log('Failed to parse Groq response:', content)
      return null
    }
  } catch (error: any) {
    console.log('Groq API call failed:', error.message)
    return null
  }
}

// Pre-filter: Quick keyword check before AI analysis (to save API calls)
function quickKeywordCheck(text: string): boolean {
  const lowerText = text.toLowerCase()
  const keywords = [
    // Party names
    'tvk', 'தவெக', 'tamilaga vettri', 'வெற்றிக் கழகம்', 'வெற்றி கழகம்',
    // Leaders
    'vijay', 'விஜய்', 'thalapathy', 'தளபதி',
    'sengottaiyan', 'செங்கொட்டையன்',
    'bussy', 'பஸ்ஸி', 'ஆனந்த்',
    // IT Wing
    'it wing', 'ஐடி விங்', 'ஐடி அணி'
  ]

  return keywords.some(k => lowerText.includes(k))
}


interface RssItem {
  title: string
  link: string
  description?: string
  pubDate?: string
  imageUrl?: string
  source: string
}

// Fetch og:image from article page (with short timeout)
async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow'
    })

    if (!response.ok) return null

    // Only read first 50KB to find og:image
    const reader = response.body?.getReader()
    if (!reader) return null

    let html = ''
    const decoder = new TextDecoder()

    while (html.length < 50000) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })

      // Check if we found og:image
      const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      if (ogImage) {
        reader.cancel()
        return ogImage[1]
      }
    }

    reader.cancel()

    // Try twitter:image in what we have
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


// Parse RSS feed
async function parseRssFeed(url: string, sourceName: string): Promise<RssItem[]> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      console.log(`RSS fetch failed for ${sourceName}: ${response.status}`)
      return []
    }

    const xmlText = await response.text()
    const items: RssItem[] = []

    // Simple XML parsing for RSS items
    const itemMatches = xmlText.match(/<item>([\s\S]*?)<\/item>/gi) || []

    for (const itemXml of itemMatches.slice(0, 50)) { // Scan up to 50 items per feed for TVK news
      const title = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim()
      const link = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1]?.trim()
      const description = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim()
      const pubDate = itemXml.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i)?.[1]?.trim()

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

  // Check for reset parameter (clear all old news before curating)
  const shouldReset = req.query.reset === 'true' || req.body?.reset === true

  try {
    await initDB()

    // If reset requested, clear all existing news
    let clearedCount = 0
    if (shouldReset) {
      console.log('Resetting: Clearing all existing news...')
      clearedCount = await clearAllNews()
      console.log(`Cleared ${clearedCount} old news items`)
    }

    // Sync RSS sources - deactivate old ones, add new ones
    console.log('Syncing RSS sources (deactivating old, adding new)...')
    await syncRssSources(DEFAULT_RSS_SOURCES)

    // Get active RSS sources
    const rssSources = await getRssSources(true)
    console.log(`Fetching from ${rssSources.length} RSS sources...`)

    let totalFetched = 0
    let totalAdded = 0
    let totalSkipped = 0
    let aiAnalyzed = 0
    const errors: string[] = []
    const skipReasons = { duplicate: 0, no_keyword: 0, image: 0, not_about_tvk: 0, negative: 0, ai_error: 0 }

    // Process each RSS source
    for (const source of rssSources) {
      try {
        console.log(`Fetching: ${source.name}`)
        const items = await parseRssFeed(source.url, source.name)
        totalFetched += items.length

        await updateRssSourceFetched(source.url)

        console.log(`Processing ${items.length} items from ${source.name}`)

        for (const item of items) {
          // Check if already exists
          if (await newsUrlExists(item.link)) {
            skipReasons.duplicate++
            totalSkipped++
            continue
          }

          const fullText = `${item.title} ${item.description || ''}`

          // Pre-filter: Quick keyword check before AI analysis (to save API calls)
          // Skip this check for Google News sources - they're already pre-filtered by search query
          if (source.category !== 'google' && !quickKeywordCheck(fullText)) {
            skipReasons.no_keyword++
            totalSkipped++
            continue
          }

          // Check for image first (before expensive AI call)
          let imageUrl = item.imageUrl

          if (!imageUrl) {
            // Try og:image as fallback (with shorter timeout for Google News)
            imageUrl = await fetchOgImage(item.link) || undefined

            // For Google News items without images, use a default TVK image
            if (!imageUrl && source.category === 'google') {
              imageUrl = 'https://tvk-official.vercel.app/tvk-flag.jpg'
              console.log(`Using default image for Google News item: ${item.title.substring(0, 40)}...`)
            } else if (!imageUrl) {
              skipReasons.image++
              totalSkipped++
              continue
            }
          }

          // AI AGENT: Analyze with Groq for relevance and sentiment
          console.log(`AI analyzing: ${item.title.substring(0, 50)}...`)
          const aiResult = await analyzeWithAI(item.title, item.description || '')
          aiAnalyzed++

          if (!aiResult) {
            // AI analysis failed - skip to be safe
            skipReasons.ai_error++
            totalSkipped++
            continue
          }

          console.log(`AI result: about_tvk=${aiResult.about_tvk}, positive=${aiResult.positive_for_tvk}, score=${aiResult.relevance_score}`)

          // Condition A: Must be ABOUT TVK (not just mentioning)
          if (!aiResult.about_tvk) {
            skipReasons.not_about_tvk++
            totalSkipped++
            continue
          }

          // Condition B: Must be POSITIVE for TVK (not criticism)
          if (!aiResult.positive_for_tvk) {
            skipReasons.negative++
            totalSkipped++
            continue
          }

          // Condition C: Relevance score must be >= 50
          if (aiResult.relevance_score < 50) {
            skipReasons.not_about_tvk++
            totalSkipped++
            continue
          }

          // Insert into database
          const result = await insertNews({
            id: generateId(),
            title: item.title,
            description: item.description,
            url: item.link,
            image_url: imageUrl,
            source_name: source.name,
            source_url: source.url,
            published_at: (() => {
              try {
                return item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
              } catch {
                return new Date().toISOString()
              }
            })(),
            keywords_matched: aiResult.reasoning,
            sentiment_score: aiResult.positive_for_tvk ? 1 : 0,
            relevance_score: aiResult.relevance_score,
            status: 'approved'
          })

          if (result.success) {
            totalAdded++
            console.log(`Added: ${item.title.substring(0, 50)}...`)
          } else {
            console.log(`Insert failed: ${result.error}`)
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
        ai_analyzed: aiAnalyzed,
        items_added: totalAdded,
        items_skipped: totalSkipped,
        skip_reasons: skipReasons,
        reset_cleared: shouldReset ? clearedCount : undefined,
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

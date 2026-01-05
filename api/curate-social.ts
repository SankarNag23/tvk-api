import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertTweet, tweetExists, logCurationRun, clearAllTweets } from '../lib/db'

/**
 * POST /api/curate-social
 * AI-Powered Social Media Scraping Agent
 *
 * Scrapes Twitter and Facebook for TVK content without paid APIs
 * Uses AI (Groq) to filter and score content
 * Runs every 4 hours via GitHub Action
 */

// Twitter accounts to monitor (public profiles)
const TWITTER_ACCOUNTS = [
  'TVKVijayHQ',
  'tvaboraiaru',
  'TVKITWingTN',
]

// Search terms for Twitter
const TWITTER_SEARCH_TERMS = [
  'TVK',
  'தவெக',
  'Tamilaga Vettri Kazhagam',
  'Vijay political',
]

// Negative keywords to filter out
const NEGATIVE_KEYWORDS = [
  'troll', 'meme', 'roast', 'comedy', 'против', 'against', 'fail',
  'dmk', 'admk', 'bjp', 'congress', 'annamalai', 'stalin',
  'movie', 'film', 'song', 'trailer',
]

// TVK positive keywords
const TVK_KEYWORDS = [
  'tvk', 'தவெக', 'tamilaga', 'vettri', 'விஜய்', 'vijay',
  'sengottaiyan', 'bussy', 'rally', 'speech', 'meeting',
]

interface ScrapedTweet {
  id: string
  text: string
  author: string
  authorHandle: string
  authorAvatar: string
  url: string
  timestamp: string
  likes?: number
  retweets?: number
  imageUrl?: string
}

interface AIAnalysisResult {
  is_tvk_content: boolean
  is_positive: boolean
  relevance_score: number
}

// Scrape Twitter using Nitter instances (open source Twitter frontend)
async function scrapeTwitterProfile(username: string): Promise<ScrapedTweet[]> {
  const tweets: ScrapedTweet[] = []

  // Try multiple Nitter instances
  const nitterInstances = [
    'nitter.net',
    'nitter.privacydev.net',
    'nitter.poast.org',
  ]

  for (const instance of nitterInstances) {
    try {
      const url = `https://${instance}/${username}/rss`
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TVKBot/1.0)',
        },
      })

      if (!response.ok) continue

      const rssText = await response.text()

      // Parse RSS feed
      const items = rssText.match(/<item>[\s\S]*?<\/item>/g) || []

      for (const item of items.slice(0, 10)) {
        const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/)
        const pubDateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
        const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)

        if (titleMatch && linkMatch) {
          // Extract tweet ID from URL
          const tweetUrl = linkMatch[1].replace(/nitter\.[^/]+/, 'twitter.com')
          const idMatch = tweetUrl.match(/status\/(\d+)/)

          // Extract image if present
          let imageUrl: string | undefined
          const imgMatch = descMatch?.[1]?.match(/src="([^"]+\.(jpg|png|jpeg))"/)
          if (imgMatch) {
            imageUrl = imgMatch[1]
          }

          tweets.push({
            id: idMatch?.[1] || `tweet_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            text: titleMatch[1].replace(/<[^>]*>/g, '').trim(),
            author: username,
            authorHandle: username,
            authorAvatar: `https://unavatar.io/twitter/${username}`,
            url: tweetUrl,
            timestamp: pubDateMatch?.[1] || new Date().toISOString(),
            imageUrl,
          })
        }
      }

      if (tweets.length > 0) break // Success, no need to try other instances

    } catch (error) {
      console.log(`Nitter ${instance} failed for ${username}:`, error)
      continue
    }
  }

  return tweets
}

// Scrape Twitter search (via RSS if available)
async function scrapeTwitterSearch(query: string): Promise<ScrapedTweet[]> {
  const tweets: ScrapedTweet[] = []

  try {
    // Try Google News for Twitter mentions
    const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' site:twitter.com')}&hl=ta&gl=IN&ceid=IN:ta`

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TVKBot/1.0)',
      },
    })

    if (response.ok) {
      const rssText = await response.text()
      const items = rssText.match(/<item>[\s\S]*?<\/item>/g) || []

      for (const item of items.slice(0, 5)) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/)
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/)

        if (titleMatch && linkMatch && linkMatch[1].includes('twitter.com')) {
          const idMatch = linkMatch[1].match(/status\/(\d+)/)

          tweets.push({
            id: idMatch?.[1] || `search_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            text: titleMatch[1].replace(/<[^>]*>/g, '').trim(),
            author: 'Twitter',
            authorHandle: 'twitter',
            authorAvatar: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
            url: linkMatch[1],
            timestamp: new Date().toISOString(),
          })
        }
      }
    }
  } catch (error) {
    console.log('Twitter search scrape failed:', error)
  }

  return tweets
}

// Quick filter before AI analysis
function passesQuickFilter(text: string): boolean {
  const lower = text.toLowerCase()

  // Must have TVK-related content
  const hasTVK = TVK_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
  if (!hasTVK) return false

  // Filter out negative content
  const hasNegative = NEGATIVE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
  if (hasNegative) return false

  return true
}

// AI Analysis using Groq
async function analyzeWithAI(text: string, groqApiKey: string): Promise<AIAnalysisResult | null> {
  try {
    const prompt = `Analyze this social media post for TVK (Tamilaga Vettri Kazhagam) fan website.

POST: "${text.substring(0, 500)}"

Is this:
1. About TVK/Vijay's political activities? (not movies)
2. Positive or neutral toward TVK? (not criticism/trolling)

Reply ONLY with JSON:
{"is_tvk_content": true/false, "is_positive": true/false, "relevance_score": 0-100}`

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 100,
      }),
    })

    if (!response.ok) return null

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    return JSON.parse(jsonMatch[0])
  } catch {
    return null
  }
}

// Fallback scoring
function fallbackScoring(text: string): AIAnalysisResult {
  const lower = text.toLowerCase()
  let score = 50

  if (lower.includes('tvk') || lower.includes('தவெக')) score += 25
  if (lower.includes('vijay') || lower.includes('விஜய்')) score += 15
  if (lower.includes('rally') || lower.includes('speech') || lower.includes('meeting')) score += 10
  if (lower.includes('sengottaiyan') || lower.includes('bussy')) score += 15

  return {
    is_tvk_content: score >= 60,
    is_positive: true,
    relevance_score: Math.min(score, 85),
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Verify API key
  const authHeader = req.headers.authorization
  const apiKey = process.env.CURATION_API_KEY
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const groqApiKey = process.env.GROQ_API_KEY
  const runId = `social_${Date.now()}`
  const startedAt = new Date().toISOString()

  const stats = {
    accounts_scraped: 0,
    tweets_found: 0,
    filtered_quick: 0,
    filtered_ai: 0,
    duplicates: 0,
    added: 0,
    ai_calls: 0,
  }

  try {
    console.log('Starting Social Media Curation Agent:', runId)
    await initDB()

    // Check if reset requested
    if (req.query.reset === 'true') {
      console.log('RESET MODE: Clearing all tweets...')
      const cleared = await clearAllTweets()
      console.log(`Cleared ${cleared} existing tweets`)
    }

    const allTweets: ScrapedTweet[] = []

    // Scrape Twitter profiles
    for (const account of TWITTER_ACCOUNTS) {
      stats.accounts_scraped++
      console.log(`Scraping Twitter: @${account}`)

      const tweets = await scrapeTwitterProfile(account)
      allTweets.push(...tweets)

      await new Promise(r => setTimeout(r, 500)) // Rate limit
    }

    // Scrape Twitter search terms
    for (const term of TWITTER_SEARCH_TERMS.slice(0, 2)) {
      console.log(`Searching Twitter: "${term}"`)
      const tweets = await scrapeTwitterSearch(term)
      allTweets.push(...tweets)

      await new Promise(r => setTimeout(r, 300))
    }

    stats.tweets_found = allTweets.length
    console.log(`Found ${allTweets.length} tweets`)

    // Deduplicate
    const uniqueTweets = Array.from(
      new Map(allTweets.map(t => [t.id, t])).values()
    )

    // Process each tweet
    for (const tweet of uniqueTweets) {
      // Check if exists
      if (await tweetExists(tweet.id)) {
        stats.duplicates++
        continue
      }

      // Quick filter
      if (!passesQuickFilter(tweet.text)) {
        stats.filtered_quick++
        continue
      }

      // AI analysis (if available)
      let analysis: AIAnalysisResult | null = null
      if (groqApiKey && stats.ai_calls < 20) { // Limit AI calls
        stats.ai_calls++
        analysis = await analyzeWithAI(tweet.text, groqApiKey)
        await new Promise(r => setTimeout(r, 200))
      }

      if (!analysis) {
        analysis = fallbackScoring(tweet.text)
      }

      if (!analysis.is_tvk_content || !analysis.is_positive || analysis.relevance_score < 55) {
        stats.filtered_ai++
        continue
      }

      // Insert tweet
      const success = await insertTweet({
        id: tweet.id,
        text: tweet.text,
        author: tweet.author,
        author_handle: tweet.authorHandle,
        author_avatar: tweet.authorAvatar,
        url: tweet.url,
        media_urls: tweet.imageUrl || undefined,
        likes: tweet.likes || 0,
        retweets: tweet.retweets || 0,
        relevance_score: analysis.relevance_score,
        status: 'approved',
        published_at: tweet.timestamp,
      })

      if (success) {
        stats.added++
        console.log(`Added tweet: ${tweet.text.substring(0, 50)}...`)
      }
    }

    await logCurationRun({
      run_id: runId,
      source: 'social-scraper',
      items_fetched: stats.tweets_found,
      items_added: stats.added,
      items_updated: 0,
      items_skipped: stats.filtered_quick + stats.filtered_ai + stats.duplicates,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(200).json({
      success: true,
      run_id: runId,
      stats,
      message: `Scraped ${stats.tweets_found} posts, added ${stats.added} new items`,
    })

  } catch (error: any) {
    console.error('Social curation error:', error)

    return res.status(500).json({
      success: false,
      run_id: runId,
      error: 'Social curation failed',
      message: error.message,
    })
  }
}

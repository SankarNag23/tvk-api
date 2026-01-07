import type { VercelRequest, VercelResponse } from '@vercel/node'
import { writeFileSync } from 'fs'
import { join } from 'path'

/**
 * POST /api/curate-social
 * AI-Powered Social Media Curation Agent for TVK YouTube Shorts
 * 
 * Features:
 * - YouTube shorts discovery via Data API
 * - AI analysis with Groq for content validation
 * - Updates data/shorts.json automatically
 * - Runs every 4 hours via GitHub Action
 */

// YouTube search queries optimized for shorts
const YOUTUBE_SEARCH_QUERIES = [
  'TVK Vijay shorts',
  'Tamilaga Vettri Kazhagam shorts',
  'விஜய் தவெக shorts',
  'Vijay TVK political speech',
]

// Keywords that indicate movie content (to filter out)
const MOVIE_KEYWORDS = [
  'trailer', 'teaser', 'song', 'movie', 'film', 'bgm', 'theme',
  'audio', 'jukebox', 'mashup', 'promo', 'first look', 'motion poster',
  'படம்', 'பாடல்', 'டீசர்', 'ட்ரெய்லர்',
]

// Keywords that indicate non-TVK Vijay content
const WRONG_VIJAY_KEYWORDS = [
  'vijay sethupathi', 'vijay devarakonda', 'vijay antony', 'vijay tv',
  'விஜய் சேதுபதி', 'விஜய் டிவி',
]

// Keywords that confirm TVK political content
const TVK_KEYWORDS = [
  'tvk', 'தவெக', 'tamilaga vettri', 'வெற்றிக் கழகம்',
  'political', 'politics', 'அரசியல்', 'party', 'கட்சி',
  'speech', 'பேச்சு', 'rally', 'பேரணி',
]

interface YouTubeShort {
  id: string
  title: string
  description: string
  url: string
}

interface AIAnalysisResult {
  is_tvk_content: boolean
  is_positive: boolean
  relevance_score: number
  reasoning: string
}

// Search YouTube for shorts
async function searchYouTubeShorts(query: string, apiKey: string): Promise<YouTubeShort[]> {
  const shorts: YouTubeShort[] = []

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search')
    searchUrl.searchParams.set('part', 'snippet')
    searchUrl.searchParams.set('q', query)
    searchUrl.searchParams.set('type', 'video')
    searchUrl.searchParams.set('videoDuration', 'short') // Filter for shorts (<= 60 seconds)
    searchUrl.searchParams.set('maxResults', '10')
    searchUrl.searchParams.set('order', 'date')
    searchUrl.searchParams.set('relevanceLanguage', 'ta')
    searchUrl.searchParams.set('regionCode', 'IN')
    searchUrl.searchParams.set('publishedAfter', getDateMonthsAgo(2))
    searchUrl.searchParams.set('key', apiKey)

    const response = await fetch(searchUrl.toString())
    if (!response.ok) {
      console.log(`YouTube API error for "${query}": ${response.status}`)
      return shorts
    }

    const data = await response.json()

    for (const item of data.items || []) {
      const snippet = item.snippet
      if (!snippet || !item.id?.videoId) continue

      const title = snippet.title || ''
      const description = snippet.description || ''
      const combined = `${title} ${description}`.toLowerCase()

      // Skip if it contains movie keywords
      if (MOVIE_KEYWORDS.some(kw => combined.includes(kw.toLowerCase()))) {
        continue
      }

      // Skip if it's the wrong Vijay
      if (WRONG_VIJAY_KEYWORDS.some(kw => combined.includes(kw.toLowerCase()))) {
        continue
      }

      shorts.push({
        id: item.id.videoId,
        title,
        description,
        url: `https://youtube.com/shorts/${item.id.videoId}`
      })
    }

    return shorts
  } catch (error) {
    console.error(`Failed to search YouTube for "${query}":`, error)
    return shorts
  }
}

// Get date N months ago in ISO format
function getDateMonthsAgo(months: number): string {
  const date = new Date()
  date.setMonth(date.getMonth() - months)
  return date.toISOString()
}

// AI analysis using Groq
async function analyzeWithAI(title: string, description: string): Promise<AIAnalysisResult | null> {
  const groqApiKey = process.env.GROQ_API_KEY
  if (!groqApiKey) {
    console.log('GROQ_API_KEY not set, skipping AI analysis')
    return null
  }

  const prompt = `You are an AI curator for TVK (Tamilaga Vettri Kazhagam), a Tamil Nadu political party led by actor Vijay.

Analyze this YouTube short:
Title: ${title}
Description: ${description || 'No description available'}

IMPORTANT CONTEXT:
- TVK = Tamilaga Vettri Kazhagam = தமிழக வெற்றிக் கழகம் = தவெக
- Key people: Vijay (விஜய், Thalapathy - political activities only, NOT movies)
- This should be POLITICAL content, not entertainment/cinema

Is this short:
1. PRIMARILY ABOUT TVK or Vijay's political activities? (Not just a passing mention)
2. POSITIVE or NEUTRAL for TVK? (Not criticism, controversy, or attacks)

Return ONLY a JSON object (no markdown):
{"is_tvk_content": true/false, "is_positive": true/false, "relevance_score": 0-100, "reasoning": "brief explanation"}`

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      }),
      signal: AbortSignal.timeout(15000)
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
    const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim()
    const result = JSON.parse(jsonStr)
    
    return {
      is_tvk_content: Boolean(result.is_tvk_content),
      is_positive: Boolean(result.is_positive),
      relevance_score: Math.min(100, Math.max(0, Number(result.relevance_score) || 0)),
      reasoning: String(result.reasoning || '')
    }
  } catch (error) {
    console.error('AI analysis failed:', error)
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Check authorization
  const authHeader = req.headers.authorization
  const expectedKey = process.env.CURATION_API_KEY
  
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const youtubeApiKey = process.env.YOUTUBE_API_KEY
  if (!youtubeApiKey) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY not configured' })
  }

  try {
    console.log('Starting social media curation...')
    const allShorts: YouTubeShort[] = []

    // Search YouTube with multiple queries
    for (const query of YOUTUBE_SEARCH_QUERIES) {
      console.log(`Searching for: ${query}`)
      const results = await searchYouTubeShorts(query, youtubeApiKey)
      allShorts.push(...results)
    }

    console.log(`Found ${allShorts.length} potential shorts`)

    // Deduplicate by video ID
    const uniqueShorts = Array.from(
      new Map(allShorts.map(s => [s.id, s])).values()
    )

    console.log(`After deduplication: ${uniqueShorts.length} shorts`)

    // Filter with AI
    const curatedShorts: YouTubeShort[] = []
    
    for (const short of uniqueShorts) {
      // Basic keyword check first
      const combined = `${short.title} ${short.description}`.toLowerCase()
      const hasTvkKeyword = TVK_KEYWORDS.some(kw => combined.includes(kw.toLowerCase()))
      
      if (!hasTvkKeyword) {
        console.log(`Skipping (no TVK keywords): ${short.title}`)
        continue
      }

      // AI analysis
      const analysis = await analyzeWithAI(short.title, short.description)
      
      if (!analysis) {
        // If AI fails, include if it has strong TVK keywords
        if (hasTvkKeyword) {
          curatedShorts.push(short)
          console.log(`✓ Added (AI unavailable, has TVK keywords): ${short.title}`)
        }
        continue
      }

      console.log(`AI Analysis: ${short.title}`)
      console.log(`  - TVK Content: ${analysis.is_tvk_content}`)
      console.log(`  - Positive: ${analysis.is_positive}`)
      console.log(`  - Score: ${analysis.relevance_score}`)
      console.log(`  - Reason: ${analysis.reasoning}`)

      // Include if it's TVK content, positive, and scores >= 60
      if (analysis.is_tvk_content && analysis.is_positive && analysis.relevance_score >= 60) {
        curatedShorts.push(short)
        console.log(`✓ Added: ${short.title}`)
      } else {
        console.log(`✗ Rejected: ${short.title}`)
      }
    }

    console.log(`Final curated shorts: ${curatedShorts.length}`)

    // Limit to top 10 most recent
    const finalShorts = curatedShorts.slice(0, 10)

    // Update data/shorts.json
    const shortsData = {
      shorts: finalShorts.map((short, index) => ({
        id: String(index + 1),
        url: short.url,
        title: short.title
      })),
      updatedAt: new Date().toISOString(),
      instructions: "Auto-curated by AI. YouTube shorts only."
    }

    const dataPath = join(process.cwd(), 'data', 'shorts.json')
    writeFileSync(dataPath, JSON.stringify(shortsData, null, 2))

    console.log('✓ Updated data/shorts.json')

    return res.status(200).json({
      success: true,
      message: 'Social media curation completed',
      stats: {
        totalSearched: allShorts.length,
        afterDedup: uniqueShorts.length,
        afterFiltering: curatedShorts.length,
        final: finalShorts.length
      },
      shorts: finalShorts
    })

  } catch (error) {
    console.error('Curation error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

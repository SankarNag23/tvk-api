import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertMedia, mediaUrlExists, logCurationRun, clearAllMedia } from '../lib/db'

/**
 * POST /api/curate-media
 * AI-Powered Media Curation Agent for TVK
 *
 * Features:
 * - YouTube video discovery via Data API
 * - AI analysis with Groq for content validation
 * - Smart deduplication by URL
 * - Link accessibility validation
 * - Runs every 4 hours via GitHub Action
 */

// YouTube search queries - optimized for speed (fewer queries)
const YOUTUBE_SEARCH_QUERIES = [
  // Primary TVK queries (most effective)
  'TVK Tamilaga Vettri Kazhagam',
  'Vijay TVK speech rally',
  'TVK latest news 2024',
  // Tamil queries
  'விஜய் தவெக',
  'தமிழக வெற்றிக் கழகம்',
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

// Keywords that indicate negative/troll content
const NEGATIVE_KEYWORDS = [
  'troll', 'roast', 'meme', 'comedy', 'funny', 'reaction', 'review',
  'expose', 'scam', 'fail', 'controversy', 'against', 'slam', 'attack',
]

// Keywords that confirm TVK political content
const TVK_POLITICAL_KEYWORDS = [
  'tvk', 'தவெக', 'tamilaga vettri', 'வெற்றிக் கழகம்',
  'political', 'politics', 'அரசியல்', 'party', 'கட்சி',
  'speech', 'பேச்சு', 'rally', 'பேரணி', 'meeting', 'கூட்டம்',
  'election', 'தேர்தல்', 'campaign', 'announce', 'அறிவிப்பு',
  'sengottaiyan', 'செங்கொட்டையன்', 'bussy', 'anand',
]

interface YouTubeVideo {
  id: string
  title: string
  description: string
  thumbnail: string
  channelTitle: string
  publishedAt: string
}

interface AIAnalysisResult {
  is_tvk_content: boolean
  is_positive: boolean
  relevance_score: number
  reasoning: string
}

// Search YouTube using Data API
async function searchYouTube(query: string, apiKey: string): Promise<YouTubeVideo[]> {
  const videos: YouTubeVideo[] = []

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search')
    searchUrl.searchParams.set('part', 'snippet')
    searchUrl.searchParams.set('q', query)
    searchUrl.searchParams.set('type', 'video')
    searchUrl.searchParams.set('maxResults', '5')
    searchUrl.searchParams.set('order', 'date')
    searchUrl.searchParams.set('relevanceLanguage', 'ta')
    searchUrl.searchParams.set('regionCode', 'IN')
    searchUrl.searchParams.set('publishedAfter', getDateMonthsAgo(3))
    searchUrl.searchParams.set('key', apiKey)

    const response = await fetch(searchUrl.toString())
    if (!response.ok) {
      console.log(`YouTube API error for "${query}": ${response.status}`)
      return videos
    }

    const data = await response.json()

    for (const item of data.items || []) {
      const snippet = item.snippet
      if (!snippet || !item.id?.videoId) continue

      videos.push({
        id: item.id.videoId,
        title: snippet.title || '',
        description: snippet.description || '',
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
        channelTitle: snippet.channelTitle || '',
        publishedAt: snippet.publishedAt || '',
      })
    }
  } catch (error) {
    console.error(`YouTube search error for "${query}":`, error)
  }

  return videos
}

// Get ISO date string for N months ago
function getDateMonthsAgo(months: number): string {
  const date = new Date()
  date.setMonth(date.getMonth() - months)
  return date.toISOString()
}

// Quick keyword-based pre-filter (before expensive AI calls)
function passesQuickFilter(title: string, description: string): { pass: boolean; reason?: string } {
  const text = `${title} ${description}`.toLowerCase()

  // Must have some TVK/Vijay mention
  const hasTVKMention = text.includes('tvk') || text.includes('தவெக') ||
    text.includes('vijay') || text.includes('விஜய்') ||
    text.includes('tamilaga') || text.includes('vettri') ||
    text.includes('sengottaiyan') || text.includes('bussy')

  if (!hasTVKMention) {
    return { pass: false, reason: 'no_tvk_mention' }
  }

  // Filter out movie content
  if (MOVIE_KEYWORDS.some(kw => text.includes(kw))) {
    return { pass: false, reason: 'movie_content' }
  }

  // Filter out wrong Vijay (other actors)
  if (WRONG_VIJAY_KEYWORDS.some(kw => text.includes(kw))) {
    return { pass: false, reason: 'wrong_vijay' }
  }

  // Filter out negative/troll content
  if (NEGATIVE_KEYWORDS.some(kw => text.includes(kw))) {
    return { pass: false, reason: 'negative_content' }
  }

  return { pass: true }
}

// AI Analysis using Groq
async function analyzeWithAI(
  title: string,
  description: string,
  channelTitle: string,
  groqApiKey: string
): Promise<AIAnalysisResult | null> {
  try {
    const prompt = `You are an AI content curator for TVK (Tamilaga Vettri Kazhagam), the political party led by actor Vijay in Tamil Nadu, India.

Analyze this YouTube video and determine if it should be featured on the official TVK fan website gallery.

VIDEO DETAILS:
Title: ${title}
Description: ${description?.substring(0, 300) || 'No description'}
Channel: ${channelTitle}

EVALUATION CRITERIA:
1. Is this video PRIMARILY about TVK, Vijay's political activities, or key TVK leaders (Sengottaiyan, Bussy Anand)?
2. Is the content POSITIVE or NEUTRAL toward TVK? (No criticism, trolling, or negative coverage)
3. Is this political content, NOT movie/entertainment content?

RESPOND IN JSON FORMAT ONLY:
{
  "is_tvk_content": true/false,
  "is_positive": true/false,
  "relevance_score": 0-100,
  "reasoning": "brief explanation"
}

A good TVK video would score 70-100. Movie trailers, songs, or non-political content should score 0.`

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
        max_tokens: 200,
      }),
    })

    if (!response.ok) {
      console.log(`Groq API error: ${response.status}`)
      return null
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const result = JSON.parse(jsonMatch[0])
    return {
      is_tvk_content: result.is_tvk_content === true,
      is_positive: result.is_positive === true,
      relevance_score: Math.min(100, Math.max(0, Number(result.relevance_score) || 0)),
      reasoning: result.reasoning || '',
    }
  } catch (error) {
    console.error('AI analysis error:', error)
    return null
  }
}

// Fallback keyword-based scoring when AI is unavailable
function fallbackScoring(title: string, description: string): AIAnalysisResult {
  const text = `${title} ${description}`.toLowerCase()
  let score = 50

  // Boost for strong TVK keywords
  if (text.includes('tvk') || text.includes('தவெக')) score += 25
  if (text.includes('tamilaga vettri') || text.includes('வெற்றிக் கழகம்')) score += 20
  if (text.includes('sengottaiyan') || text.includes('செங்கொட்டையன்')) score += 15
  if (text.includes('bussy') || text.includes('anand')) score += 15

  // Boost for political context
  if (TVK_POLITICAL_KEYWORDS.some(kw => text.includes(kw))) score += 10

  // Check for Vijay without clear political context
  if ((text.includes('vijay') || text.includes('விஜய்')) && score < 60) {
    // Only Vijay mention without TVK context - might be movie content
    score = Math.max(score - 20, 40)
  }

  return {
    is_tvk_content: score >= 60,
    is_positive: true, // Assume positive if passed quick filter
    relevance_score: Math.min(score, 85), // Cap fallback at 85
    reasoning: 'Keyword-based analysis (AI unavailable)',
  }
}

// Validate YouTube video is accessible
async function validateVideo(videoId: string): Promise<boolean> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    const response = await fetch(oembedUrl, { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

// Generate unique ID
function generateId(): string {
  return `media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
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

  // Check required API keys
  const youtubeApiKey = process.env.YOUTUBE_API_KEY
  const groqApiKey = process.env.GROQ_API_KEY
  if (!youtubeApiKey) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY not configured' })
  }

  const runId = `media_${Date.now()}`
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const stats = {
    queries: 0,
    fetched: 0,
    duplicates: 0,
    filtered_quick: 0,
    filtered_ai: 0,
    invalid: 0,
    added: 0,
    ai_calls: 0,
    ai_failures: 0,
  }

  try {
    console.log('Starting AI Media Curation Agent:', runId)
    await initDB()

    // Check if reset requested
    const resetParam = req.query.reset === 'true'
    if (resetParam) {
      console.log('RESET MODE: Clearing all existing media...')
      const cleared = await clearAllMedia()
      console.log(`Cleared ${cleared} existing media items`)
    }

    const allVideos: YouTubeVideo[] = []

    // Search YouTube for each query
    for (const query of YOUTUBE_SEARCH_QUERIES) {
      stats.queries++
      console.log(`Searching YouTube: "${query}"`)

      const videos = await searchYouTube(query, youtubeApiKey)
      allVideos.push(...videos)

      // Small delay between YouTube queries
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    stats.fetched = allVideos.length
    console.log(`Fetched ${allVideos.length} videos from YouTube`)

    // Deduplicate by video ID
    const uniqueVideos = Array.from(
      new Map(allVideos.map(v => [v.id, v])).values()
    )
    console.log(`${uniqueVideos.length} unique videos after dedup`)

    // Process each video
    for (const video of uniqueVideos) {
      const videoUrl = `https://www.youtube.com/watch?v=${video.id}`

      // Check if already exists in database
      if (await mediaUrlExists(videoUrl)) {
        stats.duplicates++
        continue
      }

      // Quick keyword filter (save AI calls)
      const quickFilter = passesQuickFilter(video.title, video.description)
      if (!quickFilter.pass) {
        stats.filtered_quick++
        continue
      }

      // Use fast keyword scoring (AI is optional via ?ai=true for deep analysis)
      const useAI = req.query.ai === 'true' && groqApiKey
      let analysis: AIAnalysisResult | null = null

      if (useAI) {
        stats.ai_calls++
        analysis = await analyzeWithAI(video.title, video.description, video.channelTitle, groqApiKey!)
        if (!analysis) {
          stats.ai_failures++
          analysis = fallbackScoring(video.title, video.description)
        }
        // Small delay for AI rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
      } else {
        // Fast keyword-based scoring (default)
        analysis = fallbackScoring(video.title, video.description)
      }

      // Filter based on AI analysis
      if (!analysis.is_tvk_content || !analysis.is_positive || analysis.relevance_score < 60) {
        stats.filtered_ai++
        console.log(`Filtered by AI: ${video.title.substring(0, 40)}... (score: ${analysis.relevance_score})`)
        continue
      }

      // Validate video is accessible
      const isValid = await validateVideo(video.id)
      if (!isValid) {
        stats.invalid++
        continue
      }

      // Insert into database
      const success = await insertMedia({
        id: generateId(),
        type: 'video',
        url: videoUrl,
        thumbnail_url: video.thumbnail,
        title: video.title,
        description: video.description?.substring(0, 500),
        source: `YouTube - ${video.channelTitle}`,
        embed_url: `https://www.youtube.com/embed/${video.id}`,
        width: 1280,
        height: 720,
        relevance_score: analysis.relevance_score,
        status: 'approved',
        published_at: video.publishedAt,
      })

      if (success) {
        stats.added++
        console.log(`Added (score ${analysis.relevance_score}): ${video.title.substring(0, 50)}...`)
      }
    }

    // Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'youtube-ai',
      items_fetched: stats.fetched,
      items_added: stats.added,
      items_updated: 0,
      items_skipped: stats.duplicates + stats.filtered_quick + stats.filtered_ai + stats.invalid,
      errors: errors.length > 0 ? errors.join('; ') : undefined,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(200).json({
      success: true,
      run_id: runId,
      stats,
      message: `AI curated ${stats.fetched} videos, added ${stats.added} new videos (${stats.ai_calls} AI calls, ${stats.ai_failures} fallbacks)`,
    })

  } catch (error: any) {
    console.error('Media curation error:', error)

    await logCurationRun({
      run_id: runId,
      source: 'youtube-ai',
      items_fetched: 0,
      items_added: 0,
      items_updated: 0,
      items_skipped: 0,
      errors: error.message,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(500).json({
      success: false,
      run_id: runId,
      error: 'Media curation failed',
      message: error.message,
    })
  }
}

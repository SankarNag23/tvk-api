import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertMedia, mediaUrlExists, logCurationRun, clearAllMedia } from '../lib/db'

/**
 * POST /api/curate-media
 * Fetches and curates YouTube videos about TVK
 * Uses YouTube Data API to search and validate videos
 * Runs every 4 hours via GitHub Action
 */

// YouTube search queries for TVK content
const YOUTUBE_SEARCH_QUERIES = [
  'TVK Tamilaga Vettri Kazhagam',
  'Vijay political speech TVK',
  'TVK party rally',
  'Thalapathy Vijay politics',
  'Vijay TVK conference',
  'TVK IT Wing',
  'Sengottaiyan TVK',
  'Bussy Anand TVK',
  'TVK latest news',
  'விஜய் தவெக',
  'தமிழக வெற்றிக் கழகம்',
]

// Negative keywords to filter out (movie trailers, songs, etc.)
const NEGATIVE_KEYWORDS = [
  'trailer', 'song', 'movie', 'film', 'teaser', 'promo',
  'bgm', 'theme', 'audio', 'jukebox', 'mashup', 'review',
  'reaction', 'roast', 'troll', 'meme', 'comedy'
]

interface YouTubeVideo {
  id: string
  title: string
  description: string
  thumbnail: string
  channelTitle: string
  publishedAt: string
}

// Search YouTube using Data API
async function searchYouTube(query: string, apiKey: string): Promise<YouTubeVideo[]> {
  const videos: YouTubeVideo[] = []

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search')
    searchUrl.searchParams.set('part', 'snippet')
    searchUrl.searchParams.set('q', query)
    searchUrl.searchParams.set('type', 'video')
    searchUrl.searchParams.set('maxResults', '10')
    searchUrl.searchParams.set('order', 'date')
    searchUrl.searchParams.set('relevanceLanguage', 'ta')
    searchUrl.searchParams.set('regionCode', 'IN')
    searchUrl.searchParams.set('key', apiKey)

    const response = await fetch(searchUrl.toString())
    if (!response.ok) {
      console.log(`YouTube API error: ${response.status}`)
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

// Check if video title contains negative keywords (movie content)
function isMovieContent(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase()
  return NEGATIVE_KEYWORDS.some(keyword => text.includes(keyword))
}

// Check if video is about TVK/politics (not just random Vijay content)
function isPoliticalContent(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase()
  const politicalKeywords = [
    'tvk', 'தவெக', 'tamilaga vettri', 'வெற்றிக் கழகம்',
    'politic', 'அரசிய', 'party', 'கட்சி', 'speech', 'உரை',
    'rally', 'பேரணி', 'election', 'தேர்தல', 'campaign',
    'sengottaiyan', 'செங்கொட்டையன்', 'bussy', 'பஸ்ஸி'
  ]
  return politicalKeywords.some(keyword => text.includes(keyword))
}

// Validate YouTube video is accessible
async function validateVideo(videoId: string): Promise<boolean> {
  try {
    // Check if embed URL is accessible
    const embedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    const response = await fetch(embedUrl, { method: 'HEAD' })
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

  // Check YouTube API key
  const youtubeApiKey = process.env.YOUTUBE_API_KEY
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
    filtered_movie: 0,
    filtered_non_political: 0,
    invalid: 0,
    added: 0,
  }

  try {
    console.log('Starting YouTube media curation:', runId)
    await initDB()

    // Check if reset requested (clear all existing media first)
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

      // Rate limit - avoid hitting API limits
      await new Promise(resolve => setTimeout(resolve, 300))
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

      // Filter out movie content (trailers, songs, etc.)
      if (isMovieContent(video.title, video.description)) {
        stats.filtered_movie++
        continue
      }

      // Filter for political content only
      if (!isPoliticalContent(video.title, video.description)) {
        stats.filtered_non_political++
        continue
      }

      // Validate video is accessible
      const isValid = await validateVideo(video.id)
      if (!isValid) {
        stats.invalid++
        continue
      }

      // Calculate relevance score based on title keywords
      let relevanceScore = 60
      const titleLower = video.title.toLowerCase()
      if (titleLower.includes('tvk') || titleLower.includes('தவெக')) relevanceScore = 90
      else if (titleLower.includes('tamilaga vettri') || titleLower.includes('வெற்றிக் கழகம்')) relevanceScore = 85
      else if (titleLower.includes('vijay') && titleLower.includes('politic')) relevanceScore = 80
      else if (titleLower.includes('speech') || titleLower.includes('rally')) relevanceScore = 75

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
        relevance_score: relevanceScore,
        status: 'approved',
        published_at: video.publishedAt,
      })

      if (success) {
        stats.added++
        console.log(`Added: ${video.title.substring(0, 50)}...`)
      }
    }

    // Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'youtube',
      items_fetched: stats.fetched,
      items_added: stats.added,
      items_updated: 0,
      items_skipped: stats.duplicates + stats.filtered_movie + stats.filtered_non_political + stats.invalid,
      errors: errors.length > 0 ? errors.join('; ') : undefined,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(200).json({
      success: true,
      run_id: runId,
      stats,
      message: `Curated ${stats.fetched} videos, added ${stats.added} new videos`,
    })

  } catch (error: any) {
    console.error('Media curation error:', error)

    await logCurationRun({
      run_id: runId,
      source: 'youtube',
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

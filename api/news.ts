import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getNews, getLastCurationTime, getStats } from '../lib/db'

/**
 * GET /api/news
 * Returns AI-curated news from Turso database
 * Curated every 4 hours by GitHub Action
 */

// TVK fallback images for news without images
const TVK_FALLBACK_IMAGES = [
  'https://pbs.twimg.com/profile_images/1820095725199663104/F-sJsNxg_400x400.jpg',
  'https://pbs.twimg.com/media/GXhQZ6jWQAApzPd?format=jpg&name=medium',
  'https://pbs.twimg.com/media/GXhQZ6hXMAA6XBd?format=jpg&name=medium',
  'https://pbs.twimg.com/media/GYG1aBVWIAAU1hO?format=jpg&name=medium',
  'https://pbs.twimg.com/media/GXi9RcgXcAAXKY2?format=jpg&name=medium',
]
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=900')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    // Parse query parameters
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0
    const language = req.query.language as string | undefined
    const category = req.query.category as string | undefined

    // Validate language
    if (language && !['en', 'ta'].includes(language)) {
      return res.status(400).json({ error: 'Invalid language. Use "en" or "ta"' })
    }

    // Validate category
    const validCategories = ['rally', 'announcement', 'event', 'interview', 'opinion', 'general']
    if (category && !validCategories.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Use one of: ${validCategories.join(', ')}` })
    }

    // Fetch news from Turso database
    const news = await getNews({ limit, offset, language, category })
    const lastCurated = await getLastCurationTime()
    const stats = await getStats()

    // Transform response for frontend compatibility
    // Use fallback images for news without images
    const transformedNews = news.map((item, index) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      url: item.url,
      image: item.image_url || TVK_FALLBACK_IMAGES[index % TVK_FALLBACK_IMAGES.length],
      source: item.source,
      language: item.language,
      category: item.category,
      relevanceScore: item.relevance_score,
      publishedAt: item.published_at,
    }))

    return res.status(200).json({
      success: true,
      news: transformedNews,
      count: transformedNews.length,
      total: stats.news,
      lastCurated,
      curationSchedule: 'Every 4 hours',
      filters: {
        limit,
        offset,
        language: language || 'all',
        category: category || 'all',
      },
    })

  } catch (error) {
    console.error('News API error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch news',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

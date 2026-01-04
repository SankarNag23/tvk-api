import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, getNews, getStats } from '../lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    await initDB()

    // Parse query parameters
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20)
    const offset = parseInt(req.query.offset as string) || 0

    // Get curated news
    const news = await getNews({ limit, offset })
    const stats = await getStats()

    return res.status(200).json({
      success: true,
      data: news.map(item => ({
        id: item.id,
        title: item.title,
        description: item.description,
        url: item.url,
        imageUrl: item.image_url,
        source: item.source_name,
        publishedAt: item.published_at,
        keywords: item.keywords_matched?.split(',') || [],
        sentiment: item.sentiment_score,
        relevance: item.relevance_score
      })),
      meta: {
        total: stats.news,
        limit,
        offset,
        lastCuration: stats.last_curation
      }
    })

  } catch (error: any) {
    console.error('Error fetching news:', error)
    return res.status(500).json({
      error: 'Failed to fetch news',
      message: error.message
    })
  }
}

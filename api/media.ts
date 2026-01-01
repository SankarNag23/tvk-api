import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getMedia, getLastCurationTime, getStats } from '../lib/db'

/**
 * GET /api/media
 * Returns AI-curated photos and videos from Turso database
 * Curated every 4 hours by GitHub Action
 */
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
    const type = req.query.type as 'image' | 'video' | undefined

    // Validate type
    if (type && !['image', 'video'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Use "image" or "video"' })
    }

    // Fetch media from Turso database
    const media = await getMedia({ limit, offset, type })
    const lastCurated = await getLastCurationTime()
    const stats = await getStats()

    // Transform response for frontend compatibility
    const transformedMedia = media.map(item => ({
      id: item.id,
      type: item.type,
      url: item.url,
      thumbnail: item.thumbnail_url || item.url,
      title: item.title,
      description: item.description,
      source: item.source,
      embedUrl: item.embed_url,
      width: item.width,
      height: item.height,
      relevanceScore: item.relevance_score,
      publishedAt: item.published_at,
    }))

    return res.status(200).json({
      success: true,
      media: transformedMedia,
      count: transformedMedia.length,
      total: stats.media,
      lastCurated,
      curationSchedule: 'Every 4 hours',
      filters: {
        limit,
        offset,
        type: type || 'all',
      },
    })

  } catch (error) {
    console.error('Media API error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch media',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

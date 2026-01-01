import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getHeroImages, getStats } from '../lib/db'

/**
 * GET /api/hero-images
 * Returns high-quality 4K/HD images for the hero carousel
 * Curated every 2 hours by GitHub Action
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
    const limit = Math.min(parseInt(req.query.limit as string) || 15, 30)
    const subject = req.query.subject as string | undefined

    // Validate subject
    const validSubjects = ['vijay', 'tvk', 'sengottaiyan', 'bussy_anand', 'rally', 'event']
    if (subject && !validSubjects.includes(subject)) {
      return res.status(400).json({
        error: `Invalid subject. Use one of: ${validSubjects.join(', ')}`
      })
    }

    // Fetch hero images from Turso database
    const images = await getHeroImages({ limit, subject, activeOnly: true })
    const stats = await getStats()

    // Transform response for frontend compatibility
    const transformedImages = images.map(img => ({
      id: img.id,
      url: img.url,
      thumbnailUrl: img.thumbnail_url,
      title: img.title,
      titleTa: img.title_ta,
      altText: img.alt_text || img.title,
      source: img.source,
      sourceUrl: img.source_url,
      width: img.width,
      height: img.height,
      aspectRatio: img.aspect_ratio,
      subject: img.subject,
      qualityScore: img.quality_score,
      displayOrder: img.display_order,
    }))

    return res.status(200).json({
      success: true,
      images: transformedImages,
      count: transformedImages.length,
      total: stats.hero_images,
      lastCurated: stats.last_curation,
      curationSchedule: 'Every 2 hours',
      filters: {
        limit,
        subject: subject || 'all',
      },
    })

  } catch (error) {
    console.error('Hero Images API error:', error)

    // Return fallback gradient on error
    return res.status(200).json({
      success: true,
      images: [{
        id: 'fallback-gradient',
        url: 'data:image/svg+xml,' + encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
            <defs>
              <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#DC2626"/>
                <stop offset="50%" style="stop-color:#000"/>
                <stop offset="100%" style="stop-color:#FBBF24"/>
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#bg)"/>
            <text x="50%" y="50%" text-anchor="middle" fill="white" font-size="72" font-family="Arial">TVK</text>
          </svg>
        `),
        title: 'TVK - Tamilaga Vettri Kazhagam',
        source: 'TVK',
        width: 1920,
        height: 1080,
      }],
      count: 1,
      fallback: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

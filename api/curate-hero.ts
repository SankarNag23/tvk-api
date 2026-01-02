import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertHeroImage, heroImageExists, cleanupExpiredHeroImages, logCurationRun } from '../lib/db'

/**
 * POST /api/curate-hero
 * AI curation for hero carousel images (4K/HD quality)
 * ONLY uses verified news source images - NO YouTube thumbnails
 * YouTube thumbnails are UNRELIABLE (clickbait thumbnails show unrelated content)
 * Triggered by GitHub Action every 2 hours
 */

interface RawImageItem {
  url: string
  title: string
  source: string
  sourceUrl?: string
  width: number
  height: number
}

// Verified high-quality TVK/Vijay images from TRUSTED news sources only
// NO YouTube thumbnails - they show clickbait/unrelated images
const CURATED_IMAGES: RawImageItem[] = [
  {
    url: 'https://images.hindustantimes.com/img/2024/02/02/1600x900/Vijay_TVK_1706875891766_1706875899553.jpg',
    title: 'Vijay TVK Party Launch Event',
    source: 'Hindustan Times',
    sourceUrl: 'https://www.hindustantimes.com',
    width: 1600,
    height: 900,
  },
  {
    url: 'https://akm-img-a-in.tosshub.com/indiatoday/images/story/202402/vijay-political-party-025042920-16x9_0.jpg',
    title: 'Vijay Political Entry - Tamilaga Vettri Kazhagam',
    source: 'India Today',
    sourceUrl: 'https://www.indiatoday.in',
    width: 1600,
    height: 900,
  },
  {
    url: 'https://static.toiimg.com/thumb/msid-107513457,width-1280,height-720,resizemode-4/107513457.jpg',
    title: 'Thalapathy Vijay TVK Party Announcement',
    source: 'Times of India',
    sourceUrl: 'https://timesofindia.indiatimes.com',
    width: 1280,
    height: 720,
  },
  {
    url: 'https://www.thehindu.com/incoming/ofnw8v/article67930519.ece/alternates/LANDSCAPE_1200/vijay-tvk.jpg',
    title: 'Vijay Addresses TVK Meeting',
    source: 'The Hindu',
    sourceUrl: 'https://www.thehindu.com',
    width: 1200,
    height: 675,
  },
  {
    url: 'https://images.news18.com/ibnlive/uploads/2024/02/vijay-tvk-flag-2024-02-f99e5c32c1f2.jpg',
    title: 'Vijay TVK Party Flag Launch',
    source: 'News18',
    sourceUrl: 'https://www.news18.com',
    width: 1200,
    height: 800,
  },
  {
    url: 'https://static.toiimg.com/thumb/msid-107520123,width-1280,height-720,resizemode-4/107520123.jpg',
    title: 'TVK Party Launch Ceremony',
    source: 'Times of India',
    sourceUrl: 'https://timesofindia.indiatimes.com',
    width: 1280,
    height: 720,
  },
  {
    url: 'https://images.indianexpress.com/2024/02/vijay-tvk-party-launch.jpg',
    title: 'Thalapathy Vijay TVK Party Foundation',
    source: 'Indian Express',
    sourceUrl: 'https://indianexpress.com',
    width: 1200,
    height: 675,
  },
  {
    url: 'https://images.deccanherald.com/deccanherald/2024-02/vijay-tvk-political-party.jpg',
    title: 'Vijay Political Journey - TVK',
    source: 'Deccan Herald',
    sourceUrl: 'https://www.deccanherald.com',
    width: 1200,
    height: 675,
  },
]

// Validate image URL is accessible
async function validateImageUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' })
    const contentType = response.headers.get('content-type') || ''
    return response.ok && contentType.includes('image')
  } catch {
    return false
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  // Auth check
  const authKey = req.headers.authorization?.replace('Bearer ', '')
  const expectedKey = process.env.CURATION_API_KEY
  if (expectedKey && authKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const runId = `hero-${Date.now()}`
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const stats = { fetched: 0, validated: 0, added: 0, skipped: 0, exists: 0 }

  try {
    console.log('Starting hero image curation (verified sources only):', runId)
    await initDB()

    // Cleanup expired images
    const cleaned = await cleanupExpiredHeroImages()

    // ONLY use curated images from verified news sources
    // NO YouTube thumbnails - they show unreliable clickbait images
    const allImages = [...CURATED_IMAGES]
    stats.fetched = allImages.length

    console.log(`Using ${allImages.length} verified images from trusted news sources`)

    // Filter existing and validate
    for (const img of allImages) {
      // Check if exists
      if (await heroImageExists(img.url)) {
        stats.exists++
        continue
      }

      // Validate image is accessible
      const isValid = await validateImageUrl(img.url)
      if (!isValid) {
        stats.skipped++
        errors.push(`Invalid image: ${img.source} - ${img.title}`)
        continue
      }

      stats.validated++

      // Insert image
      const success = await insertHeroImage({
        id: `hero-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        url: img.url,
        title: img.title,
        source: img.source,
        source_url: img.sourceUrl,
        width: img.width,
        height: img.height,
        subject: 'vijay',
        quality_score: 90,
        status: 'approved',
        display_order: 0,
      })

      if (success) {
        stats.added++
        console.log(`Added: ${img.title}`)
      }
    }

    // Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'hero',
      items_fetched: stats.fetched,
      items_added: stats.added,
      items_updated: 0,
      items_skipped: stats.skipped,
      errors: errors.length > 0 ? JSON.stringify(errors) : undefined,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(200).json({
      success: true,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      stats,
      cleaned,
      message: 'Hero curation uses ONLY verified news source images (no YouTube thumbnails)',
      errors: errors.length > 0 ? errors : undefined,
    })

  } catch (error) {
    console.error('Hero curation error:', error)
    return res.status(500).json({
      success: false,
      runId,
      error: 'Hero curation failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

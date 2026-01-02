import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertHeroImage, heroImageExists, cleanupExpiredHeroImages, logCurationRun } from '../lib/db'

/**
 * POST /api/curate-hero
 * AI curation for hero carousel images (4K/HD quality)
 * Sources: YouTube thumbnails, Google News images, direct image URLs
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

// Extended YouTube channels - Tamil news and politics
const YOUTUBE_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
  { name: 'News18 Tamil', channelId: 'UCat88i6_rELqI_prwvjspRA' },
  { name: 'Zee Tamil News', channelId: 'UCKydMnAP76PC0ZMZ_7OaDgQ' },
  { name: 'Kalaignar TV', channelId: 'UCjt8u9a1vU0J6xsqAE8knSg' },
  { name: 'Jaya Plus', channelId: 'UCuOeZgvvUP0gSoIyoSFvPEw' },
  { name: 'Captain News', channelId: 'UC9vTcL8IzV3P_2qiGXHxvXw' },
  { name: 'Raj News Tamil', channelId: 'UC7cPPVQ0iVKC9RomexC2jAg' },
  { name: 'Vendhar TV', channelId: 'UCTlgIRnl94Db8KaYKxGN4EQ' },
]

// TVK-specific keywords (must match these)
const TVK_KEYWORDS = [
  // Primary TVK terms
  'tvk', 'tamilaga vettri', 'தமிழக வெற்றி', 'தவெக',
  'tvk vijay', 'tvk party', 'tvk meeting', 'tvk rally',
  // TVK leaders
  'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
  // Vijay political context (must have tvk or party)
  'vijay tvk', 'vijay party launch', 'vijay political party',
  'thalapathy tvk', 'விஜய் தவெக', 'விஜய் கட்சி',
]

// EXCLUDE content with these anti-TVK / opposition keywords
const EXCLUDE_KEYWORDS = [
  // Opposition parties
  'dmk', 'admk', 'aiadmk', 'bjp', 'congress', 'pmk', 'mdmk',
  'திமுக', 'அதிமுக', 'பாஜக',
  // Opposition leaders
  'stalin', 'edappadi', 'eps', 'ops', 'annamalai', 'seeman',
  'ஸ்டாலின்', 'எடப்பாடி',
  // Negative terms
  'against vijay', 'criticize', 'slams', 'attacks', 'mocks',
  'troll', 'flop', 'failure', 'controversy',
  // Other actors named Vijay (to avoid confusion)
  'vijay sethupathi', 'vijay devarakonda', 'vijay antony',
]

// Curated high-quality TVK/Vijay images (verified working URLs)
const CURATED_IMAGES: RawImageItem[] = [
  {
    url: 'https://images.hindustantimes.com/img/2024/02/02/1600x900/Vijay_TVK_1706875891766_1706875899553.jpg',
    title: 'Vijay TVK Party Launch',
    source: 'Hindustan Times',
    sourceUrl: 'https://www.hindustantimes.com',
    width: 1600,
    height: 900,
  },
  {
    url: 'https://akm-img-a-in.tosshub.com/indiatoday/images/story/202402/vijay-political-party-025042920-16x9_0.jpg',
    title: 'Vijay Political Entry - TVK Launch',
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
    url: 'https://images.news18.com/ibnlive/uploads/2024/02/vijay-tvk-2024-02-02t201834.423-1-2024-02-f99e5c32c1f2f0e2c8f4a5e9d2a3b1c0.jpg',
    title: 'Vijay TVK Flag Launch',
    source: 'News18',
    sourceUrl: 'https://www.news18.com',
    width: 1200,
    height: 800,
  },
]

// Fetch YouTube thumbnails with relaxed filtering
async function fetchYouTubeThumbnails(errors: string[]): Promise<RawImageItem[]> {
  const images: RawImageItem[] = []

  for (const channel of YOUTUBE_CHANNELS) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TVK-Curation/2.0)' }
      })

      if (!response.ok) {
        errors.push(`YouTube ${channel.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 20)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const titleLower = title.toLowerCase()

        // Must match TVK keyword
        const isTVKRelated = TVK_KEYWORDS.some(kw =>
          titleLower.includes(kw.toLowerCase())
        )
        if (!isTVKRelated) continue

        // Exclude anti-TVK / opposition content
        const isExcluded = EXCLUDE_KEYWORDS.some(kw =>
          titleLower.includes(kw.toLowerCase())
        )
        if (isExcluded) continue

        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId) continue

        // Use maxresdefault for HD quality
        images.push({
          url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          title: title.trim(),
          source: `YouTube - ${channel.name}`,
          sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
          width: 1280,
          height: 720,
        })
      }
    } catch (err) {
      errors.push(`YouTube ${channel.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  return images
}

// Fetch images from Google News RSS
async function fetchGoogleNewsImages(errors: string[]): Promise<RawImageItem[]> {
  const images: RawImageItem[] = []
  const searches = [
    'Vijay+TVK+party',
    'Thalapathy+Vijay+politics',
    'TVK+Tamilaga+Vettri+Kazhagam',
    'விஜய்+தவெக',
  ]

  for (const query of searches) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TVK-Curation/2.0)' }
      })

      if (!response.ok) continue

      const text = await response.text()
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []

      for (const item of items.slice(0, 10)) {
        const title = item.match(/<title>([^<]*)<\/title>/)?.[1] || ''

        // Extract image from media:content or enclosure
        const mediaMatch = item.match(/url="([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i)
        if (!mediaMatch) continue

        const imageUrl = mediaMatch[1]
        if (!imageUrl.startsWith('http')) continue

        images.push({
          url: imageUrl,
          title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
          source: 'Google News',
          width: 1200,
          height: 675,
        })
      }
    } catch (err) {
      errors.push(`Google News: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  return images
}

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
    console.log('Starting hero image curation:', runId)
    await initDB()

    // Cleanup expired images
    const cleaned = await cleanupExpiredHeroImages()

    // Collect images from all sources
    const allImages: RawImageItem[] = []

    // 1. YouTube thumbnails
    console.log('Fetching YouTube thumbnails...')
    const ytImages = await fetchYouTubeThumbnails(errors)
    allImages.push(...ytImages)
    console.log(`YouTube: ${ytImages.length} images`)

    // 2. Google News images
    console.log('Fetching Google News images...')
    const newsImages = await fetchGoogleNewsImages(errors)
    allImages.push(...newsImages)
    console.log(`Google News: ${newsImages.length} images`)

    // 3. Curated high-quality images
    allImages.push(...CURATED_IMAGES)
    console.log(`Curated: ${CURATED_IMAGES.length} images`)

    stats.fetched = allImages.length

    if (allImages.length === 0) {
      return res.status(200).json({
        success: true,
        runId,
        message: 'No images found from any source',
        stats,
        errors: errors.length > 0 ? errors : undefined,
      })
    }

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
        quality_score: 80,
        status: 'approved',
        display_order: 0,
      })

      if (success) {
        stats.added++
        console.log(`Added: ${img.title.substring(0, 50)}...`)
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
      sources: {
        youtube: ytImages.length,
        googleNews: newsImages.length,
        curated: CURATED_IMAGES.length,
      },
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

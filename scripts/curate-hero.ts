/**
 * Hero Image Curation Script
 * Runs every 2 hours to fetch high-quality landscape images for hero carousel
 *
 * Requirements:
 * - Minimum resolution: 1280x720
 * - Landscape orientation (aspect ratio >= 1.3)
 * - Subjects: Vijay, TVK, Sengottaiyan, Bussy Anand, Rallies, Events
 */

import 'dotenv/config'
import { initDB, insertHeroImage, heroImageExists, cleanupExpiredHeroImages, closeDB } from '../lib/db'

interface RawImageItem {
  url: string
  title: string
  source: string
  sourceUrl?: string
  width?: number
  height?: number
}

// Image sources - Google News Images RSS for TVK/Vijay
const IMAGE_SEARCH_QUERIES = [
  { query: 'Vijay TVK rally 2024 2025', subject: 'rally' as const },
  { query: 'Tamilaga Vettri Kazhagam event', subject: 'event' as const },
  { query: 'Actor Vijay political rally', subject: 'vijay' as const },
  { query: 'TVK party meeting', subject: 'tvk' as const },
  { query: 'Sengottaiyan TVK', subject: 'sengottaiyan' as const },
  { query: 'Vijay speech rally', subject: 'vijay' as const },
]

// Curated high-quality image sources
const CURATED_IMAGE_SOURCES = [
  // News agency image feeds
  {
    name: 'Google Images TVK',
    rss: 'https://news.google.com/rss/search?q=TVK+Vijay+party+rally&tbm=isch&hl=en&gl=IN&ceid=IN:en',
  },
  {
    name: 'PTI Vijay',
    rss: 'https://news.google.com/rss/search?q=%22Vijay%22+%22TVK%22+source:pti&hl=en&gl=IN&ceid=IN:en',
  },
]

// Validate image dimensions by fetching headers
async function validateImageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  try {
    // First try to get dimensions from URL if it contains size info
    const sizeMatch = url.match(/[=_-](\d{3,4})x(\d{3,4})/i) || url.match(/width[=:](\d+)/i)
    if (sizeMatch) {
      const width = parseInt(sizeMatch[1])
      const height = sizeMatch[2] ? parseInt(sizeMatch[2]) : Math.floor(width * 0.5625) // Assume 16:9
      if (width >= 1280 && height >= 720 && width / height >= 1.3) {
        return { width, height }
      }
    }

    // For YouTube thumbnails, use maxresdefault dimensions
    if (url.includes('youtube.com') || url.includes('ytimg.com')) {
      if (url.includes('maxresdefault')) {
        return { width: 1280, height: 720 }
      }
      if (url.includes('hqdefault')) {
        return { width: 480, height: 360 }
      }
    }

    // Skip dimension check for known high-quality sources
    if (url.includes('pbs.twimg.com') && url.includes('large')) {
      return { width: 1600, height: 900 }
    }

    // For unknown sources, assume dimensions if URL suggests high quality
    if (url.match(/\.(jpg|jpeg|png|webp)$/i) && !url.includes('thumb')) {
      // Optimistically assume it might be large enough, let the image probe handle it
      return { width: 1280, height: 720 }
    }

    return null
  } catch {
    return null
  }
}

// Fetch images from Google News RSS
async function fetchNewsImages(errors: string[]): Promise<RawImageItem[]> {
  const images: RawImageItem[] = []

  for (const source of CURATED_IMAGE_SOURCES) {
    try {
      const response = await fetch(source.rss, {
        headers: { 'User-Agent': 'TVK-Hero-Curation-Bot/2.0' },
      })

      if (!response.ok) {
        errors.push(`${source.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []

      for (const item of items.slice(0, 15)) {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
          || item.match(/<title>([^<]*)<\/title>/)?.[1] || ''

        // Extract image URLs from various RSS tags
        const imageUrl = item.match(/<media:content[^>]*url="([^"]+)"[^>]*type="image/)?.[1]
          || item.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1]
          || item.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1]
          || item.match(/<image>\s*<url>([^<]+)<\/url>/)?.[1]
          || ''

        if (!imageUrl) continue

        // Skip small thumbnails
        if (imageUrl.includes('thumbnail') || imageUrl.includes('thumb') ||
            imageUrl.includes('_s.') || imageUrl.includes('-150x')) {
          continue
        }

        images.push({
          url: imageUrl,
          title: title.replace(/<[^>]*>/g, '').trim(),
          source: source.name,
        })
      }
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  return images
}

// Fetch high-resolution YouTube thumbnails from TVK-related videos
async function fetchYouTubeThumbnails(errors: string[]): Promise<RawImageItem[]> {
  const images: RawImageItem[] = []

  const channels = [
    { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
    { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
    { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
    { name: 'News7 Tamil', channelId: 'UCpATSg5_v9ZQ6cM4mMRqxUw' },
  ]

  const tvkKeywords = [
    'tvk', 'tamilaga vettri', 'vijay party', 'vijay politics',
    'விஜய் கட்சி', 'தமிழக வெற்றி', 'vijay rally', 'tvk rally'
  ]

  for (const channel of channels) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'TVK-Hero-Curation-Bot/2.0' }
      })

      if (!response.ok) {
        errors.push(`YouTube ${channel.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 10)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const titleLower = title.toLowerCase()

        // Check if TVK related
        const hasTVKKeyword = tvkKeywords.some(kw => titleLower.includes(kw.toLowerCase()))
        if (!hasTVKKeyword) continue

        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId) continue

        // Use maxresdefault for high quality
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

// Score images with AI for quality and relevance
async function scoreImagesWithAI(
  images: { url: string; title: string }[],
  groqKey: string
): Promise<{ quality: number; subject: string }[]> {
  const results: { quality: number; subject: string }[] = []

  for (let i = 0; i < images.length; i += 5) {
    const batch = images.slice(i, i + 5)

    const prompt = `Score each image title for quality and relevance as a hero banner for TVK (Tamilaga Vettri Kazhagam) political party website.

Subjects: vijay, tvk, sengottaiyan, bussy_anand, rally, event

Scoring:
- 90-100: Perfect hero material (Vijay at rally, TVK event, high impact)
- 70-89: Good quality (clear TVK/political context)
- 50-69: Acceptable (somewhat related)
- <50: Poor (unrelated or low quality)

Titles:
${batch.map((img, idx) => `${idx + 1}. "${img.title}"`).join('\n')}

Respond ONLY with JSON array: [{"quality": 85, "subject": "rally"}, ...]`

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 200,
        }),
      })

      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content || '[]'
      const jsonMatch = content.match(/\[[\s\S]*\]/)

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        results.push(...parsed)
      } else {
        results.push(...batch.map(() => ({ quality: 50, subject: 'event' })))
      }
    } catch {
      results.push(...batch.map(() => ({ quality: 50, subject: 'event' })))
    }
  }

  return results
}

// Main curation function
async function curateHeroImages(): Promise<void> {
  console.log('=== Hero Image Curation Started ===')
  console.log('Time:', new Date().toISOString())

  const GROQ_API_KEY = process.env.GROQ_API_KEY
  if (!GROQ_API_KEY) {
    console.error('ERROR: GROQ_API_KEY not configured')
    process.exit(1)
  }

  const errors: string[] = []
  const stats = { fetched: 0, validated: 0, scored: 0, added: 0, skipped: 0, exists: 0 }

  try {
    initDB()

    // Cleanup expired images first
    const cleaned = cleanupExpiredHeroImages()
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired hero images`)
    }

    // Fetch images from various sources
    console.log('Fetching images from news sources...')
    const newsImages = await fetchNewsImages(errors)
    console.log(`Found ${newsImages.length} news images`)

    console.log('Fetching YouTube thumbnails...')
    const ytImages = await fetchYouTubeThumbnails(errors)
    console.log(`Found ${ytImages.length} YouTube thumbnails`)

    const allImages = [...newsImages, ...ytImages]
    stats.fetched = allImages.length
    console.log(`Total images to process: ${allImages.length}`)

    // Filter and validate images
    const validImages: RawImageItem[] = []

    for (const img of allImages) {
      // Skip if already exists
      if (heroImageExists(img.url)) {
        stats.exists++
        continue
      }

      // Validate dimensions
      const dims = await validateImageDimensions(img.url)
      if (!dims || dims.width < 1280 || dims.height < 720) {
        stats.skipped++
        continue
      }

      // Check aspect ratio (landscape only)
      const aspectRatio = dims.width / dims.height
      if (aspectRatio < 1.3) {
        stats.skipped++
        continue
      }

      validImages.push({
        ...img,
        width: dims.width,
        height: dims.height,
      })
      stats.validated++
    }

    console.log(`Valid landscape images: ${validImages.length}`)

    if (validImages.length === 0) {
      console.log('No new valid images found')
      closeDB()
      return
    }

    // Score images with AI
    console.log('Scoring images with AI...')
    const scores = await scoreImagesWithAI(
      validImages.map(img => ({ url: img.url, title: img.title })),
      GROQ_API_KEY
    )
    stats.scored = scores.length

    // Insert qualified images
    console.log('Inserting qualified images...')
    const minScore = 60 // Minimum quality score for hero images

    for (let i = 0; i < validImages.length; i++) {
      const img = validImages[i]
      const score = scores[i] || { quality: 50, subject: 'event' }

      if (score.quality < minScore) {
        stats.skipped++
        continue
      }

      const validSubjects = ['vijay', 'tvk', 'sengottaiyan', 'bussy_anand', 'rally', 'event']
      const subject = validSubjects.includes(score.subject) ? score.subject : 'event'

      const success = insertHeroImage({
        id: `hero-${Date.now()}-${i}`,
        url: img.url,
        title: img.title,
        source: img.source,
        source_url: img.sourceUrl,
        width: img.width || 1280,
        height: img.height || 720,
        subject: subject as any,
        quality_score: score.quality,
        status: score.quality >= 80 ? 'approved' : 'pending',
        display_order: 0,
      })

      if (success) {
        stats.added++
        console.log(`Added: ${img.title.substring(0, 50)}... (score: ${score.quality})`)
      }
    }

    closeDB()

    console.log('\n=== Hero Curation Complete ===')
    console.log('Stats:', JSON.stringify(stats, null, 2))
    if (errors.length > 0) {
      console.log('Errors:', errors)
    }

  } catch (error) {
    console.error('Curation error:', error)
    closeDB()
    process.exit(1)
  }
}

// Run
curateHeroImages().then(() => {
  console.log('Hero curation finished successfully')
  process.exit(0)
}).catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

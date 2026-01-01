import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertHeroImage, heroImageExists, cleanupExpiredHeroImages, logCurationRun, getSetting } from '../lib/db'

/**
 * POST /api/curate-hero
 * AI curation for hero carousel images (4K/HD quality)
 * Triggered by GitHub Action every 2 hours
 * Protected by CURATION_API_KEY
 */

interface RawImageItem {
  url: string
  title: string
  source: string
  sourceUrl?: string
  width: number
  height: number
}

// YouTube news channels for video thumbnails
const YOUTUBE_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
  { name: 'News7 Tamil', channelId: 'UCpATSg5_v9ZQ6cM4mMRqxUw' },
  { name: 'Puthiya Thalaimurai', channelId: 'UCt0K_Bvs7lSNL60lHy-Bc0A' },
]

// TVK keywords for filtering
const TVK_KEYWORDS = [
  'tvk', 'tamilaga vettri', 'விஜய் கட்சி', 'தமிழக வெற்றி', 'தவெக',
  'vijay party', 'vijay politics', 'vijay rally', 'vijay speech',
  'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
]

// Fetch high-res YouTube thumbnails
async function fetchYouTubeThumbnails(errors: string[]): Promise<RawImageItem[]> {
  const images: RawImageItem[] = []

  for (const channel of YOUTUBE_CHANNELS) {
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

      for (const entry of entries.slice(0, 15)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const titleLower = title.toLowerCase()

        // Check if TVK related
        const hasTVKKeyword = TVK_KEYWORDS.some(kw => titleLower.includes(kw.toLowerCase()))
        const hasVijayPolitical = (titleLower.includes('vijay') || titleLower.includes('விஜய்')) &&
          (titleLower.includes('party') || titleLower.includes('politic') ||
           titleLower.includes('rally') || titleLower.includes('speech') ||
           titleLower.includes('கட்சி') || titleLower.includes('அரசியல்'))

        if (!hasTVKKeyword && !hasVijayPolitical) continue

        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId) continue

        // Use maxresdefault for high quality (1280x720)
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

// Score images with AI
async function scoreImagesWithAI(images: RawImageItem[], groqKey: string): Promise<{ quality: number; subject: string }[]> {
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
        results.push(...batch.map(() => ({ quality: 60, subject: 'event' })))
      }
    } catch {
      results.push(...batch.map(() => ({ quality: 60, subject: 'event' })))
    }
  }

  return results
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
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

  const GROQ_API_KEY = process.env.GROQ_API_KEY
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' })
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
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired hero images`)
    }

    // Fetch YouTube thumbnails
    console.log('Fetching YouTube thumbnails...')
    const ytImages = await fetchYouTubeThumbnails(errors)
    stats.fetched = ytImages.length
    console.log(`Found ${ytImages.length} potential hero images`)

    if (ytImages.length === 0) {
      return res.status(200).json({
        success: true,
        runId,
        message: 'No new images found',
        stats,
        errors: errors.length > 0 ? errors : undefined,
      })
    }

    // Filter already existing images
    const newImages: RawImageItem[] = []
    for (const img of ytImages) {
      if (await heroImageExists(img.url)) {
        stats.exists++
      } else {
        newImages.push(img)
        stats.validated++
      }
    }

    console.log(`New images to process: ${newImages.length}`)

    if (newImages.length === 0) {
      return res.status(200).json({
        success: true,
        runId,
        message: 'All images already exist',
        stats,
      })
    }

    // Score with AI
    console.log('Scoring images with AI...')
    const scores = await scoreImagesWithAI(newImages, GROQ_API_KEY)

    // Insert qualified images
    const minScore = parseInt(await getSetting('hero.min_score') || '60')
    const validSubjects = ['vijay', 'tvk', 'sengottaiyan', 'bussy_anand', 'rally', 'event']

    for (let i = 0; i < newImages.length; i++) {
      const img = newImages[i]
      const score = scores[i] || { quality: 50, subject: 'event' }

      if (score.quality < minScore) {
        stats.skipped++
        continue
      }

      const subject = validSubjects.includes(score.subject) ? score.subject : 'event'

      const success = await insertHeroImage({
        id: `hero-${Date.now()}-${i}`,
        url: img.url,
        title: img.title,
        source: img.source,
        source_url: img.sourceUrl,
        width: img.width,
        height: img.height,
        subject: subject,
        quality_score: score.quality,
        status: score.quality >= 80 ? 'approved' : 'pending',
        display_order: 0,
      })

      if (success) {
        stats.added++
        console.log(`Added: ${img.title.substring(0, 50)}... (score: ${score.quality})`)
      } else {
        stats.skipped++
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

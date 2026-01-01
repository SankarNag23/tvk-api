import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  initDB, insertNews, insertMedia, newsUrlExists, mediaUrlExists,
  logCurationRun, cleanupOldContent, getSetting
} from '../lib/db'

/**
 * POST /api/curate-media
 * AI curation for news and media content
 * Triggered by GitHub Action every 4 hours
 * Protected by CURATION_API_KEY
 */

interface RawNewsItem {
  title: string
  description: string
  url: string
  image?: string
  source: string
  pubDate: string
  lang: string
}

interface RawVideoItem {
  id: string
  title: string
  thumbnail: string
  publishedAt: string
  channelTitle: string
}

// News RSS sources
const NEWS_SOURCES = [
  { name: 'TVK Vijay News', rss: 'https://news.google.com/rss/search?q=%22TVK%22+%22Vijay%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'TVK Tamil', rss: 'https://news.google.com/rss/search?q=%22தமிழக+வெற்றிக்+கழகம்%22&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
  { name: 'Vijay Politics', rss: 'https://news.google.com/rss/search?q=%22Tamilaga+Vettri+Kazhagam%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'Vijay Party Tamil', rss: 'https://news.google.com/rss/search?q=விஜய்+கட்சி+TVK&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
]

// YouTube channels
const YOUTUBE_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
  { name: 'News7 Tamil', channelId: 'UCpATSg5_v9ZQ6cM4mMRqxUw' },
  { name: 'Puthiya Thalaimurai', channelId: 'UCt0K_Bvs7lSNL60lHy-Bc0A' },
]

// TVK keywords
const TVK_KEYWORDS = [
  'tvk', 'tamilaga vettri', 'தமிழக வெற்றி', 'தவெக',
  'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
]

const VIJAY_POLITICAL_KEYWORDS = [
  'vijay party', 'vijay politics', 'vijay political', 'actor vijay party',
  'thalapathy politics', 'விஜய் கட்சி', 'விஜய் அரசியல்',
  'vijay tvk', 'vijay rally', 'vijay speech',
]

function isTVKRelated(text: string): boolean {
  const lowerText = text.toLowerCase()
  const hasTVK = TVK_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))
  const hasVijayPolitical = VIJAY_POLITICAL_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))

  if (!hasTVK && !hasVijayPolitical) {
    if (lowerText.includes('vijay') || lowerText.includes('விஜய்')) {
      const politicalContext = ['party', 'politics', 'political', 'rally', 'speech', 'election',
                                'கட்சி', 'அரசியல்', 'பேரணி', 'தேர்தல்']
      return politicalContext.some(ctx => lowerText.includes(ctx))
    }
    return false
  }
  return true
}

// Fetch news from RSS
async function fetchRSSNews(errors: string[]): Promise<RawNewsItem[]> {
  const allItems: RawNewsItem[] = []

  for (const source of NEWS_SOURCES) {
    try {
      const response = await fetch(source.rss, {
        headers: { 'User-Agent': 'TVK-Curation-Bot/2.0' },
      })

      if (!response.ok) {
        errors.push(`${source.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []

      for (const item of items.slice(0, 20)) {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                   || item.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                         || item.match(/<description>([^<]*)<\/description>/)?.[1] || ''
        const link = item.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/)?.[1]
                   || item.match(/<link>([^<]+)<\/link>/)?.[1] || ''
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || ''
        const image = item.match(/<media:content[^>]*url="([^"]+)"/)?.[1]
                   || item.match(/<enclosure[^>]*url="([^"]+)"/)?.[1] || ''

        let parsedDate: string
        try {
          parsedDate = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
        } catch {
          parsedDate = new Date().toISOString()
        }

        allItems.push({
          title: title.replace(/<[^>]*>/g, '').trim(),
          description: description.replace(/<[^>]*>/g, '').substring(0, 500),
          url: link.trim(),
          image,
          source: source.name,
          pubDate: parsedDate,
          lang: source.lang,
        })
      }
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  return allItems
}

// Fetch YouTube videos
async function fetchYouTubeVideos(errors: string[]): Promise<RawVideoItem[]> {
  const videos: RawVideoItem[] = []

  for (const channel of YOUTUBE_CHANNELS) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'TVK-Curation-Bot/2.0' }
      })

      if (!response.ok) {
        errors.push(`YouTube ${channel.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 15)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''

        // Must be TVK related
        if (!isTVKRelated(title)) continue

        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId) continue

        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''

        videos.push({
          id: videoId,
          title: title.trim(),
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          publishedAt: published,
          channelTitle: channel.name,
        })
      }
    } catch (err) {
      errors.push(`YouTube ${channel.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  return videos
}

// Score content with AI
async function scoreWithAI(items: { title: string; description?: string }[], groqKey: string): Promise<number[]> {
  const scores: number[] = []

  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5)
    const prompt = `Score each news item for relevance to TVK (Tamilaga Vettri Kazhagam) party (0-100).
TVK is Actor Vijay's political party. Key figures: Vijay, Bussy Anand, Sengottaiyan.
95-100: Direct TVK news, Vijay political activities
70-94: Indirectly related political news
<50: Unrelated or negative content

Items:
${batch.map((item, idx) => `${idx + 1}. "${item.title}"`).join('\n')}

Respond ONLY with JSON array of scores: [score1, score2, ...]`

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
          max_tokens: 100,
        }),
      })

      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content || '[]'
      const scoresMatch = content.match(/\[[\d,\s]+\]/)
      const batchScores = scoresMatch ? JSON.parse(scoresMatch[0]) : batch.map(() => 50)
      scores.push(...batchScores)
    } catch {
      scores.push(...batch.map(() => 50))
    }
  }

  return scores
}

// Categorize news
function categorizeNews(title: string, description: string): string {
  const text = `${title} ${description}`.toLowerCase()
  if (text.includes('rally') || text.includes('பேரணி') || text.includes('meeting')) return 'rally'
  if (text.includes('announce') || text.includes('launch') || text.includes('அறிவிப்பு')) return 'announcement'
  if (text.includes('interview') || text.includes('speaks') || text.includes('பேட்டி')) return 'interview'
  if (text.includes('event') || text.includes('நிகழ்வு')) return 'event'
  return 'general'
}

// Detect language
function detectLanguage(text: string): 'ta' | 'en' {
  const tamilRegex = /[\u0B80-\u0BFF]/
  return tamilRegex.test(text) ? 'ta' : 'en'
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

  const runId = `media-${Date.now()}`
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const stats = {
    news: { fetched: 0, added: 0, skipped: 0 },
    media: { fetched: 0, added: 0, skipped: 0 },
  }

  try {
    console.log('Starting media curation:', runId)
    await initDB()

    // 1. Fetch news
    console.log('Fetching RSS news...')
    const rssNews = await fetchRSSNews(errors)
    stats.news.fetched = rssNews.length
    console.log(`Fetched ${rssNews.length} news items`)

    // 2. Fetch YouTube videos
    console.log('Fetching YouTube videos...')
    const videos = await fetchYouTubeVideos(errors)
    stats.media.fetched = videos.length
    console.log(`Fetched ${videos.length} videos`)

    // 3. Score news with AI
    console.log('Scoring news with AI...')
    const newsForScoring = rssNews.map(n => ({ title: n.title, description: n.description }))
    const newsScores = await scoreWithAI(newsForScoring, GROQ_API_KEY)

    // 4. Process news
    const minScore = parseInt(await getSetting('curation.min_score') || '50')

    for (let i = 0; i < rssNews.length; i++) {
      const item = rssNews[i]
      const score = newsScores[i] || 50

      // Skip if not TVK related or low score
      if (!isTVKRelated(`${item.title} ${item.description}`) || score < minScore) {
        stats.news.skipped++
        continue
      }

      // Skip if URL exists
      if (await newsUrlExists(item.url)) {
        stats.news.skipped++
        continue
      }

      const success = await insertNews({
        id: `news-${Date.now()}-${i}`,
        title: item.title,
        description: item.description,
        url: item.url,
        image_url: item.image || undefined,
        source: item.source,
        language: item.lang || detectLanguage(item.title),
        category: categorizeNews(item.title, item.description),
        relevance_score: score,
        status: score >= 80 ? 'approved' : 'pending',
        published_at: item.pubDate,
      })

      if (success) {
        stats.news.added++
        console.log(`Added news: ${item.title.substring(0, 50)}...`)
      } else {
        stats.news.skipped++
      }
    }

    // 5. Score and insert videos
    console.log('Processing videos...')
    const videoForScoring = videos.map(v => ({ title: v.title }))
    const videoScores = await scoreWithAI(videoForScoring, GROQ_API_KEY)

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]
      const score = videoScores[i] || 50

      if (score < minScore) {
        stats.media.skipped++
        continue
      }

      const videoUrl = `https://www.youtube.com/watch?v=${video.id}`
      if (await mediaUrlExists(videoUrl)) {
        stats.media.skipped++
        continue
      }

      const success = await insertMedia({
        id: `vid-${video.id}`,
        type: 'video',
        url: videoUrl,
        thumbnail_url: video.thumbnail,
        title: video.title,
        source: video.channelTitle,
        embed_url: `https://www.youtube.com/embed/${video.id}`,
        width: 1280,
        height: 720,
        relevance_score: score,
        status: score >= 80 ? 'approved' : 'pending',
        published_at: video.publishedAt,
      })

      if (success) {
        stats.media.added++
        console.log(`Added video: ${video.title.substring(0, 50)}...`)
      } else {
        stats.media.skipped++
      }
    }

    // 6. Cleanup old content
    console.log('Cleaning up old content...')
    const cleanupDays = parseInt(await getSetting('curation.cleanup_days') || '30')
    const cleanup = await cleanupOldContent(cleanupDays, minScore)
    console.log(`Cleaned up: ${cleanup.news} news, ${cleanup.media} media`)

    // 7. Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'media',
      items_fetched: stats.news.fetched + stats.media.fetched,
      items_added: stats.news.added + stats.media.added,
      items_updated: 0,
      items_skipped: stats.news.skipped + stats.media.skipped,
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
      cleanup,
      errors: errors.length > 0 ? errors : undefined,
    })

  } catch (error) {
    console.error('Media curation error:', error)
    return res.status(500).json({
      success: false,
      runId,
      error: 'Media curation failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  initDB, insertNews, insertMedia, newsUrlExists, mediaUrlExists,
  logCurationRun, cleanupOldContent
} from '../lib/db'

/**
 * POST /api/curate-media
 * AI curation for news, videos, AND images
 * Triggered by GitHub Action every 4 hours
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

interface RawImageItem {
  url: string
  title: string
  source: string
  sourceUrl?: string
}

// News RSS sources
const NEWS_SOURCES = [
  { name: 'TVK Vijay News', rss: 'https://news.google.com/rss/search?q=%22TVK%22+%22Vijay%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'TVK Tamil', rss: 'https://news.google.com/rss/search?q=%22தமிழக+வெற்றிக்+கழகம்%22&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
  { name: 'Vijay Politics', rss: 'https://news.google.com/rss/search?q=%22Tamilaga+Vettri+Kazhagam%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'Vijay Party Tamil', rss: 'https://news.google.com/rss/search?q=விஜய்+கட்சி+TVK&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
  { name: 'Thalapathy News', rss: 'https://news.google.com/rss/search?q=Thalapathy+Vijay+political&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
]

// Extended YouTube channels
const YOUTUBE_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
  { name: 'News18 Tamil', channelId: 'UCat88i6_rELqI_prwvjspRA' },
  { name: 'Zee Tamil News', channelId: 'UCKydMnAP76PC0ZMZ_7OaDgQ' },
  { name: 'Kalaignar TV', channelId: 'UCjt8u9a1vU0J6xsqAE8knSg' },
  { name: 'Jaya Plus', channelId: 'UCuOeZgvvUP0gSoIyoSFvPEw' },
  { name: 'Captain News', channelId: 'UC9vTcL8IzV3P_2qiGXHxvXw' },
]

// TVK-specific keywords (must match these)
const TVK_KEYWORDS = [
  // Primary TVK terms
  'tvk', 'tamilaga vettri', 'தமிழக வெற்றி', 'தவெக',
  'tvk vijay', 'tvk party', 'tvk meeting', 'tvk rally',
  // TVK leaders
  'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
  // Vijay political context
  'vijay tvk', 'vijay party', 'vijay political',
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
  // Other actors named Vijay
  'vijay sethupathi', 'vijay devarakonda', 'vijay antony',
]

function isTVKRelated(text: string): boolean {
  const lowerText = text.toLowerCase()

  // Must match at least one TVK keyword
  const hasTVK = TVK_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))
  if (!hasTVK) return false

  // Must NOT match any exclusion keyword
  const isExcluded = EXCLUDE_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))
  if (isExcluded) return false

  return true
}

// Fetch news from RSS
async function fetchRSSNews(errors: string[]): Promise<RawNewsItem[]> {
  const allItems: RawNewsItem[] = []

  for (const source of NEWS_SOURCES) {
    try {
      const response = await fetch(source.rss, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TVK-Curation/2.0)' },
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

        // Check if TVK related
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

// Fetch images from multiple sources
async function fetchImages(errors: string[]): Promise<RawImageItem[]> {
  const images: RawImageItem[] = []
  const searches = [
    'Vijay+TVK+party+images',
    'Thalapathy+Vijay+politics',
    'TVK+Tamilaga+Vettri+Kazhagam',
  ]

  // Google News image extraction
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

        // Extract image URL
        const mediaMatch = item.match(/url="([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i)
        if (!mediaMatch) continue

        const imageUrl = mediaMatch[1]
        if (!imageUrl.startsWith('http')) continue

        images.push({
          url: imageUrl,
          title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
          source: 'Google News',
        })
      }
    } catch (err) {
      errors.push(`Image search: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  // Curated high-quality images
  const curatedImages: RawImageItem[] = [
    {
      url: 'https://images.hindustantimes.com/img/2024/02/02/1600x900/Vijay_TVK_1706875891766_1706875899553.jpg',
      title: 'Vijay TVK Party Launch',
      source: 'Hindustan Times',
    },
    {
      url: 'https://akm-img-a-in.tosshub.com/indiatoday/images/story/202402/vijay-political-party-025042920-16x9_0.jpg',
      title: 'Vijay Political Entry',
      source: 'India Today',
    },
    {
      url: 'https://static.toiimg.com/thumb/msid-107513457,width-1280,height-720,resizemode-4/107513457.jpg',
      title: 'Thalapathy Vijay TVK Announcement',
      source: 'Times of India',
    },
  ]

  images.push(...curatedImages)

  return images
}

// Validate image URL
async function validateImageUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' })
    const contentType = response.headers.get('content-type') || ''
    return response.ok && contentType.includes('image')
  } catch {
    return false
  }
}

// Detect language
function detectLanguage(text: string): 'ta' | 'en' {
  const tamilRegex = /[\u0B80-\u0BFF]/
  return tamilRegex.test(text) ? 'ta' : 'en'
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

  const runId = `media-${Date.now()}`
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const stats = {
    news: { fetched: 0, added: 0, skipped: 0 },
    videos: { fetched: 0, added: 0, skipped: 0 },
    images: { fetched: 0, added: 0, skipped: 0 },
  }

  try {
    console.log('Starting media curation:', runId)
    await initDB()

    // 1. Fetch and process news
    console.log('Fetching RSS news...')
    const rssNews = await fetchRSSNews(errors)
    stats.news.fetched = rssNews.length

    for (const item of rssNews) {
      if (!isTVKRelated(`${item.title} ${item.description}`)) {
        stats.news.skipped++
        continue
      }

      if (await newsUrlExists(item.url)) {
        stats.news.skipped++
        continue
      }

      const success = await insertNews({
        id: `news-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: item.title,
        description: item.description,
        url: item.url,
        image_url: item.image || undefined,
        source: item.source,
        language: item.lang || detectLanguage(item.title),
        category: 'general',
        relevance_score: 80,
        status: 'approved',
        published_at: item.pubDate,
      })

      if (success) {
        stats.news.added++
      } else {
        stats.news.skipped++
      }
    }

    // 2. Fetch and process videos
    console.log('Fetching YouTube videos...')
    const videos = await fetchYouTubeVideos(errors)
    stats.videos.fetched = videos.length

    for (const video of videos) {
      const videoUrl = `https://www.youtube.com/watch?v=${video.id}`
      if (await mediaUrlExists(videoUrl)) {
        stats.videos.skipped++
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
        relevance_score: 85,
        status: 'approved',
        published_at: video.publishedAt,
      })

      if (success) {
        stats.videos.added++
      } else {
        stats.videos.skipped++
      }
    }

    // 3. Fetch and process images
    console.log('Fetching images...')
    const images = await fetchImages(errors)
    stats.images.fetched = images.length

    for (const img of images) {
      if (await mediaUrlExists(img.url)) {
        stats.images.skipped++
        continue
      }

      // Validate image
      const isValid = await validateImageUrl(img.url)
      if (!isValid) {
        stats.images.skipped++
        continue
      }

      const success = await insertMedia({
        id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'image',
        url: img.url,
        thumbnail_url: img.url,
        title: img.title,
        source: img.source,
        width: 1200,
        height: 675,
        relevance_score: 80,
        status: 'approved',
        published_at: new Date().toISOString(),
      })

      if (success) {
        stats.images.added++
      } else {
        stats.images.skipped++
      }
    }

    // 4. Cleanup old content
    console.log('Cleaning up old content...')
    const cleanup = await cleanupOldContent(30, 50)

    // 5. Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'media',
      items_fetched: stats.news.fetched + stats.videos.fetched + stats.images.fetched,
      items_added: stats.news.added + stats.videos.added + stats.images.added,
      items_updated: 0,
      items_skipped: stats.news.skipped + stats.videos.skipped + stats.images.skipped,
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

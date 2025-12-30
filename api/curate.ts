import type { VercelRequest, VercelResponse } from '@vercel/node'

// AI Curation Agent - Fetches and scores TVK-related content
// Called by GitHub Actions every 4 hours

interface NewsItem {
  id: string
  title: string
  description: string
  url: string
  image?: string
  source: string
  publishedAt: string
  language: 'en' | 'ta'
  category: 'event' | 'announcement' | 'rally' | 'general' | 'interview' | 'opinion'
  relevanceScore: number
}

interface MediaItem {
  id: string
  type: 'image' | 'video'
  url: string
  thumbnail: string
  title: string
  source: string
  publishedAt: string
  embedUrl?: string
  relevanceScore: number
}

// TVK-related search terms - expanded with key figures
const TVK_KEYWORDS = [
  'TVK', 'Tamilaga Vettri Kazhagam', 'தமிழக வெற்றிக் கழகம்',
  'Vijay politics', 'Vijay party', 'Vijay TVK', 'விஜய் அரசியல்',
  'Thalapathy Vijay political', 'Actor Vijay party',
  'Bussy Anand', 'N. Anand', 'Sengottaiyan', 'செங்கோட்டையன்',
  'TVK rally', 'TVK meeting', 'Vijay speech'
]

// Trusted news sources - Tamil Nadu focused
const NEWS_SOURCES = [
  { name: 'The Hindu TN', rss: 'https://www.thehindu.com/news/national/tamil-nadu/feeder/default.rss' },
  { name: 'The Hindu Politics', rss: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { name: 'NDTV', rss: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
  { name: 'India Today', rss: 'https://www.indiatoday.in/rss/home' },
]

// YouTube channels to fetch videos from (RSS feeds - NO API KEY NEEDED)
const YOUTUBE_CHANNELS = [
  { name: 'TVK Official', channelId: 'UC9RdE2udmP5OgKMLHhI0j0g' }, // TVK official channel if exists
  { name: 'Vijay TVK', channelId: 'UCqVEHtQoXHmUCfJ-9smpTSg' }, // Popular Tamil news
]

// YouTube search RSS (via invidious instances for no API key)
const YOUTUBE_SEARCH_QUERIES = [
  'TVK Tamilaga Vettri Kazhagam',
  'Vijay political speech 2025',
  'TVK rally meeting',
  'Bussy Anand TVK',
]

// Fetch and parse RSS feeds
async function fetchRSSNews(fetchErrors: string[]): Promise<any[]> {
  const allItems: any[] = []

  for (const source of NEWS_SOURCES) {
    try {
      console.log(`Fetching RSS from ${source.name}: ${source.rss}`)
      const response = await fetch(source.rss, {
        headers: { 'User-Agent': 'TVK-Curation-Bot/1.0' },
        redirect: 'follow'
      })

      if (!response.ok) {
        const errorMsg = `${source.name}: HTTP ${response.status} ${response.statusText}`
        console.error(errorMsg)
        fetchErrors.push(errorMsg)
        continue
      }

      const text = await response.text()
      console.log(`${source.name}: Received ${text.length} bytes`)

      // Simple RSS parsing
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []
      console.log(`${source.name}: Found ${items.length} items`)

      for (const item of items.slice(0, 20)) {
        // Extract fields - check CDATA patterns first
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                   || item.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                         || item.match(/<description>([^<]*)<\/description>/)?.[1] || ''
        const link = item.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/)?.[1]
                   || item.match(/<link>([^<]+)<\/link>/)?.[1] || ''
        const pubDate = item.match(/<pubDate><!\[CDATA\[(.*?)\]\]><\/pubDate>/)?.[1]
                     || item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || ''
        const image = item.match(/<media:content[^>]*url="([^"]+)"/)?.[1]
                   || item.match(/<enclosure[^>]*url="([^"]+)"/)?.[1] || ''

        // Safe date parsing
        let parsedDate: string
        try {
          parsedDate = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
        } catch {
          parsedDate = new Date().toISOString()
        }

        allItems.push({
          title: title.replace(/<[^>]*>/g, '').trim(),
          description: description.replace(/<[^>]*>/g, '').substring(0, 300),
          url: link.trim(),
          image,
          source: source.name,
          pubDate: parsedDate,
        })
      }
    } catch (err) {
      const errorMsg = `${source.name}: ${err instanceof Error ? err.message : 'Unknown error'}`
      console.error(`Failed to fetch ${source.name}:`, err)
      fetchErrors.push(errorMsg)
    }
  }

  return allItems
}

// Fetch YouTube videos via RSS (NO API KEY NEEDED)
async function fetchYouTubeVideosRSS(fetchErrors: string[]): Promise<any[]> {
  const videos: any[] = []
  const seenIds = new Set<string>()

  // Fetch from YouTube channel RSS feeds
  for (const channel of YOUTUBE_CHANNELS) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      console.log(`Fetching YouTube RSS: ${channel.name}`)
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'TVK-Curation-Bot/1.0' }
      })

      if (!response.ok) {
        fetchErrors.push(`YouTube ${channel.name}: HTTP ${response.status}`)
        continue
      }

      const text = await response.text()
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 10)) {
        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId || seenIds.has(videoId)) continue
        seenIds.add(videoId)

        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1]
                   || entry.match(/<media:title>([^<]*)<\/media:title>/)?.[1] || ''
        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''
        const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`

        videos.push({
          id: videoId,
          title: title.trim(),
          description: '',
          thumbnail,
          publishedAt: published,
          channelTitle: channel.name,
        })
      }
    } catch (err) {
      fetchErrors.push(`YouTube ${channel.name}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  // Also try to fetch trending TVK videos via scraping popular Tamil news channels
  const tamilNewsChannels = [
    { name: 'Thanthi TV', channelId: 'UCT6P1fgX1SNfqf0JQ6fAgVg' },
    { name: 'Puthiya Thalaimurai', channelId: 'UCmfY8uca1VdNdX5Ea5YJT6A' },
    { name: 'News7 Tamil', channelId: 'UCfIqZmrPOxgnoYVWmBwCwzA' },
  ]

  for (const channel of tamilNewsChannels) {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      const response = await fetch(rssUrl, {
        headers: { 'User-Agent': 'TVK-Curation-Bot/1.0' }
      })

      if (!response.ok) continue

      const text = await response.text()
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || []

      for (const entry of entries.slice(0, 15)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const titleLower = title.toLowerCase()

        // Only include TVK-related videos
        if (!titleLower.includes('tvk') &&
            !titleLower.includes('vijay') &&
            !titleLower.includes('tamilaga vettri') &&
            !titleLower.includes('bussy') &&
            !titleLower.includes('sengottaiyan')) {
          continue
        }

        const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!videoId || seenIds.has(videoId)) continue
        seenIds.add(videoId)

        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''
        const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`

        videos.push({
          id: videoId,
          title: title.trim(),
          description: '',
          thumbnail,
          publishedAt: published,
          channelTitle: channel.name,
        })
      }
    } catch (err) {
      // Silently skip errors for news channel fetching
    }
  }

  console.log(`Fetched ${videos.length} YouTube videos via RSS`)
  return videos
}

// Extract photos from news items that have images
function extractPhotosFromNews(newsItems: any[]): any[] {
  const photos: any[] = []
  const seenUrls = new Set<string>()

  for (const item of newsItems) {
    if (item.image && !seenUrls.has(item.image)) {
      seenUrls.add(item.image)
      photos.push({
        id: `photo-${Date.now()}-${photos.length}`,
        type: 'image',
        url: item.image,
        thumbnail: item.image,
        title: item.title,
        source: item.source,
        publishedAt: item.pubDate || new Date().toISOString(),
        relevanceScore: item.relevanceScore || 50,
      })
    }
  }

  return photos
}

// Use Groq AI to score relevance
async function scoreWithAI(items: any[], groqKey: string): Promise<any[]> {
  const scoredItems: any[] = []

  // Process in batches of 5
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5)

    const prompt = `You are a TVK (Tamilaga Vettri Kazhagam) news curator. Score each item's relevance to TVK political party (0-100).

TVK is Actor Vijay's political party in Tamil Nadu, India. Founded Feb 2024.
Key figures: Vijay (President), Bussy Anand/N. Anand (General Secretary), Sengottaiyan.

Score criteria - BE GENEROUS for Tamil Nadu political news:
- 95-100: Directly mentions TVK, Vijay's political activities, Bussy Anand, Sengottaiyan
- 80-94: Tamil Nadu state politics, elections, DMK, AIADMK, political rallies
- 60-79: Tamil Nadu news that affects politics or governance
- 40-59: General Tamil Nadu news, development, economy
- 0-39: Completely unrelated (sports, entertainment, other states)

IMPORTANT: Score Tamil Nadu political news HIGH (70+) even if TVK not mentioned directly.

Items to score:
${batch.map((item, idx) => `${idx + 1}. "${item.title}" - ${item.description?.substring(0, 100) || 'No description'}`).join('\n')}

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

      // Extract scores from response
      const scoresMatch = content.match(/\[[\d,\s]+\]/)
      const scores = scoresMatch ? JSON.parse(scoresMatch[0]) : batch.map(() => 50)

      batch.forEach((item, idx) => {
        scoredItems.push({
          ...item,
          relevanceScore: scores[idx] || 50
        })
      })
    } catch (err) {
      console.error('AI scoring error:', err)
      // Fallback: keyword-based scoring
      batch.forEach(item => {
        const text = `${item.title} ${item.description}`.toLowerCase()
        let score = 40 // Default higher for Tamil Nadu news
        if (text.includes('tvk') || text.includes('tamilaga vettri')) score = 98
        else if (text.includes('bussy') || text.includes('sengottaiyan')) score = 95
        else if (text.includes('vijay') && (text.includes('politi') || text.includes('party'))) score = 90
        else if (text.includes('vijay')) score = 70
        else if (text.includes('tamil nadu') || text.includes('chennai')) score = 60
        else if (text.includes('dmk') || text.includes('aiadmk') || text.includes('stalin')) score = 75
        scoredItems.push({ ...item, relevanceScore: score })
      })
    }
  }

  return scoredItems
}

// Categorize news
function categorizeNews(item: any): string {
  const text = `${item.title} ${item.description}`.toLowerCase()
  if (text.includes('rally') || text.includes('பேரணி') || text.includes('meeting')) return 'rally'
  if (text.includes('announce') || text.includes('launch') || text.includes('அறிவிப்பு')) return 'announcement'
  if (text.includes('interview') || text.includes('speaks') || text.includes('பேட்டி')) return 'interview'
  if (text.includes('opinion') || text.includes('analysis')) return 'opinion'
  if (text.includes('event') || text.includes('நிகழ்வு')) return 'event'
  return 'general'
}

// Detect language
function detectLanguage(text: string): 'ta' | 'en' {
  const tamilRegex = /[\u0B80-\u0BFF]/
  return tamilRegex.test(text) ? 'ta' : 'en'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  // Verify API key for curation trigger
  const authKey = req.headers.authorization?.replace('Bearer ', '')
  const expectedKey = process.env.CURATION_API_KEY

  if (expectedKey && authKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' })
  }

  try {
    console.log('Starting AI curation...')

    // Track errors for debugging
    const fetchErrors: string[] = []

    // 1. Fetch news from RSS feeds
    console.log('Fetching RSS news...')
    const rssNews = await fetchRSSNews(fetchErrors)
    console.log(`Fetched ${rssNews.length} RSS items`)

    // 2. Fetch YouTube videos via RSS (NO API KEY NEEDED)
    console.log('Fetching YouTube videos via RSS...')
    const videos = await fetchYouTubeVideosRSS(fetchErrors)
    console.log(`Fetched ${videos.length} YouTube videos`)

    // 3. Score news with AI
    console.log('Scoring news with AI...')
    const scoredNews = await scoreWithAI(rssNews, GROQ_API_KEY)

    // 4. Filter relevant news (score >= 50)
    const relevantNews = scoredNews
      .filter(item => item.relevanceScore >= 50)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 20)
      .map((item, idx) => ({
        id: `news-${Date.now()}-${idx}`,
        title: item.title,
        description: item.description,
        url: item.url,
        image: item.image,
        source: item.source,
        publishedAt: item.pubDate,
        language: detectLanguage(item.title),
        category: categorizeNews(item),
        relevanceScore: item.relevanceScore,
      }))

    // 5. Score and filter videos
    let relevantVideos: MediaItem[] = []
    if (videos.length > 0) {
      console.log('Scoring videos with AI...')
      const scoredVideos = await scoreWithAI(videos, GROQ_API_KEY)

      relevantVideos = scoredVideos
        .filter(item => item.relevanceScore >= 40) // Lower threshold for videos
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, 15)
        .map((item, idx) => ({
          id: `vid-${Date.now()}-${idx}`,
          type: 'video' as const,
          url: `https://www.youtube.com/watch?v=${item.id}`,
          thumbnail: item.thumbnail,
          title: item.title,
          source: item.channelTitle || 'YouTube',
          publishedAt: item.publishedAt,
          embedUrl: `https://www.youtube.com/embed/${item.id}`,
          relevanceScore: item.relevanceScore,
        }))
    }

    // 6. Extract photos from scored news items
    console.log('Extracting photos from news...')
    const photos = extractPhotosFromNews(scoredNews.filter(item => item.relevanceScore >= 50 && item.image))
    console.log(`Extracted ${photos.length} photos from news`)

    // Combine videos and photos into media
    const relevantMedia: MediaItem[] = [
      ...relevantVideos,
      ...photos.slice(0, 20), // Limit photos
    ]

    const result = {
      success: true,
      curatedAt: new Date().toISOString(),
      news: {
        count: relevantNews.length,
        items: relevantNews,
      },
      media: {
        count: relevantMedia.length,
        items: relevantMedia,
      },
      stats: {
        totalRSSFetched: rssNews.length,
        totalVideosFetched: videos.length,
        totalPhotosFetched: photos.length,
        newsAfterFiltering: relevantNews.length,
        videosAfterFiltering: relevantVideos.length,
        photosAfterFiltering: photos.length,
        mediaAfterFiltering: relevantMedia.length,
      },
      debug: {
        fetchErrors: fetchErrors.length > 0 ? fetchErrors : undefined,
      }
    }

    console.log('Curation complete:', result.stats)

    return res.status(200).json(result)

  } catch (error) {
    console.error('Curation error:', error)
    return res.status(500).json({
      success: false,
      error: 'Curation failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

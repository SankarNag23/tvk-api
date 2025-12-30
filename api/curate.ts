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

interface TweetItem {
  id: string
  text: string
  author: string
  authorHandle: string
  url: string
  publishedAt: string
  likes?: number
  retweets?: number
  media?: string[]
}

// STRICT TVK keywords - news MUST contain at least one of these
const TVK_MUST_HAVE_KEYWORDS = [
  'tvk', 'tamilaga vettri', 'தமிழக வெற்றி', 'தவெக',
  'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
]

// Vijay political keywords (must be combined with political context)
const VIJAY_POLITICAL_KEYWORDS = [
  'vijay party', 'vijay politics', 'vijay political', 'actor vijay party',
  'thalapathy politics', 'விஜய் கட்சி', 'விஜய் அரசியல்',
  'vijay tvk', 'vijay rally', 'vijay speech',
]

// Function to check if content is TVK-related
function isTVKRelated(text: string): boolean {
  const lowerText = text.toLowerCase()

  // Must have TVK keyword OR Vijay political keyword
  const hasTVK = TVK_MUST_HAVE_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))
  const hasVijayPolitical = VIJAY_POLITICAL_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))

  // Special case: "vijay" alone is NOT enough (could be cricket, other actors)
  // But "vijay" + political context is OK
  if (!hasTVK && !hasVijayPolitical) {
    if (lowerText.includes('vijay') || lowerText.includes('விஜய்')) {
      // Check for political context
      const politicalContext = ['party', 'politics', 'political', 'rally', 'speech', 'election',
                                'கட்சி', 'அரசியல்', 'பேரணி', 'தேர்தல்']
      return politicalContext.some(ctx => lowerText.includes(ctx))
    }
    return false
  }

  return true
}

// ONLY TVK-specific news sources - NO general Tamil Nadu news
const NEWS_SOURCES = [
  // Google News - TVK specific searches only
  { name: 'TVK Vijay News', rss: 'https://news.google.com/rss/search?q=%22TVK%22+%22Vijay%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'TVK Tamil', rss: 'https://news.google.com/rss/search?q=%22தமிழக+வெற்றிக்+கழகம்%22&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
  { name: 'Vijay Politics', rss: 'https://news.google.com/rss/search?q=%22Tamilaga+Vettri+Kazhagam%22&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
  { name: 'Vijay Party Tamil', rss: 'https://news.google.com/rss/search?q=விஜய்+கட்சி+TVK&hl=ta&gl=IN&ceid=IN:ta', lang: 'ta' },
  { name: 'Bussy Anand', rss: 'https://news.google.com/rss/search?q=%22Bussy+Anand%22+TVK&hl=en&gl=IN&ceid=IN:en', lang: 'en' },
]

// Tamil News YouTube channels (verified working RSS feeds - NO API KEY NEEDED)
const TAMIL_NEWS_CHANNELS = [
  { name: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA' },
  { name: 'Sun News', channelId: 'UCYlh4lH762HvHt6mmiecyWQ' },
  { name: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg' },
]

// TVK official/related images - using reliable public URLs
// NOTE: Using Wikimedia Commons and PTI images which allow embedding
const TVK_STATIC_IMAGES = [
  {
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/8c/TVK_Logo.svg',
    title: 'TVK Official Logo - தமிழக வெற்றிக் கழகம்',
    source: 'Wikipedia',
  },
  {
    url: 'https://i.imgur.com/placeholder.png', // Placeholder - will use frontend default
    title: 'Thalapathy Vijay - TVK தலைவர்',
    source: 'TVK Official',
  },
  {
    url: 'https://i.imgur.com/placeholder.png',
    title: 'TVK Party Launch - பிப்ரவரி 2024',
    source: 'TVK Official',
  },
  {
    url: 'https://i.imgur.com/placeholder.png',
    title: 'TVK Villupuram Rally - விழுப்புரம் பேரணி',
    source: 'TVK Official',
  },
]

// TVK-related Twitter/X accounts (official and fan accounts)
const TVK_TWITTER_ACCOUNTS = [
  'TVKVijayHQ',       // Official TVK Vijay account
  'TVKVijayTrends',   // TVK Trends account
]

// RSSHub and alternative Twitter RSS services
const TWITTER_RSS_SERVICES = [
  { base: 'https://rsshub.app/twitter/user', format: 'rsshub' },
  { base: 'https://nitter.poast.org', format: 'nitter' },
  { base: 'https://nitter.privacydev.net', format: 'nitter' },
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
          sourceLang: (source as any).lang || 'en', // Pass through source language
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

// Fetch Twitter/X posts via RSSHub or Nitter (NO API KEY NEEDED)
async function fetchTwitterPosts(fetchErrors: string[]): Promise<TweetItem[]> {
  const tweets: TweetItem[] = []
  const seenIds = new Set<string>()

  // Try each RSS service
  for (const service of TWITTER_RSS_SERVICES) {
    let serviceWorking = false

    for (const account of TVK_TWITTER_ACCOUNTS) {
      try {
        // Build URL based on service format
        let rssUrl: string
        if (service.format === 'rsshub') {
          rssUrl = `${service.base}/${account}`
        } else {
          rssUrl = `${service.base}/${account}/rss`
        }

        console.log(`Fetching Twitter RSS: @${account} from ${service.base}`)

        const response = await fetch(rssUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TVK-Bot/1.0)',
            'Accept': 'application/rss+xml, application/xml, text/xml',
          },
        })

        if (!response.ok) {
          console.log(`Twitter @${account}: HTTP ${response.status}`)
          continue
        }

        serviceWorking = true
        const text = await response.text()

        // Parse RSS items
        const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []
        console.log(`@${account}: Found ${items.length} tweets`)

        for (const item of items.slice(0, 15)) {
          const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                     || item.match(/<title>([^<]*)<\/title>/)?.[1] || ''
          const link = item.match(/<link>([^<]+)<\/link>/)?.[1] || ''
          const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || ''
          const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                           || item.match(/<description>([^<]*)<\/description>/)?.[1] || ''

          // Extract tweet ID from link
          const tweetId = link.match(/status\/(\d+)/)?.[1] || link.match(/\/(\d{15,})/)?.[1]
          if (!tweetId || seenIds.has(tweetId)) continue
          seenIds.add(tweetId)

          // Extract media URLs
          const mediaUrls = description.match(/https:\/\/[^\s"<>]+\.(jpg|jpeg|png|gif|mp4)/gi) || []

          // Safe date parsing
          let parsedDate: string
          try {
            parsedDate = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
          } catch {
            parsedDate = new Date().toISOString()
          }

          tweets.push({
            id: tweetId,
            text: title.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().substring(0, 280),
            author: account,
            authorHandle: `@${account}`,
            url: `https://x.com/${account}/status/${tweetId}`,
            publishedAt: parsedDate,
            media: mediaUrls.length > 0 ? mediaUrls : undefined,
          })
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Error'
        console.error(`Twitter @${account}: ${errMsg}`)
        fetchErrors.push(`Twitter @${account}: ${errMsg}`)
      }
    }

    // If this service worked, use it
    if (serviceWorking && tweets.length > 0) {
      console.log(`Using ${service.base} - got ${tweets.length} tweets`)
      break
    }
  }

  console.log(`Fetched ${tweets.length} Twitter posts total`)
  return tweets
}

// Fetch YouTube videos via RSS (NO API KEY NEEDED)
async function fetchYouTubeVideosRSS(fetchErrors: string[]): Promise<any[]> {
  const videos: any[] = []
  const seenIds = new Set<string>()

  // STRICT keywords - must have TVK specific terms
  const tvkKeywords = [
    'tvk', 'tamilaga vettri', 'தமிழக வெற்றி', 'தவெக',
    'bussy anand', 'sengottaiyan', 'செங்கோட்டையன்',
    'vijay party', 'vijay politics', 'vijay political',
    'விஜய் கட்சி', 'விஜய் அரசியல்'
  ]

  // Fetch from Tamil News YouTube channels
  for (const channel of TAMIL_NEWS_CHANNELS) {
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
      console.log(`${channel.name}: Found ${entries.length} videos`)

      for (const entry of entries.slice(0, 20)) {
        const title = entry.match(/<title>([^<]*)<\/title>/)?.[1] || ''
        const titleLower = title.toLowerCase()

        // STRICT: Only TVK-related videos - NO general political content
        const hasTVKKeyword = tvkKeywords.some(kw => titleLower.includes(kw))

        // Also check for "vijay" with political context
        const hasVijayPolitical = (titleLower.includes('vijay') || titleLower.includes('விஜய்')) &&
          (titleLower.includes('party') || titleLower.includes('politic') ||
           titleLower.includes('rally') || titleLower.includes('speech') ||
           titleLower.includes('கட்சி') || titleLower.includes('அரசியல்'))

        if (!hasTVKKeyword && !hasVijayPolitical) continue

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
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error(`YouTube ${channel.name}: ${errMsg}`)
      fetchErrors.push(`YouTube ${channel.name}: ${errMsg}`)
    }
  }

  console.log(`Fetched ${videos.length} TVK-related YouTube videos`)
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

    const prompt = `You are a TVK (Tamilaga Vettri Kazhagam) fan page curator. Score each item for POSITIVE relevance to TVK party (0-100).

TVK is Actor Vijay's political party in Tamil Nadu, India. Founded Feb 2024.
Key figures: Vijay (President), Bussy Anand/N. Anand (General Secretary), Sengottaiyan.

SCORING CRITERIA - Focus on POSITIVE news:
- 95-100: POSITIVE news about TVK, Vijay, Bussy Anand, Sengottaiyan (rallies, speeches, achievements)
- 85-94: Neutral news mentioning TVK/Vijay political activities
- 70-84: Positive Tamil Nadu political news, election news
- 50-69: General Tamil Nadu development/governance news
- 30-49: Neutral Tamil Nadu news
- 0-29: NEGATIVE/critical news about TVK OR unrelated content

IMPORTANT RULES:
1. BOOST positive/supportive TVK news to 95+
2. PENALIZE negative/critical news about TVK, Vijay to below 30
3. News about TVK rallies, meetings, Vijay speeches = 95+
4. News criticizing TVK or Vijay = 0-20

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

    // 3. Fetch Twitter posts via Nitter RSS
    console.log('Fetching Twitter posts...')
    const tweets = await fetchTwitterPosts(fetchErrors)
    console.log(`Fetched ${tweets.length} Twitter posts`)

    // 3. Score news with AI
    console.log('Scoring news with AI...')
    const scoredNews = await scoreWithAI(rssNews, GROQ_API_KEY)

    // 4. STRICT FILTER - Must be TVK-related AND score >= 70
    const relevantNews = scoredNews
      .filter(item => {
        const text = `${item.title} ${item.description}`.toLowerCase()
        // MUST contain TVK keywords - no general TN news
        if (!isTVKRelated(text)) {
          console.log(`Rejected (no TVK keywords): ${item.title.substring(0, 50)}`)
          return false
        }
        // Must have good score
        if (item.relevanceScore < 70) {
          console.log(`Rejected (score ${item.relevanceScore}): ${item.title.substring(0, 50)}`)
          return false
        }
        return true
      })
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
        language: item.sourceLang || detectLanguage(item.title),
        category: categorizeNews(item),
        relevanceScore: item.relevanceScore,
      }))

    // 5. STRICT filter videos - must be TVK related
    let relevantVideos: MediaItem[] = []
    if (videos.length > 0) {
      console.log('Scoring videos with AI...')
      const scoredVideos = await scoreWithAI(videos, GROQ_API_KEY)

      relevantVideos = scoredVideos
        .filter(item => {
          // Must be TVK related
          if (!isTVKRelated(item.title)) {
            console.log(`Video rejected (no TVK): ${item.title.substring(0, 50)}`)
            return false
          }
          return item.relevanceScore >= 60
        })
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

    // 6. Include TVK static images + news images
    console.log('Adding TVK photos...')
    const tvkNewsWithImages = scoredNews.filter(item => {
      if (!item.image) return false
      const text = `${item.title} ${item.description}`.toLowerCase()
      return isTVKRelated(text) && item.relevanceScore >= 70
    })
    const newsPhotos = extractPhotosFromNews(tvkNewsWithImages)

    // Add static TVK images
    const staticPhotos: MediaItem[] = TVK_STATIC_IMAGES.map((img, idx) => ({
      id: `tvk-static-${idx}`,
      type: 'image' as const,
      url: img.url,
      thumbnail: img.url,
      title: img.title,
      source: img.source,
      publishedAt: new Date().toISOString(),
      relevanceScore: 100, // Static images are always relevant
    }))

    const photos = [...staticPhotos, ...newsPhotos]
    console.log(`Total photos: ${photos.length} (${staticPhotos.length} static + ${newsPhotos.length} from news)`)

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
      twitter: {
        count: tweets.length,
        items: tweets.slice(0, 20), // Limit to 20 tweets
      },
      stats: {
        totalRSSFetched: rssNews.length,
        totalVideosFetched: videos.length,
        totalPhotosFetched: photos.length,
        totalTweetsFetched: tweets.length,
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

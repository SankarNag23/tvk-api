import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertTweet, tweetExists, logCurationRun } from '../lib/db'

// This is a simplified version of the content validation logic from curate-media.ts
// We can expand this as needed.
const NEGATIVE_KEYWORDS = [
  'dmk', 'admk', 'bjp', 'congress', 'pmk', 'stalin', 'eps', 'ops', 'annamalai', 'seeman',
  'against', 'oppose', 'criticize', 'attack', 'slam', 'fail', 'controversy', 'troll', 'mock',
  'vijay sethupathi', 'vijay devarakonda', 'vijay antony',
  'cricket', 'football', 'sports', 'match', 'score', 'ipl',
]

function isValidContent(text: string): boolean {
  const lower = text.toLowerCase()
  const hasTVK = lower.includes('tvk') || lower.includes('vijay') || lower.includes('விஜய்') || lower.includes('தவெக') || lower.includes('tamilaga vettri')
  if (!hasTVK) return false

  const hasNegative = NEGATIVE_KEYWORDS.some(kw => lower.includes(kw))
  if (hasNegative) return false

  return true
}

async function fetchRecentTweets(query: string, bearerToken: string) {
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&expansions=author_id&tweet.fields=created_at,public_metrics&user.fields=profile_image_url`
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Twitter API failed with status ${response.status}: ${errorBody}`)
  }

  return response.json()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'POST') {
    const authKey = req.headers.authorization?.replace('Bearer ', '')
    if (authKey !== process.env.CURATION_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  } else {
    return res.status(405).json({ error: 'Method not allowed. Use POST.'})
  }

  const twitterBearerToken = process.env.TWITTER_API_KEY
  if (!twitterBearerToken) {
    return res.status(500).json({ error: 'TWITTER_API_KEY is not configured.' })
  }

  const runId = `tweets-${Date.now()}`
  const startedAt = new Date().toISOString()
  const stats = { fetched: 0, added: 0, skipped: 0, exists: 0 }

  try {
    console.log('Starting Twitter curation:', runId)
    await initDB()

    const searchQuery = '(TVK OR "Tamilaga Vettri Kazhagam" OR #actorvijay OR #TVK) lang:ta -is:retweet'
    const twitterResponse = await fetchRecentTweets(searchQuery, twitterBearerToken)
    
    const tweets = twitterResponse.data || []
    const users = twitterResponse.includes?.users || []
    const userMap = new Map(users.map((user: any) => [user.id, user]))
    stats.fetched = tweets.length

    for (const tweet of tweets) {
      if (!isValidContent(tweet.text)) {
        stats.skipped++
        continue
      }

      if (await tweetExists(tweet.id)) {
        stats.exists++
        continue
      }

      const author = userMap.get(tweet.author_id)
      const success = await insertTweet({
        id: tweet.id,
        text: tweet.text,
        author: author?.name || 'Unknown',
        author_handle: author?.username || 'unknown',
        author_avatar: author?.profile_image_url || '',
        url: `https://twitter.com/${author?.username || 'anyuser'}/status/${tweet.id}`,
        likes: tweet.public_metrics?.like_count || 0,
        retweets: tweet.public_metrics?.retweet_count || 0,
        relevance_score: 70, // Default score
        status: 'approved',
        published_at: tweet.created_at,
      })

      if (success) {
        stats.added++
      }
    }

    await logCurationRun({
      run_id: runId,
      source: 'twitter',
      items_fetched: stats.fetched,
      items_added: stats.added,
      items_updated: 0,
      items_skipped: stats.skipped,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })

    return res.status(200).json({ success: true, runId, stats })

  } catch (error) {
    console.error('Twitter curation error:', error)
    return res.status(500).json({
      success: false,
      runId,
      error: 'Twitter curation failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

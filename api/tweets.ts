import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getTweets, getLastCurationTime } from '../lib/db'

/**
 * GET /api/tweets
 * Returns tweets from Turso database
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
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)
    const offset = parseInt(req.query.offset as string) || 0

    // Fetch tweets from Turso database
    const tweets = await getTweets({ limit, offset })
    const lastCurated = await getLastCurationTime()

    // Transform response for frontend compatibility
    const transformedTweets = tweets.map(item => ({
      id: item.id,
      text: item.text,
      author: item.author,
      authorHandle: item.author_handle,
      authorAvatar: item.author_avatar,
      url: item.url,
      media: item.media_urls ? JSON.parse(item.media_urls) : [],
      likes: item.likes,
      retweets: item.retweets,
      publishedAt: item.published_at,
    }))

    return res.status(200).json({
      success: true,
      tweets: transformedTweets,
      count: transformedTweets.length,
      lastCurated,
      filters: {
        limit,
        offset,
      },
    })

  } catch (error) {
    console.error('Tweets API error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch tweets',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

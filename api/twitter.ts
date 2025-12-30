import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import { join } from 'path'

// Serve curated Twitter posts from curated.json

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Read curated data
    const dataPath = join(process.cwd(), 'data', 'curated.json')
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'))

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)

    const twitter = data.twitter || { count: 0, items: [] }
    const items = twitter.items.slice(0, limit)

    return res.status(200).json({
      success: true,
      count: items.length,
      items,
      curatedAt: data.curatedAt,
    })
  } catch (error) {
    console.error('Twitter API error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to load Twitter data',
      count: 0,
      items: [],
    })
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import { join } from 'path'

// Shorts Gallery API - Serves manually curated video shorts
// Edit data/shorts.json to add/remove shorts

interface Short {
  id: string
  platform: 'youtube' | 'facebook' | 'twitter'
  url: string
  videoId: string
  title?: string
  active: boolean
}

interface ShortsData {
  shorts: Short[]
  updatedAt: string
}

// Helper to extract video ID from various URL formats
function extractVideoId(url: string, platform: string): string | null {
  try {
    if (platform === 'youtube') {
      // YouTube Shorts: https://www.youtube.com/shorts/VIDEO_ID
      // YouTube Regular: https://www.youtube.com/watch?v=VIDEO_ID
      // YouTube Short URL: https://youtu.be/VIDEO_ID
      const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/)
      if (shortsMatch) return shortsMatch[1]

      const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]+)/)
      if (watchMatch) return watchMatch[1]

      const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/)
      if (shortUrlMatch) return shortUrlMatch[1]
    }

    if (platform === 'facebook') {
      // Facebook video URLs vary widely
      const fbMatch = url.match(/\/videos\/(\d+)/) || url.match(/\/reel\/(\d+)/)
      if (fbMatch) return fbMatch[1]
    }

    if (platform === 'twitter') {
      // Twitter/X video: https://twitter.com/user/status/STATUS_ID
      const twitterMatch = url.match(/\/status\/(\d+)/)
      if (twitterMatch) return twitterMatch[1]
    }

    return null
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  // GET - Return active shorts
  if (req.method === 'GET') {
    try {
      const dataPath = join(process.cwd(), 'data', 'shorts.json')
      const rawData = readFileSync(dataPath, 'utf-8')
      const data: ShortsData = JSON.parse(rawData)

      // Filter to only active shorts
      const activeShorts = data.shorts.filter(s => s.active)

      return res.status(200).json({
        success: true,
        shorts: activeShorts,
        total: activeShorts.length,
        updatedAt: data.updatedAt
      })
    } catch (error) {
      console.error('Error reading shorts:', error)
      return res.status(500).json({
        success: false,
        error: 'Failed to load shorts',
        shorts: []
      })
    }
  }

  // POST - Add a new short (protected by API key)
  if (req.method === 'POST') {
    const authHeader = req.headers.authorization
    const apiKey = process.env.CURATION_API_KEY

    if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    try {
      const { url, platform = 'youtube', title } = req.body

      if (!url) {
        return res.status(400).json({ error: 'URL is required' })
      }

      const videoId = extractVideoId(url, platform)
      if (!videoId) {
        return res.status(400).json({ error: 'Could not extract video ID from URL' })
      }

      // Read current data
      const dataPath = join(process.cwd(), 'data', 'shorts.json')
      const rawData = readFileSync(dataPath, 'utf-8')
      const data: ShortsData = JSON.parse(rawData)

      // Check for duplicates
      if (data.shorts.some(s => s.videoId === videoId)) {
        return res.status(400).json({ error: 'This video is already in the shorts list' })
      }

      // Add new short
      const newShort: Short = {
        id: Date.now().toString(),
        platform: platform as 'youtube' | 'facebook' | 'twitter',
        url,
        videoId,
        title: title || `Short ${data.shorts.length + 1}`,
        active: true
      }

      data.shorts.unshift(newShort) // Add to beginning
      data.updatedAt = new Date().toISOString()

      // Note: In serverless, we can't write to filesystem persistently
      // This POST endpoint is for reference - actual editing should be done
      // by editing the shorts.json file directly in GitHub

      return res.status(200).json({
        success: true,
        message: 'Short added (note: edit data/shorts.json in GitHub for persistence)',
        short: newShort
      })

    } catch (error) {
      console.error('Error adding short:', error)
      return res.status(500).json({ error: 'Failed to add short' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

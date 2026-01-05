import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import { join } from 'path'

// Shorts Gallery API - Just paste URLs, system auto-detects platform and extracts IDs

interface RawShort {
  id: string
  url: string
  title?: string
  active?: boolean
}

interface ProcessedShort {
  id: string
  url: string
  platform: 'youtube' | 'facebook' | 'twitter' | 'instagram'
  videoId: string
  embedUrl: string
  title?: string
}

// Auto-detect platform from URL
function detectPlatform(url: string): 'youtube' | 'facebook' | 'twitter' | 'instagram' | null {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook'
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter'
  if (url.includes('instagram.com')) return 'instagram'
  return null
}

// Extract video ID from URL
function extractVideoId(url: string, platform: string): string | null {
  try {
    if (platform === 'youtube') {
      // YouTube Shorts: /shorts/VIDEO_ID
      const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/)
      if (shortsMatch) return shortsMatch[1]
      // YouTube watch: ?v=VIDEO_ID
      const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]+)/)
      if (watchMatch) return watchMatch[1]
      // YouTube short URL: youtu.be/VIDEO_ID
      const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/)
      if (shortUrlMatch) return shortUrlMatch[1]
    }

    if (platform === 'facebook') {
      // Facebook share URL: /share/v/VIDEO_ID/ or /share/r/VIDEO_ID/
      const shareMatch = url.match(/\/share\/[vr]\/([a-zA-Z0-9]+)/)
      if (shareMatch) return shareMatch[1]
      // Facebook reel: /reel/VIDEO_ID
      const reelMatch = url.match(/\/reel\/(\d+)/)
      if (reelMatch) return reelMatch[1]
      // Facebook video: /videos/VIDEO_ID
      const videoMatch = url.match(/\/videos\/(\d+)/)
      if (videoMatch) return videoMatch[1]
      // fb.watch short URL
      const fbWatchMatch = url.match(/fb\.watch\/([a-zA-Z0-9]+)/)
      if (fbWatchMatch) return fbWatchMatch[1]
    }

    if (platform === 'twitter') {
      // Twitter/X: /status/STATUS_ID
      const twitterMatch = url.match(/\/status\/(\d+)/)
      if (twitterMatch) return twitterMatch[1]
    }

    if (platform === 'instagram') {
      // Instagram reel: /reel/CODE/ or /p/CODE/
      const instaMatch = url.match(/\/(reel|p)\/([a-zA-Z0-9_-]+)/)
      if (instaMatch) return instaMatch[2]
    }

    return null
  } catch {
    return null
  }
}

// Generate embed URL for each platform
function getEmbedUrl(url: string, platform: string, videoId: string): string {
  switch (platform) {
    case 'youtube':
      return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&controls=0&playsinline=1`

    case 'facebook':
      // Facebook video embed plugin
      const encodedUrl = encodeURIComponent(url)
      return `https://www.facebook.com/plugins/video.php?href=${encodedUrl}&show_text=false&width=280&height=500&autoplay=true&mute=true`

    case 'twitter':
      // Twitter doesn't have easy iframe embed - return original URL
      return url

    case 'instagram':
      // Instagram embed
      return `https://www.instagram.com/reel/${videoId}/embed`

    default:
      return url
  }
}

// Process raw shorts into full details
function processShort(raw: RawShort): ProcessedShort | null {
  const platform = detectPlatform(raw.url)
  if (!platform) return null

  const videoId = extractVideoId(raw.url, platform)
  if (!videoId) return null

  return {
    id: raw.id,
    url: raw.url,
    platform,
    videoId,
    embedUrl: getEmbedUrl(raw.url, platform, videoId),
    title: raw.title
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const dataPath = join(process.cwd(), 'data', 'shorts.json')
    const rawData = readFileSync(dataPath, 'utf-8')
    const data = JSON.parse(rawData)

    // Process each short - auto-detect platform and extract IDs
    const processedShorts: ProcessedShort[] = []

    for (const raw of data.shorts) {
      if (raw.active === false) continue // Skip inactive shorts

      const processed = processShort(raw)
      if (processed) {
        processedShorts.push(processed)
      }
    }

    return res.status(200).json({
      success: true,
      shorts: processedShorts,
      total: processedShorts.length,
      updatedAt: data.updatedAt
    })

  } catch (error) {
    console.error('Shorts API error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to load shorts',
      shorts: []
    })
  }
}

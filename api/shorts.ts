import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import { join } from 'path'

// Shorts Gallery API - Just paste URLs, system resolves and embeds

interface RawShort {
  id: string
  url: string
  title?: string
  active?: boolean
  // Resolved URL (cached after first resolution)
  resolvedUrl?: string
  reelId?: string
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
      const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/)
      if (shortsMatch) return shortsMatch[1]
      const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]+)/)
      if (watchMatch) return watchMatch[1]
      const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/)
      if (shortUrlMatch) return shortUrlMatch[1]
    }

    if (platform === 'facebook') {
      // Facebook reel: /reel/VIDEO_ID
      const reelMatch = url.match(/\/reel\/(\d+)/)
      if (reelMatch) return reelMatch[1]
      // Facebook share URL: /share/v/VIDEO_ID/
      const shareMatch = url.match(/\/share\/[vr]\/([a-zA-Z0-9]+)/)
      if (shareMatch) return shareMatch[1]
      // Facebook video: /videos/VIDEO_ID
      const videoMatch = url.match(/\/videos\/(\d+)/)
      if (videoMatch) return videoMatch[1]
    }

    if (platform === 'twitter') {
      const twitterMatch = url.match(/\/status\/(\d+)/)
      if (twitterMatch) return twitterMatch[1]
    }

    if (platform === 'instagram') {
      const instaMatch = url.match(/\/(reel|p)\/([a-zA-Z0-9_-]+)/)
      if (instaMatch) return instaMatch[2]
    }

    return null
  } catch {
    return null
  }
}

// Resolve Facebook share URL to get actual reel ID
async function resolveFacebookUrl(url: string): Promise<{ resolvedUrl: string; reelId: string } | null> {
  try {
    // Check if it's already a reel URL
    const reelMatch = url.match(/\/reel\/(\d+)/)
    if (reelMatch) {
      return { resolvedUrl: url, reelId: reelMatch[1] }
    }

    // For share URLs, we need to follow the redirect with browser-like headers
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    })

    const location = response.headers.get('location')
    if (location) {
      const resolvedReelMatch = location.match(/\/reel\/(\d+)/)
      if (resolvedReelMatch) {
        return { resolvedUrl: location, reelId: resolvedReelMatch[1] }
      }
    }

    // If redirect didn't work, try to extract from the share URL itself
    // Facebook share URLs sometimes have format /share/v/ENCODED_ID/
    const shareMatch = url.match(/\/share\/[vr]\/([a-zA-Z0-9]+)/)
    if (shareMatch) {
      // Use the share ID directly - Facebook embed might accept it
      return { resolvedUrl: url, reelId: shareMatch[1] }
    }

    return null
  } catch (error) {
    console.error('Failed to resolve Facebook URL:', url, error)
    // Fallback: extract share ID
    const shareMatch = url.match(/\/share\/[vr]\/([a-zA-Z0-9]+)/)
    if (shareMatch) {
      return { resolvedUrl: url, reelId: shareMatch[1] }
    }
    return null
  }
}

// Generate embed URL for each platform
function getEmbedUrl(platform: string, videoId: string, originalUrl: string): string {
  switch (platform) {
    case 'youtube':
      return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&controls=0&playsinline=1`

    case 'facebook':
      // Use the original share URL in the embed - Facebook handles the redirect
      const encodedUrl = encodeURIComponent(originalUrl.split('?')[0]) // Remove query params
      return `https://www.facebook.com/plugins/video.php?href=${encodedUrl}&show_text=false&width=280&height=500&autoplay=true&mute=1`

    case 'instagram':
      return `https://www.instagram.com/reel/${videoId}/embed`

    default:
      return originalUrl
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    const processedShorts: ProcessedShort[] = []

    for (const raw of data.shorts) {
      if (raw.active === false) continue

      const platform = detectPlatform(raw.url)
      if (!platform) continue

      let videoId: string | null = null

      // For Facebook, resolve share URLs to get reel IDs
      if (platform === 'facebook') {
        // Check if we have a cached reel ID
        if (raw.reelId) {
          videoId = raw.reelId
        } else {
          const resolved = await resolveFacebookUrl(raw.url)
          if (resolved) {
            videoId = resolved.reelId
          }
        }
      } else {
        videoId = extractVideoId(raw.url, platform)
      }

      if (!videoId) continue

      processedShorts.push({
        id: raw.id,
        url: raw.url,
        platform,
        videoId,
        embedUrl: getEmbedUrl(platform, videoId, raw.url),
        title: raw.title
      })
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

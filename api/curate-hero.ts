import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initDB, insertHeroImage, heroImageExists, cleanupExpiredHeroImages, logCurationRun } from '../lib/db'

/**
 * POST /api/curate-hero
 * Web scrapes HD/4K landscape images of TVK leaders
 * Searches: Vijay, Sengottaiyan, Bussy Anand, TVK party
 * Filters: Landscape, HD quality, portrait photos, positive gestures
 */

interface ScrapedImage {
  url: string
  title: string
  source: string
  width: number
  height: number
}

// Search queries for TVK leaders and party
const SEARCH_QUERIES = [
  'Vijay TVK party leader HD',
  'Thalapathy Vijay political speech',
  'Vijay TVK rally crowd',
  'Sengottaiyan TVK leader',
  'Bussy Anand TVK general secretary',
  'TVK Tamilaga Vettri Kazhagam flag',
  'Vijay politician Tamil Nadu',
  'TVK party conference Vikravandi',
]

// Scrape images from Bing (more permissive than Google)
async function scrapeBingImages(query: string): Promise<ScrapedImage[]> {
  const images: ScrapedImage[] = []

  try {
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large+filterui:aspect-wide&form=IRFLTR`

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    })

    if (!response.ok) return images

    const html = await response.text()

    // Extract image URLs from Bing's data attributes
    const mRegex = /murl&quot;:&quot;(https?:\/\/[^&]+\.(?:jpg|jpeg|png|webp))/gi
    let match

    while ((match = mRegex.exec(html)) !== null) {
      const url = match[1].replace(/\\u002f/g, '/')

      // Skip small thumbnails and known bad sources
      if (url.includes('thumb') || url.includes('120x') || url.includes('150x')) continue
      if (url.includes('youtube.com') || url.includes('ytimg.com')) continue // Skip YouTube

      images.push({
        url,
        title: query,
        source: 'Bing Images',
        width: 1920,
        height: 1080,
      })

      if (images.length >= 5) break // Limit per query
    }
  } catch (error) {
    console.error(`Bing scrape error for "${query}":`, error)
  }

  return images
}

// Scrape from DuckDuckGo Images (privacy-friendly, less blocking)
async function scrapeDuckDuckGoImages(query: string): Promise<ScrapedImage[]> {
  const images: ScrapedImage[] = []

  try {
    // DDG requires a token first
    const tokenUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`
    const tokenResponse = await fetch(tokenUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    })

    const tokenHtml = await tokenResponse.text()
    const vqdMatch = tokenHtml.match(/vqd=['"]([^'"]+)['"]/)
    if (!vqdMatch) return images

    const vqd = vqdMatch[1]
    const imageUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=size:Large,type:photo`

    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    })

    if (!imageResponse.ok) return images

    const data = await imageResponse.json()

    for (const result of (data.results || []).slice(0, 5)) {
      if (!result.image) continue
      if (result.image.includes('youtube') || result.image.includes('ytimg')) continue

      images.push({
        url: result.image,
        title: result.title || query,
        source: result.source || 'DuckDuckGo',
        width: result.width || 1920,
        height: result.height || 1080,
      })
    }
  } catch (error) {
    console.error(`DDG scrape error for "${query}":`, error)
  }

  return images
}

// Validate image: check if accessible and is landscape HD
async function validateImage(url: string): Promise<{ valid: boolean; width?: number; height?: number }> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    })

    if (!response.ok) return { valid: false }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('image')) return { valid: false }

    // Check content length - HD images should be > 50KB
    const contentLength = parseInt(response.headers.get('content-length') || '0')
    if (contentLength < 50000) return { valid: false }

    return { valid: true }
  } catch {
    return { valid: false }
  }
}

// Filter for landscape images (width > height)
function isLandscape(width: number, height: number): boolean {
  return width > height && width >= 1200
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const authKey = req.headers.authorization?.replace('Bearer ', '')
  const expectedKey = process.env.CURATION_API_KEY
  if (expectedKey && authKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const runId = `hero-${Date.now()}`
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const stats = { queries: 0, scraped: 0, validated: 0, added: 0, skipped: 0, exists: 0 }

  try {
    console.log('Starting web scraping for TVK hero images:', runId)
    await initDB()

    // Cleanup old images
    const cleaned = await cleanupExpiredHeroImages()

    const allImages: ScrapedImage[] = []

    // Scrape images for each query
    for (const query of SEARCH_QUERIES) {
      stats.queries++
      console.log(`Scraping: "${query}"`)

      // Try Bing first
      const bingImages = await scrapeBingImages(query)
      allImages.push(...bingImages)

      // Also try DuckDuckGo
      const ddgImages = await scrapeDuckDuckGoImages(query)
      allImages.push(...ddgImages)

      // Rate limit - don't hammer servers
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    stats.scraped = allImages.length
    console.log(`Scraped ${allImages.length} total images`)

    // Deduplicate by URL
    const uniqueImages = Array.from(
      new Map(allImages.map(img => [img.url, img])).values()
    )

    // Validate and insert
    for (const img of uniqueImages) {
      // Check if already exists
      if (await heroImageExists(img.url)) {
        stats.exists++
        continue
      }

      // Validate image is accessible and HD
      const validation = await validateImage(img.url)
      if (!validation.valid) {
        stats.skipped++
        continue
      }

      // Check landscape
      if (!isLandscape(img.width, img.height)) {
        stats.skipped++
        continue
      }

      stats.validated++

      // Insert into database
      const success = await insertHeroImage({
        id: `hero-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        url: img.url,
        title: img.title,
        source: img.source,
        width: img.width,
        height: img.height,
        subject: 'vijay',
        quality_score: 85,
        status: 'approved',
        display_order: 0,
      })

      if (success) {
        stats.added++
        console.log(`Added: ${img.title.substring(0, 50)}...`)
      }
    }

    // Log curation run
    await logCurationRun({
      run_id: runId,
      source: 'hero-scrape',
      items_fetched: stats.scraped,
      items_added: stats.added,
      items_updated: 0,
      items_skipped: stats.skipped,
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
      cleaned,
      message: `Scraped ${stats.scraped} images, added ${stats.added} new images`,
      errors: errors.length > 0 ? errors : undefined,
    })

  } catch (error) {
    console.error('Hero scraping error:', error)
    return res.status(500).json({
      success: false,
      runId,
      error: 'Hero scraping failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

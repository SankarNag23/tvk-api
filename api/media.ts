import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import { join } from 'path'

// Serve curated media from JSON file (updated by GitHub Action)

function getCuratedData() {
  try {
    const filePath = join(process.cwd(), 'data', 'curated.json')
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    console.error('Failed to read curated.json:', err)
    return { media: { items: [] }, curatedAt: null }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=900')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const curatedData = getCuratedData()
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)
    const type = req.query.type as string | undefined

    let media = curatedData.media?.items || []

    // Filter by type if specified
    if (type === 'image' || type === 'video') {
      media = media.filter((item: any) => item.type === type)
    }

    media = media.slice(0, limit)

    return res.status(200).json({
      success: true,
      media,
      count: media.length,
      lastCurated: curatedData.curatedAt || new Date().toISOString(),
      filters: { type, limit },
    })
  } catch (error) {
    console.error('Media serve error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch media' })
  }
}

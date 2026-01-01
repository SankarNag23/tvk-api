import type { VercelRequest, VercelResponse } from '@vercel/node'
import { insertMemberTurso, getMemberByEmailTurso } from '../lib/turso'

interface MemberData {
  name: string
  email: string
  phone: string
  district: string
  message?: string
}

// Generate SVG badge for new member
function generateBadgeSvg(name: string, membershipId: string): string {
  return `
<svg width="400" height="400" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="circleClip">
      <circle cx="200" cy="200" r="180" />
    </clipPath>
    <linearGradient id="ribbonGradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#ff6b35;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#f7931e;stop-opacity:1" />
    </linearGradient>
    <filter id="shadow">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.3"/>
    </filter>
  </defs>

  <!-- Profile Circle Background -->
  <circle cx="200" cy="200" r="190" fill="#ffffff" filter="url(#shadow)"/>
  <circle cx="200" cy="200" r="180" fill="#f0f0f0" stroke="#ff6b35" stroke-width="4"/>

  <!-- Profile Photo Placeholder -->
  <circle cx="200" cy="180" r="140" fill="#e0e0e0" clip-path="url(#circleClip)"/>
  <text x="200" y="200" font-family="Arial, sans-serif" font-size="80" fill="#999" text-anchor="middle" font-weight="bold">
    ${name.charAt(0).toUpperCase()}
  </text>

  <!-- Curved Ribbon Badge at Bottom -->
  <path d="M 50 320 Q 200 280 350 320 L 350 360 Q 200 340 50 360 Z"
        fill="url(#ribbonGradient)"
        filter="url(#shadow)"/>

  <!-- Ribbon Fold Effects -->
  <path d="M 50 320 L 50 360 L 70 350 Z" fill="#d55a2a" opacity="0.6"/>
  <path d="M 350 320 L 350 360 L 330 350 Z" fill="#d55a2a" opacity="0.6"/>

  <!-- Badge Text -->
  <text x="200" y="345" font-family="Arial, sans-serif" font-size="24" fill="#ffffff"
        text-anchor="middle" font-weight="bold">
    TVK MEMBER
  </text>

  <!-- Member Name on Ribbon -->
  <text x="200" y="368" font-family="Arial, sans-serif" font-size="16" fill="#ffffff"
        text-anchor="middle" opacity="0.9">
    ${name.toUpperCase()}
  </text>

  <!-- Top Badge Circle -->
  <circle cx="200" cy="50" r="40" fill="#ff6b35" filter="url(#shadow)"/>
  <text x="200" y="60" font-family="Arial, sans-serif" font-size="32" fill="#ffffff"
        text-anchor="middle" font-weight="bold">
    ★
  </text>

  <!-- Membership ID -->
  <text x="200" y="390" font-family="Arial, sans-serif" font-size="10" fill="#666"
        text-anchor="middle">
    ${membershipId}
  </text>
</svg>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const memberData: MemberData = req.body

    // Validate required fields
    if (!memberData.name || !memberData.email || !memberData.phone || !memberData.district) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, email, phone, district',
      })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(memberData.email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
      })
    }

    // Validate phone format (Indian phone numbers)
    const phoneRegex = /^[6-9]\d{9}$/
    const cleanPhone = memberData.phone.replace(/[^\d]/g, '')
    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Use 10-digit Indian mobile number',
      })
    }

    // Check if email already registered (Turso - async)
    const existingMember = await getMemberByEmailTurso(memberData.email.toLowerCase().trim())
    if (existingMember) {
      return res.status(409).json({
        success: false,
        error: 'This email is already registered',
        membershipId: existingMember.membership_id,
      })
    }

    // Generate membership ID
    const membershipId = `TVK${Date.now().toString(36).toUpperCase()}`

    // Insert member into Turso database (async, persists across serverless invocations)
    const result = await insertMemberTurso({
      membership_id: membershipId,
      name: memberData.name.trim(),
      email: memberData.email.toLowerCase().trim(),
      phone: cleanPhone,
      district: memberData.district.trim(),
      message: memberData.message?.trim(),
      status: 'pending',
    })

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to register member',
      })
    }

    // Generate badge SVG
    const badgeSvg = generateBadgeSvg(memberData.name, membershipId)

    return res.status(201).json({
      success: true,
      message: 'Membership application received successfully',
      member: {
        id: result.id,
        membershipId,
        name: memberData.name,
        email: memberData.email,
        district: memberData.district,
        status: 'pending',
        badgeSvg,
      },
      timestamp: new Date().toISOString(),
    })

  } catch (error) {
    console.error('Member registration error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to process membership',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'

// ElevenLabs Voice Cloning API for Vijay's voice
// Setup:
// 1. Create account at elevenlabs.io
// 2. Go to Voice Lab > Add Voice > Instant Voice Clone
// 3. Upload Vijay's speech samples (from YouTube/public speeches)
// 4. Get the Voice ID and add to Vercel env

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const VIJAY_VOICE_ID = process.env.VIJAY_VOICE_ID || 'pNInz6obpgDQGcFmaJgB' // Default to a sample voice

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { text } = req.body

  if (!text) {
    return res.status(400).json({ error: 'Text is required' })
  }

  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'Voice service not configured. Add ELEVENLABS_API_KEY to env.' })
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VIJAY_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2', // Supports Tamil
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0.5,
            use_speaker_boost: true
          }
        }),
      }
    )

    if (!response.ok) {
      const error = await response.json()
      console.error('ElevenLabs error:', error)
      return res.status(500).json({ error: 'Voice generation failed' })
    }

    // Return audio as base64
    const audioBuffer = await response.arrayBuffer()
    const base64Audio = Buffer.from(audioBuffer).toString('base64')

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64Audio}`,
    })

  } catch (error) {
    console.error('Voice API error:', error)
    return res.status(500).json({ error: 'Voice service error' })
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'

// Voice Synthesis API for Vijay AI
// Primary: Fish Audio with cloned Vijay voice
// Fallback: ElevenLabs with multilingual model

const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const VIJAY_VOICE_ID = process.env.VIJAY_VOICE_ID || '457f72ed33a747658d40b5f876ada7fe'

// ElevenLabs fallback voice - a mature male voice
const ELEVENLABS_FALLBACK_VOICE = 'JBFqnCBsd6RMkjVDRZzb' // George - Warm storyteller

async function tryFishAudio(text: string): Promise<Buffer | null> {
  if (!FISH_AUDIO_API_KEY) return null

  try {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        reference_id: VIJAY_VOICE_ID,
        format: 'mp3',
        mp3_bitrate: 128,
        normalize: true,
        latency: 'normal'
      }),
    })

    if (response.ok) {
      const buffer = await response.arrayBuffer()
      return Buffer.from(buffer)
    }

    const error = await response.text()
    console.log('Fish Audio unavailable:', error)
    return null
  } catch (error) {
    console.log('Fish Audio error:', error)
    return null
  }
}

async function tryElevenLabs(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_FALLBACK_VOICE}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.5,
            use_speaker_boost: true
          }
        }),
      }
    )

    if (response.ok) {
      const buffer = await response.arrayBuffer()
      return Buffer.from(buffer)
    }

    const error = await response.text()
    console.log('ElevenLabs error:', error)
    return null
  } catch (error) {
    console.log('ElevenLabs error:', error)
    return null
  }
}

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

  if (!FISH_AUDIO_API_KEY && !ELEVENLABS_API_KEY) {
    return res.status(500).json({
      error: 'Voice service not configured. Add FISH_AUDIO_API_KEY or ELEVENLABS_API_KEY to env.'
    })
  }

  try {
    // Try Fish Audio first (Vijay's cloned voice)
    let audioBuffer = await tryFishAudio(text)
    let source = 'fish_audio'

    // Fallback to ElevenLabs
    if (!audioBuffer) {
      audioBuffer = await tryElevenLabs(text)
      source = 'elevenlabs'
    }

    if (!audioBuffer) {
      return res.status(500).json({ error: 'All voice services failed' })
    }

    const base64Audio = audioBuffer.toString('base64')

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64Audio}`,
      source: source
    })

  } catch (error) {
    console.error('Voice API error:', error)
    return res.status(500).json({ error: 'Voice service error' })
  }
}

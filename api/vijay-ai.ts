import type { VercelRequest, VercelResponse } from '@vercel/node'

// Vijay AI Agent - Fan interaction chatbot
// Uses Groq API with Llama 3 for fast responses

const VIJAY_SYSTEM_PROMPT = `You are an AI assistant representing the spirit and values of Actor Vijay (Thalapathy), the founder of Tamilaga Vettri Kazhagam (TVK - தமிழக வெற்றிக் கழகம்).

IMPORTANT DISCLAIMERS:
- You are an AI fan assistant, NOT the real Vijay
- Always remind users you are an AI when appropriate
- Only discuss publicly known information

YOUR PERSONA & VALUES (based on Vijay's public speeches):
- Advocate for Secular Social Justice (மதச்சார்பற்ற சமூக நீதி)
- Follow principles of Periyarism and Ambedkarism
- Champion equality, democracy, and youth empowerment
- Support education as the path to progress
- Oppose corruption and advocate for transparent governance
- Believe in unity among all communities
- Speak with humility and connect with common people

KEY TVK PRINCIPLES:
1. Secular governance - No religious politics
2. Social justice for all communities
3. Youth empowerment and employment
4. Quality education for everyone
5. Anti-corruption and transparency
6. Tamil pride and cultural heritage
7. Democratic values and people's welfare

SPEAKING STYLE:
- Warm, humble, and approachable
- Mix of Tamil and English naturally
- Inspirational but grounded
- Address fans as "நண்பர்களே" (friends) or "தோழர்களே" (comrades)
- Use simple language everyone can understand
- Reference real TVK events: Party launch (Feb 2024), Flag unveiling (Aug 2024), Vikravandi Rally (Oct 2024)

TOPICS YOU CAN DISCUSS:
- TVK's vision and policies
- Social justice and equality
- Education and youth development
- Tamil culture and heritage
- General motivation and life advice
- Vijay's public speeches and messages
- Upcoming TVK events and goals (2026 elections)

TOPICS TO AVOID:
- Personal/private life details
- Film career specifics (focus on politics)
- Controversial statements not publicly made
- Attacking specific individuals personally
- Making promises on behalf of TVK

LANGUAGE - VERY IMPORTANT (Tanglish Style):
- Speak in TANGLISH (Tamil + English mix) like how Vijay naturally speaks
- Use romanized Tamil words mixed with English: "Enna nanba", "namma", "sollu", "podu"
- This is how fans talk and expect Vijay to respond
- Keep it casual, friendly, and conversational
- Add emotional expressions: "nanba", "nanbi", "thozhan", "vettri namadhe!"

VIJAY'S SIGNATURE PHRASES (use these naturally):
- "Enna nanba, eppadi irukeenga?"
- "Arasiyal cinema maidaanam illa, porkkalam!"
- "Nambikkaiyoda munnera poren"
- "Oru voice-um mukkiyam"
- "Kalvi thaan uyarvukku vazhi"
- "Samooga needhi thaan namma lakshyam"
- "Vettri namadhe!"
- "Sollu nanba, enna doubt?"

EXAMPLE RESPONSES:
User: "TVK policies enna?"
Response: "Nanba, namma TVK policies-a solren kelu:
1. Secular governance - mathathula arasiyal venaam
2. Social justice - ellaarukkum needhi
3. Youth power - ilaignargalukku velai vaippu
4. Quality education - ellaarukkum nalla kalvi
Innum doubt iruntha kelu! Vettri namadhe! 💪"

Remember: Nee latchakkanakkana makkalin nambikkai kuralaa irukka. Positive change-oda ambassador-aa iru!`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { message, history = [] } = req.body

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' })
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'AI service not configured' })
  }

  try {
    // Build messages array with history
    const messages = [
      { role: 'system', content: VIJAY_SYSTEM_PROMPT },
      ...history.slice(-10).map((h: any) => ({ // Keep last 10 messages for context
        role: h.role,
        content: h.content
      })),
      { role: 'user', content: message }
    ]

    // Call Groq API
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', // Fast and capable
        messages,
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 0.9,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('Groq API error:', error)
      return res.status(500).json({ error: 'AI service error' })
    }

    const data = await response.json() as any
    const aiResponse = data.choices[0]?.message?.content || 'மன்னிக்கவும், பதில் அளிக்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.'

    return res.status(200).json({
      success: true,
      response: aiResponse,
      disclaimer: 'This is an AI assistant, not the real Vijay. Responses are based on publicly available information about TVK.',
    })

  } catch (error) {
    console.error('Vijay AI error:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to process request',
      response: 'மன்னிக்கவும் நண்பர்களே, தற்போது இணைப்பில் சிக்கல். சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.'
    })
  }
}

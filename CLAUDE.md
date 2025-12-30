# TVK API - Claude Code Guidelines

> **Last Updated**: 2024-12-30
> **Parent Project**: See `tvk/CLAUDE.md` for full architecture

---

## What This Project Is

This is the **API backend** for the TVK website. It handles heavy processing:
- AI chat (Groq)
- Voice synthesis (Fish Audio + ElevenLabs fallback)
- Content curation (RSS + AI scoring)

**Frontend is in a separate repo**: https://github.com/SankarNag23/tvk

---

## CRITICAL: Do NOT Duplicate

This project exists specifically to separate concerns. **Never copy these files to the tvk repo:**

```
api/
├── curate.ts       ← AI curation (ONLY HERE)
├── news.ts         ← Curated news server (ONLY HERE)
├── media.ts        ← Curated media server (ONLY HERE)
├── vijay-ai.ts     ← AI chat (ONLY HERE)
└── vijay-voice.ts  ← Voice synthesis (ONLY HERE)
```

If you need to modify how the frontend calls these APIs, edit:
- `tvk/src/config/api.ts` (endpoint URLs)
- NOT by copying APIs to the frontend project

---

## What Belongs Here

| YES - Put in tvk-api | NO - Put in tvk instead |
|---------------------|------------------------|
| AI/LLM integrations | UI components |
| External API calls (Groq, ElevenLabs) | Form handlers |
| Web scraping / RSS parsing | Static data |
| Heavy data processing | Translations |
| Scheduled curation tasks | YouTube embed detection |

---

## Files Overview

```
tvk-api/
├── api/
│   ├── curate.ts      # AI curation agent - fetches RSS, scores with Groq
│   ├── news.ts        # Serves curated news from data/curated.json
│   ├── media.ts       # Serves curated media from data/curated.json
│   ├── vijay-ai.ts    # Groq Llama 3.3 chat endpoint
│   └── vijay-voice.ts # Fish Audio TTS (with ElevenLabs fallback)
├── scripts/
│   ├── clone-voice.py     # ElevenLabs voice cloning script
│   └── fish-audio-clone.py # Fish Audio voice cloning script
├── data/
│   └── curated.json   # Auto-updated by GitHub Action every 4 hours
├── .github/
│   └── workflows/
│       └── curate.yml # Scheduled curation (runs /api/curate, commits result)
├── CLAUDE.md          # This file
├── package.json
├── tsconfig.json
└── vercel.json        # CORS + routing config
```

---

## Environment Variables

### Vercel Dashboard
```
GROQ_API_KEY=<your groq api key>
YOUTUBE_API_KEY=<youtube data api v3 key>
FISH_AUDIO_API_KEY=<fish audio api key - primary for Vijay's cloned voice>
ELEVENLABS_API_KEY=<elevenlabs api key - fallback TTS>
VIJAY_VOICE_ID=4415218e21374deeadf8b11e49a68368  # Vijay's cloned voice on Fish Audio
CURATION_API_KEY=<random secret to protect /api/curate>
```

**Voice Setup**: Vijay's voice was cloned using Fish Audio. The cloned voice ID is already set above.
To use Vijay's actual cloned voice, add credits to your Fish Audio account at https://fish.audio

### GitHub Secrets (for Actions)
```
GROQ_API_KEY
YOUTUBE_API_KEY
CURATION_API_KEY
```

---

## Adding New Features

### Adding a new AI endpoint

1. Create `api/new-endpoint.ts`
2. Add CORS headers (copy from existing files)
3. Deploy (push to main)
4. Update `tvk/src/config/api.ts` with new endpoint
5. Update frontend components to use it

### Adding new RSS news sources

Edit `api/curate.ts`:
```typescript
const NEWS_SOURCES = [
  { name: 'The Hindu', rss: 'https://...' },
  { name: 'New Source', rss: 'https://new-source.com/rss' }, // Add here
]
```

### Changing curation schedule

Edit `.github/workflows/curate.yml`:
```yaml
on:
  schedule:
    - cron: '0 */4 * * *'  # Change this cron expression
```

---

## GitHub Action Flow

```
┌──────────────────────────────────────────────────────────┐
│  GitHub Action: AI Content Curation (every 4 hours)      │
├──────────────────────────────────────────────────────────┤
│  1. Checkout repository                                  │
│  2. POST to /api/curate (with CURATION_API_KEY)          │
│  3. API fetches RSS feeds from news sources              │
│  4. API fetches YouTube videos for TVK queries           │
│  5. API scores all items with Groq AI (0-100)            │
│  6. API filters items >= 50 score                        │
│  7. API returns curated JSON                             │
│  8. Action saves to data/curated.json                    │
│  9. Action commits and pushes                            │
│  10. Vercel auto-deploys with fresh data                 │
└──────────────────────────────────────────────────────────┘
```

---

## API Reference

### POST /api/curate
Triggers AI curation. Protected by `CURATION_API_KEY`.

```bash
curl -X POST https://tvk-api.vercel.app/api/curate \
  -H "Authorization: Bearer YOUR_CURATION_API_KEY"
```

### GET /api/news
Returns curated news items.

```bash
curl "https://tvk-api.vercel.app/api/news?limit=10&language=ta"
```

### GET /api/media
Returns curated media (images/videos).

```bash
curl "https://tvk-api.vercel.app/api/media?type=video&limit=10"
```

### POST /api/vijay-ai
AI chat endpoint.

```bash
curl -X POST https://tvk-api.vercel.app/api/vijay-ai \
  -H "Content-Type: application/json" \
  -d '{"message": "TVK policies enna?", "history": []}'
```

### POST /api/vijay-voice
Voice synthesis endpoint.

```bash
curl -X POST https://tvk-api.vercel.app/api/vijay-voice \
  -H "Content-Type: application/json" \
  -d '{"text": "Vanakkam nanba!"}'
```

---

## Troubleshooting

### "Curation not working"
1. Check GitHub Actions → Did workflow run?
2. Check Vercel logs for /api/curate
3. Verify GROQ_API_KEY is valid
4. Manual trigger: Actions → Run workflow

### "Voice returns 500"
1. Check FISH_AUDIO_API_KEY or ELEVENLABS_API_KEY in Vercel env
2. If using Fish Audio: Add credits at https://fish.audio (voice ID: 4415218e21374deeadf8b11e49a68368)
3. If Fish Audio fails, it falls back to ElevenLabs automatically
4. Check API quota/credits for both services

### "AI chat not responding"
1. Check GROQ_API_KEY in Vercel env
2. Check Groq API status
3. Review Vercel function logs

---

## Related Documentation

- **Full Architecture**: `tvk/CLAUDE.md`
- **Progress Tracking**: `tvk/PROGRESS.md`
- **Frontend Repo**: https://github.com/SankarNag23/tvk

# DocuBot — AI Documentary & Lecture Generator

Turns a lecture PDF into a narrated, scene-by-scene documentary video, optionally in a
voice cloned from the client, and progressive word-by-word highlighting that tracks the
narration.

Two ways to use it:

- **The website** (`npm run web`) — a chat-style studio: upload a PDF, optionally clone
  your voice, generate, preview in-browser, export an MP4.
- **The CLI** (`npm run pipeline`) — the same pipeline, headless.

---

## Quick start

```bash
cd Documentry-ai-genrator
npm install

# 1. Website (builds the frontend, then serves it)
npm run web            # → http://localhost:3100

# 2. Headless pipeline
npm run pipeline

# 3. Remotion Studio / preview / render
npm run studio
npm run preview
npm run render
```

`npm run build` type-checks both the Remotion composition and the website.

### Optional configuration

Copy `.env.example` to `.env`. Everything degrades gracefully without keys:

| Key | Effect when missing |
| --- | --- |
| `ELEVENLABS_API_KEY` | Narration uses `en-US-AndrewNeural` instead of a cloned voice |
| `GEMINI_API_KEY` / `GROK_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | Chatbot returns a guided-mode message; the script falls back to the built-in synthesizer |
| `PEXELS_API_KEY` | Visuals fall back to a curated stock set |

---

## How it works

```
PDF ──► parsePdf.js ──► llm.js ──► pipeline.js ──► tts.js ──► src/dataset.json
        (sanitize)      (script)    (8–12 scenes)   (MP3s)      (runtime data)
                                                          │
                                    src/DocumentaryVideo.tsx (Remotion)
```

1. **`server/parsePdf.js`** — extracts PDF text and strips administrative noise
   (office hours, emails, course codes, slide footers, bullet glyphs).
2. **`server/llm.js`** — one provider abstraction (Gemini → Grok → Groq → OpenAI) shared
   by script generation and the chatbot.
3. **`server/pipeline.js`** — writes an 8–12 scene script, fetches landscape visuals from
   Pexels by `imageKeyword`, synthesizes narration, measures real MP3 durations with
   `music-metadata`, and emits word-level timings.
4. **`server/tts.js`** — ElevenLabs voice cloning when a key is present, otherwise a
   high-quality neural teacher voice.
5. **`src/DocumentaryVideo.tsx`** — renders the video. Everything on screen comes from
   the dataset: there are no hardcoded strings in the composition.

### Word-level highlighting

The caption highlights and underlines each word as it is spoken:

- `todo` — dimmed, no underline
- `done` — white with a soft yellow underline
- `current` — bright yellow, thicker underline, subtle glow

Timings come from the TTS provider's word alignment when available, otherwise
`server/tts.js` estimates them proportionally from the measured audio duration. The
renderer (`src/wordTimings.ts`) prefers real timings and falls back to the same
proportional estimate, so older datasets still highlight correctly.

---

## Voice cloning

The site shows three fixed sentences for the client to read aloud. They are deliberately
constant so every clone request contains the same phonetic material — a neutral
statement, a line with natural cadence, and a short closing line with a distinct ending
tone:

> The quality of a system is never an accident, it is engineered one careful decision at a time.
>
> Our team measured reliability across every release, and the numbers told a very clear story.
>
> Thank you for listening, and welcome to the next chapter of the story.

Record them as one MP3 and upload it. With `ELEVENLABS_API_KEY` set, the sample is cloned
instantly and all narration uses that voice. Without a key the sample is still stored and
the pipeline narrates with `en-US-AndrewNeural`.

---

## Website API

The server is `server/web.js` (Node's built-in `http`, no runtime dependencies).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Voice sample sentences + capability flags |
| `POST /api/session` | Create a session |
| `POST /api/upload/pdf` | Upload + sanitize a PDF |
| `POST /api/upload/voice` | Upload an MP3 and clone the voice |
| `POST /api/chat` | Chatbot Q&A grounded in the uploaded PDF |
| `POST /api/generate` | Start a generation job |
| `POST /api/render` | Start an MP4 render job |
| `GET /api/job/:id` | Job status, logs and result |
| `GET /api/session/:id` | Session snapshot, including the dataset |
| `GET /audio/*` | Generated narration |
| `GET /video/:id` | Rendered MP4 |

Sessions are isolated: each gets its own uploads under `.data/sessions/<id>/` and its own
audio under `public/audio/<id>/`, so concurrent visitors never see each other's documents.
A session can be resumed or shared with `?session=<id>` in the URL.

Long work (generation, rendering) runs as background jobs that the UI polls. Uploads are
sent as base64 JSON rather than multipart, which keeps the server dependency-free.

```bash
npm run web:smoke     # end-to-end API test against a running server
```

---

## Notes

- `public/audio/*.mp3` and per-session folders are gitignored — narration is a build
  artifact, reproducible with `npm run pipeline`.
- The composition's `defaultProps` must stay an object (`{ scenes: dataset }`); Remotion
  rejects a raw array.
- `web/dist/` is generated by `web/build.js` (esbuild) and is not committed.

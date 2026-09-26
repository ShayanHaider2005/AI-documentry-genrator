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
                                    visuals.js                      │
                                    (diagram + focus)               ▼
                                                    src/DocumentaryVideo.tsx
```

1. **`server/parsePdf.js`** — extracts PDF text and strips administrative noise
   (office hours, emails, course codes, slide footers, bullet glyphs).
2. **`server/llm.js`** — one provider abstraction (Gemini → Grok → Groq → OpenAI) shared
   by script generation and the chatbot.
3. **`server/visuals.js`** — derives the subject title, the document outline, and the
   per-scene focus rectangles. It also renders the document diagrams.
4. **`server/pipeline.js`** — writes an 8–12 scene script, resolves contextual visuals,
   synthesizes narration, measures real MP3 durations with `music-metadata`, and emits
   word-level timings. Every external call is **sequential** — one scene at a time, never
   `Promise.all` — so a slow or rate-limited API can never fan out or freeze the server.
5. **`server/tts.js`** — ElevenLabs voice cloning when a key is present, otherwise a
   high-quality neural teacher voice.
6. **`src/DocumentaryVideo.tsx`** — renders the video. Everything on screen comes from
   the dataset: there are no hardcoded strings in the composition.

### Contextual visuals (never generic stock)

A scene's visual must be traceable to the document being narrated:

1. The LLM is required to emit a **2–5 word `imageKeyword` naming the specific concept**,
   plus a `visualPrompt` describing what is literally on screen.
2. `isSpecificKeyword()` rejects vague queries (`"technology"`, `"business team"`,
   `"abstract background"`, …) against a curated blocklist.
3. If a keyword survives **and** a `PEXELS_API_KEY` is present, a contextual photo is used.
4. Otherwise the scene falls back to a **document diagram synthesised from the real PDF**:
   the actual heading outline rendered as a page of labelled blocks, wired with flow
   arrows. There is deliberately no generic stock-photo fallback list.

### Pointer & focus overlays

Each scene carries a `focusArea` — a normalised (0–1) rectangle plus a label, describing
exactly which part of the visual the narrator is discussing. The LLM may return one
rectangle or several; `normalizeFocusArea()` repairs anything missing using the outline.

`src/focusOverlay.ts` then drives the on-screen pointer: it flies in over the opening
frames, travels to each target as the narration reaches it, settles with a pulsing
highlight box, and shows a callout label. The diagram geometry and the focus rectangles
come from one shared function (`computeDiagramLayout`), so the pointer always lands
exactly on the block it highlights.

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
| `POST /api/session` | Create a working session |
| `POST /api/upload/pdf` | Upload + sanitize a PDF |
| `POST /api/upload/voice` | Upload an MP3 and clone the voice |
| `POST /api/chat` | Chatbot Q&A grounded in the uploaded PDF |
| `POST /api/generate` | Start a generation job |
| `POST /api/render` | Start an MP4 render job |
| `GET /api/job/:id` | Job status, logs and result |
| `GET /api/sessions` | Video history (summaries only — small and fast) |
| `GET /api/sessions/:id` | One full record, for the player |
| `DELETE /api/sessions/:id` | Remove a video from history |
| `GET /audio/*` | Generated narration |
| `GET /video/:id` | Rendered MP4 |

### Session history

Finished videos are stored in a single JSON file, `server/sessions.json`, via
`server/db.js`:

```json
{
  "id": "sess_27a9f236b97ad1e11c",
  "title": "Introduction to Quality Concepts",
  "createdAt": "2026-09-26T16:19:36.063Z",
  "scenes": [ /* scene objects incl. imageUrl, focusArea, wordTimings */ ]
}
```

Writes are serialized in-process and atomic (temp file + rename), so a crash mid-write can
never truncate the store. There is no database, no ORM and no migration.

The UI keeps the sidebar light: `GET /api/sessions` returns only summaries, and the full
scene payload (~126 KB) is fetched once when a video is selected. After that the
`@remotion/player` switches scenes purely from React state — selecting a past video never
re-runs generation.

### Isolation

Working sessions keep uploads in `.data/sessions/<id>/` and narration in
`public/audio/<id>/`, so concurrent visitors never see each other's documents. A video can
be reopened or shared with `?session=<id>`.

Long work (generation, rendering) runs as background jobs that the UI polls. Uploads are
sent as base64 JSON rather than multipart, which keeps the server dependency-free.

```bash
npm run web:smoke     # end-to-end API test against a running server
```

---

## Notes

- `public/audio/*.mp3`, per-session folders, `.data/` and `server/sessions.json` are
  gitignored — they are runtime data, reproducible with `npm run pipeline`.
- The composition's `defaultProps` must stay an object (`{ scenes: dataset }`); Remotion
  rejects a raw array.
- `web/dist/` is generated by `web/build.js` (esbuild) and is not committed.
- Everything degrades without API keys: no LLM key uses the built-in script synthesizer,
  no ElevenLabs key uses `en-US-AndrewNeural`, no Pexels key uses document diagrams.

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

Copy `.env.example` to `.env` and fill in what you have. **`.env` is gitignored** — never
commit real keys. Every key is optional and the engine degrades gracefully:

| Key | Effect when present | Effect when missing |
| --- | --- | --- |
| `PEXELS_API_KEY` | Each scene part gets a contextual stock photo | Document diagrams built from the PDF |
| `ELEVENLABS_API_KEY` | Narration uses the cloned client voice | `en-US-AndrewNeural` neural voice |
| `GEMINI_API_KEY` / `GROK_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | LLM scene writing + "Ask DocuBot" chat | Built-in synthesizer; chat explains itself |

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
   plus a per-beat `imageKeyword` for each part.
2. `isSpecificKeyword()` rejects vague queries (`"technology"`, `"business team"`,
   `"abstract background"`, …) against a curated blocklist.
3. If a keyword survives **and** a `PEXELS_API_KEY` is present, a contextual photo is used.
4. Otherwise the scene falls back to a **document diagram synthesised from the real PDF**:
   the actual heading outline rendered as a page of labelled blocks, wired with flow
   arrows. There is deliberately no generic stock-photo fallback list.

Per-beat search terms are built from the scene's concept plus the document section that beat
highlights (`buildBeatKeyword`), never from the narration prose — filler like "every
complex" makes a useless stock query. With a Pexels key the current output is 12/12 scenes
on contextual photos.

### Pointer & focus overlays, in sync with the speech

Each scene is split into **beats** — 2 or 3 parts, derived from the narration's own phrase
boundaries. Every beat carries:

- its **own visual** (a different document diagram or contextual photo), so the imagery
  changes as the narrator moves between ideas rather than sitting still;
- its own **highlight region** (normalised 0–1 rectangle + label);
- the **word at which it starts** (`startWord`, or `atWord` for LLM output).

The renderer resolves each beat's start frame from the measured word timings
(`resolveBeats()` in `src/focusOverlay.ts`), so the visual change and the pointer movement
happen on the frame that word is spoken — not on an arbitrary fraction of the scene. The
highlight cross-fades over 6 frames, the pointer travels to the new region, then pulses and
shows its callout label while that part is being explained. Beats with no usable word
timing fall back to an even split, so a beat is never unscheduled.

Verified on scene 1 (446 frames, 27 words): beat 1 covers words 0–8 and beat 2 starts at
word 9 ("Behind", frame 140), where the diagram switches to the next section group and the
pointer moves to the corresponding block.

`computeDiagramLayout()` is the single source of truth for diagram geometry, shared by the
renderer and the focus calculator, so the pointer always lands on the block it highlights.
The page also stops above the caption band so no content hides behind the subtitles.

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

Record them as one audio file and either press **Record my voice** in the browser (Chrome
records webm/opus, Safari records mp4) or upload an MP3. With `ELEVENLABS_API_KEY` set, the
sample is cloned instantly and all narration uses that voice. Without a key the sample is
still stored and the pipeline narrates with `en-US-AndrewNeural`.

> Voice cloning providers usually prefer MP3. If cloning fails with a browser recording,
> export the clip as MP3 and upload that instead.

---

## Using the website

1. Press **+ New Video** in the sidebar.
2. **Add your PDF** — drop it on the box.
3. **Add your voice** (optional) — record the three lines, or upload a file.
4. **Generate video** — the player appears as soon as it is ready.
5. **Download MP4** — renders in the background with a progress bar.

Your finished videos stay in the left sidebar. Selecting one loads it instantly; generation
never re-runs.

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

### Guardrails for a public deployment

| Guard | Default | Env override |
| --- | --- | --- |
| Requests per minute per IP on costly routes (upload, generate, render, chat) | 20 | `RATE_LIMIT_PER_MINUTE` |
| Concurrent MP4 renders (each spawns a Chrome process) | 1 | `MAX_CONCURRENT_RENDERS` |
| Idle working-session lifetime before eviction (with on-disk cleanup) | 120 min | `SESSION_TTL_MINUTES` |
| Upload body ceiling | 64 MB | — |
| Videos kept in `sessions.json` | 60 | — |

Cheap reads (`/api/sessions`, `/api/config`, static files) are deliberately unthrottled so
browsing history never degrades.

```bash
npm run web:smoke     # end-to-end API test against a running server
```

---

## Notes

- **`.env` is gitignored.** Copy `.env.example` and keep real keys out of tracked files. If a
  key is ever committed or pasted into a public channel, rotate it in the provider's
  dashboard — treat it as compromised.
- `public/audio/*.mp3`, per-session folders, `.data/`, `server/sessions.json` and
  `web/dist/` are gitignored — they are runtime data, reproducible with
  `npm run pipeline` and `npm run web:build`.
- The composition's `defaultProps` must stay an object (`{ scenes: dataset }`); Remotion
  rejects a raw array.
- Everything degrades without API keys: no LLM key uses the built-in script synthesizer,
  no ElevenLabs key uses `en-US-AndrewNeural`, no Pexels key uses document diagrams.

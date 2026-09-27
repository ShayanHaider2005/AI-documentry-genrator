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

# One time only, on a new machine: install the local voice stack
npm run voice:setup

# The website. This starts BOTH the web server and the voice service.
npm run web            # → http://localhost:3100

# Headless pipeline
npm run pipeline

# Remotion Studio / preview / render
npm run studio
npm run preview
npm run render
```

`npm run web` is the only command you need. Voice cloning runs in a local Python
service, and this starts it, waits for the model to load, and stops it again when
you close the window:

```
  DocuBot - starting services

  voice clone  ready cloning+speech on cpu

  DocuBot - AI Documentary Generator
  ready on   http://localhost:3100
```

**Leave that window open.** Closing it stops voice cloning along with the site. If
you ever start the site without the voice service, the page shows a red banner
naming the command to run rather than silently narrating in the default voice.

`npm run build` type-checks both the Remotion composition and the website.

### Optional configuration

Copy `.env.example` to `.env` and fill in what you have. **`.env` is gitignored** — never
commit real keys. Every key is optional and the engine degrades gracefully:

| Key | Effect when present | Effect when missing |
| --- | --- | --- |
| `PEXELS_API_KEY` | Each scene part gets a contextual stock photo | Document diagrams built from the PDF |
| OpenVoice v2 service running (local, no key) | Narration uses the cloned client voice | `en-US-AndrewNeural` neural voice |
| `GEMINI_API_KEY` / `GROK_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | LLM scene writing + "Ask DocuBot" chat | Built-in synthesizer; chat explains itself |

---

## How the script is written

The narration is **always derived from the document you uploaded** — there is no
pre-written script in the codebase. Two paths, in order:
1. **AI-written.** If an LLM key is configured, the document is turned into a 6–8 scene
   documentary script (`server/llm.js`). Providers are tried in order — Gemini → Groq →
   Grok → OpenAI — and each is retried with backoff on 429/5xx, so an overloaded or
   quota-limited provider falls through to the next instead of failing the run.
2. **Derived from the document.** If no provider answers, `server/script.js` builds the
   scenes from the document's own sentences and headings. The narration quotes the
   document verbatim, so it is still specific to what you uploaded.

> A note on PDF extraction, because it is easy to get wrong: short lines are usually
> section headings ("Technical Debt", "Self Awareness"), and they are exactly what the
> chapter titles and the document outline are built from. Dropping them leaves the
> pipeline with no headings, and it falls back to truncating a body sentence into a
> title like *"Correctness Measures Whether the Output of a"*. Short lines are therefore
> kept when they look like headings, and the course-scaffolding headings that come with
> them ("Today's Outline", "Administrative Stuff", "About Me") are filtered out by name
> instead.

The pipeline log always states which path was used:

```
[PIPELINE] Script: AI written
[PIPELINE] Script: derived from the document
```

> Note: Gemini's free tier returns `429 exceeded quota` and `503 high demand` often.
> That is why provider failover exists — configure at least two providers, or rely on
> the document-derived path.

## Every video ends on a conclusion

The last scene is always a closing statement: it names the document's single most
important takeaway, ties it back to the opening, and closes on a line addressed to the
viewer. It is never a "thank you for watching" filler.

A model is asked to write this, but a model that ignores the request just relabels its
last content scene "Conclusion" and leaves it as an ordinary paragraph. So the conclusion
is **verified, not trusted** (`withConclusion` in `server/pipeline.js`):

- A model conclusion of 20–70 words is kept, because the prose is better.
- Anything else is replaced by a closing statement assembled from the document itself
  (`buildConclusionScene` in `server/script.js`): the document's own final sentence
  supplies the takeaway, its own key terms name the subject, and its own title frames
  the close. Still 30–60 words, still specific to that document.

The conclusion is flagged `isConclusion` in the dataset, which gives it its own closing
card in the composition, and it uses a document summary diagram rather than a stock photo
— a photo has nothing to summarise.

## Voice cloning

Voice cloning runs **entirely on your machine** using
[OpenVoice v2](https://github.com/myshell-ai/OpenVoice) (MIT). There is no vendor
account, no API key, and no per-character cost.

One-time setup, then start the service (leave that window open while you generate):

```
npm run voice:setup     # py -3 server/voice/setup.py
npm run voice:start     # server\voice\.venv\Scripts\python.exe server/voice/service.py
```

Setup installs CPU-only PyTorch into a local virtualenv, clones OpenVoice and MeloTTS,
downloads the tone-colour converter (~125 MB), and installs the NLTK corpora the English
grapheme-to-phoneme step needs. It is safe to re-run. The service listens on
`http://127.0.0.1:5055` and reports its state on `GET /health`.

The client reads three fixed sentences aloud, records them, and uploads the clip. The
service extracts a **tone colour** from that sample (2–3 s on CPU) and re-colours the
narration with it, so all scenes are spoken in the client's voice.

**A failed clone is reported as a failure (HTTP 501), never a quiet success.** The reason
comes back verbatim — unreadable file, sample too short, service not running — and the
website shows it in a persistent banner. When the service is down, narration falls back to
`en-US-AndrewNeural` so the rest of the pipeline still completes.

Keep the sample to roughly 10–15 seconds of clean, single-speaker audio. MP3 and WAV work
with no extra tools. **You do not need ffmpeg to record in the browser**: the app decodes
whatever MediaRecorder produced (webm/opus in Chrome and Edge, mp4/aac in Safari) using
the browser's own `decodeAudioData`, then uploads mono 16 kHz WAV
(`web/src/audio.ts`). Installing ffmpeg is still useful if you want to upload a webm file
you recorded elsewhere.

`npm run voice:check` clones a sample and speaks a test line, so you can confirm the
stack works before generating a whole video.

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
5. **`server/tts.js`** — voice cloning through the local OpenVoice v2 service when it is
   running, otherwise a high-quality neural teacher voice. `server/voice/service.py` is
   the Python service that does the cloning; `server/openvoice.js` is the client.
6. **`server/voice/setup.py`** — one-time installer for the local voice stack (CPU-only
   PyTorch, OpenVoice, MeloTTS base speaker, checkpoints).
7. **`src/DocumentaryVideo.tsx`** — renders the video. Everything on screen comes from
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

### Visuals

Each scene is split into 2–3 **beats** — parts derived from the narration's own phrase
boundaries. Every beat carries its own visual, so imagery changes as the narrator moves
between ideas. Beats are anchored to a word (`startWord`, or `atWord` for LLM output), and
`resolveBeats()` resolves that to a scene-relative frame using the measured word timings,
so the image change happens on the frame the word is spoken. The visual cross-fades over
6 frames.

There is deliberately **no pointer, cursor or highlight box** — that overlay was removed
after it proved hard to keep in sync. The caption still highlights and underlines each word
as it is spoken.

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
records webm/opus, Safari records mp4) or upload an MP3. With the local OpenVoice service
running, the sample is cloned and all narration uses that voice. Without the service the
sample is still stored and the pipeline narrates with `en-US-AndrewNeural`.

> OpenVoice extracts tone colour from the reference, so roughly 10–15 seconds of clean
> single-speaker audio is plenty. MP3 or WAV both work.

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
npm run web:smoke       # end-to-end API test against a running server
npm run voice:check     # clone a sample and speak a test line
npm run check:unique    # prove each voice and each PDF makes its own video
npm run check:conclusion
node web/check-e2e.js                 # PDF + voice sample -> finished documentary
node web/check-conclusion-scene.js    # the conclusion builder in isolation
```

### Nothing is hardcoded

`npm run check:unique` is the test for that claim. It uploads four deliberately
different voices, speaks the **same sentence** through each, and then generates two
unrelated documents, each with its own voice. It asserts:

- every voice gets its own clone id, and every rendition is measurably different in
  timbre from every other
- no narration line and no chapter title is shared between the two documents
- each document's narration quotes its own terminology, and neither drifts into the
  other's subject
- each run's audio lives in its own session folder, and each uses the voice uploaded
  with it

Note what voice cloning does and does not copy. OpenVoice captures **tone colour** —
timbre, accent and delivery. The base synthesiser supplies the fundamental pitch, so
four clones of the same sentence sit at a similar f0; what differs is the spectral
shape, which is the timbre. That is the model's designed behaviour, not a limitation
being worked around.

---

## Notes

- **`.env` is gitignored.** Copy `.env.example` and keep real keys out of tracked files. If a
  key is ever committed or pasted into a public channel, rotate it in the provider's
  dashboard — treat it as compromised.
- `public/audio/*.mp3`, per-session folders, `.data/`, `server/sessions.json` and
  `web/dist/` are gitignored — they are runtime data, reproducible with
  `npm run pipeline` and `npm run web:build`.
- The local voice stack is gitignored too, because it is large:
  `server/voice/.venv/` (~1 GB), `OpenVoice/`, `MeloTTS/`, `checkpoints_v2/`
  (~125 MB), `nltk_data/`, `.cache/`. Run `py -3 server/voice/setup.py` to rebuild it.
- The composition's `defaultProps` must stay an object (`{ scenes: dataset }`); Remotion
  rejects a raw array.
- Everything degrades gracefully: no LLM key uses the built-in script synthesizer, the
  OpenVoice service being down uses `en-US-AndrewNeural`, no Pexels key uses document
  diagrams.
- The voice service needs `NLTK_ALLOW_PROXIED_URLOPEN=1` and `NLTK_DATA` pointed at
  `server/voice/nltk_data` if your network goes through a proxy; the setup script installs
  the corpora.

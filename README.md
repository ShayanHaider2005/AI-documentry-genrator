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
| OmniVoice service running (local, no key) | Narration uses the cloned client voice | `en-US-AndrewNeural` neural voice |
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
[OmniVoice](https://github.com/k2-fsa/OmniVoice) — a zero-shot TTS covering 600+
languages, with accent, cadence and prosody preserved from the reference speaker.
There is no vendor account, no API key, and no per-character cost.

One-time setup, then start the service (leave that window open while you generate):

```
npm run voice:setup     # py -3 server/voice/setup.py
npm run voice:start     # server\voice\.venv\Scripts\python.exe server/voice/server.py
```

Setup installs CPU-only PyTorch plus OmniVoice into a local virtualenv and downloads the
`k2-fsa/OmniVoice` weights (**~3.3 GB**). It is safe to re-run. The service listens on
`http://127.0.0.1:8000` and reports its state on `GET /health`.

> **GPU or CPU?** The weights alone are ~3.3 GB, so the service only claims a GPU with at
> least `OMNIVOICE_GPU_MIN_FREE_GB` (default 6) free, and otherwise runs on CPU. On CPU a
> cold start is minutes, and a diffusion TTS is compute-heavy without a GPU — expect the
> first sentence of a video to be noticeably slow. This machine's 2 GB MX330 falls back to
> CPU by design, which is the correct behaviour, not a failure.

**Step count is the main speed dial.** `OMNIVOICE_NUM_STEP` defaults to **12**, and cost is
close to linear in it. Measured here on CPU: the same 5.3 s line took **174 s at 12 steps
and 467 s at 32**, a 2.68× speedup, with every speech frequency band within 3.8 dB and
pitch matching to 0.1 Hz — the same voice, not a different one. Use 32 for a final quality
pass and 8 while drafting.

Two related settings, both of which exist because of a specific failure:

- `OMNIVOICE_TORCH_THREADS` (default 4) caps inference threads, leaving headroom for the OS
  and the browser previewing the result. Raise it to the core count for raw throughput.
- `OMNIVOICE_SYNTH_TIMEOUT_MS` (default 5,400,000, i.e. 90 minutes) bounds one
  synthesis. The Node client uses core `http` rather than `fetch` for this deliberately:
  `fetch` runs on undici, which enforces its own 300-second headers timeout that
  `AbortSignal` cannot override, so any generation past five minutes used to die with
  `UND_ERR_HEADERS_TIMEOUT` no matter what this was set to.

> **Still slow on CPU.** Even at 12 steps, synthesis cost is dominated by total audio
> length, so the script is capped twice over — in code as well as in the prompt, because
> a prompt instruction is advisory and models overshoot:
>
> | Budget | Default | Override |
> |---|---|---|
> | Total narration words | 400 (`MAX_TOTAL_WORDS`) | `MAX_TOTAL_WORDS` |
> | Scene count | 5 (`MAX_SCENES`) | `MAX_SCENES` |
>
> `enforceWordBudget` in `server/pipeline.js` applies the scene cap first, since dropping a
> scene removes both its words and its fixed per-request synthesis overhead (~52 s measured),
> then the word cap. It keeps the opening and the conclusion and drops from the middle, and
> shortens the conclusion at a sentence boundary only as a last resort.
>
> A 400-word script is about 2½ minutes of speech, roughly 45-60 minutes of synthesis at 12
> steps. To go longer, raise both caps together and expect the time to grow with the audio.
> Realistically, this wants a GPU with at least 6 GB of VRAM.

### The reference transcript, and why it is not optional

OmniVoice clones per synthesis and needs both the reference audio **and** its transcript.
If `ref_text` is missing, `OmniVoice.generate` loads `openai/whisper-large-v3-turbo`
(≈1.5 GB) and transcribes the reference itself — on a cold cache, and again on every scene
once the model is resident.

So every caller supplies it, in one of two ways:

- the pipeline passes the client's known transcript, because the recording is made by
  reading three fixed sentences, so the words are already known;
- the bundled narrator's transcript lives beside it at
  `server/voices/south_asian_narrator.txt`, and the service reads a `.txt` sidecar
  automatically for any reference (`raj.wav` → `raj.txt`).

`GET /api/validate-reference` and the response of `POST /api/generate-voice` both report
`ref_text_known` and `whisperUsed`, so a caller can confirm it took the cheap path.
`npm run dry:reftext` exercises this end to end.

### How cloning works here

The client reads three fixed sentences aloud, records them, and uploads the clip. Because
the sentences are fixed, **the transcript is already known** — so `ref_text` is sent
alongside the audio, which clones far better than letting the model transcribe it by
guesswork. OmniVoice clones per synthesis, so the reference is passed on every scene
rather than turned into a reusable id.

### The narrator library

A user who has not recorded a sample still gets a choice: ten generated narrators, five
accents across two genders, built by `npm run voice:library` into
`server/voices/defaults/` with a `manifest.json` describing each one.

| Gender | Accents |
|---|---|
| Male, Female | Indian (South Asian), UK, USA, Asian (East/Southeast), Other (Lusophone) |

> **There is no African accent, and the UI does not claim one.** OmniVoice's instruct
> vocabulary is closed — `american`, `australian`, `british`, `canadian`, `chinese`,
> `indian`, `japanese`, `korean`, `portuguese`, `russian` — with no African entry. The
> fifth slot is filled with the `portuguese accent`, the closest available to the
> Lusophone West African read it is named for. The manifest records the exact `instruct`
> used for every voice, and the picker reads its labels from there, so a label can never
> drift from the audio. `npm run check:library` fails if any profile claims an accent the
> model cannot produce.

Building the library takes roughly 30 minutes on CPU (ten profiles at ~3 minutes each) and
loads the model once for all of them. **Stop the voice service first**: two copies of a
3.3 GB model on 7.8 GB of RAM will thrash.

The bundled default narrator (`server/voices/south_asian_narrator.wav`, from
`npm run voice:default`) is the fallback when no library is built.

**A failed clone is reported as a failure (HTTP 501), never a quiet success.** The reason
comes back verbatim — unreadable file, sample too short, service not running — and the
website shows it in a persistent banner. When the service is down, narration falls back to
`en-US-AndrewNeural` so the rest of the pipeline still completes.

### Accounts

Registration and sign-in are required for everything above the login page: the dashboard,
the upload routes, the pipeline, and `/api/produce`. `/api/config` and `/api/auth/me` are
reachable without a session, because the sign-in screen needs to report whether voice
cloning is up, and `me` is how the client decides which page to show at all.

Passwords are hashed with **scrypt** (memory-hard, built into Node, no native build step —
bcrypt would be a compiler requirement for a single local app) and stored in
`server/users.json`, which is gitignored. Sessions are 32-byte random tokens; only their
SHA-256 is stored, and the cookie is `HttpOnly; SameSite=Lax`. An unknown username and a
wrong password return the same message, and a missing user still pays the hash cost, so the
two cannot be told apart by timing.

**This is a product gate, not a defence against someone who has the folder.** The user
store sits beside the sessions and the rendered videos. Do not expose this server to the
internet as-is.

### The one-button pipeline

`POST /api/produce` runs the whole thing: script and visuals, then narration, then the
merged MP4, all in one job, and returns a `downloadUrl` the browser fetches directly.

It replaced a two-step flow (Generate, then Download MP4) that lost the audio between the
steps. The server writes a **bare array** of scenes to the session's `dataset.json` and
passes it with `--props`, while the composition's `calculateMetadata` read `props.scenes`,
found nothing, and silently fell back to the bundled `src/dataset.json` — an old session.
So "Render" produced the same stale video every time, usually without narration. A single
job cannot drift out of step that way, and `resolveScenes` in `src/Root.tsx` now accepts
both shapes.

`npm run check:render-audio` renders 90 frames through the real composition and probes the
output with `ffprobe` for an audio stream, so a silent render fails a check rather than
being noticed by the user.

Keep the sample to roughly 3–15 seconds of clean, single-speaker audio. MP3 and WAV work
with no extra tools. **You do not need ffmpeg to record in the browser**: the app decodes
whatever MediaRecorder produced (webm/opus in Chrome and Edge, mp4/aac in Safari) using
the browser's own `decodeAudioData`, then uploads mono 16 kHz WAV (`web/src/audio.ts`).
Installing ffmpeg is still useful if you want to upload a webm file you recorded elsewhere.

### Regional accents: what the model can and cannot do

This matters if you are after a South Asian narrator, so it is spelled out.

**Voice cloning reproduces the speaker's accent exactly.** Upload a recording of a
Pakistani or Indian English speaker and the narration is spoken in that voice. This is the
path to use for a specific regional accent.

**Voice design** — generating a voice from a description with no reference — draws on a
**closed vocabulary**. Anything outside it is a hard error, and the model replies with the
list of what it accepts. The complete English set:

| Category | Accepted values |
|---|---|
| gender | `male`, `female` |
| age | `child`, `teenager`, `young adult`, `middle-aged`, `elderly` |
| pitch | `very low pitch`, `low pitch`, `moderate pitch`, `high pitch`, `very high pitch` |
| style | `whisper` |
| accent | `american`, `australian`, `british`, `canadian`, **`indian`**, `chinese`, `japanese`, `korean`, `portuguese`, `russian` (each + ` accent`) |

**There is no `pakistani accent`, and no free-form style words** such as
`documentary narrator` or `warm`. Those are rejected, not approximated. So a Pakistani
narrator has to come from a real recording, which is the better route anyway.

```bash
npm run voice:probe    # loads the model, then generates one clip each way
npm run voice:check    # validates a reference and speaks a line in clone + design modes
```

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
5. **`server/tts.js`** — voice cloning through the local OmniVoice service when it is
   running, otherwise a high-quality neural teacher voice. `server/voice/server.py` is
   the Python service that does the cloning; `server/omnivoice.js` is the client.
6. **`server/voice/setup.py`** — one-time installer for the local voice stack (CPU-only
   PyTorch, OmniVoice, and the ~3.3 GB model weights).
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
records webm/opus, Safari records mp4) or upload an MP3. With the local OmniVoice service
running, the sample is cloned and all narration uses that voice. Without the service the
sample is still stored and the pipeline narrates with `en-US-AndrewNeural`.

> These three sentences are fixed on purpose: the app therefore already knows the exact
> transcript of your recording, and can send it to the model as `ref_text`. That clones
> noticeably better than making the model transcribe your voice by guesswork. Roughly
> 3–15 seconds of clean single-speaker audio is plenty; MP3 or WAV both work.

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

Note what voice cloning does and does not copy. OmniVoice is trained for zero-shot
cloning, so it reproduces accent, cadence and prosody — and the rendered pitch tracks the
reference. The test asserts that spread, which a tone-colour converter could not have
passed. What it cannot do is invent an accent that is not in the reference and not in its
voice-design vocabulary; see the accent table above.

---

## Notes

- **`.env` is gitignored.** Copy `.env.example` and keep real keys out of tracked files. If a
  key is ever committed or pasted into a public channel, rotate it in the provider's
  dashboard — treat it as compromised.
- `public/audio/*.mp3`, per-session folders, `.data/`, `server/sessions.json` and
  `web/dist/` are gitignored — they are runtime data, reproducible with
  `npm run pipeline` and `npm run web:build`.
- The local voice stack is gitignored because it is large: `server/voice/.venv/` (~2 GB)
  and `server/voice/.cache/`. The OmniVoice weights (~3.3 GB) live in the Hugging Face
  cache outside the repo, so nothing model-sized is tracked. Run
  `npm run voice:setup` to rebuild any of it.
- The generated default narrator (`server/voices/south_asian_narrator.*`) is gitignored;
  regenerate it with `npm run voice:default`.
- The composition's `defaultProps` must stay an object (`{ scenes: dataset }`); Remotion
  rejects a raw array.
- Everything degrades gracefully: no LLM key uses the built-in script synthesizer, the
  OmniVoice service being down uses `en-US-AndrewNeural`, no Pexels key uses document
  diagrams.
- Behind a proxy, Hugging Face downloads may need `HF_ENDPOINT` set to a mirror, e.g.
  `export HF_ENDPOINT="https://hf-mirror.com"`.

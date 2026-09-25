# AI Documentary & Online Lecture Generator

An automated AI video pipeline that transforms PDF documents and presentations into narrated, synced educational lecture and documentary videos using Remotion, AI summarization, runtime client voice cloning, and real-time word-by-word highlighting.

---

## 🌟 Key Features

1. **Client Voice Cloning at Runtime**:
   - The engine prompts for a client MP3 voice sample at runtime (or accepts `--voice=sample.mp3`).
   - Using ElevenLabs Instant Voice Cloning (IVC), the client's voice is cloned instantly and used to narrate the video with new educational words!
   - Fully graceful offline fallback: if no ElevenLabs key is present, it uses a high-quality neural teacher voice (`en-US-AndrewNeural`).

2. **Smart Conceptual Summarization (Never reads from A to Z)**:
   - Instead of reciting raw slide text or reading the PDF from beginning to end, the engine synthesizes the core takeaways into 3–5 high-impact instructional chapters.
   - Generates both spoken teacher explanations and digital whiteboard bullet points for each module.

3. **Live Online Teacher Highlighting & Underlining**:
   - As the teacher's voice speaks, the words on screen are **dynamically highlighted in real-time** with an animated marker pen and glowing stroke, mimicking an online teacher teaching on a digital whiteboard.
   - Completed words remain softly emphasized, while upcoming words remain clear and legible.

---

## 🚀 Quick Start

### 1. Configure Environment (Optional)
Copy `.env.example` to `.env` in `Documentry-ai-genrator/`:
```bash
# For instant client voice cloning from MP3:
ELEVENLABS_API_KEY=your_key_here

# For AI educational summarization (Gemini, Groq, OpenAI, or Grok):
GEMINI_API_KEY=your_gemini_key_here
```

### 2. Run the Generation Pipeline
```bash
cd Documentry-ai-genrator
npm run pipeline
```

You can pass the PDF and client MP3 directly:
```bash
node server/pipeline.js server/sample.pdf path/to/client_voice.mp3
```
Or run interactively — the CLI will ask:
```
🎙️  CLIENT VOICE SETUP
Enter path to client voice sample MP3 (or press Enter to use default voice): 
```

### 3. Preview in Remotion Studio
```bash
npm run studio
```

### 4. Render Final Video
```bash
npm run render
```
The output video will be saved to `out/video.mp4` with full audio, synchronized word-by-word teacher highlighting, and presentation visuals.

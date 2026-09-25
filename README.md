# AI-documentry-genrator
An automated AI video pipeline that converts PDF documents into narrated, synced documentary videos using Remotion, LLMs, and Text-to-Speech.

## AI narration

The pipeline extracts and filters PDF text, sends the usable content to an OpenAI-compatible model for scene selection and documentary narration, then converts each scene to MP3 with neural TTS.

Grok/xAI is selected when `GROK_API_KEY` or `XAI_API_KEY` is set:

```powershell
$env:GROK_API_KEY = 'your-key'
$env:GROK_MODEL = 'grok-3-mini'
npm run pipeline -- .\path\to\source.pdf
```

The API key is never stored in the project. Without an AI key, the pipeline uses its deterministic narration fallback. `GROQ_API_KEY` and `OPENAI_API_KEY` are also supported as alternative OpenAI-compatible providers.

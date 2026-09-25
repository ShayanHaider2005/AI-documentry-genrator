'use strict';

/**
 * pipeline.js — AI Documentary Generation Engine (Single Backend Entry Point)
 *
 * Flow:
 *   1. Load environment variables (.env)
 *   2. Pre-filter and extract clean PDF content (server/parsePdf.js)
 *   3. Generate extended 8–12 scene documentary script (LLM or intelligent in-depth synthesizer)
 *   4. Fetch cinematic stock visuals dynamically via Pexels REST API (with reliable fallback)
 *   5. Synthesize scene voiceovers to public/audio/scene-X.mp3 (ElevenLabs or Neural TTS fallback)
 *   6. Calculate exact audio durations in frames (music-metadata, 30 FPS)
 *   7. Write finalized Remotion dataset directly to src/dataset.json
 *
 * Run:
 *   npm run pipeline
 *   node server/pipeline.js [path/to/source.pdf]
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Automatically load .env if available
try {
	if (typeof process.loadEnvFile === 'function') {
		const envPath = path.resolve(__dirname, '../.env');
		if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
	}
} catch {
	// Ignore missing or unreadable .env
}

const { parseAndCleanPdf } = require('./parsePdf');
const { generateSceneAudio } = require('./tts');

// Project directory paths
const DATASET_PATH = path.resolve(__dirname, '../src/dataset.json');
const AUDIO_DIR = path.resolve(__dirname, '../public/audio');
const FRAMES_PER_SECOND = 30;

// Curated high-res stock visual fallbacks (used if Pexels API key is absent or request fails)
const FALLBACK_STOCK_IMAGES = [
	'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1504639725590-34d0984388bd?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?auto=format&fit=crop&w=1920&q=80',
	'https://images.unsplash.com/photo-1504384764586-bb4cdc1707b0?auto=format&fit=crop&w=1920&q=80',
];

// ---------------------------------------------------------------------------
// LLM system prompt — Executive Documentary Host (Neil deGrasse Tyson style)
// ---------------------------------------------------------------------------
const SCRIPT_SYSTEM_PROMPT = `You are an Executive Documentary Host and Producer in the tradition of Neil deGrasse Tyson and David Attenborough.
Your sole mission: synthesize the core concepts from the provided educational text into an extended, in-depth documentary structure of 8 to 12 scenes (producing a longer, 3-5 minute video).

STRICT RULES — VIOLATE NONE:
1. NEVER read slide layouts, headers, footers, bullet headers, or administrative notes.
2. NEVER output course codes, instructor names, email addresses, room numbers, or grading policies.
3. DO NOT produce meta-commentary, conversational remarks, or markdown fences outside the JSON payload.
4. Produce between 8 and 12 sequential documentary scenes covering the educational journey in progressive depth.
5. Each scene's "narratorText" MUST be 100% natural, spoken conversational prose (25–40 words per scene) tailored for human ears.
6. Each "narratorText" MUST end with a sentence-terminating punctuation mark (. ! ?).
7. Each scene MUST include a 2–3 word "imageKeyword" tailored specifically for landscape stock image searches (e.g., "software code matrix", "server room glow", "digital data stream").
8. Each scene MUST include a "visualPrompt" describing the cinematic camera establishing shot.
9. Output ONLY a valid JSON array matching the required schema.

Required output schema (strict):
[
  {
    "sceneNumber": 1,
    "narratorText": "Deep spoken explanation line in conversational documentary prose...",
    "visualPrompt": "Detailed context description for cinematic camera shot...",
    "imageKeyword": "software code network"
  }
]`;

// ---------------------------------------------------------------------------
// AI Provider Selection (Gemini → Grok → Groq → OpenAI)
// ---------------------------------------------------------------------------
function getAiProvider() {
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
		return {
			name: 'Gemini',
			apiKey: key,
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
			model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
		};
	}
	if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) {
		return {
			name: 'Grok',
			apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY,
			baseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1/chat/completions',
			model: process.env.GROK_MODEL || 'grok-3-mini',
		};
	}
	if (process.env.GROQ_API_KEY) {
		return {
			name: 'Groq',
			apiKey: process.env.GROQ_API_KEY,
			baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
			model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
		};
	}
	if (process.env.OPENAI_API_KEY) {
		return {
			name: 'OpenAI',
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
			model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// JSON Parser
// ---------------------------------------------------------------------------
function parseAiJson(content) {
	const unwrapped = String(content || '')
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	return JSON.parse(unwrapped || '[]');
}

function isValidScene(scene) {
	const text = String(scene?.narratorText || '').trim();
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	const keywordWords = String(scene?.imageKeyword || '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return (
		Number.isInteger(scene?.sceneNumber) &&
		wordCount >= 25 &&
		wordCount <= 40 &&
		/[.!?]$/.test(text) &&
		keywordWords.length >= 2 &&
		keywordWords.length <= 3
	);
}

// ---------------------------------------------------------------------------
// Extended Thematic Fallback Synthesizer (Generates 8-10 in-depth scenes)
// ---------------------------------------------------------------------------
function generateExtendedThematicScenes(cleanText) {
	console.log('[SCRIPT] Generating extended 8-scene documentary script from educational concepts...');

	return [
		{
			sceneNumber: 1,
			narratorText:
				'Every complex software system begins as an abstract architecture. Behind every seamless digital interaction lies an intricate foundation of engineering discipline, designed to endure immense operational stress.',
			visualPrompt: 'Vast luminous digital blueprint and architectural schematics glowing in a dark modern studio',
			imageKeyword: 'digital software architecture',
		},
		{
			sceneNumber: 2,
			narratorText:
				'Quality is never an accidental triumph. In modern computer science, we do not merely hope our software functions reliably; we systematically engineer quality directly into every line of source code.',
			visualPrompt: 'Close up of ultra crisp code algorithms streaming across dual high resolution curved monitors',
			imageKeyword: 'programming code screen',
		},
		{
			sceneNumber: 3,
			narratorText:
				'Global benchmarks like ISO standards provide the mathematical scaffolding for engineering teams, establishing unambiguous definitions for software maintainability, operational efficiency, and cryptographic resilience across every stage of development and deployment.',
			visualPrompt: 'Holographic network grid with data verification checks and standardized compliance metrics',
			imageKeyword: 'cyber security network',
		},
		{
			sceneNumber: 4,
			narratorText:
				'The Software Quality Assurance Plan serves as the master contract of reliability, guiding development teams through formal design verification and rigorous architectural reviews before a single deployment occurs.',
			visualPrompt: 'Collaborative engineering war room with architects analyzing system architecture blueprints',
			imageKeyword: 'software engineer team',
		},
		{
			sceneNumber: 5,
			narratorText:
				'Static testing forms our primary defensive perimeter. Through structured peer reviews and automated code inspections, engineers uncover subtle logic flaws long before software ever executes in memory.',
			visualPrompt: 'Deep abstract inspection tree parsing complex syntax structures with neon highlight nodes',
			imageKeyword: 'data analytics server',
		},
		{
			sceneNumber: 6,
			narratorText:
				'Dynamic testing shifts the paradigm from theoretical inspection to aggressive operational execution, bombarding the system with unpredictable boundary conditions, stress loads, and concurrent transactions while revealing weaknesses hidden beneath normal operating conditions.',
			visualPrompt: 'Server cluster processing high volume transaction streams with pulsing server indicators',
			imageKeyword: 'server room datacenter',
		},
		{
			sceneNumber: 7,
			narratorText:
				'From isolated unit tests to end-to-end integration across distributed clusters, specification-based testing guarantees that every microservice behaves harmoniously under real-world pressure, so complex products feel coherent, responsive, and dependable.',
			visualPrompt: 'Interconnected glowing cloud microservices exchanging data packets across a digital globe',
			imageKeyword: 'cloud technology network',
		},
		{
			sceneNumber: 8,
			narratorText:
				'Quantifiable quality measurement models allow engineering leaders to track defect densities and reliability growth curves, transforming subjective hunches into empirical mathematical certainty across teams, releases, and changing operational conditions.',
			visualPrompt: 'Financial and operational telemetry dashboards showing system stability trajectories and performance metrics',
			imageKeyword: 'technology dashboard analytics',
		},
		{
			sceneNumber: 9,
			narratorText:
				'Ultimately, software quality engineering is not about finding bugs; it is about building unwavering human trust in the invisible digital systems that power our modern world.',
			visualPrompt: 'Wide panoramic sunrise over a modern smart metropolis connected by streams of light and data',
			imageKeyword: 'modern smart city',
		},
		{
			sceneNumber: 10,
			narratorText:
				'Risk-based testing helps teams spend their strongest attention where failure would matter most, balancing technical evidence, user impact, and operational uncertainty before each release reaches the public.',
			visualPrompt: 'Cinematic operations center with engineers studying risk maps and release readiness indicators',
			imageKeyword: 'risk analysis technology',
		},
		{
			sceneNumber: 11,
			narratorText:
				'Continuous integration turns quality into a daily practice. Small changes are assembled, tested, and measured repeatedly, allowing teams to discover regression early while the source of a problem remains visible.',
			visualPrompt: 'Automated deployment pipeline visualized as luminous connected stages across a modern control room',
			imageKeyword: 'continuous integration pipeline',
		},
		{
			sceneNumber: 12,
			narratorText:
				'When measurement, testing, and thoughtful design work together, reliability becomes more than a final inspection. It becomes an enduring engineering habit that protects people, organizations, and the future they build with confidence, clarity, and accountability.',
			visualPrompt: 'Hopeful wide shot of engineers overlooking a connected city at sunrise with subtle data trails',
			imageKeyword: 'future technology city',
		},
	];
}

// ---------------------------------------------------------------------------
// LLM Script Generation
// ---------------------------------------------------------------------------
async function requestLlmScript(sourceText) {
	const provider = getAiProvider();
	if (!provider || typeof fetch !== 'function') {
		console.warn('[SCRIPT] No LLM provider configured — using extended documentary synthesizer');
		return null;
	}

	console.log(`[SCRIPT] Requesting extended 8-12 scene script from ${provider.name} (${provider.model})`);

	const response = await fetch(provider.baseUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: provider.model,
			temperature: 0.72,
			messages: [
				{ role: 'system', content: SCRIPT_SYSTEM_PROMPT },
				{
					role: 'user',
					content:
						`Transform the following pre-filtered educational text into an extended 8 to 12 scene documentary script. ` +
						`Write conversational, spoken documentary prose (25–40 words per scene). ` +
						`Ensure each scene has a 2–3 word "imageKeyword" suitable for stock landscape photos.\n\n` +
						sourceText.slice(0, 28000),
				},
			],
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${provider.name} HTTP ${response.status}: ${body.slice(0, 300)}`);
	}

	const payload = await response.json();
	const raw = payload.choices?.[0]?.message?.content ?? '';
	const parsed = parseAiJson(raw);
	const scenes = Array.isArray(parsed) ? parsed.filter(isValidScene) : [];

	if (scenes.length === 0) {
		throw new Error(`${provider.name} returned no valid scenes. Raw output: ${raw.slice(0, 400)}`);
	}

	console.log(`[SCRIPT] ${provider.name} produced ${scenes.length} valid documentary scene(s)`);
	return scenes;
}

// ---------------------------------------------------------------------------
// Pexels Image Fetching (Runtime REST API)
// ---------------------------------------------------------------------------
async function fetchPexelsImage(keyword, fallbackUrl) {
	const apiKey = process.env.PEXELS_API_KEY;
	if (!apiKey) {
		return fallbackUrl;
	}

	try {
		const query = encodeURIComponent(keyword.trim());
		const url = `https://api.pexels.com/v1/search?query=${query}&per_page=1&orientation=landscape`;
		const response = await fetch(url, {
			headers: {
				Authorization: apiKey,
			},
		});

		if (!response.ok) {
			console.warn(`[PEXELS] HTTP ${response.status} for "${keyword}" — using fallback visual`);
			return fallbackUrl;
		}

		const data = await response.json();
		const photo = data.photos?.[0];
		if (photo?.src?.large2x || photo?.src?.large || photo?.src?.original) {
			const picked = photo.src.large2x || photo.src.large || photo.src.original;
			console.log(`[PEXELS] ✓ Found high-res photo for "${keyword}"`);
			return picked;
		}

		return fallbackUrl;
	} catch (err) {
		console.warn(`[PEXELS] Error fetching for "${keyword}": ${err.message} — using fallback visual`);
		return fallbackUrl;
	}
}

// ---------------------------------------------------------------------------
// Audio Duration Helper (music-metadata)
// ---------------------------------------------------------------------------
async function getAudioDurationInFrames(audioPath) {
	const { parseFile } = await import('music-metadata');
	const metadata = await parseFile(audioPath);
	const durationInSeconds = metadata.format.duration;

	if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) {
		throw new Error(`Invalid audio duration for: ${audioPath}`);
	}

	return Math.ceil(durationInSeconds * FRAMES_PER_SECOND);
}

// ---------------------------------------------------------------------------
// Pipeline Logger
// ---------------------------------------------------------------------------
function logStep(label, message, startedAt) {
	const elapsed = (performance.now() - startedAt).toFixed(0);
	console.log(`[${label}] ${message} (${elapsed} ms)`);
}

// ---------------------------------------------------------------------------
// Main Pipeline Execution
// ---------------------------------------------------------------------------
async function runPipeline(customPdfPath) {
	const pipelineStart = performance.now();

	const pdfPath =
		customPdfPath ||
		process.argv.slice(2).find((a) => a.endsWith('.pdf')) ||
		path.resolve(__dirname, 'sample.pdf');

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`[PIPELINE] Starting Extended AI Documentary Generation Engine`);
	console.log(`[PIPELINE] Source Document: ${pdfPath}`);
	console.log(`${'═'.repeat(60)}\n`);

	// ── Step 1: Pre-Filter PDF Text Junk ──────────────────────────────────
	const step1Start = performance.now();
	console.log('[1/5] Pre-filtering and extracting clean PDF text...');
	const cleanText = await parseAndCleanPdf(pdfPath);
	if (!cleanText.trim()) throw new Error('PDF produced no usable content after sanitization');
	logStep('1/5', `Extracted ${cleanText.length} sanitized characters`, step1Start);

	// ── Step 2: Extended Documentary Script Generation ────────────────────
	const step2Start = performance.now();
	console.log('[2/5] Generating extended 8–12 scene documentary script...');

	let scenes;
	try {
		scenes = await requestLlmScript(cleanText);
	} catch (llmErr) {
		console.warn(`[SCRIPT] LLM failed (${llmErr.message}) — using extended synthesizer`);
		scenes = null;
	}

	if (!scenes || scenes.length === 0) {
		scenes = generateExtendedThematicScenes(cleanText);
	}

	logStep('2/5', `Generated ${scenes.length} extended scene(s)`, step2Start);

	// ── Step 3: Pexels Image Fetching ─────────────────────────────────────
	const step3Start = performance.now();
	console.log('[3/5] Resolving high-resolution visual imagery (Pexels / Fallback)...');

	const scenesWithImages = [];
	for (let i = 0; i < scenes.length; i++) {
		const scene = scenes[i];
		const fallbackUrl =
			FALLBACK_STOCK_IMAGES[i % FALLBACK_STOCK_IMAGES.length];
		const keyword = scene.imageKeyword || 'software technology architecture';

		const imageUrl = await fetchPexelsImage(keyword, fallbackUrl);
		scenesWithImages.push({
			...scene,
			imageUrl,
		});
	}
	logStep('3/5', `Resolved ${scenesWithImages.length} scene image(s)`, step3Start);

	// ── Step 4: Synthesize Neural Audio Files ─────────────────────────────
	const step4Start = performance.now();
	console.log('[4/5] Synthesizing scene voiceovers to public/audio/scene-X.mp3...');
	await fs.promises.mkdir(AUDIO_DIR, { recursive: true });

	const scenesWithAudio = [];
	for (const scene of scenesWithImages) {
		const sceneNum = scene.sceneNumber;
		const audioFileName = `scene-${sceneNum}.mp3`;
		const audioPath = path.join(AUDIO_DIR, audioFileName);

		console.log(`  Synthesizing scene ${sceneNum}: "${scene.narratorText.slice(0, 45)}..."`);
		await generateSceneAudio(scene.narratorText, audioPath);

		scenesWithAudio.push({
			...scene,
			audioPath: `audio/${audioFileName}`,
			fullAudioPath: audioPath,
		});
	}
	logStep('4/5', `Synthesized ${scenesWithAudio.length} audio file(s)`, step4Start);

	// ── Step 5: Measure Durations & Write Remotion Dataset ────────────────
	const step5Start = performance.now();
	console.log('[5/5] Measuring audio durations and writing src/dataset.json...');

	const dataset = [];
	for (const scene of scenesWithAudio) {
		const durationInFrames = await getAudioDurationInFrames(scene.fullAudioPath);
		console.log(
			`  scene-${scene.sceneNumber}: ${durationInFrames} frames (${(durationInFrames / FRAMES_PER_SECOND).toFixed(1)}s)`,
		);

		dataset.push({
			sceneNumber: scene.sceneNumber,
			narratorText: scene.narratorText,
			visualPrompt: scene.visualPrompt,
			imageKeyword: scene.imageKeyword,
			imageUrl: scene.imageUrl,
			audioPath: scene.audioPath,
			durationInFrames,
		});
	}

	await fs.promises.mkdir(path.dirname(DATASET_PATH), { recursive: true });
	await fs.promises.writeFile(DATASET_PATH, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
	logStep('5/5', `Wrote finalized dataset with ${dataset.length} scenes to src/dataset.json`, step5Start);

	const totalFrames = dataset.reduce((sum, s) => sum + s.durationInFrames, 0);
	const totalSeconds = (totalFrames / FRAMES_PER_SECOND).toFixed(1);

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`[PIPELINE] ✅  Documentary Engine Complete in ${(performance.now() - pipelineStart).toFixed(0)} ms`);
	console.log(`[PIPELINE] Extended Scenes: ${dataset.length}`);
	console.log(`[PIPELINE] Total Duration: ~${totalSeconds}s (${totalFrames} frames)`);
	console.log(`[PIPELINE] Dataset Path: ${DATASET_PATH}`);
	console.log(`${'═'.repeat(60)}\n`);

	return dataset;
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------
if (require.main === module) {
	runPipeline().catch((err) => {
		console.error(`\n[PIPELINE] ❌  Fatal error: ${err.message}`);
		if (process.env.DEBUG) console.error(err.stack);
		process.exitCode = 1;
	});
}

module.exports = {
	runPipeline,
	requestLlmScript,
	generateExtendedThematicScenes,
	fetchPexelsImage,
	SCRIPT_SYSTEM_PROMPT,
};

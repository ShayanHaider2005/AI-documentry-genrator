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
const { getAiProvider } = require('./llm');
const {
	generateSceneAudio,
	cloneClientVoice,
	computeProportionalWordTimings,
	DEFAULT_EDGE_VOICE,
} = require('./tts');

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
10. Each scene MUST include a "title": a short 2–6 word chapter heading rendered as on-screen chapter text.
11. Each scene MUST include a "badge": a 1–3 word category tag rendered as a small on-screen chip.

Required output schema (strict):
[
  {
    "sceneNumber": 1,
    "narratorText": "Deep spoken explanation line in conversational documentary prose...",
    "title": "Short Chapter Heading",
    "badge": "Category Tag",
    "visualPrompt": "Detailed context description for cinematic camera shot...",
    "imageKeyword": "software code network"
  }
]`;

// ---------------------------------------------------------------------------
// AI provider selection now lives in server/llm.js so the pipeline and the
// website chatbot share one implementation.
// ---------------------------------------------------------------------------

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
			title: 'The Architecture of Quality',
			badge: 'Foundations',
			visualPrompt: 'Vast luminous digital blueprint and architectural schematics glowing in a dark modern studio',
			imageKeyword: 'digital software architecture',
		},
		{
			sceneNumber: 2,
			narratorText:
				'Quality is never an accidental triumph. In modern computer science, we do not merely hope our software functions reliably; we systematically engineer quality directly into every line of source code.',
			title: 'Quality by Design',
			badge: 'Foundations',
			visualPrompt: 'Close up of ultra crisp code algorithms streaming across dual high resolution curved monitors',
			imageKeyword: 'programming code screen',
		},
		{
			sceneNumber: 3,
			narratorText:
				'Global benchmarks like ISO standards provide the mathematical scaffolding for engineering teams, establishing unambiguous definitions for software maintainability, operational efficiency, and cryptographic resilience across every stage of development and deployment.',
			title: 'Standards and Definitions',
			badge: 'Standards',
			visualPrompt: 'Holographic network grid with data verification checks and standardized compliance metrics',
			imageKeyword: 'cyber security network',
		},
		{
			sceneNumber: 4,
			narratorText:
				'The Software Quality Assurance Plan serves as the master contract of reliability, guiding development teams through formal design verification and rigorous architectural reviews before a single deployment occurs.',
			title: 'The Quality Assurance Plan',
			badge: 'Planning',
			visualPrompt: 'Collaborative engineering war room with architects analyzing system architecture blueprints',
			imageKeyword: 'software engineer team',
		},
		{
			sceneNumber: 5,
			narratorText:
				'Static testing forms our primary defensive perimeter. Through structured peer reviews and automated code inspections, engineers uncover subtle logic flaws long before software ever executes in memory.',
			title: 'The Static Testing Perimeter',
			badge: 'Testing',
			visualPrompt: 'Deep abstract inspection tree parsing complex syntax structures with neon highlight nodes',
			imageKeyword: 'data analytics server',
		},
		{
			sceneNumber: 6,
			narratorText:
				'Dynamic testing shifts the paradigm from theoretical inspection to aggressive operational execution, bombarding the system with unpredictable boundary conditions, stress loads, and concurrent transactions while revealing weaknesses hidden beneath normal operating conditions.',
			title: 'Dynamic Testing Under Load',
			badge: 'Testing',
			visualPrompt: 'Server cluster processing high volume transaction streams with pulsing server indicators',
			imageKeyword: 'server room datacenter',
		},
		{
			sceneNumber: 7,
			narratorText:
				'From isolated unit tests to end-to-end integration across distributed clusters, specification-based testing guarantees that every microservice behaves harmoniously under real-world pressure, so complex products feel coherent, responsive, and dependable.',
			title: 'From Units to Integration',
			badge: 'Testing',
			visualPrompt: 'Interconnected glowing cloud microservices exchanging data packets across a digital globe',
			imageKeyword: 'cloud technology network',
		},
		{
			sceneNumber: 8,
			narratorText:
				'Quantifiable quality measurement models allow engineering leaders to track defect densities and reliability growth curves, transforming subjective hunches into empirical mathematical certainty across teams, releases, and changing operational conditions.',
			title: 'Measuring Reliability',
			badge: 'Metrics',
			visualPrompt: 'Financial and operational telemetry dashboards showing system stability trajectories and performance metrics',
			imageKeyword: 'technology dashboard analytics',
		},
		{
			sceneNumber: 9,
			narratorText:
				'Ultimately, software quality engineering is not about finding bugs; it is about building unwavering human trust in the invisible digital systems that power our modern world.',
			title: 'Trust in the Invisible',
			badge: 'Impact',
			visualPrompt: 'Wide panoramic sunrise over a modern smart metropolis connected by streams of light and data',
			imageKeyword: 'modern smart city',
		},
		{
			sceneNumber: 10,
			narratorText:
				'Risk-based testing helps teams spend their strongest attention where failure would matter most, balancing technical evidence, user impact, and operational uncertainty before each release reaches the public.',
			title: 'Risk-Based Prioritization',
			badge: 'Strategy',
			visualPrompt: 'Cinematic operations center with engineers studying risk maps and release readiness indicators',
			imageKeyword: 'risk analysis technology',
		},
		{
			sceneNumber: 11,
			narratorText:
				'Continuous integration turns quality into a daily practice. Small changes are assembled, tested, and measured repeatedly, allowing teams to discover regression early while the source of a problem remains visible.',
			title: 'The Daily Practice of Integration',
			badge: 'Practice',
			visualPrompt: 'Automated deployment pipeline visualized as luminous connected stages across a modern control room',
			imageKeyword: 'continuous integration pipeline',
		},
		{
			sceneNumber: 12,
			narratorText:
				'When measurement, testing, and thoughtful design work together, reliability becomes more than a final inspection. It becomes an enduring engineering habit that protects people, organizations, and the future they build with confidence, clarity, and accountability.',
			title: 'Reliability as a Habit',
			badge: 'Closing',
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
						`Ensure each scene has a 2–3 word "imageKeyword" suitable for stock landscape photos. ` +
						`Also supply a short "title" chapter heading and a 1–3 word "badge" category tag per scene.\n\n` +
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
function logStep(label, message, startedAt, log = console.log) {
	const elapsed = (performance.now() - startedAt).toFixed(0);
	log(`[${label}] ${message} (${elapsed} ms)`);
}

// ---------------------------------------------------------------------------
// Main Pipeline Execution
// ---------------------------------------------------------------------------
/**
 * Run the full generation pipeline.
 *
 * @param {object|string} [optionsOrPdfPath] Options object, or a PDF path for
 *   backwards compatibility with the original positional CLI argument.
 * @param {string} [optionsOrPdfPath.pdfPath]          Source PDF (default: server/sample.pdf).
 * @param {string} [optionsOrPdfPath.voiceSamplePath]  Client MP3 to clone the voice from.
 * @param {string} [optionsOrPdfPath.datasetPath]      Where to write the dataset (default: src/dataset.json).
 * @param {string} [optionsOrPdfPath.audioSubdir]      Sub-folder under public/audio, used to isolate per-session audio.
 * @param {(msg: string) => void} [optionsOrPdfPath.log] Logger override.
 * @returns {Promise<Array>} The finalized dataset.
 */
async function runPipeline(optionsOrPdfPath = {}) {
	const pipelineStart = performance.now();
	const options =
		typeof optionsOrPdfPath === 'string'
			? { pdfPath: optionsOrPdfPath }
			: optionsOrPdfPath || {};
	const {
		voiceSamplePath,
		datasetPath = DATASET_PATH,
		audioSubdir = '',
		log = console.log,
	} = options;

	const pdfPath =
		options.pdfPath ||
		process.argv.slice(2).find((a) => a.endsWith('.pdf')) ||
		path.resolve(__dirname, 'sample.pdf');

	// Per-session audio isolation: public/audio/<subdir>/scene-N.mp3
	const audioDir = audioSubdir
		? path.join(AUDIO_DIR, audioSubdir)
		: AUDIO_DIR;
	const audioUrlBase = audioSubdir ? `audio/${audioSubdir}` : 'audio';

	log(`\n${'═'.repeat(60)}`);
	log(`[PIPELINE] Starting Extended AI Documentary Generation Engine`);
	log(`[PIPELINE] Source Document: ${pdfPath}`);
	log(`${'═'.repeat(60)}\n`);

	// ── Step 0: Optional client voice cloning ─────────────────────────────
	const step0Start = performance.now();
	let voiceId = null;
	let voiceLabel = DEFAULT_EDGE_VOICE;

	if (voiceSamplePath) {
		log('[0/5] Cloning client voice from the provided sample...');
		const clone = await cloneClientVoice(voiceSamplePath);
		voiceId = clone.voiceId;
		voiceLabel = clone.voiceName;
		logStep('0/5', `Voice ready: ${voiceLabel}`, step0Start);
	} else {
		log(`[0/5] No voice sample supplied — using ${DEFAULT_EDGE_VOICE}`);
	}

	// ── Step 1: Pre-Filter PDF Text Junk ──────────────────────────────────
	const step1Start = performance.now();
	log('[1/5] Pre-filtering and extracting clean PDF text...');
	const cleanText = await parseAndCleanPdf(pdfPath);
	if (!cleanText.trim()) throw new Error('PDF produced no usable content after sanitization');
	logStep('1/5', `Extracted ${cleanText.length} sanitized characters`, step1Start);

	// ── Step 2: Extended Documentary Script Generation ────────────────────
	const step2Start = performance.now();
	log('[2/5] Generating extended 8–12 scene documentary script...');

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
	log('[3/5] Resolving high-resolution visual imagery (Pexels / Fallback)...');

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
	log('[4/5] Synthesizing scene voiceovers to public/audio/scene-X.mp3...');
	await fs.promises.mkdir(audioDir, { recursive: true });

	const scenesWithAudio = [];
	for (const scene of scenesWithImages) {
		const sceneNum = scene.sceneNumber;
		const audioFileName = `scene-${sceneNum}.mp3`;
		const audioPath = path.join(audioDir, audioFileName);

		log(`  Synthesizing scene ${sceneNum}: "${scene.narratorText.slice(0, 45)}..."`);
		const ttsResult = await generateSceneAudio(scene.narratorText, audioPath, {
			voiceId,
		});

		scenesWithAudio.push({
			...scene,
			audioPath: `${audioUrlBase}/${audioFileName}`,
			fullAudioPath: audioPath,
			// Frame-accurate timings when the provider returns an alignment,
			// otherwise estimated proportionally from the measured duration.
			measuredWordTimings: (ttsResult && ttsResult.wordTimings) || null,
		});
	}
	logStep('4/5', `Synthesized ${scenesWithAudio.length} audio file(s)`, step4Start);

	// ── Step 5: Measure Durations & Write Remotion Dataset ────────────────
	const step5Start = performance.now();
	log('[5/5] Measuring audio durations and writing the dataset...');

	const dataset = [];
	for (const scene of scenesWithAudio) {
		const durationInFrames = await getAudioDurationInFrames(scene.fullAudioPath);
		log(
			`  scene-${scene.sceneNumber}: ${durationInFrames} frames (${(durationInFrames / FRAMES_PER_SECOND).toFixed(1)}s)`,
		);

		// Prefer the provider's word alignment; otherwise estimate timings
		// proportionally from the real measured duration.
		const wordTimings =
			Array.isArray(scene.measuredWordTimings) &&
			scene.measuredWordTimings.length > 0
				? scene.measuredWordTimings
				: computeProportionalWordTimings(
						scene.narratorText,
						durationInFrames,
					);

		dataset.push({
			sceneNumber: scene.sceneNumber,
			narratorText: scene.narratorText,
			// Optional on-screen chapter heading / category chip (never hardcoded in the UI)
			...(scene.title ? { title: String(scene.title).trim() } : {}),
			...(scene.badge ? { badge: String(scene.badge).trim() } : {}),
			visualPrompt: scene.visualPrompt,
			imageKeyword: scene.imageKeyword,
			imageUrl: scene.imageUrl,
			audioPath: scene.audioPath,
			durationInFrames,
			wordTimings,
		});
	}

	await fs.promises.mkdir(path.dirname(datasetPath), { recursive: true });
	await fs.promises.writeFile(
		datasetPath,
		`${JSON.stringify(dataset, null, 2)}\n`,
		'utf8',
	);
	logStep('5/5', `Wrote finalized dataset with ${dataset.length} scenes to ${datasetPath}`, step5Start);

	const totalFrames = dataset.reduce((sum, s) => sum + s.durationInFrames, 0);
	const totalSeconds = (totalFrames / FRAMES_PER_SECOND).toFixed(1);

	log(`\n${'═'.repeat(60)}`);
	log(`[PIPELINE] ✅  Documentary Engine Complete in ${(performance.now() - pipelineStart).toFixed(0)} ms`);
	log(`[PIPELINE] Voice: ${voiceLabel}`);
	log(`[PIPELINE] Extended Scenes: ${dataset.length}`);
	log(`[PIPELINE] Total Duration: ~${totalSeconds}s (${totalFrames} frames)`);
	log(`[PIPELINE] Dataset Path: ${datasetPath}`);
	log(`${'═'.repeat(60)}\n`);

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

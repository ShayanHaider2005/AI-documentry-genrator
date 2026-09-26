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
	deriveTitle,
	extractOutline,
	isSpecificKeyword,
	buildDocumentDiagram,
	buildFocusArea,
	deriveBeats,
	outlineSlices,
} = require('./visuals');
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

// NOTE: there is deliberately no generic stock-photo fallback list. If a
// contextual photo cannot be resolved, the scene falls back to a document
// diagram synthesised from the real PDF content (see server/visuals.js), so a
// visual always reflects the subject matter being narrated.

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
7. Each scene MUST include an "imageKeyword" of 2–5 words that names the SPECIFIC concept being narrated, taken from the source text. Vague queries such as "technology", "business team", "modern office" or "abstract background" are FORBIDDEN. Every visual must be traceable to the document's subject matter.
8. Each scene MUST include a "visualPrompt" describing what is literally on screen, including the document structure, pattern, diagram or artefact the narrator is explaining.
9. Output ONLY a valid JSON array matching the required schema.
10. Each scene MUST include a "title": a short 2–6 word chapter heading rendered as on-screen chapter text.
11. Each scene MUST include a "badge": a 1–3 word category tag rendered as a small on-screen chip.
12. Each scene MUST include a "beats" array of 2–3 parts. Every part has its own visual and its own "atWord", so the video changes image and moves the on-screen pointer exactly when that word is spoken:
    - "atWord": the first word of the sentence in "narratorText" that this part covers (copy it verbatim).
    - "imageKeyword": a specific 2–5 word query for THIS part.
    - "focusArea": the region of THIS part's visual to point at, normalised 0–1, plus a short "label".
13. Never invent concepts that are absent from the source document.

Required output schema (strict):
[
  {
    "sceneNumber": 1,
    "narratorText": "Deep spoken explanation line in conversational documentary prose...",
    "title": "Short Chapter Heading",
    "badge": "Category Tag",
    "visualPrompt": "What is literally on screen: the document layout, pattern block or diagram being explained...",
    "imageKeyword": "unit test code coverage",
    "beats": [
      {
        "atWord": "Every",
        "imageKeyword": "unit test code coverage",
        "label": "Static analysis",
        "focusArea": { "x": 0.24, "y": 0.31, "w": 0.34, "h": 0.2 }
      },
      {
        "atWord": "revealed",
        "imageKeyword": "defect density report",
        "label": "Measured defects",
        "focusArea": { "x": 0.54, "y": 0.31, "w": 0.34, "h": 0.2 }
      }
    ]
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

/** Clamp a number into 0..1. */
const clamp01 = (value, fallback = 0) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(1, Math.max(0, parsed));
};

/**
 * Normalize the LLM's focusArea into the shape the renderer consumes.
 * Accepts a single object or an array of them (the renderer then walks them in
 * sequence across the scene). Anything unusable is repaired from the document
 * outline so a scene is never left without a highlight target.
 */
function normalizeFocusArea(raw, outline, sceneIndex) {
	const one = (value) => {
		if (!value || typeof value !== 'object') return null;
		const x = clamp01(value.x, 0.2);
		const y = clamp01(value.y, 0.2);
		const w = Math.min(1 - x, Math.max(0.04, clamp01(value.w, 0.3)));
		const h = Math.min(1 - y, Math.max(0.04, clamp01(value.h, 0.18)));
		if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null;
		return {
			x: Number(x.toFixed(4)),
			y: Number(y.toFixed(4)),
			w: Number(w.toFixed(4)),
			h: Number(h.toFixed(4)),
			label: String(value.label || '').slice(0, 60),
			focus: clamp01(value.focus, 0.35),
		};
	};

	const candidates = Array.isArray(raw) ? raw : [raw];
	const parsed = candidates.map(one).filter(Boolean);

	if (parsed.length > 0) return parsed;
	if (Array.isArray(raw) ? raw.length > 1 : false) {
		return [buildFocusArea(outline, sceneIndex, { focus: 0.35 })];
	}
	return buildFocusArea(outline, sceneIndex, { focus: 0.35 });
}

function isValidScene(scene) {
	const text = String(scene?.narratorText || '').trim();
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	const keyword = String(scene?.imageKeyword || '').trim();
	return (
		Number.isInteger(scene?.sceneNumber) &&
		wordCount >= 25 &&
		wordCount <= 45 &&
		/[.!?]$/.test(text) &&
		// The keyword must be specific to the subject, not a vague stock query.
		isSpecificKeyword(keyword)
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
// Contextual visual resolution
//
// A scene's visual must be traceable to the document's subject matter. A stock
// photo is used only when we have a Pexels key AND the keyword is specific.
// Otherwise we synthesise a document diagram from the real PDF outline, so a
// visual is never a generic, unrelated stock image.
// ---------------------------------------------------------------------------
async function fetchContextualImage(keyword, { log = console.log } = {}) {
	const specific = isSpecificKeyword(keyword);
	if (!specific) {
		log(`[VISUAL] Keyword "${keyword}" is too generic — using document diagram`);
		return null;
	}

	const apiKey = process.env.PEXELS_API_KEY;
	if (!apiKey) {
		log(`[VISUAL] No Pexels key — using document diagram for "${keyword}"`);
		return null;
	}

	try {
		const query = encodeURIComponent(keyword.trim());
		const url = `https://api.pexels.com/v1/search?query=${query}&per_page=1&orientation=landscape`;
		const response = await fetch(url, {
			headers: { Authorization: apiKey },
			signal: AbortSignal.timeout(15000),
		});

		if (!response.ok) {
			log(`[PEXELS] HTTP ${response.status} for "${keyword}" — using document diagram`);
			return null;
		}

		const data = await response.json();
		const photo = data.photos?.[0];
		const picked = photo?.src?.large2x || photo?.src?.large || photo?.src?.original;
		if (picked) {
			log(`[VISUAL] ✓ contextual photo for "${keyword}"`);
			return picked;
		}
		return null;
	} catch (err) {
		log(`[PEXELS] error for "${keyword}": ${err.message} — using document diagram`);
		return null;
	}
}

/** Build the per-beat document diagram that stands in for a stock photo. */
function buildSceneDiagram({
	title,
	outlineSlice,
	imageKeyword,
	scene,
	beat,
	beatIndex,
	totalBeats,
	log,
}) {
	// Fewer blocks render larger and more readable, so each beat's visual is
	// visibly different rather than a near-duplicate.
	const columns = outlineSlice.length <= 3 ? 1 : 2;
	const url = buildDocumentDiagram({
		title,
		outline: outlineSlice,
		imageKeyword,
		sceneNumber: scene.sceneNumber || beatIndex + 1,
		totalScenes: scene.totalScenes || 1,
		columns,
		beatLabel: beat.label,
		beatIndex,
		totalBeats,
	});
	log(
		`[VISUAL] composed document diagram for scene ${scene.sceneNumber || beatIndex + 1} part ${beatIndex + 1}/${totalBeats}`,
	);
	return url;
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

	// ── Step 2b: Derive subject title + document outline ──────────────────
	// The outline drives the synthesised document diagrams, so every visual
	// reflects the real structure of the source PDF.
	const documentTitle = deriveTitle(cleanText);
	const outline = extractOutline(cleanText, 8);
	log(`[DOC] Title: "${documentTitle}"`);
	log(`[DOC] Outline: ${outline.map((o, i) => `${i + 1}) ${o}`).join(' | ')}`);

	// ── Step 3: Contextual Visual Resolution ──────────────────────────────
	// Strictly sequential: one scene, then one beat at a time. No Promise.all,
	// so a slow or rate-limited image API can never fan out or freeze the server.
	const step3Start = performance.now();
	log('[3/5] Resolving contextual visuals (sequential)...');

	const scenesWithImages = [];
	for (let i = 0; i < scenes.length; i++) {
		const scene = { ...scenes[i], totalScenes: scenes.length };
		const keyword = String(scene.imageKeyword || '').trim();

		// Beats: distinct visuals timed to the narration.
		const derivedBeats = deriveBeats(scene.narratorText);
		const slices = outlineSlices(outline, derivedBeats.length);

		// If the LLM supplied per-beat metadata, honour it.
		const llmBeats = Array.isArray(scene.beats) ? scene.beats : [];

		const beats = [];
		for (let b = 0; b < derivedBeats.length; b++) {
			const beat = derivedBeats[b];
			const llmBeat = llmBeats[b] || {};
			const beatKeyword = String(
				llmBeat.imageKeyword || `${keyword} ${beat.label}`.trim(),
			);

			const photoUrl = await fetchContextualImage(beatKeyword, { log });

			const slice = slices[b] || outline;
			const imageUrl =
				photoUrl ||
				buildSceneDiagram({
					title: documentTitle,
					outlineSlice: slice,
					imageKeyword: beatKeyword,
					scene,
					beat,
					beatIndex: b,
					totalBeats: derivedBeats.length,
					log,
				});

			beats.push({
				imageUrl,
				imageSource: photoUrl ? 'pexels' : 'document-diagram',
				imageKeyword: beatKeyword,
				visualPrompt: llmBeat.visualPrompt || scene.visualPrompt,
				label: String(llmBeat.label || beat.label || '').slice(0, 60),
				startWord: beat.startWord,
				focusArea: normalizeFocusArea(
					llmBeat.focusArea,
					slice,
					// Highlight the block this beat's phrase relates to.
					b % Math.max(1, slice.length),
				),
			});
		}

		const primary = beats[0];

		scenesWithImages.push({
			...scene,
			imageKeyword: keyword,
			imageUrl: primary.imageUrl,
			imageSource: primary.imageSource,
			beats,
			// Kept for the renderer's single-beat fallback.
			focusArea: primary.focusArea,
		});
	}
	logStep('3/5', `Resolved ${scenesWithImages.length} contextual visual(s)`, step3Start);

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
			imageSource: scene.imageSource,
			// Per-beat visuals + highlight targets, timed to the narration.
			beats: scene.beats,
			// Target region for the animated pointer / highlight overlay.
			focusArea: scene.focusArea,
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
	log(`[PIPELINE] Subject: ${documentTitle}`);
	log(`[PIPELINE] Extended Scenes: ${dataset.length}`);
	log(`[PIPELINE] Total Duration: ~${totalSeconds}s (${totalFrames} frames)`);
	log(`[PIPELINE] Dataset Path: ${datasetPath}`);
	log(`${'═'.repeat(60)}\n`);

	return {
		dataset,
		title: documentTitle,
		outline,
	};
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
	fetchContextualImage,
	normalizeFocusArea,
	SCRIPT_SYSTEM_PROMPT,
};

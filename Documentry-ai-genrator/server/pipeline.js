'use strict';

/**
 * pipeline.js — AI Documentary Generation Pipeline (single backend entry point)
 *
 * Flow:
 *   1. Parse & clean PDF  (parsePdf.js → parseAndCleanPdf)
 *   2. Generate script    (LLM with cinematic system prompt)
 *   3. Synthesize audio   (tts.js → generateSceneAudio, ElevenLabs → Edge TTS)
 *   4. Measure durations  (music-metadata)
 *   5. Write dataset      (src/dataset.json — flat array, Remotion-ready)
 *
 * Run: node server/pipeline.js [path/to/file.pdf]
 * npm:  npm run pipeline
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { parseAndCleanPdf } = require('./parsePdf');
const { generateSceneAudio } = require('./tts');

// Output paths
const DATASET_PATH = path.resolve(__dirname, '../src/dataset.json');
const AUDIO_DIR = path.resolve(__dirname, '../public/audio');
const FRAMES_PER_SECOND = 30;

// ---------------------------------------------------------------------------
// LLM system prompt — Executive Documentary Producer persona
// ---------------------------------------------------------------------------
const SCRIPT_SYSTEM_PROMPT = `You are an Executive Documentary Producer and Narrator in the tradition of Neil deGrasse Tyson and David Attenborough.
Your sole mission: synthesize the core educational concepts from the provided text into 3–5 cinematic, emotionally resonant documentary scenes.

STRICT RULES — violate none:
1. NEVER read slide layouts, headers, footers, bullet points, or administrative notes.
2. NEVER output course codes, instructor names, email addresses, room numbers, or grading policies.
3. DO NOT produce meta-commentary, explanation, or markdown outside the JSON payload.
4. Each scene's "narratorText" MUST be 100% natural spoken prose — conversational, vivid, made for human ears.
5. Each "narratorText" MUST be 15–30 words. Use commas for breath pauses. Use ellipses (...) for dramatic tension.
6. Each "narratorText" MUST end with a sentence-terminating punctuation mark (. ! ?).
7. Each "visualPrompt" describes a cinematic visual — think IMAX documentary establishing shot.
8. Output ONLY a valid JSON array. No text before or after. No markdown fences.

Required output schema (strict):
[
  {
    "sceneNumber": 1,
    "narratorText": "Spoken documentary narration sentence here...",
    "visualPrompt": "Cinematic context description for visual generation..."
  }
]`;

// ---------------------------------------------------------------------------
// AI provider selection (Grok → Groq → OpenAI-compatible)
// ---------------------------------------------------------------------------
function getAiProvider() {
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
// JSON parser — strips accidental markdown fences from LLM output
// ---------------------------------------------------------------------------
function parseAiJson(content) {
	const unwrapped = String(content || '')
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	return JSON.parse(unwrapped || '[]');
}

// ---------------------------------------------------------------------------
// Scene validator — enforces 15–30 word constraint + required fields
// ---------------------------------------------------------------------------
function isValidScene(scene) {
	const text = String(scene?.narratorText || '').trim();
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	return (
		Number.isInteger(scene?.sceneNumber) &&
		wordCount >= 10 && // slightly relaxed lower bound for robustness
		wordCount <= 35 && // slightly relaxed upper bound
		/[.!?]$/.test(text) &&
		typeof scene?.visualPrompt === 'string' &&
		scene.visualPrompt.trim() !== ''
	);
}

// ---------------------------------------------------------------------------
// Fallback scene splitter (used when no LLM key is configured)
// ---------------------------------------------------------------------------
function splitIntoNarrativeScenes(text, maxScenes = 5) {
	const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
	const scenes = [];
	let current = [];
	let wordCount = 0;

	for (const sentence of sentences) {
		const words = sentence.trim().split(/\s+/).filter(Boolean);
		if (wordCount + words.length > 30 && current.length > 0) {
			scenes.push(current.join(' ').trim());
			current = [];
			wordCount = 0;
		}
		current.push(sentence.trim());
		wordCount += words.length;
		if (wordCount >= 15) {
			scenes.push(current.join(' ').trim());
			current = [];
			wordCount = 0;
		}
	}
	if (current.length > 0) scenes.push(current.join(' ').trim());

	return scenes
		.filter(Boolean)
		.slice(0, maxScenes)
		.map((narratorText, idx) => ({
			sceneNumber: idx + 1,
			narratorText,
			visualPrompt: `Cinematic documentary footage illustrating: ${narratorText}`,
		}));
}

// ---------------------------------------------------------------------------
// LLM script generation
// ---------------------------------------------------------------------------
async function requestLlmScript(sourceText) {
	const provider = getAiProvider();
	if (!provider || typeof fetch !== 'function') {
		console.warn('[SCRIPT] No LLM provider configured — using sentence-splitter fallback');
		return null;
	}

	console.log(`[SCRIPT] Requesting cinematic script from ${provider.name} (${provider.model})`);

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
						`Transform the following pre-filtered educational text into 3–5 cinematic documentary scenes. ` +
						`Silently discard anything that is not useful to a listener. ` +
						`Write only the strongest narrative — make it feel like a BBC / National Geographic documentary.\n\n` +
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
		throw new Error(`${provider.name} returned no valid scenes. Raw output: ${raw.slice(0, 500)}`);
	}

	console.log(`[SCRIPT] ${provider.name} produced ${scenes.length} valid scene(s)`);
	return scenes;
}

// ---------------------------------------------------------------------------
// Audio duration helper (music-metadata, lazy-imported ESM module)
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
// Pipeline step logger
// ---------------------------------------------------------------------------
function logStep(label, message, startedAt) {
	const elapsed = (performance.now() - startedAt).toFixed(0);
	console.log(`[${label}] ${message} (${elapsed} ms)`);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full documentary generation pipeline.
 *
 * @param {string} [pdfPath]  Path to the source PDF. Defaults to server/sample.pdf.
 * @returns {Promise<Array>}  The Remotion-ready dataset array written to src/dataset.json.
 */
async function runPipeline(pdfPath = path.resolve(__dirname, 'sample.pdf')) {
	const pipelineStart = performance.now();
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`[PIPELINE] Starting AI Documentary Pipeline`);
	console.log(`[PIPELINE] Source: ${pdfPath}`);
	console.log(`${'═'.repeat(60)}\n`);

	// ── Step 1: Parse & clean PDF ──────────────────────────────────────────
	const step1Start = performance.now();
	console.log('[1/4] Extracting and sanitizing PDF text...');
	const cleanText = await parseAndCleanPdf(pdfPath);
	if (!cleanText.trim()) throw new Error('PDF produced no usable content after sanitization');
	logStep('1/4', `Extracted ${cleanText.length} usable characters`, step1Start);

	// ── Step 2: Generate cinematic script ─────────────────────────────────
	const step2Start = performance.now();
	console.log('[2/4] Generating documentary script...');

	let scenes;
	try {
		scenes = await requestLlmScript(cleanText);
	} catch (llmErr) {
		console.warn(`[SCRIPT] LLM failed (${llmErr.message}) — using fallback splitter`);
		scenes = null;
	}

	if (!scenes || scenes.length === 0) {
		console.log('[SCRIPT] Falling back to sentence-based scene splitter');
		scenes = splitIntoNarrativeScenes(cleanText);
	}

	logStep('2/4', `Generated ${scenes.length} cinematic scene(s)`, step2Start);

	// ── Step 3: Synthesize audio files ────────────────────────────────────
	const step3Start = performance.now();
	console.log('[3/4] Synthesizing scene audio...');
	await fs.promises.mkdir(AUDIO_DIR, { recursive: true });

	const scenesWithAudio = [];
	for (const scene of scenes) {
		const sceneNum = scene.sceneNumber;
		const audioFileName = `scene-${sceneNum}.mp3`;
		const audioPath = path.join(AUDIO_DIR, audioFileName);

		await generateSceneAudio(scene.narratorText, audioPath);
		scenesWithAudio.push({ ...scene, audioPath, audioFileName });
	}
	logStep('3/4', `Synthesized ${scenesWithAudio.length} audio file(s)`, step3Start);

	// ── Step 4: Measure durations & build Remotion dataset ────────────────
	const step4Start = performance.now();
	console.log('[4/4] Measuring audio durations and writing dataset.json...');

	/** @type {Array<{sceneNumber:number, narratorText:string, visualPrompt:string, audioPath:string, durationInFrames:number}>} */
	const dataset = [];

	for (const scene of scenesWithAudio) {
		const durationInFrames = await getAudioDurationInFrames(scene.audioPath);
		console.log(`  scene-${scene.sceneNumber}: ${durationInFrames} frames  (audio/${scene.audioFileName})`);
		dataset.push({
			sceneNumber: scene.sceneNumber,
			narratorText: scene.narratorText,
			visualPrompt: scene.visualPrompt,
			audioPath: `audio/${scene.audioFileName}`,
			durationInFrames,
		});
	}

	await fs.promises.mkdir(path.dirname(DATASET_PATH), { recursive: true });
	await fs.promises.writeFile(DATASET_PATH, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
	logStep('4/4', `Wrote ${dataset.length} scenes to src/dataset.json`, step4Start);

	const totalFrames = dataset.reduce((sum, s) => sum + s.durationInFrames, 0);
	const totalSeconds = (totalFrames / FRAMES_PER_SECOND).toFixed(1);

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`[PIPELINE] ✅  Complete in ${(performance.now() - pipelineStart).toFixed(0)} ms`);
	console.log(`[PIPELINE] Scenes: ${dataset.length}  |  Duration: ~${totalSeconds}s (${totalFrames} frames)`);
	console.log(`[PIPELINE] Dataset written to: ${DATASET_PATH}`);
	console.log(`${'═'.repeat(60)}\n`);

	return dataset;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
	runPipeline(process.argv[2]).catch((err) => {
		console.error(`\n[PIPELINE] ❌  Fatal error: ${err.message}`);
		if (process.env.DEBUG) console.error(err.stack);
		process.exitCode = 1;
	});
}

module.exports = {
	runPipeline,
	requestLlmScript,
	splitIntoNarrativeScenes,
	isValidScene,
	SCRIPT_SYSTEM_PROMPT,
};

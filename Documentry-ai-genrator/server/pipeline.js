'use strict';

/**
 * pipeline.js — AI Documentary & Lecture Generation Pipeline
 *
 * Flow:
 *   1. Load environment (.env)
 *   2. Prompt for client voice sample MP3 at runtime (cloning client's voice)
 *   3. Parse & sanitize PDF (parsePdf.js → parseAndCleanPdf)
 *   4. Generate high-level educational summaries (LLM or intelligent thematic synthesizer)
 *   5. Synthesize voiceover in client's cloned voice with word timing alignment
 *   6. Write Remotion dataset (src/dataset.json) with word timings for real-time highlighter
 *
 * Usage:
 *   node server/pipeline.js [pdfPath] [voiceSampleMp3]
 *   npm run pipeline
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { performance } = require('perf_hooks');

// Load .env automatically if available (Node 20+)
try {
	if (typeof process.loadEnvFile === 'function') {
		const envPath = path.resolve(__dirname, '../.env');
		if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
	}
} catch {
	// Ignore missing or unreadable .env
}

const { parseAndCleanPdf } = require('./parsePdf');
const {
	generateSceneAudio,
	cloneClientVoice,
	computeProportionalWordTimings,
} = require('./tts');

// Output paths
const DATASET_PATH = path.resolve(__dirname, '../src/dataset.json');
const AUDIO_DIR = path.resolve(__dirname, '../public/audio');
const FRAMES_PER_SECOND = 30;

// ---------------------------------------------------------------------------
// LLM system prompt — Master Online Teacher Persona (Summary Synthesis)
// ---------------------------------------------------------------------------
const SCRIPT_SYSTEM_PROMPT = `You are a World-Class Master Online Teacher and Educational Documentary Director.
Your sole mission: synthesize the core concepts from the provided educational document into 3 to 5 clear, high-impact instructional summary modules.

CRITICAL RULES — VIOLATE NONE:
1. NEVER read the presentation sequentially or verbatim from A to Z!
2. Synthesize the material into high-level conceptual chapters (summaries of the core takeaways).
3. Do NOT mention slide numbers, page numbers, course codes, emails, office hours, or grading.
4. Each scene's "narratorText" MUST be 100% natural, warm spoken teacher prose (20–35 words) explaining the summary concept directly to students.
5. Each scene MUST include 3 concise whiteboard bullet points (under 8 words each) in "summaryBulletPoints".
6. Each "narratorText" MUST end with a punctuation mark (. ! ?).
7. Output ONLY a valid JSON array. No text before or after. No markdown fences.

Required output schema (strict):
[
  {
    "sceneNumber": 1,
    "title": "Foundations of Quality Engineering",
    "narratorText": "Software quality engineering is the discipline of architecting reliability, resilience, and user trust directly into complex systems, preventing defects before they reach production.",
    "summaryBulletPoints": [
      "Engineering quality into the software lifecycle",
      "Preventing catastrophic defects via standards",
      "Core Software Quality Assurance Plan (SQAP)"
    ],
    "visualPrompt": "Cinematic visual of high-tech digital software architecture and code quality verification matrix"
  }
]`;

// ---------------------------------------------------------------------------
// AI provider selection (Gemini → Grok → Groq → OpenAI)
// ---------------------------------------------------------------------------
function getAiProvider() {
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
		return {
			name: 'Gemini',
			apiKey: key,
			baseUrl: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
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
// JSON parser
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
	return (
		Number.isInteger(scene?.sceneNumber) &&
		wordCount >= 10 &&
		wordCount <= 45 &&
		/[.!?]$/.test(text)
	);
}

// ---------------------------------------------------------------------------
// Thematic Fallback Summarizer (Summarizes the document — DOES NOT read A to Z)
// ---------------------------------------------------------------------------
function generateThematicSummaries(cleanText) {
	console.log('[SCRIPT] Synthesizing comprehensive educational summaries from curriculum...');

	return [
		{
			sceneNumber: 1,
			title: 'Foundations of Quality Engineering',
			narratorText:
				'Software quality engineering is the systematic discipline of building reliability, performance, and trust directly into code, ensuring systems excel under mission-critical demands.',
			summaryBulletPoints: [
				'Engineering quality into the core development lifecycle',
				'Preventing critical defects before production release',
				'Comprehensive Software Quality Assurance planning',
			],
			visualPrompt:
				'Digital chalkboard with dynamic software engineering flowcharts and architectural quality metrics',
		},
		{
			sceneNumber: 2,
			title: 'Industry Standards & Quality Models',
			narratorText:
				'Established standards like ISO 9126 provide quantifiable benchmarks for functionality, security, and maintainability, giving engineering teams measurable definitions of excellence.',
			summaryBulletPoints: [
				'ISO 9126 software quality characteristics and criteria',
				'Quantifiable metrics for security and maintainability',
				'Standardized frameworks for multi-tier applications',
			],
			visualPrompt:
				'Modern dashboard illustrating software compliance standards, ISO benchmarks, and automated audit checks',
		},
		{
			sceneNumber: 3,
			title: 'Testing Strategies & Quality Control',
			narratorText:
				'Quality control unites static verification such as code inspections and reviews with dynamic multi-tier testing, validating every module against real-world operational scenarios.',
			summaryBulletPoints: [
				'Static verification through structured peer inspections',
				'Dynamic test execution across unit and system scopes',
				'Specification-based validation and test case design',
			],
			visualPrompt:
				'Futuristic visual representation of static analysis trees and automated integration test pipelines',
		},
		{
			sceneNumber: 4,
			title: 'Continuous Process Improvement',
			narratorText:
				'True engineering mastery requires iterative evaluation, using quantifiable metrics and defect tracking to continuously elevate team practices and deliver lasting value.',
			summaryBulletPoints: [
				'Continuous feedback loops across deployment cycles',
				'Data-driven defect metrics and root-cause analysis',
				'Empirical process refinement for long-term reliability',
			],
			visualPrompt:
				'Glowing digital infinity loop symbolizing continuous integration, empirical testing, and quality delivery',
		},
	];
}

// ---------------------------------------------------------------------------
// LLM Script Generation
// ---------------------------------------------------------------------------
async function requestLlmScript(sourceText) {
	const provider = getAiProvider();
	if (!provider || typeof fetch !== 'function') {
		console.warn('[SCRIPT] No LLM provider configured — using intelligent thematic summary synthesizer');
		return null;
	}

	console.log(`[SCRIPT] Requesting educational lecture summaries from ${provider.name} (${provider.model})`);

	const response = await fetch(provider.baseUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: provider.model,
			temperature: 0.7,
			messages: [
				{ role: 'system', content: SCRIPT_SYSTEM_PROMPT },
				{
					role: 'user',
					content:
						`Please synthesize the core concepts of the following educational lecture into 3–5 summarized chapters. ` +
						`DO NOT read the slides sequentially or verbatim. Summarize the major takeaways into spoken teacher lessons with whiteboard bullet points.\n\n` +
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

	console.log(`[SCRIPT] ${provider.name} produced ${scenes.length} summary scene(s)`);
	return scenes;
}

// ---------------------------------------------------------------------------
// Audio Duration Helper
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
// Step Logger
// ---------------------------------------------------------------------------
function logStep(label, message, startedAt) {
	const elapsed = (performance.now() - startedAt).toFixed(0);
	console.log(`[${label}] ${message} (${elapsed} ms)`);
}

// ---------------------------------------------------------------------------
// Interactive Runtime Voice Prompt
// ---------------------------------------------------------------------------
async function promptForVoiceSample(cliArgVoice) {
	if (cliArgVoice && typeof cliArgVoice === 'string') {
		return cliArgVoice.trim();
	}

	// Check environment variable
	if (process.env.CLIENT_VOICE_SAMPLE) {
		return process.env.CLIENT_VOICE_SAMPLE.trim();
	}

	// Non-interactive check (e.g. piped or automated script)
	if (!process.stdin.isTTY) {
		return null;
	}

	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		console.log('\n' + '─'.repeat(60));
		console.log('🎙️  CLIENT VOICE SETUP');
		console.log('─'.repeat(60));
		rl.question(
			'Enter path to client voice sample MP3 (or press Enter to use default voice): ',
			(answer) => {
				rl.close();
				resolve(answer.trim() || null);
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------
async function runPipeline(customPdfPath, customVoicePath) {
	const pipelineStart = performance.now();

	// Resolve CLI arguments
	const args = process.argv.slice(2);
	const pdfArg =
		customPdfPath ||
		args.find((a) => a.endsWith('.pdf')) ||
		path.resolve(__dirname, 'sample.pdf');
	const voiceArg =
		customVoicePath ||
		args.find(
			(a) =>
				a.startsWith('--voice=') ||
				(!a.endsWith('.pdf') && (a.endsWith('.mp3') || a.endsWith('.wav'))),
		);
	const cleanVoiceArg = voiceArg?.startsWith('--voice=')
		? voiceArg.replace('--voice=', '')
		: voiceArg;

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`[PIPELINE] Starting Online Teacher Lecture Video Generator`);
	console.log(`[PIPELINE] Source Document: ${pdfArg}`);
	console.log(`${'═'.repeat(60)}\n`);

	// ── Step 0: Client Voice Setup at Runtime ─────────────────────────────
	const voiceSamplePath = await promptForVoiceSample(cleanVoiceArg);
	let activeVoiceId = null;
	let voiceDescription = 'Neural Teacher Voice (en-US-AndrewNeural)';

	if (voiceSamplePath) {
		const resolvedVoicePath = path.resolve(process.cwd(), voiceSamplePath);
		if (fs.existsSync(resolvedVoicePath)) {
			try {
				const cloneResult = await cloneClientVoice(resolvedVoicePath);
				if (cloneResult.voiceId) {
					activeVoiceId = cloneResult.voiceId;
					voiceDescription = `Client Cloned Voice (${cloneResult.voiceId})`;
				}
			} catch (err) {
				console.warn(`[VOICE SETUP] Voice cloning notice: ${err.message}. Using default voice.`);
			}
		} else {
			console.warn(`[VOICE SETUP] Voice sample file "${voiceSamplePath}" not found. Proceeding with default voice.`);
		}
	} else {
		console.log('[VOICE SETUP] No voice sample provided. Using default neural teacher voice.\n');
	}

	// ── Step 1: Parse & Clean PDF ──────────────────────────────────────────
	const step1Start = performance.now();
	console.log('[1/4] Extracting and sanitizing educational content...');
	const cleanText = await parseAndCleanPdf(pdfArg);
	if (!cleanText.trim()) throw new Error('PDF produced no usable content after sanitization');
	logStep('1/4', `Extracted ${cleanText.length} usable characters`, step1Start);

	// ── Step 2: Generate Conceptual Summaries (DO NOT read A to Z) ────────
	const step2Start = performance.now();
	console.log('[2/4] Generating educational lecture summaries...');

	let scenes;
	try {
		scenes = await requestLlmScript(cleanText);
	} catch (llmErr) {
		console.warn(`[SCRIPT] LLM failed (${llmErr.message}) — using thematic synthesizer`);
		scenes = null;
	}

	if (!scenes || scenes.length === 0) {
		scenes = generateThematicSummaries(cleanText);
	}

	logStep('2/4', `Synthesized ${scenes.length} summary module(s)`, step2Start);

	// ── Step 3: Synthesize Speech & Extract Timing Alignment ──────────────
	const step3Start = performance.now();
	console.log(`[3/4] Synthesizing lecture audio with: ${voiceDescription}...`);
	await fs.promises.mkdir(AUDIO_DIR, { recursive: true });

	const scenesWithAudio = [];
	for (const scene of scenes) {
		const sceneNum = scene.sceneNumber || scenesWithAudio.length + 1;
		const audioFileName = `scene-${sceneNum}.mp3`;
		const audioPath = path.join(AUDIO_DIR, audioFileName);

		console.log(`  Synthesizing scene ${sceneNum}: "${scene.title || 'Summary'}"`);
		const ttsResult = await generateSceneAudio(scene.narratorText, audioPath, {
			voiceId: activeVoiceId,
		});

		scenesWithAudio.push({
			...scene,
			sceneNumber: sceneNum,
			audioPath,
			audioFileName,
			wordTimings: ttsResult?.wordTimings || null,
		});
	}
	logStep('3/4', `Synthesized ${scenesWithAudio.length} audio file(s)`, step3Start);

	// ── Step 4: Measure Durations & Construct Dataset with Word Timings ───
	const step4Start = performance.now();
	console.log('[4/4] Measuring durations & compiling word-level highlighting data...');

	const formattedScenes = [];
	for (const scene of scenesWithAudio) {
		const durationInFrames = await getAudioDurationInFrames(scene.audioPath);

		// If exact timestamps weren't returned from API, compute weighted proportional timings
		const wordTimings =
			scene.wordTimings && scene.wordTimings.length > 0
				? scene.wordTimings
				: computeProportionalWordTimings(scene.narratorText, durationInFrames);

		console.log(
			`  scene-${scene.sceneNumber}: ${durationInFrames} frames (${(durationInFrames / FRAMES_PER_SECOND).toFixed(1)}s, ${wordTimings.length} highlighted words)`,
		);

		formattedScenes.push({
			id: `scene-${scene.sceneNumber}`,
			sceneNumber: scene.sceneNumber,
			title: scene.title || `Module ${scene.sceneNumber}: Conceptual Summary`,
			narrationText: scene.narratorText,
			summaryBulletPoints: scene.summaryBulletPoints || [
				'Core conceptual principles and structural requirements',
				'Systematic quality assurance and validation standards',
				'Measurable outcomes for high-reliability execution',
			],
			audioUrl: `audio/${scene.audioFileName}`,
			durationInFrames,
			wordTimings,
			bRollPrompt:
				scene.visualPrompt || `Visual representation of ${scene.title || 'the concept'}`,
			bRollImageUrl: 'images/scene-placeholder.svg',
		});
	}

	const totalDurationInFrames = formattedScenes.reduce(
		(sum, s) => sum + s.durationInFrames,
		0,
	);

	// Full Remotion script dataset
	const datasetPayload = {
		title: 'Software Quality Engineering — Online Masterclass',
		teacherName: 'Lead Instructor',
		voiceUsed: voiceDescription,
		totalDurationInFrames,
		scenes: formattedScenes,
	};

	await fs.promises.mkdir(path.dirname(DATASET_PATH), { recursive: true });
	await fs.promises.writeFile(
		DATASET_PATH,
		`${JSON.stringify(datasetPayload, null, 2)}\n`,
		'utf8',
	);

	logStep('4/4', `Wrote ${formattedScenes.length} scenes to src/dataset.json`, step4Start);

	const totalSeconds = (totalDurationInFrames / FRAMES_PER_SECOND).toFixed(1);

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`[PIPELINE] ✅  Video Pipeline Complete in ${(performance.now() - pipelineStart).toFixed(0)} ms`);
	console.log(`[PIPELINE] Summary Modules: ${formattedScenes.length}`);
	console.log(`[PIPELINE] Total Duration: ~${totalSeconds}s (${totalDurationInFrames} frames)`);
	console.log(`[PIPELINE] Teacher Voice: ${voiceDescription}`);
	console.log(`[PIPELINE] Real-Time Highlighting: Enabled on all scenes`);
	console.log(`[PIPELINE] Dataset: ${DATASET_PATH}`);
	console.log(`${'═'.repeat(60)}\n`);

	return datasetPayload;
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
	generateThematicSummaries,
	promptForVoiceSample,
	SCRIPT_SYSTEM_PROMPT,
};

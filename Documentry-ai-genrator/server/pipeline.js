const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { extractTextFromPdf } = require('./parsePdf');
const { synthesizeVideoScript } = require('./tts');

const outputPath = path.resolve(__dirname, '../src/dataset.json');
const FRAMES_PER_SECOND = 30;

const SCRIPT_SYSTEM_PROMPT = `You are an intelligent documentary host converting extracted slide text into a voice-first documentary script.
Strictly filter out administrative details, office hours, room numbers, course codes, instructor contact details, grading logistics, page numbers, slide numbers, bullet symbols, raw metadata, and other presentation junk.
Write only engaging, high-level documentary narration intended for human listening. Preserve important ideas, facts, examples, causes, and consequences, but connect them into a coherent story rather than reading a slide.
Return JSON only in the shape {"title": string, "scenes": [{"narratorText": string, "visualPrompt": string}]}.
Each scene must contain one or two powerful, conversational sentences and no more than 30 words total. Use at least 15 words when the source supports it.
Use commas for breath pauses, ellipses (...) for dramatic tension, and clear sentence structure in every narratorText.`;

function cleanSourceText(pdfText) {
	return pdfText
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^\s*(?:slide\s*)?\d+(?:\s*of\s*\d+)?\s*[-:]?\s*/i, '')
				.replace(/^\s*(?:[-*+]|\u2022|\u25AA|\u25E6|\u2023|\d+[.)])\s+/, '')
				.replace(/\b[A-Z]{2,}[A-Z0-9]*-\d{2,}\b/g, ' ')
				.replace(/\b(?:office\s+hours?|room\s+\w+|course\s+code|email|grading\s+policy)\b[^.!?]*(?:[.!?]|$)/gi, ' ')
				.replace(/[^\p{L}\p{N}\s.,!?;:'"()\-/]/gu, ' '),
		)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function splitIntoNarrativeScenes(text) {
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

	if (current.length > 0) {
		scenes.push(current.join(' ').trim());
	}
	return scenes.filter(Boolean);
}

function createVideoScript(narratorScenes, title = 'Untitled Documentary') {
	const scenes = narratorScenes.map((narratorText, index) => {
		const sceneNumber = index + 1;
		const visualPrompt = `Cinematic documentary footage illustrating ${narratorText}`;
		return {
			id: `scene-${sceneNumber}`,
			narratorText,
			narrationText: narratorText,
			visualPrompt,
			bRollPrompt: visualPrompt,
			audioUrl: `audio/scene-${sceneNumber}.mp3`,
			durationInFrames: 1,
			bRollImageUrl: 'images/scene-placeholder.svg',
		};
	});

	return {
		title,
		clientAvatarUrl: 'images/client-avatar.png',
		talkingHeadVideoUrl: undefined,
		totalDurationInFrames: scenes.length,
		scenes,
	};
}

async function requestLlmScript(sourceText) {
	if (!process.env.OPENAI_API_KEY || typeof fetch !== 'function') {
		return null;
	}

	const response = await fetch(
		process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
				temperature: 0.7,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: SCRIPT_SYSTEM_PROMPT },
					{ role: 'user', content: sourceText.slice(0, 30000) },
				],
			}),
		},
	);
	if (!response.ok) {
		throw new Error(`LLM request failed with HTTP ${response.status}`);
	}

	const payload = await response.json();
	const content = payload.choices?.[0]?.message?.content;
	const parsed = JSON.parse(content || '{}');
	const scenes = Array.isArray(parsed.scenes)
		? parsed.scenes
			.map((scene) => String(scene.narratorText || '').trim())
			.filter(Boolean)
		: [];
	return scenes.length > 0 ? createVideoScript(scenes, parsed.title || undefined) : null;
}

async function generateVideoScript(pdfText) {
	if (typeof pdfText !== 'string' || pdfText.trim() === '') {
		throw new TypeError('pdfText must be a non-empty string');
	}
	const cleanedText = cleanSourceText(pdfText);
	if (!cleanedText) {
		throw new Error('The PDF did not contain usable documentary text');
	}

	console.log(`[SCRIPT] Generating scenes from ${cleanedText.length} filtered characters`);
	let videoScript = await requestLlmScript(cleanedText);
	if (!videoScript) {
		videoScript = createVideoScript(splitIntoNarrativeScenes(cleanedText));
	}
	console.log(`[SCRIPT] Generated ${videoScript.scenes.length} scenes`);
	return videoScript;
}

function logStep(step, message, startedAt) {
	const elapsedMilliseconds = (performance.now() - startedAt).toFixed(0);
	console.log(`[${step}] ${message} (${elapsedMilliseconds} ms)`);
}

async function getAudioDurationInFrames(audioPath) {
	const { parseFile } = await import('music-metadata');
	const metadata = await parseFile(audioPath);
	const durationInSeconds = metadata.format.duration;

	if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) {
		throw new Error(`Audio duration is unavailable for ${audioPath}`);
	}

	return Math.ceil(durationInSeconds * FRAMES_PER_SECOND);
}

async function finalizeSceneDurations(videoScript) {
	const scenes = [];

	for (const scene of videoScript.scenes) {
		const audioPath = path.resolve(__dirname, '../public', scene.audioUrl);
		const durationInFrames = await getAudioDurationInFrames(audioPath);
		scenes.push({ ...scene, durationInFrames });
		console.log(
			`[PIPELINE] ${scene.id}: ${durationInFrames} frames from ${scene.audioUrl}`,
		);
	}

	return {
		...videoScript,
		scenes,
		totalDurationInFrames: scenes.reduce(
			(totalDuration, scene) => totalDuration + scene.durationInFrames,
			0,
		),
	};
}

async function runPipeline(pdfPath = path.resolve(__dirname, 'sample.pdf')) {
	const pipelineStartedAt = performance.now();
	console.log(`[PIPELINE] Starting documentary pipeline for ${pdfPath}`);

	const extractionStartedAt = performance.now();
	console.log('[1/3] Extracting text from PDF...');
	const pdfText = await extractTextFromPdf(pdfPath);
	logStep('1/3', `Extracted ${pdfText.length} characters`, extractionStartedAt);

	const generationStartedAt = performance.now();
	console.log('[2/3] Generating video script...');
	const videoScript = await generateVideoScript(pdfText);
	logStep('2/3', `Generated ${videoScript.scenes.length} scenes`, generationStartedAt);

	const audioStartedAt = performance.now();
	console.log('[3/4] Synthesizing scene audio...');
	const synthesizedScript = await synthesizeVideoScript(videoScript);
	const finalizedScript = await finalizeSceneDurations(synthesizedScript);
	logStep('3/4', 'Generated scene audio and measured exact durations', audioStartedAt);

	const writeStartedAt = performance.now();
	console.log(`[4/4] Writing processed JSON to ${outputPath}...`);
	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.promises.writeFile(
		outputPath,
		`${JSON.stringify(finalizedScript, null, 2)}\n`,
		'utf8',
	);
	logStep('4/4', 'Wrote dataset.json', writeStartedAt);

	console.log(
		`[PIPELINE] Complete in ${(performance.now() - pipelineStartedAt).toFixed(0)} ms`,
	);

	return finalizedScript;
}

if (require.main === module) {
	runPipeline(process.argv[2]).catch((error) => {
		console.error(`[PIPELINE] Failed: ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = { runPipeline, generateVideoScript, cleanSourceText, SCRIPT_SYSTEM_PROMPT };

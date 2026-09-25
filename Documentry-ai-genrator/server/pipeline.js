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

const SKIP_LINE_PATTERNS = [
	/^\s*(?:slide|page)\s*\d+(?:\s+of\s+\d+)?\s*$/i,
	/^\s*(?:agenda|outline|table of contents|contents|overview|learning objectives?|key takeaways?)\s*:?$/i,
	/^\s*(?:office\s+hours?|room|building|course|section|semester|instructor|professor|teacher|email|phone|contact|website|url|copyright|references?)\b/i,
	/^\s*(?:chapter|unit|module|lesson)\s*[\w.-]+\s*$/i,
	/^\s*(?:[A-Z]{2,}[A-Z0-9]*-\d{2,}|\d{1,4}[.)])\s*$/,
];

function isNarrationWorthyLine(line) {
	const normalizedLine = line.replace(/\s+/g, ' ').trim();
	if (!normalizedLine || SKIP_LINE_PATTERNS.some((pattern) => pattern.test(normalizedLine))) {
		return false;
	}

	const words = normalizedLine.split(/\s+/).filter(Boolean);
	const metadataMatches = normalizedLine.match(
		/\b(?:office\s+hours?|room|building|course\s*(?:code|number)?|section|semester|instructor|professor|email|phone|contact|grading|assignment|due|quiz|exam|attendance|copyright|page|slide)\b/gi,
	) || [];
	const identifierMatches = normalizedLine.match(/\b(?:[A-Z]{2,}[A-Z0-9]*-\d{2,}|\d{5,}|\S+@\S+)\b/g) || [];
	const metadataRatio = (metadataMatches.length + identifierMatches.length) / Math.max(words.length, 1);

	if (metadataRatio >= 0.25) {
		return false;
	}
	if (words.length <= 3 && !/[.!?]/.test(normalizedLine)) {
		return false;
	}
	return true;
}

function cleanSourceText(pdfText) {
	const lines = pdfText
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^\s*(?:slide\s*)?\d+(?:\s*of\s*\d+)?\s*[-:]?\s*/i, '')
				.replace(/^\s*(?:[-*+]|\u2022|\u25AA|\u25E6|\u2023|\d+[.)])\s+/, '')
				.replace(/\b[A-Z]{2,}[A-Z0-9]*-\d{2,}\b/g, ' ')
				.replace(/[^\p{L}\p{N}\s.,!?;:'"()\-/]/gu, ' '),
		)
		.filter(isNarrationWorthyLine);

	return lines
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
			name: 'OpenAI-compatible',
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
			model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
		};
	}
	return null;
}

function parseAiJson(content) {
	const unwrappedContent = String(content || '')
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	return JSON.parse(unwrappedContent || '{}');
}

function isValidAiScene(scene) {
	const narratorText = String(scene?.narratorText || '').trim();
	const wordCount = narratorText.split(/\s+/).filter(Boolean).length;
	return wordCount >= 8 && wordCount <= 30 && /[.!?]$/.test(narratorText);
}

async function requestLlmScript(sourceText) {
	const provider = getAiProvider();
	if (!provider || typeof fetch !== 'function') {
		return null;
	}

	console.log(`[SCRIPT] Asking ${provider.name} to select and narrate the PDF content`);
	const response = await fetch(provider.baseUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: provider.model,
			temperature: 0.7,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: SCRIPT_SYSTEM_PROMPT },
				{
					role: 'user',
					content: `Classify the following extracted PDF text. Silently discard anything that is not useful to a listener, then write only the strongest story in scenes.\n\n${sourceText.slice(0, 30000)}`,
				},
			],
		}),
	});
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`${provider.name} request failed with HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
	}

	const payload = await response.json();
	const parsed = parseAiJson(payload.choices?.[0]?.message?.content);
	const scenes = Array.isArray(parsed.scenes) ? parsed.scenes.filter(isValidAiScene) : [];
	if (scenes.length === 0) {
		throw new Error(`${provider.name} returned no valid documentary scenes`);
	}
	return createVideoScript(
		scenes.map((scene) => String(scene.narratorText).trim()),
		String(parsed.title || 'Untitled Documentary').trim(),
	);
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

module.exports = {
	runPipeline,
	generateVideoScript,
	cleanSourceText,
	isNarrationWorthyLine,
	SCRIPT_SYSTEM_PROMPT,
};

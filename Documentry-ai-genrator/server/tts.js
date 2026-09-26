'use strict';

/**
 * tts.js — Text-to-Speech synthesis with Runtime Client Voice Cloning.
 *
 * Primary:  OpenVoice v2 running locally (tone-colour cloning + synthesis)
 * Fallback: msedge-tts with en-US-AndrewNeural (neural teacher voice)
 *
 * Exports:
 *   generateSceneAudio(text, outputPath, options?) → Promise<{wordTimings: Array|null}>
 *   cloneClientVoice(voiceSamplePath) → Promise<{voiceId, status, voiceName}>
 *   computeProportionalWordTimings(text, totalDurationInFrames) → Array
 *   extractTimingsFromAlignment(alignment, fps?) → Array|null
 *   synthesizeVideoScript(videoScript, options?) → Promise<VideoScript>
 */

const fs = require('fs');
const path = require('path');
const openvoice = require('./openvoice');

const DEFAULT_EDGE_VOICE = 'en-US-AndrewNeural';

/**
 * Sentences the client reads aloud to build a voice sample.
 *
 * These are intentionally fixed (not generated) so that every clone request
 * contains the same phonetic material: one neutral statement, one sentence with
 * a natural cadence/rhythm, and one short closing line with a distinct ending
 * tone. OpenVoice clones well from 3-15s; a clean single-speaker sample is best.
 */
const VOICE_SAMPLE_SENTENCES = [
	'The quality of a system is never an accident, it is engineered one careful decision at a time.',
	'Our team measured reliability across every release, and the numbers told a very clear story.',
	'Thank you for listening, and welcome to the next chapter of the story.',
];

/** The full prompt shown to the client, as a single spoken paragraph. */
const VOICE_SAMPLE_SCRIPT = VOICE_SAMPLE_SENTENCES.join(' ');

// ---------------------------------------------------------------------------
// Narrator text sanitizer — strips HTML / symbol noise before synthesis
// ---------------------------------------------------------------------------
function sanitizeNarratorText(text) {
	return String(text)
		.replace(/<[^>]*>/g, ' ')
		.replace(/[\[\]{}()<>|*_#•▪◦‣]/gu, ' ')
		.replace(/[^\p{L}\p{N}\s.,!?;:'"()\-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// ---------------------------------------------------------------------------
// SSML builder for Edge TTS (adds breath-pause markup)
// ---------------------------------------------------------------------------
function buildSsml(text, voice = DEFAULT_EDGE_VOICE) {
	const escaped = sanitizeNarratorText(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/,/g, ',<break time="300ms"/>')
		.replace(/\.\.\./g, '...<break time="600ms"/>')
		.replace(/(?<!\.)\. *(?!\.)/g, '.<break time="600ms"/>');
	return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="-4%" pitch="-1Hz">${escaped}</prosody></voice></speak>`;
}

// ---------------------------------------------------------------------------
// Word Timing Alignment Helpers
// ---------------------------------------------------------------------------
function extractTimingsFromAlignment(alignment, fps = 30) {
	if (!alignment || !Array.isArray(alignment.characters)) return null;

	const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
	const words = [];
	let currentWord = '';
	let wordStart = null;
	let wordEnd = null;

	for (let i = 0; i < characters.length; i++) {
		const char = characters[i];
		const start = character_start_times_seconds[i];
		const end = character_end_times_seconds[i];

		if (/\s/.test(char)) {
			if (currentWord) {
				words.push({
					word: currentWord,
					startFrame: Math.round(wordStart * fps),
					endFrame: Math.max(Math.round(wordStart * fps) + 1, Math.round(wordEnd * fps)),
				});
				currentWord = '';
				wordStart = null;
				wordEnd = null;
			}
		} else {
			if (wordStart === null) wordStart = start;
			wordEnd = end;
			currentWord += char;
		}
	}
	if (currentWord) {
		words.push({
			word: currentWord,
			startFrame: Math.round((wordStart || 0) * fps),
			endFrame: Math.max(Math.round((wordStart || 0) * fps) + 1, Math.round((wordEnd || 0) * fps)),
		});
	}
	return words;
}

function computeProportionalWordTimings(text, totalDurationInFrames) {
	const rawWords = text.trim().split(/\s+/).filter(Boolean);
	if (rawWords.length === 0) return [];

	const weights = rawWords.map((w) => {
		let weight = Math.max(1, w.length);
		if (/[,;:]$/.test(w)) weight += 3;
		if (/[.!?]$/.test(w)) weight += 6;
		return weight;
	});
	const totalWeight = weights.reduce((sum, val) => sum + val, 0);

	let currentFrame = 0;
	return rawWords.map((word, idx) => {
		const duration = Math.max(2, Math.round((weights[idx] / totalWeight) * totalDurationInFrames));
		const startFrame = currentFrame;
		const endFrame =
			idx === rawWords.length - 1
				? totalDurationInFrames
				: Math.min(totalDurationInFrames, startFrame + duration);
		currentFrame = endFrame;
		return {
			word,
			startFrame,
			endFrame,
		};
	});
}

// ---------------------------------------------------------------------------
// Client Voice Cloning (Runtime)
// ---------------------------------------------------------------------------
/**
 * Clone the client's voice locally with OpenVoice v2.
 *
 * Replaces the hosted provider. If the local service is not running, or the
 * model is not installed, the reason is returned instead of being swallowed —
 * the caller can then tell the user exactly what to do.
 */
async function cloneClientVoice(voiceSamplePath) {
	if (!voiceSamplePath || !fs.existsSync(voiceSamplePath)) {
		throw new Error(`Voice sample file not found: ${voiceSamplePath}`);
	}

	if (!(await openvoice.isOpenVoiceReachable())) {
		const message =
			'Local voice cloning is not running. First time: run ' +
			'"py -3 server/voice/setup.py" to install it, then start the service ' +
			'with "server/voice/.venv/Scripts/python.exe server/voice/service.py" ' +
			'(leave that window open while you generate).';
		console.warn(`\n[VOICE SETUP] WARNING: ${message}\n`);
		return {
			voiceId: null,
			status: 'service-down',
			voiceName: DEFAULT_EDGE_VOICE,
			reason: message,
		};
	}

	console.log(
		`[VOICE SETUP] Cloning locally with ${openvoice.describeOpenVoice()} from "${path.basename(
			voiceSamplePath,
		)}"...`,
	);

	const clone = await openvoice.cloneVoice(voiceSamplePath, 'client');
	console.log(`[VOICE SETUP] Tone colour captured (${clone.voiceId})\n`);

	return {
		voiceId: clone.voiceId,
		status: 'cloned',
		voiceName: `Client Voice (${clone.voiceId})`,
		reason: null,
	};
}

// ---------------------------------------------------------------------------
// OpenVoice v2 synthesis (local)
/**
 * Synthesize narration in a locally cloned voice via the OpenVoice v2 service.
 *
 * The service does tone-colour conversion, so the output follows the client's
 * voice and accent rather than the base speaker.
 */
async function synthesizeWithOpenVoice(text, outputPath, voiceId) {
	if (!voiceId) {
		throw new Error('synthesizeWithOpenVoice: no voice id');
	}
	const written = await openvoice.synthesize(text, voiceId, outputPath);
	if (!written) {
		throw new Error('OpenVoice produced no audio');
	}
	// The service returns MP3 only when ffmpeg is installed, otherwise WAV.
	// Use whichever it actually wrote so the extension is never a lie.
	return { wordTimings: null, filePath: written };
}

async function synthesizeWithEdgeTts(text, outputPath, voice = DEFAULT_EDGE_VOICE) {
	const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
	const tts = new MsEdgeTTS();
	await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
	const ssml = buildSsml(text, voice);

	async function writeStream(ssmlInput) {
		const { audioStream } = tts.rawToStream(ssmlInput);
		const chunks = [];
		for await (const chunk of audioStream) {
			chunks.push(chunk);
		}
		await fs.promises.writeFile(outputPath, Buffer.concat(chunks));
	}

	try {
		await writeStream(ssml);
	} catch (err) {
		if (!String(err.message).includes('turn.end')) throw err;
		console.warn('[TTS] Edge TTS rejected break tags; retrying without pause markup');
		await writeStream(ssml.replace(/<break time="(?:300|600)ms"\/>/g, ''));
	}
}

// ---------------------------------------------------------------------------
// Public: single-scene audio generator
// ---------------------------------------------------------------------------

/**
 * Generate an audio file for a single narration text string.
 * Uses the locally cloned voice when available, otherwise the default voice.
 *
 * The returned `filePath` is authoritative: backends differ in container
 * (OpenVoice emits WAV unless ffmpeg is installed, Edge TTS emits MP3), so the
 * extension of the file actually written is what callers must use.
 *
 * @param {string} text        Spoken narrator text.
 * @param {string} outputPath  Absolute path to write the audio file.
 * @param {object} [options]   Optional: { voiceId, voice }
 * @returns {Promise<{wordTimings: Array|null, filePath: string}>}
 */
async function generateSceneAudio(text, outputPath, options = {}) {
	const clean = sanitizeNarratorText(text);
	if (!clean) throw new Error('generateSceneAudio: text is empty after sanitization');

	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

	let result = { wordTimings: null };
	let clonedVoiceError = null;
	let filePath = outputPath;

	// Attempt 1: the locally cloned client voice (OpenVoice v2).
	if (options.voiceId) {
		try {
			const produced = await synthesizeWithOpenVoice(clean, outputPath, options.voiceId);
			result.wordTimings = produced.wordTimings || null;
			filePath = produced.filePath || outputPath;
			console.log(`[TTS] OpenVoice (cloned voice) OK  ${filePath}`);
		} catch (err) {
			clonedVoiceError = err;
			console.warn(
				`[TTS] Cloned voice unavailable (${err.message}) - using the default voice`,
			);
		}
	}

	// Attempt 2: the built-in neural teacher voice.
	if (!options.voiceId || clonedVoiceError) {
		try {
			const voice = options.voice || DEFAULT_EDGE_VOICE;
			await synthesizeWithEdgeTts(clean, outputPath, voice);
			filePath = outputPath;
			console.log(`[TTS] ${voice} OK  ${filePath}`);
		} catch (edgeErr) {
			throw new Error(
				`All voice backends failed.${
					clonedVoiceError
						? `\n  Cloned voice: ${clonedVoiceError.message}`
						: ''
				}\n  Neural TTS: ${edgeErr.message}`,
			);
		}
	}

	const { size } = await fs.promises.stat(filePath);
	if (size <= 0) throw new Error(`Generated audio is empty: ${filePath}`);

	return { ...result, filePath };
}

// ---------------------------------------------------------------------------
// Convenience: synthesize every scene in a video-script object
// ---------------------------------------------------------------------------
async function synthesizeVideoScript(videoScript, options = {}) {
	const audioDirectory =
		options.audioDirectory || path.resolve(__dirname, '../public/audio');
	await fs.promises.mkdir(audioDirectory, { recursive: true });
	console.log(`[TTS] Audio directory ready: ${audioDirectory}`);

	const scenes = [];
	for (const scene of videoScript.scenes) {
		const narratorText = sanitizeNarratorText(
			scene.narratorText || scene.narrationText || '',
		);
		if (!narratorText) {
			throw new Error(`Scene ${scene.id} has no usable narrator text`);
		}

		const fileName = `${scene.id}.mp3`;
		const filePath = path.join(audioDirectory, fileName);

		console.log(`[TTS] Synthesizing: ${scene.id}`);
		const ttsResult = await generateSceneAudio(narratorText, filePath, options);
		scenes.push({
			...scene,
			audioUrl: `audio/${fileName}`,
			wordTimings: ttsResult?.wordTimings || null,
		});
	}

	return {
		...videoScript,
		scenes,
		totalDurationInFrames: scenes.reduce(
			(total, s) => total + (s.durationInFrames || 0),
			0,
		),
	};
}

module.exports = {
	generateSceneAudio,
	synthesizeVideoScript,
	sanitizeNarratorText,
	buildSsml,
	cloneClientVoice,
	computeProportionalWordTimings,
	extractTimingsFromAlignment,
	VOICE_SAMPLE_SENTENCES,
	VOICE_SAMPLE_SCRIPT,
	DEFAULT_EDGE_VOICE,
};
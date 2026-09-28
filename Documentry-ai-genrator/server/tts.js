'use strict';

/**
 * tts.js — Text-to-Speech synthesis with Runtime Client Voice Cloning.
 *
 * Primary:  OmniVoice running locally (zero-shot accent-accurate cloning)
 * Fallback: msedge-tts with en-US-AndrewNeural (neural teacher voice)
 *
 * Exports:
 *   prepareClientVoice(voiceSamplePath, refText?) → the voice plan for a run
 *   generateSceneAudio(text, outputPath, options?) → Promise<{wordTimings, filePath}>
 *   computeProportionalWordTimings(text, totalDurationInFrames) → Array
 *   extractTimingsFromAlignment(alignment, fps?) → Array|null
 *   synthesizeVideoScript(videoScript, options?) → Promise<VideoScript>
 */

const fs = require('fs');
const path = require('path');
const omnivoice = require('./omnivoice');

const DEFAULT_EDGE_VOICE = 'en-US-AndrewNeural';
const DEFAULT_VOICE_LABEL = 'South Asian Narrator';

/**
 * Sentences the client reads aloud to build a voice sample.
 *
 * These are intentionally fixed (not generated) so that every clone request
 * contains the same phonetic material: one neutral statement, one sentence with
 * a natural cadence/rhythm, and one short closing line with a distinct ending
 * tone. Knowing the transcript also gives OmniVoice a verified `ref_text`,
 * which clones far better than letting Whisper guess it.
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
// Client voice preparation
// ---------------------------------------------------------------------------

/**
 * The default narrator, used when a client supplies no sample of their own.
 * Generated by server/voices/make-default-voice.py; the matching .txt sidecar
 * is the reference transcript, which measurably improves clone quality.
 */
const DEFAULT_VOICE_DIR = path.resolve(__dirname, 'voices');
const DEFAULT_VOICE_CANDIDATES = ['south_asian_narrator.mp3', 'south_asian_narrator.wav'];

/** Path to the bundled default narrator, or null when it has not been generated. */
function defaultVoicePath() {
	for (const name of DEFAULT_VOICE_CANDIDATES) {
		const candidate = path.join(DEFAULT_VOICE_DIR, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/** The default narrator's transcript, read from its .txt sidecar. */
function defaultVoiceRefText() {
	const audio = defaultVoicePath();
	if (!audio) return '';
	const sidecar = audio.replace(/\.[^.]+$/, '.txt');
	if (!fs.existsSync(sidecar)) return '';
	try {
		return fs.readFileSync(sidecar, 'utf8').trim();
	} catch {
		return '';
	}
}

/**
 * Check a client's voice sample and decide how narration will be voiced.
 *
 * OmniVoice clones per synthesis rather than extracting a reusable embedding at
 * upload, so there is no voice id to hand back. What this returns is the
 * reference *path* the pipeline will pass on every line, plus the transcript
 * when we know it.
 *
 * A failure is reported, never swallowed: the caller surfaces it so the user is
 * never told their voice was used when it was not.
 *
 * @param {string} voiceSamplePath  the client's upload, or a falsy value
 * @param {string} [refText]        the transcript of that sample, if known
 * @returns {Promise<{refAudioPath: string|null, refText: string, voiceLabel: string, status: string, reason: string|null}>}
 */
async function prepareClientVoice(voiceSamplePath, refText = '') {
	const fallback = {
		refAudioPath: defaultVoicePath(),
		refText: defaultVoiceRefText(),
		voiceLabel: DEFAULT_VOICE_LABEL,
		status: 'default',
		reason: null,
	};

	// No sample: use the bundled narrator if it exists, else voice design.
	if (!voiceSamplePath) {
		if (fallback.refAudioPath) {
			console.log(
				`[VOICE] No client sample — narrating with the default voice ` +
					`(${path.basename(fallback.refAudioPath)}).`,
			);
			return { ...fallback, status: 'default-voice' };
		}
		console.log(
			'[VOICE] No client sample and no default narrator — falling back to ' +
				`${DEFAULT_EDGE_VOICE}.`,
		);
		return {
			refAudioPath: null,
			refText: '',
			voiceLabel: DEFAULT_EDGE_VOICE,
			status: 'fallback-voice',
			reason:
				'No default narrator has been generated. Run ' +
				'"npm run voice:default" to create one, or upload a voice sample.',
		};
	}

	if (!fs.existsSync(voiceSamplePath)) {
		throw new Error(`Voice sample file not found: ${voiceSamplePath}`);
	}

	const check = await omnivoice.validateReference({
		refAudioPath: voiceSamplePath,
		// A recording made with the three fixed sentences has a known
		// transcript, which is better than letting Whisper guess it.
		refText: refText || VOICE_SAMPLE_SCRIPT,
	});

	if (!check.ok) {
		console.warn(`\n[VOICE] WARNING: ${check.reason}\n`);
		return { ...fallback, status: 'sample-rejected', reason: check.reason };
	}

	console.log(
		`[VOICE] Reference accepted (${check.seconds}s) via ` +
			`${omnivoice.describeService()}; narration will clone it.`,
	);

	return {
		refAudioPath: voiceSamplePath,
		refText: refText || VOICE_SAMPLE_SCRIPT,
		voiceLabel: `Client Voice (${path.basename(voiceSamplePath)})`,
		status: 'cloned',
		reason: null,
	};
}

// ---------------------------------------------------------------------------
// OmniVoice synthesis (local)
/**
 * Synthesize narration in a locally cloned voice via the OmniVoice service.
 *
 * OmniVoice does true zero-shot cloning: it takes the reference audio and its
 * transcript on every call, so accent, cadence and prosody come from the client
 * rather than from a base speaker.
 */
async function synthesizeWithOmniVoice(text, outputPath, voice) {
	if (!voice || !voice.refAudioPath) {
		throw new Error('synthesizeWithOmniVoice: no reference audio');
	}
	const result = await omnivoice.generateVoice({
		text,
		refAudioPath: voice.refAudioPath,
		refText: voice.refText,
		instruct: voice.instruct,
		numStep: voice.numStep,
		outputPath,
	});
	// The service wrote the file itself and reports the path it used, so the
	// extension always matches the container.
	return { wordTimings: null, filePath: result.filePath };
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
 * (OmniVoice writes whatever extension it is given, Edge TTS emits MP3), so the
 * file actually written is what callers must use.
 *
 * @param {string} text        Spoken narrator text.
 * @param {string} outputPath  Absolute path to write the audio file.
 * @param {object} [options]   Optional: { voice } where voice is the object
 *                             returned by prepareClientVoice()
 * @returns {Promise<{wordTimings: Array|null, filePath: string}>}
 */
async function generateSceneAudio(text, outputPath, options = {}) {
	const clean = sanitizeNarratorText(text);
	if (!clean) throw new Error('generateSceneAudio: text is empty after sanitization');

	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

	let result = { wordTimings: null };
	let clonedVoiceError = null;
	let filePath = outputPath;
	const voice = options.voice || null;

	// Attempt 1: the locally cloned client voice (OmniVoice).
	if (voice && voice.refAudioPath) {
		try {
			const produced = await synthesizeWithOmniVoice(clean, outputPath, voice);
			result.wordTimings = produced.wordTimings || null;
			filePath = produced.filePath || outputPath;
			console.log(`[TTS] OmniVoice (cloned voice) OK  ${filePath}`);
		} catch (err) {
			clonedVoiceError = err;
			console.warn(
				`[TTS] Cloned voice unavailable (${err.message}) - using the default voice`,
			);
		}
	}

	// Attempt 2: the built-in neural teacher voice.
	if (!voice || !voice.refAudioPath || clonedVoiceError) {
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
	prepareClientVoice,
	defaultVoicePath,
	defaultVoiceRefText,
	computeProportionalWordTimings,
	extractTimingsFromAlignment,
	VOICE_SAMPLE_SENTENCES,
	VOICE_SAMPLE_SCRIPT,
	DEFAULT_EDGE_VOICE,
	DEFAULT_VOICE_LABEL,
};
'use strict';

/**
 * tts.js — Text-to-Speech synthesis with Runtime Client Voice Cloning.
 *
 * Primary:  ElevenLabs API (Instant Voice Cloning + Timestamp Word Alignment)
 * Fallback: msedge-tts with en-US-AndrewNeural (high-quality neural teacher voice)
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

const DEFAULT_EDGE_VOICE = 'en-US-AndrewNeural';

/**
 * Sentences the client reads aloud to build a voice sample.
 *
 * These are intentionally fixed (not generated) so that every clone request
 * contains the same phonetic material: one neutral statement, one sentence with
 * a natural cadence/rhythm, and one short closing line with a distinct ending
 * tone. ElevenLabs needs a clean, single-speaker sample of roughly 30s or less.
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
async function cloneClientVoice(voiceSamplePath) {
	if (!voiceSamplePath || !fs.existsSync(voiceSamplePath)) {
		throw new Error(`Voice sample file not found: ${voiceSamplePath}`);
	}

	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) {
		console.warn('\n[VOICE SETUP] ⚠️  Voice cloning is NOT available: ELEVENLABS_API_KEY is not set.');
		console.warn('[VOICE SETUP] The sample is saved, but narration will use the default neural voice.');
		console.warn('[VOICE SETUP] To clone the client voice, add ELEVENLABS_API_KEY to .env and restart.\n');
		return { voiceId: null, status: 'no-key', voiceName: DEFAULT_EDGE_VOICE, reason: 'ELEVENLABS_API_KEY is not set on the server.' };
	}

	console.log(`[VOICE SETUP] 🎙️  Cloning client voice from "${path.basename(voiceSamplePath)}"...`);
	const fileName = path.basename(voiceSamplePath);
	const fileBuffer = await fs.promises.readFile(voiceSamplePath);
	const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });

	const formData = new FormData();
	formData.append('name', `Client Voice (${fileName})`);
	formData.append('description', `Cloned from client voice sample ${fileName} at runtime`);
	formData.append('files', blob, fileName);

	const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
		method: 'POST',
		headers: {
			'xi-api-key': apiKey,
		},
		body: formData,
		signal: AbortSignal.timeout(60000),
	});

	if (!response.ok) {
		// Surface the provider's own reason. Silently falling back is what made
		// this look broken: the user uploaded a voice and nothing happened.
		const errorText = await response.text();
		let reason = errorText.slice(0, 400);
		try {
			const parsed = JSON.parse(errorText);
			reason = parsed?.detail?.message || parsed?.detail || parsed?.message || reason;
		} catch {
			/* keep the raw text */
		}
		if (response.status === 401) {
			reason = `ElevenLabs rejected the API key (401). ${reason}`;
		}
		throw new Error(
			`Voice cloning failed (HTTP ${response.status}): ${reason}\n` +
				'  The account may need voice-cloning access, or the free tier may be disabled.',
		);
	}

	const data = await response.json();
	const voiceId = data.voice_id;
	console.log(`[VOICE SETUP] ✅  Client voice cloned successfully! Cloned Voice ID: ${voiceId}\n`);
	return { voiceId, status: 'cloned', voiceName: `Client Voice (${voiceId})` };
}

// ---------------------------------------------------------------------------
// ElevenLabs synthesis
// ---------------------------------------------------------------------------
async function synthesizeWithElevenLabs(text, outputPath, voiceId) {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const targetVoiceId = voiceId || process.env.ELEVENLABS_VOICE_ID;

	if (!apiKey || !targetVoiceId) {
		throw new Error('ElevenLabs env vars missing (ELEVENLABS_API_KEY / target voice ID)');
	}

	const sanitized = sanitizeNarratorText(text);

	// Attempt with-timestamps for exact word alignment
	try {
		const url = `https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}/with-timestamps`;
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'xi-api-key': apiKey,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				text: sanitized,
				model_id: 'eleven_multilingual_v2',
				voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.0 },
			}),
		});

		if (response.ok) {
			const payload = await response.json();
			const audioBuffer = Buffer.from(payload.audio_base64, 'base64');
			await fs.promises.writeFile(outputPath, audioBuffer);
			const timings = extractTimingsFromAlignment(payload.alignment);
			return { wordTimings: timings };
		}
	} catch (timestampErr) {
		console.warn(`[TTS] Timestamps notice: ${timestampErr.message}, trying standard endpoint`);
	}

	// Standard synthesis fallback
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'xi-api-key': apiKey,
			'Content-Type': 'application/json',
			Accept: 'audio/mpeg',
		},
		body: JSON.stringify({
			text: sanitized,
			model_id: 'eleven_turbo_v2_5',
			voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.0 },
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`ElevenLabs HTTP ${response.status}: ${body.slice(0, 300)}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	await fs.promises.writeFile(outputPath, Buffer.from(arrayBuffer));
	return { wordTimings: null };
}

// ---------------------------------------------------------------------------
// Edge TTS synthesis (fallback)
// ---------------------------------------------------------------------------
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
 * Generate an MP3 audio file for a single narration text string.
 * Tries ElevenLabs (or cloned voice) first; falls back to Edge TTS (en-US-AndrewNeural).
 *
 * @param {string} text        Spoken narrator text.
 * @param {string} outputPath  Absolute path to write the .mp3 file.
 * @param {object} [options]   Optional: { voiceId, voice }
 * @returns {Promise<{wordTimings: Array|null}>}
 */
async function generateSceneAudio(text, outputPath, options = {}) {
	const clean = sanitizeNarratorText(text);
	if (!clean) throw new Error('generateSceneAudio: text is empty after sanitization');

	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

	let result = { wordTimings: null };

	// ── Attempt 1: ElevenLabs (with custom voiceId if provided) ─────────────
	try {
		result = await synthesizeWithElevenLabs(clean, outputPath, options.voiceId);
		console.log(`[TTS] ElevenLabs ✓  ${outputPath}`);
	} catch (elevenErr) {
		if (options.voiceId || process.env.ELEVENLABS_VOICE_ID) {
			console.warn(`[TTS] ElevenLabs unavailable (${elevenErr.message}) — falling back to Edge TTS`);
		}

		// ── Attempt 2: Edge TTS ───────────────────────────────────────────
		try {
			await synthesizeWithEdgeTts(clean, outputPath, options.voice || DEFAULT_EDGE_VOICE);
			console.log(`[TTS] Edge TTS (${options.voice || DEFAULT_EDGE_VOICE}) ✓  ${outputPath}`);
		} catch (edgeErr) {
			throw new Error(
				`Both TTS providers failed.\n  ElevenLabs: ${elevenErr.message}\n  Edge TTS: ${edgeErr.message}`,
			);
		}
	}

	// Validate file size > 0
	const { size } = await fs.promises.stat(outputPath);
	if (size <= 0) throw new Error(`Generated MP3 is empty: ${outputPath}`);

	return result;
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
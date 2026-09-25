'use strict';

/**
 * tts.js — Text-to-Speech synthesis.
 *
 * Primary:  ElevenLabs API  (requires ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)
 * Fallback: msedge-tts with en-US-AndrewNeural (high-quality neural voice)
 *
 * Exports:
 *   generateSceneAudio(text, outputPath) → Promise<void>
 *   synthesizeVideoScript(videoScript, options?) → Promise<VideoScript>
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_EDGE_VOICE = 'en-US-AndrewNeural';

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
	return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="-5%" pitch="-2Hz">${escaped}</prosody></voice></speak>`;
}

// ---------------------------------------------------------------------------
// ElevenLabs synthesis (primary)
// ---------------------------------------------------------------------------
async function synthesizeWithElevenLabs(text, outputPath) {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const voiceId = process.env.ELEVENLABS_VOICE_ID;

	if (!apiKey || !voiceId) {
		throw new Error('ElevenLabs env vars missing (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID)');
	}

	const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'xi-api-key': apiKey,
			'Content-Type': 'application/json',
			Accept: 'audio/mpeg',
		},
		body: JSON.stringify({
			text: sanitizeNarratorText(text),
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
		// Some Edge TTS endpoints reject break tags — retry without them
		console.warn('[TTS] Edge TTS rejected break tags; retrying without pause markup');
		await writeStream(ssml.replace(/<break time="(?:300|600)ms"\/>/g, ''));
	}
}

// ---------------------------------------------------------------------------
// Public: single-scene audio generator
// ---------------------------------------------------------------------------

/**
 * Generate an MP3 audio file for a single narration text string.
 * Tries ElevenLabs first; falls back to Edge TTS (en-US-AndrewNeural).
 *
 * @param {string} text        Spoken narrator text.
 * @param {string} outputPath  Absolute path to write the .mp3 file.
 * @returns {Promise<void>}
 */
async function generateSceneAudio(text, outputPath) {
	const clean = sanitizeNarratorText(text);
	if (!clean) throw new Error('generateSceneAudio: text is empty after sanitization');

	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

	// ── Attempt 1: ElevenLabs ─────────────────────────────────────────────
	try {
		await synthesizeWithElevenLabs(clean, outputPath);
		console.log(`[TTS] ElevenLabs ✓  ${outputPath}`);
	} catch (elevenErr) {
		console.warn(`[TTS] ElevenLabs unavailable (${elevenErr.message}) — falling back to Edge TTS`);

		// ── Attempt 2: Edge TTS ───────────────────────────────────────────
		try {
			await synthesizeWithEdgeTts(clean, outputPath, DEFAULT_EDGE_VOICE);
			console.log(`[TTS] Edge TTS (${DEFAULT_EDGE_VOICE}) ✓  ${outputPath}`);
		} catch (edgeErr) {
			throw new Error(
				`Both TTS providers failed.\n  ElevenLabs: ${elevenErr.message}\n  Edge TTS: ${edgeErr.message}`,
			);
		}
	}

	// Validate file size > 0
	const { size } = await fs.promises.stat(outputPath);
	if (size <= 0) throw new Error(`Generated MP3 is empty: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Convenience: synthesize every scene in a video-script object
// ---------------------------------------------------------------------------

/**
 * Synthesize audio for all scenes in a videoScript object.
 * Scene audio files are written to `public/audio/scene-N.mp3`.
 *
 * @param {object} videoScript   Script object with a `.scenes` array.
 * @param {object} [options]     Optional: { audioDirectory, voice }
 * @returns {Promise<object>}    Updated script with per-scene audioUrl.
 */
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
		await generateSceneAudio(narratorText, filePath);
		scenes.push({
			...scene,
			audioUrl: `audio/${fileName}`,
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
};
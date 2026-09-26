'use strict';

/**
 * openvoice.js — Client for the local OpenVoice v2 voice-cloning service.
 *
 * Replaces the hosted voice provider. The Python service (server/voice/service.py)
 * does the actual cloning and synthesis; this module is the only thing the
 * pipeline knows about.
 *
 * Everything here fails soft: if the service is not running, or was never
 * installed, the caller falls back to the neural teacher voice. Nothing throws
 * unless a caller explicitly wants to know.
 *
 * Exports:
 *   isOpenVoiceConfigured()
 *   isOpenVoiceReachable(timeoutMs)
 *   cloneVoice(samplePath, name)  -> { voiceId } | null
 *   synthesize(text, voiceId, outPath) -> boolean
 *   describeOpenVoice() -> string (for logs / error messages)
 */

const fs = require('fs');
const path = require('path');

const SERVICE_URL = (
	process.env.OPENVOICE_URL || 'http://127.0.0.1:5055'
).replace(/\/+$/, '');

const CLONE_TIMEOUT_MS = Number(process.env.OPENVOICE_CLONE_TIMEOUT_MS || 120000);
const SYNTH_TIMEOUT_MS = Number(process.env.OPENVOICE_SYNTH_TIMEOUT_MS || 300000);

const isOpenVoiceConfigured = () => true; // always available as an option

const describeOpenVoice = () =>
	`OpenVoice v2 (local) at ${SERVICE_URL}`;

/** Is the service up and has it loaded its model? */
async function isOpenVoiceReachable(timeoutMs = 4000) {
	try {
		const res = await fetch(`${SERVICE_URL}/health`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return false;
		const body = await res.json().catch(() => ({}));
		return Boolean(body?.ready);
	} catch {
		return false;
	}
}

/**
 * Extract a tone colour from a voice sample.
 * @returns {Promise<{voiceId: string, sampleSeconds?: number}|null>}
 */
async function cloneVoice(samplePath, name = 'client') {
	if (!fs.existsSync(samplePath)) {
		throw new Error(`Voice sample not found: ${samplePath}`);
	}

	const form = new FormData();
	const buffer = fs.readFileSync(samplePath);
	form.append('audio', new Blob([buffer]), path.basename(samplePath));
	form.append('name', name);

	const res = await fetch(`${SERVICE_URL}/clone`, {
		method: 'POST',
		body: form,
		signal: AbortSignal.timeout(CLONE_TIMEOUT_MS),
	});

	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { detail: text };
	}

	if (!res.ok) {
		throw new Error(
			`OpenVoice clone failed (HTTP ${res.status}): ${
				body?.detail || body?.error || text.slice(0, 200)
			}`,
		);
	}
	if (!body?.voiceId) {
		throw new Error('OpenVoice clone returned no voice id');
	}

	return { voiceId: String(body.voiceId), sampleSeconds: body.sampleSeconds };
}

/**
 * Speak `text` in a cloned tone colour, writing audio next to `outPath`.
 * @returns {Promise<string|false>} the path actually written, or false.
 */
async function synthesize(text, voiceId, outPath) {
	if (!voiceId) return false;

	const form = new FormData();
	form.append('text', String(text));
	form.append('voice_id', String(voiceId));

	const res = await fetch(`${SERVICE_URL}/synthesize`, {
		method: 'POST',
		body: form,
		signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(
			`OpenVoice synthesis failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
		);
	}

	const audio = Buffer.from(await res.arrayBuffer());
	if (audio.length === 0) {
		throw new Error('OpenVoice returned empty audio');
	}

	// Name the file for the container the service actually sent. The service
	// returns MP3 when ffmpeg is available and WAV otherwise, and downstream
	// tooling (music-metadata, the browser) reads the format from the bytes.
	const target = audio.subarray(0, 3).toString('latin1') === 'ID3' || isMpegFrame(audio)
		? outPath
		: outPath.replace(/\.mp3$/i, '.wav');

	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, audio);
	return target;
}

/** MPEG audio frame sync: eleven set bits. */
function isMpegFrame(buffer) {
	if (buffer.length < 2) return false;
	return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

module.exports = {
	SERVICE_URL,
	isOpenVoiceConfigured,
	isOpenVoiceReachable,
	cloneVoice,
	synthesize,
	describeOpenVoice,
};

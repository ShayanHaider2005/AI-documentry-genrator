'use strict';

/**
 * omnivoice.js — client for the local OmniVoice service.
 *
 * The Python service (server/voice/server.py) does the cloning and synthesis;
 * this module is the only thing the pipeline knows about.
 *
 * The contract differs from the retired OpenVoice service. OpenVoice extracted a
 * reusable tone colour at upload and returned a voice *id*. OmniVoice clones per
 * synthesis and needs the reference *path* every time, plus the reference's
 * transcript. So this client passes paths, and `validateReference` replaces the
 * old upload-time `clone`.
 *
 * Exports:
 *   isServiceReachable(timeoutMs)
 *   describeService()                       for logs and error messages
 *   serviceHealth(timeoutMs)                the raw /health payload
 *   validateReference({ refAudioPath, refText })
 *   generateVoice({ text, refAudioPath, refText, instruct, outputPath })
 */

const fs = require('fs');
const path = require('path');

const SERVICE_URL = (
	process.env.OMNIVOICE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');

const HEALTH_TIMEOUT_MS = Number(process.env.OMNIVOICE_HEALTH_TIMEOUT_MS || 4000);
const VALIDATE_TIMEOUT_MS = Number(process.env.OMNIVOICE_VALIDATE_TIMEOUT_MS || 120000);

/**
 * Generation timeout.
 *
 * OmniVoice is a diffusion TTS, so cost is close to linear in both audio length
 * and `num_step`. Measured on CPU: a 5 s clip at 32 steps took 244 s, which puts
 * an 18 s scene at roughly 15 minutes and a whole documentary at hours. A
 * timeout below that aborts the request and loses the clip, so this defaults
 * well above it. On a GPU with enough memory it finishes in seconds and the
 * value is simply never reached.
 */
const SYNTH_TIMEOUT_MS = Number(process.env.OMNIVOICE_SYNTH_TIMEOUT_MS || 90 * 60 * 1000);

const describeService = () => `OmniVoice (local) at ${SERVICE_URL}`;

/** Raw /health payload, or null when the service is unreachable. */
async function serviceHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
	try {
		const res = await fetch(`${SERVICE_URL}/health`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		const body = await res.json().catch(() => null);
		return { reachable: res.ok, status: res.status, body };
	} catch {
		return { reachable: false, status: 0, body: null };
	}
}

/** Is the service up with its model loaded? */
async function isServiceReachable(timeoutMs = HEALTH_TIMEOUT_MS) {
	const { reachable, body } = await serviceHealth(timeoutMs);
	return Boolean(reachable && body?.ready);
}

/** POST JSON and turn a non-2xx into a thrown Error carrying the service's reason. */
async function postJson(route, payload, timeoutMs) {
	const res = await fetch(`${SERVICE_URL}${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(timeoutMs),
	});

	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { detail: text };
	}

	if (!res.ok) {
		const detail =
			(typeof body.detail === 'string' && body.detail) ||
			(typeof body.error === 'string' && body.error) ||
			text.slice(0, 300) ||
			`HTTP ${res.status}`;
		throw new Error(`OmniVoice ${route} failed (HTTP ${res.status}): ${detail}`);
	}
	return body;
}

/**
 * Check that a reference sample is usable for zero-shot cloning.
 *
 * This is the upload-time gate. OmniVoice extracts no reusable embedding, so
 * the honest check is decodability plus duration, not a successful clone.
 *
 * @returns {Promise<{ok: boolean, seconds?: number, reason?: string}>}
 */
async function validateReference({ refAudioPath, refText = '' } = {}) {
	if (!refAudioPath || !fs.existsSync(refAudioPath)) {
		return { ok: false, reason: `Voice sample file not found: ${refAudioPath}` };
	}

	const { reachable, body } = await serviceHealth();
	if (!reachable) {
		return { ok: false, reason: serviceDownReason(body) };
	}
	if (!body?.ready) {
		return {
			ok: false,
			reason: body?.error || 'OmniVoice is still loading its model.',
		};
	}

	try {
		const result = await postJson(
			'/api/validate-reference',
			{ ref_audio_path: refAudioPath, ref_text: refText },
			VALIDATE_TIMEOUT_MS,
		);
		return { ok: true, seconds: result.seconds, refTextKnown: result.ref_text_known };
	} catch (err) {
		return { ok: false, reason: err.message };
	}
}

/**
 * Speak `text`, writing the clip to `outputPath` via the service.
 *
 * The service writes the file itself and reports the path it actually wrote,
 * because the container follows the extension it was given. That returned path
 * is authoritative.
 *
 * @returns {Promise<{filePath: string, seconds: number, mode: string}>}
 */
async function generateVoice({
	text,
	refAudioPath = null,
	refText = '',
	instruct = null,
	numStep = null,
	outputPath,
}) {
	if (!text) throw new Error('generateVoice: text is required');
	if (!outputPath) throw new Error('generateVoice: outputPath is required');

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });

	const payload = {
		text,
		output_path: outputPath,
		...(refAudioPath ? { ref_audio_path: refAudioPath } : {}),
		...(refText ? { ref_text: refText } : {}),
		...(instruct ? { instruct } : {}),
		...(numStep ? { num_step: numStep } : {}),
	};

	const result = await postJson('/api/generate-voice', payload, SYNTH_TIMEOUT_MS);

	// The service may have fallen back to WAV if the requested encoder is
	// unavailable, so use the path it reports rather than the one requested.
	const filePath = result.output_path || outputPath;
	if (!fs.existsSync(filePath)) {
		throw new Error(`OmniVoice reported writing ${path.basename(filePath)} but it is not on disk`);
	}

	return {
		filePath,
		seconds: result.seconds ?? null,
		mode: result.mode ?? 'unknown',
		rtf: result.rtf ?? null,
		numStep: result.num_step ?? null,
		device: result.device ?? null,
	};
}

function serviceDownReason(healthBody) {
	const detail = healthBody?.error;
	if (detail) return detail;
	return (
		'Local voice cloning is not running. Start it with ' +
		'"npm run voice:start" (or just "npm run web", which starts both). ' +
		'First time on a new machine: run "npm run voice:setup" once.'
	);
}

module.exports = {
	SERVICE_URL,
	serviceHealth,
	isServiceReachable,
	describeService,
	validateReference,
	generateVoice,
	serviceDownReason,
};

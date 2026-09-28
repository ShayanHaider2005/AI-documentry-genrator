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
const http = require('http');
const https = require('https');
const path = require('path');

const SERVICE_URL = (
	process.env.OMNIVOICE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');

const HEALTH_TIMEOUT_MS = Number(process.env.OMNIVOICE_HEALTH_TIMEOUT_MS || 4000);
const VALIDATE_TIMEOUT_MS = Number(process.env.OMNIVOICE_VALIDATE_TIMEOUT_MS || 120000);

/**
 * Generation timeout: 90 minutes, 5,400,000 ms.
 *
 * OmniVoice is a diffusion TTS, so cost is close to linear in both audio length
 * and `num_step`. Measured on CPU: a 5.3 s clip took 174 s at 12 steps and
 * about 380 s at 32, which puts an 18 s scene at 10-25 minutes depending on the
 * step count. A timeout below that aborts the request and loses the clip, so
 * this defaults well above it. On a GPU with enough memory it finishes in
 * seconds and the value is simply never reached.
 *
 * This only works because postJson uses core `http` rather than `fetch`; see
 * the comment there. With `fetch`, undici's 300 s headers timeout killed every
 * request past five minutes no matter what this was set to.
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

/**
 * POST JSON and return the parsed body, throwing on a non-2xx.
 *
 * Uses core `http` rather than global `fetch`, for one specific reason:
 * `fetch` runs on undici, which enforces its OWN 300-second headers timeout
 * that `AbortSignal` does not override. OmniVoice returns nothing at all until
 * inference finishes, so any synthesis taking more than five minutes died with
 * `UND_ERR_HEADERS_TIMEOUT` no matter what OMNIVOICE_SYNTH_TIMEOUT_MS said.
 * The 90-minute timeout below was, until this was fixed, entirely decorative.
 *
 * `setTimeout` is an inactivity timeout, which is the right semantic here: the
 * socket is idle for the whole inference, so it bounds total wait correctly.
 */
function postJson(route, payload, timeoutMs) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(route, SERVICE_URL);
		} catch (err) {
			reject(new Error(`OmniVoice has an unusable service URL: ${err.message}`));
			return;
		}

		const body = Buffer.from(JSON.stringify(payload), 'utf8');
		const transport = url.protocol === 'https:' ? https : http;

		const req = transport.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? 443 : 80),
				path: url.pathname + url.search,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': body.length,
				},
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					let parsed;
					try {
						parsed = text ? JSON.parse(text) : {};
					} catch {
						parsed = { detail: text };
					}

					if (res.statusCode < 200 || res.statusCode >= 300) {
						const detail =
							(typeof parsed.detail === 'string' && parsed.detail) ||
							(typeof parsed.error === 'string' && parsed.error) ||
							text.slice(0, 300) ||
							`HTTP ${res.statusCode}`;
						reject(
							new Error(
								`OmniVoice ${route} failed (HTTP ${res.statusCode}): ${detail}`,
							),
						);
						return;
					}
					resolve(parsed);
				});
			},
		);

		req.setTimeout(timeoutMs, () => {
			req.destroy(
				new Error(
					`OmniVoice ${route} timed out after ${Math.round(timeoutMs / 60000)} minutes. ` +
						'On CPU this usually means the script is too long for the step count; ' +
						'lower OMNIVOICE_NUM_STEP or shorten the script.',
				),
			);
		});

		req.on('error', (err) => {
			reject(
				err.code === 'ECONNREFUSED'
					? new Error(`${serviceDownReason(null)} (${err.code})`)
					: err,
			);
		});

		req.end(body);
	});
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
		// false here means the service had no transcript and fell back to
		// loading Whisper, which is a ~1.5 GB download on a cold cache.
		refTextKnown: result.refTextKnown ?? null,
		whisperUsed: result.whisperUsed ?? null,
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

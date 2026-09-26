'use strict';

/**
 * llm.js — Shared AI provider access (script generation + chatbot Q&A).
 *
 * Providers are auto-detected from the environment, in this order:
 *   Gemini -> Grok -> Groq -> OpenAI
 *
 * Exports:
 *   getAiProvider()            → provider descriptor or null
 *   hasLlmProvider()           → boolean
 *   chatCompletion({system, user, temperature, maxTokens}) → { text, provider, model }
 */

try {
	const fs = require('fs');
	const path = require('path');
	if (typeof process.loadEnvFile === 'function') {
		const envPath = path.resolve(__dirname, '../.env');
		if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
	}
} catch {
	// Ignore missing or unreadable .env
}

/** Current Gemini model ids, newest first. The first one that responds wins. */
const GEMINI_MODEL_CANDIDATES = [
	'gemini-3.8-flash',
	'gemini-flash-latest',
	'gemini-2.5-pro',
	'gemini-2.5-flash',
];

/**
 * Current Groq model ids that can return chat completions.
 * `llama-3.3-70b-versatile` is listed by /models but returns 404 without access,
 * so it is left last as a harmless extra attempt.
 */
const GROQ_MODEL_CANDIDATES = [
	'qwen/qwen3.8-27b',
	'openai/gpt-oss-120b',
	'openai/gpt-oss-20b',
	'llama-3.3-70b-versatile',
];

/** Model ids tried in order when a provider rejects a model as unavailable. */
const MODEL_FALLBACKS = {
	Gemini: GEMINI_MODEL_CANDIDATES,
	Groq: GROQ_MODEL_CANDIDATES,
};

function getAiProvider() {
	return getAiProviders()[0] || null;
}

/**
 * Every configured provider, in preference order. chatCompletion walks this list
 * so an overloaded or quota-limited provider (Gemini regularly 503s or returns
 * 429 on the free tier) automatically falls through to the next one available.
 */
function getAiProviders() {
	const providers = [];

	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		providers.push({
			name: 'Gemini',
			apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
			baseUrl:
				'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
			model: process.env.GEMINI_MODEL || GEMINI_MODEL_CANDIDATES[0],
		});
	}

	if (process.env.GROQ_API_KEY) {
		providers.push({
			name: 'Groq',
			apiKey: process.env.GROQ_API_KEY,
			baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
			model: process.env.GROQ_MODEL || GROQ_MODEL_CANDIDATES[0],
		});
	}

	if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) {
		providers.push({
			name: 'Grok',
			apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY,
			baseUrl:
				process.env.GROK_BASE_URL || 'https://api.x.ai/v1/chat/completions',
			model: process.env.GROK_MODEL || 'grok-3-mini',
		});
	}

	if (process.env.OPENAI_API_KEY) {
		providers.push({
			name: 'OpenAI',
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl:
				process.env.OPENAI_BASE_URL ||
				'https://api.openai.com/v1/chat/completions',
			model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
		});
	}

	return providers;
}

const hasLlmProvider = () => getAiProviders().length > 0;

const isModelUnavailable = (status, body) =>
	status === 404 || /is not found|not supported|no longer available/i.test(String(body));

/** Transient upstream failures worth retrying (429 / 5xx / network). */
const isRetryable = (status) => [408, 409, 425, 429, 500, 502, 503, 504].includes(status);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST a chat completion, retrying transient failures with a short backoff and
 * honouring Retry-After. Returns { response, body } or throws the last error.
 */
async function postWithRetry(url, headers, payload, model, attempts = 3) {
	let lastError = null;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(120000),
			});
		} catch (err) {
			lastError = new Error(`network error: ${err.message}`);
			if (attempt < attempts) {
				await sleep(800 * attempt);
				continue;
			}
			throw lastError;
		}

		if (response.ok) return { response, body: null };

		const body = await response.text();
		if (isRetryable(response.status) && attempt < attempts) {
			const retryAfter = Number(response.headers.get('retry-after'));
			const waitMs =
				Number.isFinite(retryAfter) && retryAfter > 0
					? Math.min(retryAfter * 1000, 15000)
					: 800 * attempt * 2;
			console.warn(
				`[LLM] ${model}: HTTP ${response.status}, retrying in ${waitMs}ms`,
			);
			await sleep(waitMs);
			continue;
		}

		return { response, body };
	}

	throw lastError || new Error(`${model}: exhausted retries`);
}

/**
 * Run a single-turn chat completion.
 *
 * If the provider rejects the model, the remaining candidate models are tried in
 * turn, so an outdated model id cannot silently disable the LLM path. Transient
 * 429/5xx responses are retried with a short backoff.
 */
async function chatCompletion({
	system,
	user,
	temperature = 0.6,
	maxTokens = 700,
	model: modelOverride,
} = {}) {
	const messages = [];
	if (system) messages.push({ role: 'system', content: system });
	messages.push({ role: 'user', content: String(user ?? '') });

	const providers = getAiProviders();
	if (providers.length === 0) {
		throw new Error('No LLM provider configured');
	}

	const failures = [];

	// Walk providers in order, then each provider's candidate models. The first
	// usable response wins, so one flaky provider never blocks the run.
	for (const provider of providers) {
		const candidates = modelOverride
			? [modelOverride]
			: [provider.model, ...(MODEL_FALLBACKS[provider.name] || [])];

		const headers = {
			Authorization: `Bearer ${provider.apiKey}`,
			'Content-Type': 'application/json',
		};

		for (const model of [...new Set(candidates)]) {
			let result;
			try {
				result = await postWithRetry(
					provider.baseUrl,
					headers,
					{ model, temperature, max_tokens: maxTokens, messages },
					`${provider.name}/${model}`,
				);
			} catch (err) {
				failures.push(`${provider.name}/${model}: ${err.message}`);
				break; // network problem: move on to the next provider
			}

			const { response, body } = result;

			if (response.ok) {
				const payload = await response.json();
				const text = payload.choices?.[0]?.message?.content;
				if (typeof text === 'string' && text.trim()) {
					return { text, provider: provider.name, model };
				}
				failures.push(`${provider.name}/${model}: empty response`);
				continue;
			}

			if (isModelUnavailable(response.status, body)) {
				failures.push(`${provider.name}/${model}: model unavailable`);
				continue;
			}

			// A real API error (auth, quota, bad request) for this provider.
			failures.push(
				`${provider.name}/${model}: HTTP ${response.status} ${String(body).slice(0, 120)}`,
			);
			break;
		}
	}

	throw new Error(`All LLM providers failed. ${failures.join(' | ')}`);
}

module.exports = {
	getAiProvider,
	getAiProviders,
	hasLlmProvider,
	chatCompletion,
};

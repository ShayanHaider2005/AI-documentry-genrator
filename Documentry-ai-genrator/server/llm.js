'use strict';

/**
 * llm.js — Shared AI provider access (script generation + chatbot Q&A).
 *
 * Providers are auto-detected from the environment, in this order:
 *   Groq -> Gemini -> Grok -> OpenAI
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

/**
 * Gemini model ids, best first. Verified live by `npm run check:models`.
 *
 * The list this replaced was entirely broken: `gemini-3.8-flash` and
 * `gemini-flash-latest` both returned 503 "high demand", and `gemini-2.5-pro`
 * and `gemini-2.5-flash` both returned 404 "no longer available to new users".
 * Because Gemini is the *first* provider in `getAiProviders()`, every single LLM
 * call in the app — script generation and chat alike — paid three failed round
 * trips before reaching Groq. A model id that no longer exists fails at request
 * time, long after the code has been reviewed and looks correct, which is why
 * this is a test and not a comment.
 *
 * The last two are kept as last resorts despite currently returning 503: an
 * overloaded model is a better outcome than no provider, and they cost one
 * attempt.
 */
const GEMINI_MODEL_CANDIDATES = [
	'gemini-3.5-flash',
	'gemini-3.1-flash-lite',
	'gemini-3.8-flash',
	'gemini-flash-latest',
];

/**
 * Groq model ids that return chat completions, verified live.
 *
 * `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` are both gone from this
 * key's `/models` list and return 404 "does not exist or you do not have
 * access". Groq serves only 11 models to this account and chat-capable ones are
 * just these three.
 */
const GROQ_MODEL_CANDIDATES = [
	'qwen/qwen3.8-27b',
	'openai/gpt-oss-120b',
	'openai/gpt-oss-20b',
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
 *
 * Groq leads, ahead of Gemini. That is a latency decision as much as a cost
 * one: Groq's inference tier is built for time-to-first-token, and a
 * documentary script request or a chat answer is dominated by how long the user
 * waits on it. It also puts a provider with a verified-working model first, so
 * the common path is one round trip rather than a walk down a broken list.
 */
function getAiProviders() {
	const providers = [];

	if (process.env.GROQ_API_KEY) {
		providers.push({
			name: 'Groq',
			apiKey: process.env.GROQ_API_KEY,
			baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
			model: process.env.GROQ_MODEL || GROQ_MODEL_CANDIDATES[0],
		});
	}

	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		providers.push({
			name: 'Gemini',
			apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
			baseUrl:
				'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
			model: process.env.GEMINI_MODEL || GEMINI_MODEL_CANDIDATES[0],
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

/**
 * Whether a failure is about the *model* rather than the *account*.
 *
 * This distinction decides whether to try the provider's next model or give up
 * on the provider entirely, and getting it wrong is expensive in both
 * directions.
 *
 * Gemini returns 503 "This model is currently experiencing high demand" for a
 * single overloaded model while the rest of the provider is perfectly healthy.
 * Treating that as a provider failure abandoned the remaining candidates, so a
 * request that would have succeeded on the second model instead burned a round
 * trip and fell through to the next provider. A 5xx is therefore treated as
 * model-specific and the loop continues.
 *
 * A 429 is the opposite: it is a key-wide rate limit, so every model on this
 * provider would fail the same way, and it is better to move straight on. Same
 * for 401 and 403, which are an invalid or unauthorised key.
 */
const isModelScoped = (status) => status >= 500;

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

			if (isModelUnavailable(response.status, body) || isModelScoped(response.status)) {
				// The model is the problem, not the account. Try the next one
				// rather than abandoning a provider that is otherwise healthy.
				failures.push(
					`${provider.name}/${model}: ${
						isModelScoped(response.status)
							? `HTTP ${response.status} (model overloaded)`
							: 'model unavailable'
					}`,
				);
				continue;
			}

			// A key-wide failure (401, 403, 429, a bad request): every model on
			// this provider would fail the same way, so move straight on.
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

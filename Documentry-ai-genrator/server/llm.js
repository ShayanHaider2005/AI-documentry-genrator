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

function getAiProvider() {
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
		return {
			name: 'Gemini',
			apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
			model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
		};
	}
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
			name: 'OpenAI',
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl:
				process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
			model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
		};
	}
	return null;
}

const hasLlmProvider = () => getAiProvider() !== null;

/**
 * Run a single-turn chat completion.
 * Throws when no provider is configured or the request fails.
 */
async function chatCompletion({
	system,
	user,
	temperature = 0.6,
	maxTokens = 700,
} = {}) {
	const provider = getAiProvider();
	if (!provider) {
		throw new Error('No LLM provider configured');
	}
	if (typeof fetch !== 'function') {
		throw new Error('This Node runtime has no global fetch()');
	}

	const messages = [];
	if (system) messages.push({ role: 'system', content: system });
	messages.push({ role: 'user', content: String(user ?? '') });

	const response = await fetch(provider.baseUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: provider.model,
			temperature,
			max_tokens: maxTokens,
			messages,
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`${provider.name} HTTP ${response.status}: ${body.slice(0, 300)}`,
		);
	}

	const payload = await response.json();
	const text = payload.choices?.[0]?.message?.content ?? '';
	if (!text) throw new Error(`${provider.name} returned an empty response`);

	return { text, provider: provider.name, model: provider.model };
}

module.exports = { getAiProvider, hasLlmProvider, chatCompletion };

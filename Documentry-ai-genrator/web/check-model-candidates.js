'use strict';

/**
 * Verifies every model id the codebase actually hardcodes, in order.
 *
 * This exists because a model id that no longer exists fails at request time,
 * long after the code has been reviewed and looks correct. The brief for the
 * chat work named `llama-3.1-8b-instant`, `gemini-2.5-flash` and
 * `gemini-3.7-flash`; all three turned out to be unusable against these keys,
 * and the pre-existing candidate list had drifted too.
 *
 * Prints a table and exits non-zero if the first candidate of either provider
 * does not answer, because that one is on the hot path for every single request.
 *
 * Usage: node web/check-model-candidates.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const loadEnv = () => {
	try {
		for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
			const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch {
		/* no .env */
	}
};

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/** Pull the live candidate arrays out of llm.js so this test cannot drift. */
const candidates = () => {
	const src = fs.readFileSync(path.join(ROOT, 'server', 'llm.js'), 'utf8');
	const read = (name) => {
		const start = src.indexOf(`const ${name} = [`);
		if (start === -1) return [];
		const end = src.indexOf('];', start);
		return [...src.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
	};
	return { gemini: read('GEMINI_MODEL_CANDIDATES'), groq: read('GROQ_MODEL_CANDIDATES') };
};

const ask = async (url, key, model) => {
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
				max_tokens: 8,
			}),
			signal: AbortSignal.timeout(30000),
		});
		if (res.ok) return { ok: true, status: res.status, note: '' };
		const text = await res.text();
		let note = text.slice(0, 110).replace(/\s+/g, ' ');
		try {
			const b = JSON.parse(text);
			note = b.error?.message || b.error?.[0]?.message || note;
		} catch {
			/* raw text is fine */
		}
		return { ok: false, status: res.status, note: String(note).slice(0, 110) };
	} catch (err) {
		return { ok: false, status: 0, note: err.name === 'TimeoutError' ? 'timeout' : err.message };
	}
};

const main = async () => {
	loadEnv();
	const { gemini, groq } = candidates();
	let failures = 0;

	const run = async (label, url, key, models, hotPath) => {
		console.log(`\n${label} (${models.length} candidates)`);
		if (!key) {
			console.log('  no API key; skipped');
			return;
		}
		for (const model of models) {
			const r = await ask(url, key, model);
			const isHot = model === models[0];
			console.log(
				`  ${r.ok ? 'OK  ' : 'FAIL'} ${model.padEnd(28)} ${isHot ? '(primary)' : ''} ${
					r.ok ? '' : r.note
				}`,
			);
			// The primary is on the hot path: if it fails, every request pays a
			// wasted round trip before falling through.
			if (isHot && !r.ok) {
				failures += 1;
				console.log(`       ^ the primary model does not answer; every request would be slowed`);
			}
		}
	};

	await run('Groq', GROQ, process.env.GROQ_API_KEY, groq);
	await run('Gemini', GEMINI, process.env.GEMINI_API_KEY, gemini);

	// A model that fails is a candidate problem, not a test failure; only the
	// primary check above is fatal.
	console.log(
		failures === 0
			? '\nBoth providers have a working primary model.'
			: `\n${failures} provider(s) have a broken primary model.`,
	);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`FAILED: ${err.message}`);
	process.exit(1);
});

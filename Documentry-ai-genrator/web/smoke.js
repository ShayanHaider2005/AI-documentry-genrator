'use strict';

/** End-to-end smoke test for the DocuBot web API. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3100';
const ROOT = path.resolve(__dirname, '..');

const json = async (url, options = {}) => {
	const res = await fetch(url, {
		...options,
		headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
	});
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(body)}`);
	return body;
};

const ok = (label) => console.log(`  PASS  ${label}`);
const info = (label, value) => console.log(`        ${label}: ${value}`);

(async () => {
	console.log('\n=== 1. Frontend is served ===');
	const html = await (await fetch(`${BASE}/`)).text();
	html.includes('bundle.js') ? ok('index.html references bundle.js') : console.log('  FAIL no bundle.js');
	const bundle = await fetch(`${BASE}/bundle.js`);
	bundle.ok ? ok(`bundle.js served (${bundle.headers.get('content-type')})`) : console.log('  FAIL bundle');
	const css = await fetch(`${BASE}/bundle.css`);
	css.ok ? ok('bundle.css served') : console.log('  FAIL css');

	console.log('\n=== 2. Create session ===');
	const { sessionId } = await json(`${BASE}/api/session`, { method: 'POST' });
	ok(`session ${sessionId}`);

	console.log('\n=== 3. Upload PDF ===');
	const { ensureSamplePdf } = require('../server/sample');
	const pdf = fs.readFileSync(ensureSamplePdf(path.join(ROOT, 'server', 'sample.pdf')));
	const upload = await json(`${BASE}/api/upload/pdf`, {
		method: 'POST',
		body: JSON.stringify({
			sessionId,
			fileName: 'sample.pdf',
			dataBase64: pdf.toString('base64'),
		}),
	});
	ok(`parsed ${upload.fileName}`);
	info('characters', upload.characters);

	console.log('\n=== 4. Chat without an LLM key (graceful) ===');
	const chat = await json(`${BASE}/api/chat`, {
		method: 'POST',
		body: JSON.stringify({ sessionId, message: 'What is this document about?' }),
	});
	chat.reply ? ok('chat replied') : console.log('  FAIL no reply');
	info('reply', `${chat.reply.slice(0, 90)}...`);

	console.log('\n=== 5. Generate ===');
	const { jobId } = await json(`${BASE}/api/generate`, {
		method: 'POST',
		body: JSON.stringify({ sessionId }),
	});
	ok(`job ${jobId} started`);

	let job;
	const started = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, 1500));
		job = await json(`${BASE}/api/job/${jobId}`);
		const last = job.logs[job.logs.length - 1] || '';
		process.stdout.write(`\r        [${job.status}] ${last.slice(0, 96)}`.padEnd(110));
		if (job.status !== 'running') break;
		if (Date.now() - started > 300000) throw new Error('timed out');
	}
	console.log('');
	if (job.status !== 'done') throw new Error(`job failed: ${job.error}`);
	ok(`generated ${job.result.sceneCount} scenes, ${job.result.totalFrames} frames`);

	console.log('\n=== 6. Session dataset ===');
	const snapshot = await json(`${BASE}/api/session/${sessionId}`);
	ok(`hasDataset=${snapshot.hasDataset}`);
	const first = snapshot.dataset[0];
	info('scene 1', `${first.title} / ${first.badge}`);
	info('words timed', `${first.wordTimings.length} of ${first.narratorText.split(/\s+/).length}`);
	info('audioPath', first.audioPath);

	const timedWords = first.wordTimings.length;
	const spokenWords = first.narratorText.trim().split(/\s+/).length;
	timedWords === spokenWords
		? ok('every spoken word has a timing')
		: console.log(`  WARN timings ${timedWords} vs words ${spokenWords}`);

	console.log('\n=== 7. Audio is reachable at the dataset path ===');
	const audioUrl = `/${first.audioPath}`;
	const audio = await fetch(`${BASE}${audioUrl}`);
	audio.ok
		? ok(`GET ${audioUrl} -> ${audio.status}, ${audio.headers.get('content-type')}`)
		: console.log(`  FAIL ${audioUrl} -> ${audio.status}`);

	console.log('\n=== 8. Rejections ===');
	for (const [label, run] of [
		['unknown session', () => json(`${BASE}/api/session/sess_deadbeefdeadbeef`, { method: 'GET' }).then(() => { throw new Error('should have failed'); }, (e) => e)],
		['non-pdf upload', () => json(`${BASE}/api/upload/pdf`, { method: 'POST', body: JSON.stringify({ sessionId, fileName: 'x.txt', dataBase64: 'aGVsbG8=' }) }).then(() => { throw new Error('should have failed'); }, (e) => e)],
		['generate without pdf', () => json(`${BASE}/api/generate`, { method: 'POST', body: JSON.stringify({ sessionId: 'sess_000000000000000000' }) }).then(() => { throw new Error('should have failed'); }, (e) => e)],
		['path traversal', () => fetch(`${BASE}/audio/../../package.json`).then((r) => r.text())],
	]) {
		const result = await run();
		const detail = typeof result === 'string' ? result.slice(0, 40).replace(/\n/g, ' ') : result.message.slice(0, 60);
		ok(`${label} handled -> ${detail}`);
	}

	console.log(`\nSESSION_ID=${sessionId}`);
	console.log('\nAll API checks passed.\n');
})().catch((err) => {
	console.error('\nTEST FAILED:', err.message);
	process.exit(1);
});

'use strict';
// Full end-to-end test against the real API: create a session, upload a PDF,
// clone a voice from a sample, generate, and confirm the narration came back.
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3100';
const REPO = path.join(__dirname, '..');

async function api(route, payload) {
	const res = await fetch(`${BASE}${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload || {}),
	});
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text.slice(0, 300) };
	}
	return { status: res.status, body };
}

const step = (n, text) => console.log(`\n${n}. ${text}`);

async function main() {
	step(1, 'create session');
	let r = await api('/api/session');
	if (r.status >= 400) throw new Error(`create failed: ${JSON.stringify(r.body)}`);
	const sessionId = r.body.sessionId;
	console.log(`   session ${sessionId}`);

	step(2, 'upload the sample PDF');
	const pdfPath = path.join(REPO, 'server', 'sample.pdf');
	if (!fs.existsSync(pdfPath)) throw new Error(`no sample PDF at ${pdfPath}`);
	r = await api('/api/upload/pdf', {
		sessionId,
		fileName: 'sample.pdf',
		dataBase64: fs.readFileSync(pdfPath).toString('base64'),
	});
	console.log(`   ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
	if (r.status >= 400) throw new Error('PDF upload failed');

	step(3, 'clone a voice from a sample');
	const sample = ['public/audio/scene-3.mp3', 'public/audio/scene-5.mp3']
		.map((p) => path.join(REPO, p))
		.find((p) => fs.existsSync(p));
	if (!sample) throw new Error('no narration clip to use as a voice sample');
	r = await api('/api/upload/voice', {
		sessionId,
		fileName: path.basename(sample),
		dataBase64: fs.readFileSync(sample).toString('base64'),
	});
	console.log(`   ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
	if (r.status >= 400) throw new Error('voice clone failed');

	step(4, 'generate the documentary');
	r = await api('/api/generate', { sessionId });
	if (r.status >= 400) throw new Error(`generate failed: ${JSON.stringify(r.body)}`);
	console.log(`   job ${r.body.jobId || JSON.stringify(r.body).slice(0, 80)}`);

	step(5, 'wait for the job');
	const session = await fetch(`${BASE}/api/session/${sessionId}`).then((x) => x.json());
	const jobId = session.jobId || r.body.jobId;
	const deadline = Date.now() + 25 * 60 * 1000;
	let state = null;
	while (Date.now() < deadline) {
		await new Promise((res) => setTimeout(res, 4000));
		const poll = await fetch(`${BASE}/api/session/${sessionId}`).then((x) => x.json());
		state = poll;
		if (poll.dataset) break;
		process.stdout.write('.');
	}
	console.log('');
	if (!state || !state.dataset) throw new Error('no dataset after 25 minutes');
	if (state.error) throw new Error(`job error: ${state.error}`);

	step(6, 'inspect the result');
	const scenes = Array.isArray(state.dataset) ? state.dataset : state.dataset.scenes || [];
	console.log(`   ${scenes.length} scenes`);
	for (const s of scenes.slice(0, 3)) {
		const audio = path.join(REPO, 'public', s.audioPath || '');
		const exists = s.audioPath && fs.existsSync(audio);
		console.log(
			`   - ${String(s.title || '(untitled)').slice(0, 42).padEnd(42)} ` +
				`${String(s.durationInFrames).padStart(5)}f  ` +
				`${exists ? `${Math.round(fs.statSync(audio).size / 1024)} KB` : 'MISSING'}`,
		);
	}
	if (scenes.length) {
		console.log(`\n   narration sample:`);
		console.log(`     "${String(scenes[0].narratorText || '').slice(0, 130)}"`);
	}
	const missing = scenes.filter((s) => !fs.existsSync(path.join(REPO, 'public', s.audioPath || '')));
	if (missing.length) throw new Error(`${missing.length} scene(s) have no audio on disk`);

	console.log('\nPASS: PDF + voice sample -> documentary with a cloned voice');
}

main().catch((err) => {
	console.error(`\nFAILED: ${err.message}`);
	process.exit(1);
});

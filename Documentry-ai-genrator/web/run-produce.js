'use strict';

/**
 * Runs the full one-button pipeline on a PDF and reports what came out.
 *
 * Drives the same HTTP surface the UI uses, against a live server, so what is
 * measured here is the path a user actually gets.
 *
 * Stage order and why the timing matters: script generation is ~1s, narration is
 * CPU-only OmniVoice at roughly 12 diffusion steps and takes tens of minutes for
 * a full video, and the Remotion render is a few minutes. So the whole thing is
 * run as a detached process writing a log, and the caller polls.
 *
 * The PDF path and voice are read from the environment as well as argv,
 * because a Windows path with spaces in it gets shredded by argument
 * splitting long before this script ever sees it.
 *
 *   DOCUBOT_PDF=<path> DOCUBOT_VOICE=male_indian node web/run-produce.js
 *   node web/run-produce.js "<path with spaces>" [voiceId]   (quoted, fine)
 */

const fs = require('fs');
const path = require('path');

const PDF = process.env.DOCUBOT_PDF || process.argv[2];
const VOICE = process.env.DOCUBOT_VOICE || process.argv[3] || 'male_indian';
const BASE = process.env.DOCUBOT_BASE || 'http://127.0.0.1:3100';
const USER = process.env.DOCUBOT_USER || 'shayan';
const PASS = process.env.DOCUBOT_PASS || 'partsentra-pitch-2026';

let cookie = null;

const call = async (p, init = {}) => {
	const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
	if (cookie) headers.Cookie = cookie;
	const res = await fetch(`${BASE}${p}`, { ...init, headers });
	const set = res.headers.get('set-cookie');
	if (set) cookie = set.split(';')[0];
	const text = await res.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: res.status, body };
};

const log = (msg) => {
	process.stdout.write(`${msg}\n`);
	fs.appendFileSync(path.join(__dirname, '..', '.produce.log'), `${msg}\n`);
};

const main = async () => {
	const started = Date.now();
	const stamp = () => `[${((Date.now() - started) / 1000).toFixed(0)}s]`;

	if (!PDF || !fs.existsSync(PDF)) {
		log(`FATAL: no such PDF: ${PDF}`);
		process.exit(1);
	}
	const bytes = fs.readFileSync(PDF);
	log(`${stamp()} starting: ${path.basename(PDF)} (${(bytes.length / 1024).toFixed(0)} KB)`);
	log(`${stamp()} narrator: ${VOICE}`);

	/* ---- account ---------------------------------------------------------- */
	// Register once; a second run on the same name gets a 409 and falls through
	// to login, so this script is re-runnable.
	const reg = await call('/api/auth/register', {
		method: 'POST',
		body: JSON.stringify({ username: USER, password: PASS }),
	});
	if (reg.status === 200 || reg.status === 201) {
		log(`${stamp()} registered ${USER}`);
	} else {
		const login = await call('/api/auth/login', {
			method: 'POST',
			body: JSON.stringify({ username: USER, password: PASS }),
		});
		if (login.status !== 200) {
			log(`FATAL: could not sign in (${reg.status} then ${login.status}): ${JSON.stringify(login.body)}`);
			process.exit(1);
		}
		log(`${stamp()} signed in as ${USER}`);
	}

	/* ---- session ---------------------------------------------------------- */
	const session = await call('/api/session', { method: 'POST', body: '{}' });
	const sessionId = session.body?.sessionId;
	if (!sessionId) {
		log(`FATAL: no session (${session.status}): ${JSON.stringify(session.body)}`);
		process.exit(1);
	}
	log(`${stamp()} session ${sessionId}`);

	/* ---- kick off the pipeline -------------------------------------------- */
	const started2 = await call('/api/produce', {
		method: 'POST',
		body: JSON.stringify({
			sessionId,
			voiceId: VOICE,
			fileName: path.basename(PDF),
			dataBase64: bytes.toString('base64'),
		}),
	});
	if (started2.status !== 200 && started2.status !== 202) {
		log(`FATAL: produce refused (${started2.status}): ${JSON.stringify(started2.body)}`);
		process.exit(1);
	}
	const jobId = started2.body?.jobId;
	log(`${stamp()} job accepted: ${jobId}`);
	if (started2.body?.downloadUrl) log(`${stamp()} downloadUrl: ${started2.body.downloadUrl}`);

	/* ---- poll -------------------------------------------------------------- */
	let lastLine = '';
	while (true) {
		await new Promise((r) => setTimeout(r, 20000));
		const job = await call(`/api/job/${jobId}`);
		const status = job.body?.status;
		const logs = job.body?.log || [];
		const newest = logs[logs.length - 1];
		// Only print when something changed: a 30-minute job otherwise produces
		// hundreds of identical lines.
		if (newest && newest !== lastLine) {
			lastLine = newest;
			log(`${stamp()} ${newest}`);
		}
		if (status === 'done' || status === 'complete' || status === 'error' || status === 'failed') {
			log(`${stamp()} FINAL status=${status}`);
			log(JSON.stringify({ status, error: job.body?.error, downloadUrl: job.body?.downloadUrl, fileName: job.body?.fileName, narrator: job.body?.narrator }, null, 2));
			fs.writeFileSync(
				path.join(__dirname, '..', '.produce-result.json'),
				JSON.stringify({ sessionId, jobId, ...job.body }, null, 2),
			);
			process.exit(status === 'done' || status === 'complete' ? 0 : 1);
		}
	}
};

main().catch((err) => {
	log(`FATAL: ${err.stack || err.message}`);
	process.exit(1);
});

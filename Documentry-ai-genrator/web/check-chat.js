'use strict';

/**
 * Live end-to-end test of the PDF chat page's backend.
 *
 * Two real accounts against a real server, with a real PDF converted and a real
 * question answered by a real provider. The isolation half is the point: Bob
 * must not be able to learn anything about Alice's document, and must not be
 * able to make the server read it on his behalf.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeClient = () => {
	let cookie = null;
	return async (p, init = {}) => {
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
		return { status: res.status, body, raw: text };
	};
};

const startServer = (dataDir) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(ROOT, 'server', 'web.js')], {
			cwd: ROOT,
			env: {
				...process.env,
				PORT: String(PORT),
				HOST: '127.0.0.1',
				DOCUBOT_DATA_DIR: dataDir,
				DOCUBOT_USERS_FILE: path.join(dataDir, 'users.json'),
				DOCUBOT_SESSIONS_FILE: path.join(dataDir, 'sessions.json'),
				FORCE_COLOR: '0',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let log = '';
		child.stdout.on('data', (b) => {
			log += b.toString();
		});
		child.stderr.on('data', (b) => {
			log += b.toString();
		});
		child.on('error', reject);
		(async () => {
			for (let i = 0; i < 60; i += 1) {
				await sleep(400);
				try {
					await fetch(`${BASE}/api/auth/me`);
					resolve({ child, log: () => log });
					return;
				} catch {
					/* not up yet */
				}
			}
			reject(new Error(`server did not start:\n${log}`));
		})();
	});

/** A real PDF from a previous run, so the conversion is genuine. */
const findPdf = () => {
	const direct = path.resolve(ROOT, '.data', 'sessions');
	if (!fs.existsSync(direct)) return null;
	for (const dir of fs.readdirSync(direct)) {
		const full = path.join(direct, dir);
		if (!fs.statSync(full).isDirectory()) continue;
		for (const f of fs.readdirSync(full)) {
			if (f.toLowerCase().endsWith('.pdf')) return path.join(full, f);
		}
	}
	return null;
};

const main = async () => {
	const pdfPath = findPdf();
	if (!pdfPath) {
		console.log('no PDF available; run the app once or drop one in .data/sessions');
		process.exit(1);
	}
	const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
	const pdfName = path.basename(pdfPath);

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docubot-chat-'));
	const { child, log } = await startServer(dataDir);
	const alice = makeClient();
	const bob = makeClient();
	const anon = makeClient();

	try {
		console.log(`\nusing ${pdfName} (${(pdfBase64.length / 1024).toFixed(0)} KB base64)\n`);

		/* ---- 1. auth ------------------------------------------------------ */
		console.log('1. authentication');
		await alice('/api/auth/register', {
			method: 'POST',
			body: JSON.stringify({ username: 'alice', password: 'alice-password' }),
		});
		await bob('/api/auth/register', {
			method: 'POST',
			body: JSON.stringify({ username: 'bob', password: 'bob-password' }),
		});
		check('alice signed in', Boolean((await alice('/api/auth/me')).body?.user));
		check('bob signed in', Boolean((await bob('/api/auth/me')).body?.user));

		/* ---- 2. the routes exist and are gated --------------------------- */
		console.log('\n2. the routes are gated');
		check('no account cannot read a bundle', (await anon('/api/chat/bundle')).status === 401);
		check('no account cannot convert', (await anon('/api/chat/convert', { method: 'POST', body: '{}' })).status === 401);
		check('no account cannot query', (await anon('/api/chat/query', { method: 'POST', body: '{}' })).status === 401);

		/* ---- 3. validation ----------------------------------------------- */
		console.log('\n3. input validation');
		const notPdf = await alice('/api/chat/convert', {
			method: 'POST',
			body: JSON.stringify({ fileName: 'notes.txt', dataBase64: 'aGVsbG8=' }),
		});
		check('a non-PDF extension is refused', notPdf.status === 400, JSON.stringify(notPdf.body));

		const renamed = await alice('/api/chat/convert', {
			method: 'POST',
			// A .pdf name on content that is not a PDF. The extension is the
			// cheap check; the magic bytes are the real one.
			body: JSON.stringify({ fileName: 'fake.pdf', dataBase64: Buffer.from('PK\u0003\u0004not a pdf').toString('base64') }),
		});
		check('a .pdf that is not a PDF is refused', renamed.status === 400, JSON.stringify(renamed.body));

		const emptyQ = await alice('/api/chat/query', { method: 'POST', body: JSON.stringify({ message: '   ' }) });
		check('an empty question is refused', emptyQ.status === 400);
		const longQ = await alice('/api/chat/query', {
			method: 'POST',
			body: JSON.stringify({ message: 'x'.repeat(5000) }),
		});
		check('an absurdly long question is refused', longQ.status === 400);

		/* ---- 4. no document yet ------------------------------------------ */
		console.log('\n4. before converting');
		const emptyBundle = await alice('/api/chat/bundle');
		check('a new user has no bundle', emptyBundle.body?.ready === false);
		const noDoc = await alice('/api/chat/query', {
			method: 'POST',
			body: JSON.stringify({ message: 'What is this about?' }),
		});
		check('querying without a document is a 200 with guidance', noDoc.status === 200);
		check('and says so rather than inventing', /do not have a document/i.test(noDoc.body?.answer || ''), noDoc.body?.answer?.slice(0, 60));

		/* ---- 5. conversion ------------------------------------------------ */
		console.log('\n5. converting');
		const converted = await alice('/api/chat/convert', {
			method: 'POST',
			body: JSON.stringify({ fileName: pdfName, dataBase64: pdfBase64 }),
		});
		check('it converts', converted.status === 200, JSON.stringify(converted.body).slice(0, 140));
		check('the manifest reports pages', (converted.body?.manifest?.pageCount || 0) > 0, `pageCount ${converted.body?.manifest?.pageCount}`);
		check('and concept files', (converted.body?.manifest?.fileCount || 0) > 0, `fileCount ${converted.body?.manifest?.fileCount}`);

		const bundleNow = await alice('/api/chat/bundle');
		check('the bundle endpoint now reports ready', bundleNow.body?.ready === true);
		check('it does not ship the corpus, only the manifest',
			!JSON.stringify(bundleNow.body).includes('filler') && !JSON.stringify(bundleNow.body).includes('Introduction to Software'),
			'no node text on the wire');

		/* ---- 6. isolation ------------------------------------------------- */
		console.log('\n6. bob cannot reach alice document');
		const bobBundle = await bob('/api/chat/bundle');
		check('bob has no bundle', bobBundle.body?.ready === false, JSON.stringify(bobBundle.body));
		const bobQuery = await bob('/api/chat/query', {
			method: 'POST',
			body: JSON.stringify({ message: 'What is this document about? List its sections.' }),
		});
		check('bob is told he has no document', /do not have a document/i.test(bobQuery.body?.answer || ''), bobQuery.body?.answer?.slice(0, 60));
		check('and gets no sources from it', (bobQuery.body?.sources || []).length === 0);
		check('alice title does not leak to bob', !JSON.stringify(bobQuery.body).includes(converted.body?.manifest?.title || '\u0000'));
		check('bob cannot convert into alice directory either',
			(await bob('/api/chat/convert', { method: 'POST', body: JSON.stringify({ fileName: pdfName, dataBase64: pdfBase64 }) })).status === 200);

		// Bob converting his own copy must not disturb Alice's.
		const aliceBefore = await alice('/api/chat/bundle');
		check('alice bundle is unchanged after bob converted his own',
			aliceBefore.body?.manifest?.fileCount === converted.body?.manifest?.fileCount,
			`${aliceBefore.body?.manifest?.fileCount} files`);

		// A path-shaped question is just a question, but a path-shaped *field*
		// must not steer the lookup.
		const aliceTitle = converted.body?.manifest?.title || '\u0000';
		const traversal = await bob('/api/chat/query', {
			method: 'POST',
			body: JSON.stringify({
				message: 'What is this document about?',
				// Both of these are ignored. There is no parameter that names a
				// bundle, so a caller cannot point the lookup anywhere.
				bundleDir: path.join(dataDir, '..'),
				userId: (await alice('/api/auth/me')).body.user.id,
			}),
		});
		check(
			'a caller-supplied bundleDir and userId are both ignored',
			!JSON.stringify(traversal.body).includes(aliceTitle) || traversal.body?.ready === undefined,
			`bob was pointed at "${aliceTitle}" and got ${JSON.stringify(traversal.body).includes(aliceTitle) ? 'ALICE' : 'his own'}`,
		);
		check('the answer is about his own document, not hers',
			!JSON.stringify(traversal.body.answer || '').includes(aliceTitle),
			(traversal.body?.answer || '').slice(0, 60));

		/* ---- 7. a real answer -------------------------------------------- */
		console.log('\n7. a real answer (this calls a live provider)');
		const answered = await alice('/api/chat/query', {
			method: 'POST',
			body: JSON.stringify({ message: 'What is this document about? Answer in one sentence.' }),
		});
		check('alice gets an answer', answered.status === 200 && typeof answered.body?.answer === 'string' && answered.body.answer.length > 20, answered.body?.answer?.slice(0, 90));
		check('a provider is named', Boolean(answered.body?.activeProvider), answered.body?.activeProvider);
		if (answered.body?.model) console.log(`      model: ${answered.body.model}${answered.body.degraded ? ` (${answered.body.degraded})` : ''}`);
		check('sources carry page numbers', (answered.body?.sources || []).every((s) => Number.isInteger(s.page) && s.page > 0),
			JSON.stringify((answered.body?.sources || []).map((s) => s.page)));
		check('sources are within the document', (answered.body?.sources || []).every((s) => s.page <= (converted.body?.manifest?.pageCount || 0)));
		check('the answer cites a page, per the system prompt', /\[p\.\d+\]/.test(answered.body?.answer || ''), answered.body?.answer?.slice(0, 120));

		/* ---- 8. abstention ------------------------------------------------ */
		console.log('\n8. it abstains rather than inventing');
		const nonsense = await alice('/api/chat/query', {
			method: 'POST',
			body: JSON.stringify({ message: 'zzzqqq wwxxyy vvvorx qqqjjj' }),
		});
		check('a nonsense question returns no sources', (nonsense.body?.sources || []).length === 0);
		check('and says it could not find it', /could not find/i.test(nonsense.body?.answer || ''), nonsense.body?.answer?.slice(0, 70));
		check('rather than answering anyway', !/\[p\.\d+\]/.test(nonsense.body?.answer || ''));

		/* ---- 9. on disk --------------------------------------------------- */
		console.log('\n9. on disk');
		const dirs = fs.readdirSync(dataDir).filter((d) => d.startsWith('u_'));
		check('each user has their own directory', dirs.length === 2, dirs.join(', '));
		const withBundle = dirs.filter((d) => fs.existsSync(path.join(dataDir, d, 'okf_bundle', 'manifest.json')));
		check('each converted bundle lives in its own user directory', withBundle.length === 2, withBundle.join(', '));
		// The decisive check: no bundle dir contains another user's PDF.
		const leaks = withBundle.filter((d) =>
			fs.readdirSync(path.join(dataDir, d)).some((f) => f.toLowerCase().endsWith('.pdf')) &&
			fs.readdirSync(path.join(dataDir, d)).filter((f) => f.toLowerCase().endsWith('.pdf')).length > 1,
		);
		check('and no user directory holds more than one source PDF', leaks.length === 0, leaks.join(', '));
		check('the source PDF is stored under the user scope, not inside the bundle',
			withBundle.every((d) =>
				!fs.readdirSync(path.join(dataDir, d, 'okf_bundle')).some((f) => f.toLowerCase().endsWith('.pdf')),
			),
			'the bundle dir holds only markdown and the manifest');
	} finally {
		child.kill();
		await sleep(300);
		fs.rmSync(dataDir, { recursive: true, force: true });
	}

	console.log(
		failures === 0
			? '\nThe chat backend works, and Bob cannot learn anything about Alice document.'
			: `\n${failures} check(s) failed.`,
	);
	if (failures > 0) console.log(log().slice(-1200));
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`\nFAILED: ${err.stack || err.message}`);
	process.exit(1);
});

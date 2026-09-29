'use strict';

/**
 * End-to-end check of the auth gate, the narrator library route, and the
 * one-button produce route, against a live server.
 *
 * Starts server/web.js on a spare port with a throwaway data directory, then
 * drives it with real HTTP. What it proves that unit checks cannot: that the
 * server actually returns 401 for an anonymous call, that a session cookie is
 * issued and accepted, and that /api/produce is reachable only once signed in.
 *
 * Usage: node web/check-server-auth.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fetch that keeps the session cookie between calls, like a browser would. */
const makeClient = () => {
	let cookie = null;
	return async (path, options = {}) => {
		const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
		if (cookie) headers.Cookie = cookie;
		const res = await fetch(`${BASE}${path}`, { ...options, headers });
		const setCookie = res.headers.get('set-cookie');
		if (setCookie) cookie = setCookie.split(';')[0];
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return { status: res.status, body, setCookie };
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
				// Keep the throwaway store out of the real one.
				DOCUBOT_DATA_DIR: dataDir,
				DOCUBOT_USERS_FILE: path.join(dataDir, 'users.json'),
				DOCUBOT_SESSIONS_FILE: path.join(dataDir, 'sessions.json'),
				FORCE_COLOR: '0',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (b) => {
			out += b.toString();
		});
		child.stderr.on('data', (b) => {
			out += b.toString();
		});
		child.on('error', reject);
		// Poll rather than parse the banner, which is not contractual.
		(async () => {
			for (let i = 0; i < 60; i += 1) {
				await sleep(400);
				try {
					await fetch(`${BASE}/api/auth/me`);
					resolve({ child, log: () => out });
					return;
				} catch {
					/* not up yet */
				}
			}
			reject(new Error(`server did not start:\n${out}`));
		})();
	});

const main = async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docubot-server-'));
	const { child, log } = await startServer(dataDir);
	const client = makeClient();

	try {
		/* ---- 1. the gate is closed by default ---------------------------- */
		console.log('\n1. unauthenticated access is refused');
		for (const route of ['/api/sessions', '/api/config']) {
			// /api/config is deliberately public; the rest are not.
			const res = await client(route);
			if (route === '/api/config') {
				check(`${route} is reachable (it must be, for the sign-in screen)`, res.status === 200, `HTTP ${res.status}`);
			} else {
				check(`${route} is refused`, res.status === 401, `HTTP ${res.status}`);
			}
		}
		const post = await client('/api/produce', { method: 'POST', body: JSON.stringify({}) });
		check('POST /api/produce is refused', post.status === 401, `HTTP ${post.status}`);
		check('the refusal names the reason', /sign in/i.test(post.body?.error || ''), post.body?.error);
		const chat = await client('/api/chat', { method: 'POST', body: JSON.stringify({}) });
		check('POST /api/chat is refused', chat.status === 401, `HTTP ${chat.status}`);

		/* ---- 2. /api/auth/me is open, and honest ------------------------ */
		console.log('\n2. /api/auth/me before signing in');
		{
			const res = await client('/api/auth/me');
			check('it answers 200, not 401', res.status === 200, `HTTP ${res.status}`);
			check('it reports no user', res.body?.user === null, JSON.stringify(res.body));
		}

		/* ---- 3. registration and the session cookie --------------------- */
		console.log('\n3. registration');
		{
			const reg = await client('/api/auth/register', {
				method: 'POST',
				body: JSON.stringify({ username: 'shayan', password: 'a-good-password' }),
			});
			check('it creates the account', reg.status === 201, `HTTP ${reg.status} ${reg.body?.error || ''}`);
			check('it returns the user', reg.body?.user?.username === 'shayan');
			check('it never returns a hash', !JSON.stringify(reg.body).includes('scrypt$'));
			check('it sets a session cookie', Boolean(reg.setCookie), reg.setCookie);
			check('the cookie is httpOnly', /HttpOnly/i.test(reg.setCookie || ''), reg.setCookie);
			check('the cookie is SameSite=Lax', /SameSite=Lax/i.test(reg.setCookie || ''));

			const weak = await client('/api/auth/register', {
				method: 'POST',
				body: JSON.stringify({ username: 'weakling', password: 'short' }),
			});
			check('a short password is rejected', weak.status === 400, weak.body?.error);
		}

		/* ---- 4. the gate is now open ------------------------------------ */
		console.log('\n4. the same routes with a session');
		{
			const list = await client('/api/sessions');
			check('GET /api/sessions now works', list.status === 200, `HTTP ${list.status}`);
			check('it returns a list', Array.isArray(list.body?.sessions));

			const session = await client('/api/session', { method: 'POST', body: JSON.stringify({}) });
			check('a session can be created', session.status === 201, `HTTP ${session.status}`);
			check('it has an id', /^sess_[a-f0-9]{18}$/.test(session.body?.sessionId || ''), session.body?.sessionId);

			const cfg = await client('/api/config');
			check('config carries the voice library', 'voiceLibrary' in (cfg.body || {}));
			const lib = cfg.body?.voiceLibrary;
			check('the library reports availability', typeof lib?.available === 'boolean', `available=${lib?.available}`);
			if (lib?.available) {
				check('it has voices', lib.voices.length > 0, `${lib.voices.length}`);
				check('every voice has a transcript', lib.voices.every((v) => v.refText));
				check('every voice has a label', lib.voices.every((v) => v.accentLabel));
			} else {
				check('it explains how to build it', /voice:library/.test(lib?.note || ''), lib?.note);
			}
		}

		/* ---- 5. validation is real -------------------------------------- */
		console.log('\n5. login validation');
		{
			const bad = await client('/api/auth/login', {
				method: 'POST',
				body: JSON.stringify({ username: 'shayan', password: 'wrong-password' }),
			});
			check('a wrong password is refused', bad.status === 401, bad.body?.error);
			check('the message does not confirm the username exists',
				!/taken|exists/i.test(bad.body?.error || ''), bad.body?.error);

			const missing = await client('/api/auth/login', {
				method: 'POST',
				body: JSON.stringify({ username: 'ghost', password: 'whatever-x' }),
			});
			check('an unknown user gives the same message',
				missing.body?.error === bad.body?.error, missing.body?.error);

			const empty = await client('/api/auth/login', { method: 'POST', body: JSON.stringify({}) });
			check('an empty body is a 401, not a crash', empty.status === 401, `HTTP ${empty.status}`);

			const garbage = await fetch(`${BASE}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{not json',
			});
			check('malformed JSON is a 400, not a crash', garbage.status === 400, `HTTP ${garbage.status}`);
		}

		/* ---- 6. logout closes it again ---------------------------------- */
		console.log('\n6. logout');
		{
			await client('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
			const after = await client('/api/sessions');
			check('the gate is closed again', after.status === 401, `HTTP ${after.status}`);

			// And signing back in works, so it is a session and not a dead end.
			const back = await client('/api/auth/login', {
				method: 'POST',
				body: JSON.stringify({ username: 'shayan', password: 'a-good-password' }),
			});
			check('signing in again works', back.status === 200, `HTTP ${back.status}`);
			const reopened = await client('/api/sessions');
			check('and the gate reopens', reopened.status === 200, `HTTP ${reopened.status}`);
		}

		/* ---- 7. an unknown narrator is a 400, not a silent swap -------- */
		console.log('\n7. narrator selection');
		{
			const session = await client('/api/session', { method: 'POST', body: JSON.stringify({}) });
			const sid = session.body?.sessionId;
			const bad = await client('/api/produce', {
				method: 'POST',
				body: JSON.stringify({ sessionId: sid, voiceId: 'not_a_real_voice' }),
			});
			// The PDF check may fire first, which is also a fine rejection; what
			// matters is that it is a 4xx and not a 200 with a different voice.
			check('an unknown narrator is refused with a 4xx', bad.status >= 400 && bad.status < 500,
				`HTTP ${bad.status} ${bad.body?.error || ''}`);
		}
	} finally {
		child.kill();
		await sleep(300);
		fs.rmSync(dataDir, { recursive: true, force: true });
	}

	console.log(failures === 0 ? '\nAll server auth checks passed.' : `\n${failures} check(s) failed.`);
	if (failures > 0) console.log(log().slice(-800));
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`\nFAILED: ${err.stack || err.message}`);
	process.exit(1);
});

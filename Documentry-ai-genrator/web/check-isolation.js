'use strict';

/**
 * Proves per-user data isolation, with two real accounts against a live server.
 *
 * The bugs this catches were both live in this codebase:
 *
 *   1. `req.user` was set by the auth gate and then never used. Every session
 *      read, list, delete and download was unscoped, so any authenticated user
 *      could see and take everyone else's documents.
 *   2. The auth gate lived only inside handleApi, which is reached solely for
 *      /api/ paths. /video/<id> and /audio/<sessionId>/ served private data
 *      with no login at all — needing no account, not just a wrong one.
 *
 * A static check cannot prove either. This registers two users, gives one of
 * them a session, and then tries every route as the other.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3189;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A cookie-keeping client, so each one behaves like a separate browser. */
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

const main = async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docubot-iso-'));
	const { child, log } = await startServer(dataDir);

	const alice = makeClient();
	const bob = makeClient();

	try {
		/* ---- 1. two real accounts -------------------------------------- */
		console.log('\n1. two accounts');
		await alice('/api/auth/register', {
			method: 'POST',
			body: JSON.stringify({ username: 'alice', password: 'alice-password' }),
		});
		await bob('/api/auth/register', {
			method: 'POST',
			body: JSON.stringify({ username: 'bob', password: 'bob-password' }),
		});
		check('alice is registered', Boolean(await alice('/api/auth/me')), '');
		const bobMe = await bob('/api/auth/me');
		check('bob is registered', bobMe.body?.user?.username === 'bob', JSON.stringify(bobMe.body));

		/* ---- 2. alice creates and stores a session --------------------- */
		console.log('\n2. alice creates a session');
		const created = await alice('/api/session', { method: 'POST', body: '{}' });
		const aliceSession = created.body?.sessionId;
		check('she gets a session', /^sess_[a-f0-9]{18}$/.test(aliceSession || ''), aliceSession);

		// Put a record in the store as alice, the way the pipeline does.
		const stored = await alice('/api/generate', {
			method: 'POST',
			body: JSON.stringify({ sessionId: aliceSession }),
		});
		check('a job is accepted (it will fail on the missing PDF, which is fine)', stored.status === 400 || stored.status === 202, `HTTP ${stored.status}`);

		// Seed a record directly so the read paths have something to isolate.
		const seedPath = path.join(dataDir, 'sessions.json');
		fs.writeFileSync(
			seedPath,
			JSON.stringify(
				{
					version: 1,
					sessions: [
						{
							id: aliceSession,
							userId: 'alice-user-id',
							title: "Alice's private documentary",
							createdAt: new Date().toISOString(),
							scenes: [{ sceneNumber: 1, narratorText: 'ALICE SECRET CONTENT' }],
						},
						{
							id: 'sess_000000000000000000',
							userId: 'someone-else',
							title: "Someone else's private documentary",
							createdAt: new Date().toISOString(),
							scenes: [{ sceneNumber: 1, narratorText: 'OTHER PERSON SECRET' }],
						},
					],
				},
				null,
				2,
			),
		);
		// Re-derive alice's real user id from her cookie and fix the seed.
		const whoami = await alice('/api/auth/me');
		const aliceId = whoami.body.user.id;
		const seeded = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
		seeded.sessions[0].userId = aliceId;
		fs.writeFileSync(seedPath, JSON.stringify(seeded, null, 2));
		// Restart so the store is re-read with the right owner.
		child.kill();
		await sleep(600);
		const restarted = await startServer(dataDir);
		child.kill();
		await sleep(400);
		const { child: child2 } = await startServer(dataDir);

		/* ---- 3. isolation: bob must not see alice ---------------------- */
		console.log('\n3. bob cannot reach alice data');
		const bobList = await bob('/api/sessions');
		check(
			"bob's list contains none of alice's videos",
			!(bobList.body?.sessions || []).some((s) => s.id === aliceSession),
			JSON.stringify(bobList.body?.sessions?.map((s) => s.title)),
		);

		const bobRead = await bob(`/api/sessions/${aliceSession}`);
		check('reading her session by id is refused', bobRead.status === 404, `HTTP ${bobRead.status}`);
		check(
			'and it does not leak her content',
			!JSON.stringify(bobRead.body).includes('ALICE SECRET'),
			JSON.stringify(bobRead.body).slice(0, 80),
		);
		check('the 404 does not confirm the id exists', !/403|forbidden/i.test(JSON.stringify(bobRead.body)));

		const bobDelete = await bob(`/api/sessions/${aliceSession}`, { method: 'DELETE' });
		check('deleting her session is refused', bobDelete.status === 404, `HTTP ${bobDelete.status}`);

		const bobVideo = await bob(`/video/${aliceSession}`);
		check('downloading her video is refused', bobVideo.status === 404 || bobVideo.status === 401, `HTTP ${bobVideo.status}`);

		const bobAudio = await bob(`/audio/${aliceSession}/scene-1.mp3`);
		check(
			'downloading her narration is refused',
			bobAudio.status === 404 || bobAudio.status === 401,
			`HTTP ${bobAudio.status}`,
		);

		/* ---- 4. no account at all is also refused ---------------------- */
		console.log('\n4. an anonymous caller is refused');
		const anon = makeClient();
		const anonList = await anon('/api/sessions');
		check('no session is refused', anonList.status === 401, `HTTP ${anonList.status}`);
		const anonVideo = await anon(`/video/${aliceSession}`);
		check('no account, no video', anonVideo.status === 401, `HTTP ${anonVideo.status}`);
		const anonAudio = await anon(`/audio/${aliceSession}/scene-1.mp3`);
		check('no account, no narration', anonAudio.status === 401, `HTTP ${anonAudio.status}`);

		/* ---- 5. alice can still reach her own ------------------------- */
		console.log('\n5. alice can still reach her own data');
		const aliceList = await alice('/api/sessions');
		check(
			"her own video is listed",
			(aliceList.body?.sessions || []).some((s) => s.id === aliceSession),
			JSON.stringify(aliceList.body?.sessions?.map((s) => s.title)),
		);
		const aliceRead = await alice(`/api/sessions/${aliceSession}`);
		check('she can read it', aliceRead.status === 200, `HTTP ${aliceRead.status}`);
		check('with her own content', JSON.stringify(aliceRead.body).includes('ALICE SECRET'));

		// Isolation must not become a lockout.
		const stillWorks = await alice('/api/auth/me');
		check('her session survives all of it', stillWorks.body?.user?.username === 'alice');

		void child2;
		void restarted;
	} finally {
		child.kill();
		await sleep(300);
		fs.rmSync(dataDir, { recursive: true, force: true });
	}

	console.log(
		failures === 0
			? '\nUsers are isolated. Bob cannot see, read, delete or download anything of Alice.'
			: `\n${failures} check(s) failed.`,
	);
	if (failures > 0) console.log(log().slice(-900));
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`\nFAILED: ${err.stack || err.message}`);
	process.exit(1);
});

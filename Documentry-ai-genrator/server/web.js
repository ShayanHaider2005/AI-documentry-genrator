'use strict';

/**
 * web.js — Public website + JSON API for the AI Documentary engine.
 *
 * Zero runtime dependencies (Node's built-in http). Serves the React frontend
 * from web/dist and exposes:
 *
 *   GET  /                      → the app
 *   GET  /api/config            → voice sample sentences + capability flags
 *   POST /api/session           → create a session
 *   POST /api/upload/pdf        → upload + sanitize the source PDF
 *   POST /api/upload/voice      → upload an MP3 and clone the voice
 *   POST /api/chat              → chatbot Q&A grounded in the uploaded PDF
 *   POST /api/generate          → start a generation job
 *   POST /api/render            → start an MP4 render job
 *   GET  /api/job/:id           → job status, logs and result
 *   GET  /api/session/:id       → current session snapshot (dataset, etc.)
 *   GET  /audio/*               → generated narration
 *   GET  /video/:id             → rendered MP4
 *
 * Run: node server/web.js   (PORT defaults to 3100)
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { runPipeline } = require('./pipeline');
const { parseAndCleanPdf } = require('./parsePdf');
const { createDb } = require('./db');
const {
	prepareClientVoice,
	defaultVoicePath,
	VOICE_SAMPLE_SENTENCES,
	VOICE_SAMPLE_SCRIPT,
	DEFAULT_EDGE_VOICE,
	DEFAULT_VOICE_LABEL,
} = require('./tts');
const { chatCompletion, getAiProvider } = require('./llm');
const { convertToOkf, readBundle, bundleDir: okfBundleDir } = require('./chat/okf');
const { answerQuestion } = require('./chat/query');
const { renderVideo } = require('./render');
const omnivoice = require('./omnivoice');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
// Overridable so a test can run a throwaway instance without touching the real
// session store, the user store, or the rendered videos.
const DATA_DIR = process.env.DOCUBOT_DATA_DIR
	? path.resolve(process.env.DOCUBOT_DATA_DIR)
	: path.join(ROOT, '.data', 'sessions');
const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MB (base64 inflates by ~33%)

/** Persistent history of generated videos (single JSON file). */
const db = createDb();
const { createAuth, parseCookies, COOKIE_NAME, SESSION_TTL_MS: AUTH_TTL_MS } = require('./auth');
const { readVoiceLibrary, defaultLibraryVoice, voiceById } = require('./voices');

const auth = createAuth();

/**
 * Routes reachable without a session.
 *
 * `/api/config` and `/api/auth/me` are here on purpose: the sign-in screen
 * reads config to report whether voice cloning is up, and `me` is how the client
 * decides whether to show the login page at all.
 */
const PUBLIC_ROUTES = new Set([
	'/api/config',
	'/api/auth/register',
	'/api/auth/login',
	'/api/auth/logout',
	'/api/auth/me',
]);

const sessionToken = (req) => parseCookies(req.headers?.cookie)[COOKIE_NAME] || null;

/**
 * The library voice to narrate with, or null to keep the previous default.
 *
 * An unknown id is a client error, not a silent fallback: the user picked a
 * narrator and would otherwise get a different voice with no explanation.
 */
const resolveLibraryVoice = (voiceId) => {
	const wanted = String(voiceId || '').trim();
	if (!wanted) return voiceById(defaultLibraryVoice());
	const found = voiceById(wanted);
	if (!found) {
		throw Object.assign(new Error(`Unknown narrator "${wanted}".`), { status: 400 });
	}
	return found;
};

/** httpOnly so page scripts cannot read the token, and SameSite=Lax for CSRF. */
const sessionCookie = (token) =>
	`${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
		AUTH_TTL_MS / 1000,
	)}`;

const clearSessionCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.pdf': 'application/pdf',
};

// ---------------------------------------------------------------------------
// Session + job stores (in-memory; files persist under .data/sessions)
// ---------------------------------------------------------------------------
const sessions = new Map();
const jobs = new Map();

/** Working sessions (uploads in progress) expire so a public site cannot leak memory. */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 120) * 60 * 1000;
let lastSweep = 0;

/** Only one Remotion render at a time: each render spawns a Chrome process. */
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 1);

/** Very small fixed-window limiter, enough to stop casual abuse of costly routes. */
const RATE_LIMIT = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);

const rateLimited = (key) => {
	const now = Date.now();
	const entry = RATE_LIMIT.get(key);

	if (!entry || now > entry.resetAt) {
		RATE_LIMIT.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return false;
	}
	entry.count += 1;
	return entry.count > RATE_MAX;
};

const sweepSessions = () => {
	const now = Date.now();
	if (now - lastSweep < 60 * 1000) return;
	lastSweep = now;

	// Drop the rate-limit buckets that have expired.
	for (const [key, entry] of RATE_LIMIT) {
		if (now > entry.resetAt) RATE_LIMIT.delete(key);
	}

	// Evict idle working sessions. Finished videos are persisted in db, and any
	// on-disk artefacts are cleaned up with them. The owner comes from the
	// session record, not from anywhere the caller controls.
	for (const [id, session] of sessions) {
		if (session.lastUsed && now - session.lastUsed > SESSION_TTL_MS) {
			sessions.delete(id);
			fs.rm(sessionDir(id, session.userId), { recursive: true, force: true }, () => {});
			fs.rm(path.join(PUBLIC_DIR, 'audio', id), { recursive: true, force: true }, () => {});
		}
	}
};

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
const isValidId = (id) => typeof id === 'string' && /^[a-z]+_[a-f0-9]{18}$/.test(id);

/**
 * Whether this user owns the working session.
 *
 * Without this check any authenticated user could read another user's uploaded
 * document, chat history and rendered video by guessing or stealing a session
 * id. Session ids are 18 hex characters, so they are not guessable in
 * practice, but obscurity is not access control: an id leaks through a shared
 * link, a screenshot, or a log file, and the API is the only thing standing
 * between that and someone else's document.
 */
const ownsSession = (session, user) =>
	Boolean(session && user && session.userId === user.id);

/**
 * A working session, only if the caller owns it.
 *
 * Every route that touches session data goes through here, so the check cannot
 * be forgotten in a new handler. A missing or unknown id and someone else's id
 * both return null, and the callers turn that into a 404 — deliberately the
 * same response, because a 403 would confirm the id exists.
 */
const getSession = (id, user) => {
	const session = isValidId(id) ? sessions.get(id) : undefined;
	if (!ownsSession(session, user)) return null;
	session.lastUsed = Date.now();
	return session;
};

/**
 * Where a session's files live.
 *
 * Scoped under the owning user, so a path traversal or a stray absolute path
 * cannot reach another user's directory, and so a whole account can be removed
 * in one `rm`. `userId` comes from the session record, never from the URL.
 */
const sessionDir = (id, userId) => path.join(DATA_DIR, userDirName(userId), id);

/**
 * Everything belonging to one user: their sessions, their rendered videos and
 * their converted documents all hang off this one directory.
 *
 * Single definition on purpose. Two implementations of the `u_<hash>` naming
 * that drift apart would put one user's files where the other code expects to
 * find its own, and the resulting bug is a cross-user data leak that no type
 * checker would catch.
 */
const userDataDir = (userId) => path.join(DATA_DIR, userDirName(userId));

/**
 * The per-user directory name.
 *
 * Hashes the id rather than using it raw: a user id is a UUID, and putting one
 * in a path is an invitation to encode the traversal characters. Six hex
 * characters is ample for a local single-user-per-directory store, and the
 * mapping is stable so a restart finds the same directory.
 */
const userDirName = (userId) => {
	if (!userId) return '_orphan';
	return `u_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12)}`;
};

function createSession(user) {
	const id = newId('sess');
	const dir = sessionDir(id, user.id);
	fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
	const session = {
		id,
		// The owner. Nothing may create a session without one.
		userId: user.id,
		createdAt: new Date().toISOString(),
		lastUsed: Date.now(),
		pdf: null,
		cleanText: '',
		voice: null,
		dataset: null,
		renderPath: null,
	};
	sessions.set(id, session);
	sweepSessions();
	return session;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload, extraHeaders = {}) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store',
		...extraHeaders,
	});
	res.end(body);
}

function sendText(res, status, text) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end(text);
}

/** Serve a file, refusing any path that escapes `rootDir`. */
function serveFile(res, rootDir, urlPath, { download = null, cacheControl = null } = {}) {
	const decoded = decodeURIComponent(urlPath.split('?')[0]);
	const target = path.resolve(rootDir, `.${path.posix.normalize(decoded)}`);

	if (target !== rootDir && !target.startsWith(rootDir + path.sep)) {
		return sendText(res, 403, 'Forbidden');
	}
	if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
		return sendText(res, 404, 'Not found');
	}

	const ext = path.extname(target).toLowerCase();
	const headers = {
		'Content-Type': MIME[ext] || 'application/octet-stream',
		'Content-Length': fs.statSync(target).size,
	};
	if (download) {
		headers['Content-Disposition'] = `attachment; filename="${download}"`;
	} else if (cacheControl) {
		headers['Cache-Control'] = cacheControl;
	} else if (ext === '.html') {
		headers['Cache-Control'] = 'no-store';
	} else {
		headers['Cache-Control'] = 'public, max-age=300';
	}

	res.writeHead(200, headers);
	fs.createReadStream(target).pipe(res);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('Payload too large (limit 64 MB)'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (err) {
				reject(new Error(`Invalid JSON body: ${err.message}`));
			}
		});
		req.on('error', reject);
	});
}

/**
 * Parse a small JSON body, for the auth routes.
 *
 * readBody allows 64 MB, which is right for a PDF upload and absurd for a login.
 * A missing body is an empty object rather than an error, so a blank form posts
 * cleanly and fails validation with a useful message instead of a parse error.
 */
function readJsonBody(req, limitBytes = 8 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				reject(Object.assign(new Error('Request body too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim();
			if (!raw) return resolve({});
			try {
				const parsed = JSON.parse(raw);
				resolve(parsed && typeof parsed === 'object' ? parsed : {});
			} catch {
				reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}

/** Decode a base64 upload into a Buffer, guarding against garbage input. */
function decodeUpload(dataBase64) {
	if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
		throw new Error('Missing file data');
	}
	const base64 = dataBase64.includes(',') ? dataBase64.split(',').pop() : dataBase64;
	const buffer = Buffer.from(base64, 'base64');
	if (buffer.length === 0) throw new Error('Uploaded file is empty');
	return buffer;
}

/** Strip any path information from a client-supplied file name. */
const safeFileName = (name, fallback) => {
	const base = path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_');
	return base && base.length > 3 ? base.slice(0, 80) : fallback;
};

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------
function createJob(type, sessionId) {
	const job = {
		id: newId('job'),
		type,
		sessionId,
		status: 'running',
		logs: [],
		progress: 0,
		createdAt: Date.now(),
		result: null,
		error: null,
	};
	jobs.set(job.id, job);

	// Keep the in-memory job table from growing without bound.
	if (jobs.size > 100) {
		const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
		if (oldest) jobs.delete(oldest.id);
	}
	return job;
}

const jobLog = (job, text, progress = null) => {
	job.logs.push(text);
	if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
	if (progress && Number.isFinite(progress.percent)) {
		job.progress = Math.max(job.progress, progress.percent);
	}
};

function runJob(job, work) {
	work()
		.then((result) => {
			job.status = 'done';
			job.result = result;
			job.progress = 100;
		})
		.catch((err) => {
			job.status = 'error';
			job.error = err.message;
			jobLog(job, `ERROR: ${err.message}`);
		});
	return job;
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
const CHAT_SYSTEM_PROMPT = `You are DocuBot, an AI assistant built into an automated documentary generator.
You help a user understand their uploaded lecture document and plan a narrated video from it.

Rules:
- Answer strictly from the SOURCE DOCUMENT provided. If the answer is not in it, say so plainly.
- Be concise and practical: 2-5 sentences, or a short bullet list when it genuinely helps.
- Never invent course codes, instructor names, emails, room numbers or grading policies.
- Never use markdown fences. Plain text only.
- If asked how the generator works, briefly explain: it sanitizes the PDF, writes an 8-12 scene documentary script, fetches stock visuals, synthesizes narration (optionally in a cloned client voice), and renders it with Remotion.`;

async function handleApi(req, res, url) {
	const route = url.pathname;

	// Throttle the expensive routes. Cheap reads stay unthrottled.
	const COSTLY = [
		'/api/generate',
		'/api/render',
		'/api/upload/pdf',
		'/api/upload/voice',
		'/api/chat',
		'/api/chat/convert',
		'/api/chat/query',
	];
	if (COSTLY.includes(route)) {
		const key = `${route}:${req.socket.remoteAddress || 'unknown'}`;
		if (rateLimited(key)) {
			return sendJson(res, 429, {
				error: 'Too many requests. Please wait a moment and try again.',
			});
		}
	}

	// ── Auth gateway ───────────────────────────────────────────────────────
	// Everything above the login page is gated. /api/config is deliberately
	// reachable without a session: the sign-in screen needs to know whether
	// voice cloning is up in order to explain itself honestly.
	if (!PUBLIC_ROUTES.has(route) && !PUBLIC_ROUTES.has(`${req.method} ${route}`)) {
		const user = auth.verify(sessionToken(req));
		if (!user) {
			return sendJson(res, 401, {
				error: 'Sign in to continue.',
				code: 'unauthenticated',
			});
		}
		req.user = user;
	}

	// ── GET /api/config ────────────────────────────────────────────────────
	if (route === '/api/config' && req.method === 'GET') {
		const provider = getAiProvider();
		// Voice cloning is local, so ask the service instead of checking a key.
		const health = await omnivoice.serviceHealth();
		return sendJson(res, 200, {
			voiceSampleSentences: VOICE_SAMPLE_SENTENCES,
			voiceSampleScript: VOICE_SAMPLE_SCRIPT,
			fallbackVoice: DEFAULT_EDGE_VOICE,
			voiceCloningAvailable: Boolean(health.reachable && health.body?.ready),
			voiceEngine: 'OmniVoice (local)',
			voiceLoading: Boolean(health.body?.loading),
			voiceError: health.reachable ? health.body?.error || null : omnivoice.serviceDownReason(health.body),
			defaultVoiceAvailable: Boolean(defaultVoicePath()),
			defaultVoiceLabel: DEFAULT_VOICE_LABEL,
			// The generated library, so a user with no sample of their own can
			// still pick a narrator instead of getting one fixed default.
			voiceLibrary: readVoiceLibrary(),
			chatEnabled: Boolean(provider),
			llmProvider: provider ? provider.name : null,
		});
	}

	// ── Auth routes ────────────────────────────────────────────────────────
	if (route === '/api/auth/register' && req.method === 'POST') {
		try {
			const body = await readJsonBody(req);
			const { token, user } = await auth.register(body || {});
			return sendJson(res, 201, { user }, { 'Set-Cookie': sessionCookie(token) });
		} catch (err) {
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}

	if (route === '/api/auth/login' && req.method === 'POST') {
		try {
			const body = await readJsonBody(req);
			const { token, user } = await auth.login(body || {});
			return sendJson(res, 200, { user }, { 'Set-Cookie': sessionCookie(token) });
		} catch (err) {
			// A malformed body is the client's mistake, not a server fault: report
			// it as the 400 it already carries rather than letting it fall through
			// to the catch-all and become a 500.
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}

	if (route === '/api/auth/logout' && req.method === 'POST') {
		const token = sessionToken(req);
		if (token) await auth.logout(token);
		return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
	}

	if (route === '/api/auth/me' && req.method === 'GET') {
		// Unguarded on purpose: the client calls it on boot to decide whether to
		// show the login page, and a 401 here is a normal answer, not an error.
		const user = auth.verify(sessionToken(req));
		return sendJson(res, 200, { user });
	}

	// ── POST /api/session ──────────────────────────────────────────────────
	if (route === '/api/session' && req.method === 'POST') {
		const session = createSession(req.user);
		return sendJson(res, 201, { sessionId: session.id });
	}

	// ── GET /api/session/:id ───────────────────────────────────────────────
	let match = /^\/api\/session\/([^/]+)$/.exec(route);
	if (match && req.method === 'GET') {
		const session = getSession(match[1], req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });
		return sendJson(res, 200, {
			sessionId: session.id,
			pdf: session.pdf,
			voice: session.voice,
			hasDataset: Boolean(session.dataset),
			dataset: session.dataset,
			renderPath: session.renderPath,
		});
	}

	// ── POST /api/upload/pdf ───────────────────────────────────────────────
	if (route === '/api/upload/pdf' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId, req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });

		const fileName = safeFileName(body.fileName, 'source.pdf');
		const buffer = decodeUpload(body.dataBase64);
		if (!/\.pdf$/i.test(fileName)) {
			return sendJson(res, 400, { error: 'Please upload a PDF file.' });
		}

		const pdfPath = path.join(sessionDir(session.id, session.userId), fileName);
		fs.writeFileSync(pdfPath, buffer);

		const cleanText = await parseAndCleanPdf(pdfPath);
		if (!cleanText.trim()) {
			return sendJson(res, 422, {
				error:
					'No usable text found in that PDF. It may be a scan — try a PDF with selectable text.',
			});
		}

		session.pdf = { fileName, bytes: buffer.length, characters: cleanText.length };
		session.cleanText = cleanText;

		return sendJson(res, 200, {
			fileName,
			characters: cleanText.length,
			preview: cleanText.slice(0, 900),
		});
	}

	// ── POST /api/upload/voice ─────────────────────────────────────────────
	if (route === '/api/upload/voice' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId, req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });

		const fileName = safeFileName(body.fileName, 'voice-sample.mp3');
		const buffer = decodeUpload(body.dataBase64);
		// Browsers record to webm/opus (Chrome) or mp4 (Safari); MP3 stays the
		// best-supported format for cloning, so it is accepted alongside those.
		if (!/\.(mp3|wav|m4a|webm|ogg|opus)$/i.test(fileName)) {
			return sendJson(res, 400, {
				error: 'Please upload a voice sample (MP3, WAV, M4A, WEBM or OGG).',
			});
		}

		const samplePath = path.join(sessionDir(session.id, session.userId), fileName);
		fs.writeFileSync(samplePath, buffer);
		session.voiceSamplePath = samplePath;

		// OmniVoice clones per synthesis, so there is no embedding to capture
		// here. What we do is verify the sample is usable and remember its
		// transcript, which is passed with it on every later synthesis.
		let plan;
		try {
			plan = await prepareClientVoice(samplePath, VOICE_SAMPLE_SCRIPT);
		} catch (err) {
			session.voice = {
				status: 'error',
				voiceName: DEFAULT_EDGE_VOICE,
				voiceId: null,
				fileName,
				bytes: buffer.length,
				reason: err.message,
			};
			console.error(`[VOICE] ${err.message}`);
			return sendJson(res, 501, {
				error:
					'Your voice sample was saved, but it is NOT being used: voice cloning failed.',
				detail: err.message,
				voiceName: DEFAULT_EDGE_VOICE,
			});
		}

		// The client read the three fixed sentences, so its transcript is known.
		// If the service is down, fall back to letting Whisper transcribe.
		session.voiceSampleRefText = VOICE_SAMPLE_SCRIPT;
		session.voice = {
			status: plan.status,
			voiceName: plan.voiceLabel,
			voiceId: null,
			fileName,
			bytes: buffer.length,
			reason: plan.reason || null,
		};

		if (plan.status !== 'cloned') {
			return sendJson(res, 501, {
				error: `Your voice sample was saved, but it is NOT being used. ${
					plan.reason || 'Voice cloning is unavailable.'
				}`,
				detail: plan.reason || null,
				voiceName: plan.voiceLabel,
			});
		}

		return sendJson(res, 200, session.voice);
	}

	// ── POST /api/chat ─────────────────────────────────────────────────────
	if (route === '/api/chat' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId, req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });

		const message = String(body.message || '').trim();
		if (!message) return sendJson(res, 400, { error: 'Empty message' });

		if (!getAiProvider()) {
			return sendJson(res, 200, {
				reply:
					'AI chat is not configured on this server right now, so I cannot answer questions yet. Add a GEMINI_API_KEY, GROQ_API_KEY, GROK_API_KEY or OPENAI_API_KEY to the .env file and I will be able to discuss your document with you. Everything else — uploading your PDF, cloning your voice and rendering the video — still works without it.',
				provider: null,
			});
		}

		const source = session.cleanText
			? session.cleanText.slice(0, 24000)
			: '(The user has not uploaded a document yet.)';

		const result = await chatCompletion({
			system: CHAT_SYSTEM_PROMPT,
			user: `SOURCE DOCUMENT:\n"""\n${source}\n"""\n\nUSER QUESTION: ${message}`,
		});

		return sendJson(res, 200, { reply: result.text, provider: result.provider });
	}

	// ── GET /api/chat/bundle ─────────────────────────────────────────────────
	// Whether this user has a converted document, so the page can restore its
	// state on reload instead of showing an empty dropzone over a full index.
	if (route === '/api/chat/bundle' && req.method === 'GET') {
		const dir = okfBundleDir(userDataDir(req.user.id));
		const bundle = await readBundle(dir);
		return sendJson(res, 200, {
			ready: Boolean(bundle),
			// The manifest only, never the node text: this is a status endpoint,
			// and shipping the whole corpus to render a status line would put the
			// document on the wire for no reason.
			manifest: bundle
				? {
						title: bundle.manifest.title,
						source: bundle.manifest.source,
						pageCount: bundle.manifest.pageCount,
						fileCount: bundle.manifest.fileCount,
						generated: bundle.manifest.generated,
					}
				: null,
		});
	}

	// ── POST /api/chat/convert ───────────────────────────────────────────────
	if (route === '/api/chat/convert' && req.method === 'POST') {
		const body = await readBody(req);
		const fileName = safeFileName(body.fileName, 'document.pdf');
		if (!/\.pdf$/i.test(fileName)) {
			return sendJson(res, 400, { error: 'Please upload a PDF.' });
		}

		const buffer = decodeUpload(body.dataBase64);
		if (!buffer || buffer.length < 5) {
			return sendJson(res, 400, { error: 'That file was empty.' });
		}
		// The magic bytes, not the extension. A rename is trivial and the parser
		// would otherwise be handed a zip or an image and fail with something
		// unhelpful.
		if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
			return sendJson(res, 400, { error: 'That file is not a PDF.' });
		}

		// Both the PDF and the bundle live under this user's own directory, and
		// there is no code path that writes a user-supplied file outside it.
		//
		// The PDF sits beside the bundle rather than inside it, because
		// convertToOkf clears its output directory to avoid leaving orphan
		// concept files behind — which would have deleted the very file it had
		// just read. Keeping them apart also means a failed reconversion cannot
		// destroy the previous working bundle.
		const userDir = userDataDir(req.user.id);
		const outDir = okfBundleDir(userDir);
		await fs.promises.mkdir(userDir, { recursive: true });
		const sourcePath = path.join(userDir, safeFileName(fileName, 'document.pdf'));
		await fs.promises.writeFile(sourcePath, buffer);

		try {
			const manifest = await convertToOkf({
				pdfPath: sourcePath,
				outDir,
				title: String(body.title || '').trim() || undefined,
				sourceName: fileName,
			});
			// A PDF whose pages are all images extracts to nothing, and an empty
			// bundle would leave the user staring at a chat that says "I have no
			// document" about a document they can plainly see.
			if (manifest.fileCount === 0) {
				await fs.promises.rm(outDir, { recursive: true, force: true });
				return sendJson(res, 422, {
					error:
						'I could not read any text from that PDF. It looks like a scan of images rather than a text document.',
				});
			}
			return sendJson(res, 200, {
				ready: true,
				manifest: {
					title: manifest.title,
					source: manifest.source,
					pageCount: manifest.pageCount,
					fileCount: manifest.fileCount,
					generated: manifest.generated,
				},
			});
		} catch (err) {
			// A half-written bundle would be read as authoritative by the query
			// path, so clear it before reporting the failure. The source PDF is
			// untouched, so the user can retry without re-uploading.
			await fs.promises.rm(outDir, { recursive: true, force: true });
			return sendJson(res, 500, {
				error: `Could not convert that PDF: ${err.message}`,
			});
		}
	}

	// ── POST /api/chat/query ─────────────────────────────────────────────────
	if (route === '/api/chat/query' && req.method === 'POST') {
		const body = await readBody(req);
		const question = String(body.message || body.question || '').trim();
		if (!question) return sendJson(res, 400, { error: 'Empty question' });
		if (question.length > 4000) {
			return sendJson(res, 400, { error: 'That question is too long.' });
		}

		// Scoped by the caller, never by anything in the request body. There is no
		// bundleId parameter, so there is nothing for a caller to point at
		// someone else's directory.
		const result = await answerQuestion({
			bundleDir: okfBundleDir(userDataDir(req.user.id)),
			question,
			limit: 5,
		});
		return sendJson(res, 200, result);
	}

	// ── POST /api/generate ─────────────────────────────────────────────────
	if (route === '/api/generate' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId, req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });
		if (!session.pdf) {
			return sendJson(res, 400, { error: 'Upload a PDF before generating.' });
		}

		const job = createJob('generate', session.id);
		const pdfPath = path.join(sessionDir(session.id, session.userId), session.pdf.fileName);
		const datasetPath = path.join(sessionDir(session.id, session.userId), 'dataset.json');
		const voice = resolveLibraryVoice(body.voiceId);

		runJob(job, async () => {
			const { dataset, title } = await runPipeline({
				pdfPath,
				voiceSamplePath: session.voiceSamplePath,
				voiceSampleRefText: session.voiceSampleRefText || VOICE_SAMPLE_SCRIPT,
				// No uploaded sample: fall back to the chosen library narrator.
				// The reference and its transcript travel together, so this never
				// triggers the Whisper path.
				libraryVoicePath: voice?.audioPath || null,
				datasetPath,
				audioSubdir: session.id,
				log: (message) => jobLog(job, message),
			});

			session.dataset = dataset;
			session.renderPath = null;
			session.voiceId = voice?.voiceId || null;

			// Persist to the single-file store so the sidebar can list it and a
			// returning visitor can load it instantly.
			await db.add({
				id: session.id,
				userId: session.userId,
				title,
				createdAt: new Date().toISOString(),
				scenes: dataset,
			});

			return {
				sessionId: session.id,
				title,
				sceneCount: dataset.length,
				totalFrames: dataset.reduce((sum, s) => sum + s.durationInFrames, 0),
				narrator: session.voiceSamplePath ? null : voice?.name || null,
				scenes: dataset.map((s) => ({
					sceneNumber: s.sceneNumber,
					title: s.title || '',
					badge: s.badge || '',
					durationInFrames: s.durationInFrames,
					imageSource: s.imageSource || '',
				})),
			};
		});

		return sendJson(res, 202, { jobId: job.id });
	}

	// ── GET /api/sessions ──────────────────────────────────────────────────
	if (route === '/api/sessions' && req.method === 'GET') {
		// Summaries only: the scene payloads are large, so the list stays small
		// and the sidebar switches without pulling every video's data.
		return sendJson(res, 200, {
			sessions: db.listFor(req.user.id).map((s) => ({
				id: s.id,
				title: s.title,
				createdAt: s.createdAt,
				sceneCount: s.scenes.length,
				totalFrames: s.scenes.reduce(
					(sum, scene) => sum + (scene.durationInFrames || 0),
					0,
				),
			})),
		});
	}

	// ── GET /api/sessions/:id ─────────────────────────────────────────────
	match = /^\/api\/sessions\/([^/]+)$/.exec(route);
	if (match && req.method === 'GET') {
		// Scoped lookup: another user's id resolves to nothing, and the 404 is
		// deliberately identical to a genuinely missing one so a valid foreign id
		// cannot be confirmed by the response.
		const record = db.getFor(req.user.id, match[1]);
		if (!record) return sendJson(res, 404, { error: 'Session not found' });
		return sendJson(res, 200, record);
	}

	// ── DELETE /api/sessions/:id ──────────────────────────────────────────
	if (match && req.method === 'DELETE') {
		// Look the record up under the caller's scope first. Without it the
		// owner is unknown and the on-disk path cannot be resolved, which is how
		// a cleanup ends up writing to the wrong directory.
		const owned = db.getFor(req.user.id, match[1]);
		const removed = owned ? await db.removeFor(req.user.id, match[1]) : false;
		if (removed && owned) {
			// Reclaim the disk: the rendered video and the per-session assets.
			fs.rm(
				path.join(ROOT, 'out', userDirName(owned.userId), `${match[1]}.mp4`),
				{ force: true },
				() => {},
			);
			fs.rm(sessionDir(match[1], owned.userId), { recursive: true, force: true }, () => {});
			fs.rm(
				path.join(PUBLIC_DIR, 'audio', match[1]),
				{ recursive: true, force: true },
				() => {},
			);
			sessions.delete(match[1]);
		}
		return removed
			? sendJson(res, 200, { ok: true })
			: sendJson(res, 404, { error: 'Session not found' });
	}

	// ── POST /api/produce ──────────────────────────────────────────────────
	// The one-button path: generate the script and visuals, synthesise every
	// scene, then render the merged MP4 in a single job.
	//
	// Previously the browser had to call /api/generate, wait, then call
	// /api/render, and the second call was where audio went missing: the
	// composition was handed a bare array of scenes and silently fell back to the
	// bundled dataset, so the video came out without the narration that had just
	// been synthesised. One job that owns the whole sequence cannot drift out of
	// step, and it gives the client a single progress stream.
	if (route === '/api/produce' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId, req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });

		// Resolve the narrator first. It is a cheap check, and doing it before the
		// PDF means a bad voice id is reported as a bad voice id rather than being
		// masked by a missing document.
		let voice;
		try {
			voice = resolveLibraryVoice(body.voiceId);
		} catch (err) {
			return sendJson(res, err.status || 400, { error: err.message });
		}

		// The button must work from a cold start, so a PDF may arrive in this same
		// request instead of having been uploaded beforehand. Reuses the upload
		// path so validation and text extraction stay in one place.
		if (body.dataBase64) {
			try {
				const fileName = safeFileName(body.fileName, 'source.pdf');
				if (!/\.pdf$/i.test(fileName)) {
					return sendJson(res, 400, { error: 'Please upload a PDF file.' });
				}
				const buffer = decodeUpload(body.dataBase64);
				const pdfPath = path.join(sessionDir(session.id, session.userId), fileName);
				fs.writeFileSync(pdfPath, buffer);
				const cleanText = await parseAndCleanPdf(pdfPath);
				if (!cleanText.trim()) {
					return sendJson(res, 422, {
						error:
							'No usable text found in that PDF. It may be a scan — try a PDF with selectable text.',
					});
				}
				session.pdf = { fileName, bytes: buffer.length, characters: cleanText.length };
				session.cleanText = cleanText;
			} catch (err) {
				return sendJson(res, err.status || 400, { error: err.message });
			}
		}
		if (!session.pdf) {
			return sendJson(res, 400, { error: 'Upload a PDF before generating.' });
		}

		const activeRenders = [...jobs.values()].filter(
			(job) => job.type === 'produce' && job.status === 'running',
		).length;
		if (activeRenders >= MAX_CONCURRENT_RENDERS) {
			return sendJson(res, 429, {
				error: 'A video is already being produced. Please wait for it to finish.',
			});
		}

		const job = createJob('produce', session.id);
		const datasetPath = path.join(sessionDir(session.id, session.userId), 'dataset.json');
		const outFile = path.join(ROOT, 'out', userDirName(session.userId), `${session.id}.mp4`);
		const pdfPath = path.join(sessionDir(session.id, session.userId), session.pdf.fileName);

		runJob(job, async () => {
			jobLog(job, 'Step 1/2 — writing the script and resolving visuals...');
			const { dataset, title } = await runPipeline({
				pdfPath,
				voiceSamplePath: session.voiceSamplePath,
				voiceSampleRefText: session.voiceSampleRefText || VOICE_SAMPLE_SCRIPT,
				libraryVoicePath: voice?.audioPath || null,
				datasetPath,
				audioSubdir: session.id,
				log: (message) => jobLog(job, message),
			});

			session.dataset = dataset;
			session.renderPath = null;
			session.voiceId = voice?.voiceId || null;

			await db.add({
				id: session.id,
				userId: session.userId,
				title,
				createdAt: new Date().toISOString(),
				scenes: dataset,
			});

			jobLog(job, 'Step 2/2 — rendering the merged video with audio...');
			const result = await renderVideo({
				datasetPath,
				outFile,
				onLog: (text, progress) => jobLog(job, text, progress),
			});
			session.renderPath = result;

			const totalFrames = dataset.reduce((sum, s) => sum + s.durationInFrames, 0);
			jobLog(job, `Done: ${dataset.length} scenes, ${(totalFrames / 30).toFixed(1)}s of video.`);
			job.progress = 100;

			return {
				sessionId: session.id,
				title,
				sceneCount: dataset.length,
				totalFrames,
				narrator: session.voiceSamplePath ? 'your uploaded voice' : voice?.name || null,
				// The client turns this straight into a download, which is the whole
				// point of the one-button flow.
				videoUrl: `/video/${session.id}`,
				downloadUrl: `/video/${session.id}?download=1`,
				fileName: `DocuBot_${session.id}.mp4`,
			};
		});

		return sendJson(res, 202, { jobId: job.id });
	}

	// ── POST /api/render ───────────────────────────────────────────────────
	if (route === '/api/render' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId, req.user);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });
		if (!session.dataset && !db.getFor(req.user.id, session.id)) {
			return sendJson(res, 400, { error: 'Generate the video before rendering.' });
		}

		// Renders are expensive; refuse rather than pile up Chrome processes.
		const activeRenders = [...jobs.values()].filter(
			(job) => job.type === 'render' && job.status === 'running',
		).length;
		if (activeRenders >= MAX_CONCURRENT_RENDERS) {
			return sendJson(res, 429, {
				error:
					'A render is already running. Please wait for it to finish and try again.',
			});
		}

		const job = createJob('render', session.id);
		const datasetPath = path.join(sessionDir(session.id, session.userId), 'dataset.json');
		const outFile = path.join(ROOT, 'out', userDirName(session.userId), `${session.id}.mp4`);

		// A session restored from the store may not have its dataset on disk
		// (e.g. after a server restart) — materialise it from the record.
		const ensureDataset = async () => {
			if (fs.existsSync(datasetPath)) return;
			const record = db.getFor(req.user.id, session.id);
			if (!record || record.scenes.length === 0) {
				throw new Error('No dataset available to render for this session.');
			}
			await fs.promises.mkdir(path.dirname(datasetPath), { recursive: true });
			await fs.promises.writeFile(
				datasetPath,
				`${JSON.stringify(record.scenes, null, 2)}\n`,
				'utf8',
			);
		};

		runJob(job, async () => {
			await ensureDataset();
			const result = await renderVideo({
				datasetPath,
				outFile,
				onLog: (text, progress) => jobLog(job, text, progress),
			});
			session.renderPath = result;
			return { videoUrl: `/video/${session.id}`, path: result };
		});

		return sendJson(res, 202, { jobId: job.id });
	}

	// ── GET /api/job/:id ───────────────────────────────────────────────────
	match = /^\/api\/job\/([^/]+)$/.exec(route);
	if (match && req.method === 'GET') {
		const job = jobs.get(match[1]);
		if (!job) return sendJson(res, 404, { error: 'Job not found' });
		return sendJson(res, 200, {
			id: job.id,
			type: job.type,
			status: job.status,
			progress: job.progress,
			logs: job.logs.slice(-60),
			result: job.result,
			error: job.error,
		});
	}

	return sendJson(res, 404, { error: 'Unknown endpoint' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * The session id embedded in a data path, if any.
 *
 * `/audio/<sessionId>/scene-1.mp3` and `/video/<sessionId>` both name a
 * session, and both hand out that session's private data.
 */
const sessionIdFromPath = (pathname) => {
	const audio = /^\/audio\/([a-z]+_[a-f0-9]{18})\//.exec(pathname);
	if (audio) return audio[1];
	const video = /^\/video\/([a-z]+_[a-f0-9]{18})$/.exec(pathname);
	return video ? video[1] : null;
};

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

	try {
		if (url.pathname.startsWith('/api/')) {
			return await handleApi(req, res, url);
		}

		/*
		 * Everything below is per-user data, and it used to be entirely
		 * unauthenticated: the auth gate lived only inside handleApi, which is
		 * reached solely for /api/ paths. That meant anyone who knew or guessed
		 * a session id could download another user's rendered video and their
		 * generated narration without logging in at all — a bigger hole than the
		 * API scoping, because it needed no account whatsoever.
		 */
		const dataSessionId = sessionIdFromPath(url.pathname);
		if (dataSessionId) {
			const user = auth.verify(sessionToken(req));
			if (!user) {
				return sendText(res, 401, 'Sign in to view this.');
			}
			// And the session must be theirs, not merely authenticated.
			const owned = getSession(dataSessionId, user);
			if (!owned) {
				// 404, not 403: a 403 would confirm the id exists.
				return sendText(res, 404, 'Not found.');
			}
			req.user = user;
		}

		if (url.pathname.startsWith('/audio/')) {
			// Note: serve from PUBLIC_DIR using the *full* path so that
			// /audio/<sessionId>/scene-N.mp3 maps to public/audio/<sessionId>/...
			return serveFile(res, PUBLIC_DIR, url.pathname);
		}

		const videoMatch = /^\/video\/([^/]+)$/.exec(url.pathname);
		if (videoMatch && req.method === 'GET') {
			const id = videoMatch[1];
			// Ownership was already established above for any /video/<id> path.
			const recorded = getSession(id, req.user)?.renderPath;
			const candidate =
				recorded && fs.existsSync(recorded)
					? recorded
					: path.join(ROOT, 'out', userDirName(req.user.id), `${id}.mp4`);

			if (!fs.existsSync(candidate)) {
				return sendText(res, 404, 'No rendered video for this video yet.');
			}
			// ?download=1 forces a save dialog. The single-CTA flow hands the
			// browser a download URL it can fetch directly, and naming the file
			// after the session is what makes the downloaded artefact traceable
			// back to the run that produced it.
			const wantsDownload =
				url.searchParams.get('download') === '1' ||
				req.headers.accept?.includes('application/octet-stream');
			return serveFile(
				res,
				path.resolve(candidate, '..'),
				`/${path.basename(candidate)}`,
				{ download: wantsDownload ? `DocuBot_${id}.mp4` : null },
			);
		}

		// Static frontend, with an SPA fallback to index.html.
		const requested = url.pathname === '/' ? '/index.html' : url.pathname;
		const candidate = path.resolve(WEB_DIST, `.${path.posix.normalize(requested)}`);
		if (
			candidate.startsWith(WEB_DIST + path.sep) &&
			fs.existsSync(candidate) &&
			fs.statSync(candidate).isFile()
		) {
			// no-store: the bundle is rebuilt in place, so a cached copy would
			// leave visitors running stale code after an update.
			return serveFile(res, WEB_DIST, requested, { cacheControl: 'no-store' });
		}
		return serveFile(res, WEB_DIST, '/index.html', { cacheControl: 'no-store' });
	} catch (err) {
		console.error('[WEB] Unhandled error:', err);
		if (!res.headersSent) {
			return sendJson(res, 500, { error: err.message || 'Internal server error' });
		}
		res.end();
	}
});

/**
 * Start listening and print the startup banner.
 *
 * Exported so `server/serve.js` can run the web server in the same process as
 * the voice service supervisor. It is safe to call once.
 */
function startWebServer() {
	if (server.listening) return server;

	fs.mkdirSync(DATA_DIR, { recursive: true });
	// Periodic cleanup of idle working sessions and expired rate-limit buckets.
	setInterval(sweepSessions, 60 * 1000).unref();

	const banner = async () => {
		const provider = getAiProvider();
		const health = await omnivoice.serviceHealth();
		const cloning = Boolean(health.reachable && health.body?.ready);
		console.log('');
		console.log('  DocuBot - AI Documentary Generator');
		console.log(`  ready on   http://localhost:${PORT}`);
		console.log(
			`  chat       ${provider ? provider.name : 'disabled (no LLM key configured)'}`,
		);
		if (cloning) {
			console.log(
				`  voice      OmniVoice on ${health.body.device} (${health.body.dtype})`,
			);
		} else if (health.body?.loading) {
			console.log('  voice      OmniVoice loading its model...');
		} else {
			console.log(
				`  voice      service not available - fallback ${DEFAULT_EDGE_VOICE}`,
			);
		}
		console.log(
			`  visuals    ${process.env.PEXELS_API_KEY ? 'Pexels photos + document diagrams' : 'document diagrams (no Pexels key)'}`,
		);
		console.log(
			`  limits     ${RATE_MAX} req/min per IP, ${MAX_CONCURRENT_RENDERS} render at a time`,
		);
		console.log('');
	};

	server.listen(PORT, HOST, () => {
		banner().catch((err) => console.warn(`  banner check failed: ${err.message}`));
	});
	return server;
}

if (require.main === module) {
	startWebServer();
}

module.exports = { server, startWebServer, createSession, sessions, jobs, db, PORT, HOST };

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
	cloneClientVoice,
	VOICE_SAMPLE_SENTENCES,
	VOICE_SAMPLE_SCRIPT,
	DEFAULT_EDGE_VOICE,
} = require('./tts');
const { chatCompletion, getAiProvider } = require('./llm');
const { renderVideo } = require('./render');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const DATA_DIR = path.join(ROOT, '.data', 'sessions');
const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MB (base64 inflates by ~33%)

/** Persistent history of generated videos (single JSON file). */
const db = createDb();

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

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
const isValidId = (id) => typeof id === 'string' && /^[a-z]+_[a-f0-9]{18}$/.test(id);

const getSession = (id) => (isValidId(id) ? sessions.get(id) : undefined);

const sessionDir = (id) => path.join(DATA_DIR, id);

function createSession() {
	const id = newId('sess');
	fs.mkdirSync(path.join(sessionDir(id), 'audio'), { recursive: true });
	const session = {
		id,
		createdAt: new Date().toISOString(),
		pdf: null,
		cleanText: '',
		voice: null,
		dataset: null,
		renderPath: null,
	};
	sessions.set(id, session);
	return session;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store',
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

	// ── GET /api/config ────────────────────────────────────────────────────
	if (route === '/api/config' && req.method === 'GET') {
		const provider = getAiProvider();
		return sendJson(res, 200, {
			voiceSampleSentences: VOICE_SAMPLE_SENTENCES,
			voiceSampleScript: VOICE_SAMPLE_SCRIPT,
			fallbackVoice: DEFAULT_EDGE_VOICE,
			voiceCloningAvailable: Boolean(process.env.ELEVENLABS_API_KEY),
			chatEnabled: Boolean(provider),
			llmProvider: provider ? provider.name : null,
		});
	}

	// ── POST /api/session ──────────────────────────────────────────────────
	if (route === '/api/session' && req.method === 'POST') {
		const session = createSession();
		return sendJson(res, 201, { sessionId: session.id });
	}

	// ── GET /api/session/:id ───────────────────────────────────────────────
	let match = /^\/api\/session\/([^/]+)$/.exec(route);
	if (match && req.method === 'GET') {
		const session = getSession(match[1]);
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
		const session = getSession(body.sessionId);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });

		const fileName = safeFileName(body.fileName, 'source.pdf');
		const buffer = decodeUpload(body.dataBase64);
		if (!/\.pdf$/i.test(fileName)) {
			return sendJson(res, 400, { error: 'Please upload a PDF file.' });
		}

		const pdfPath = path.join(sessionDir(session.id), fileName);
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
		const session = getSession(body.sessionId);
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

		const samplePath = path.join(sessionDir(session.id), fileName);
		fs.writeFileSync(samplePath, buffer);
		session.voiceSamplePath = samplePath;

		const clone = await cloneClientVoice(samplePath);
		session.voice = {
			status: clone.status,
			voiceName: clone.voiceName,
			voiceId: clone.voiceId,
			fileName,
			bytes: buffer.length,
		};

		return sendJson(res, 200, session.voice);
	}

	// ── POST /api/chat ─────────────────────────────────────────────────────
	if (route === '/api/chat' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId);
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

	// ── POST /api/generate ─────────────────────────────────────────────────
	if (route === '/api/generate' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });
		if (!session.pdf) {
			return sendJson(res, 400, { error: 'Upload a PDF before generating.' });
		}

		const job = createJob('generate', session.id);
		const pdfPath = path.join(sessionDir(session.id), session.pdf.fileName);
		const datasetPath = path.join(sessionDir(session.id), 'dataset.json');

		runJob(job, async () => {
			const { dataset, title } = await runPipeline({
				pdfPath,
				voiceSamplePath: session.voiceSamplePath,
				datasetPath,
				audioSubdir: session.id,
				log: (message) => jobLog(job, message),
			});

			session.dataset = dataset;
			session.renderPath = null;

			// Persist to the single-file store so the sidebar can list it and a
			// returning visitor can load it instantly.
			await db.add({
				id: session.id,
				title,
				createdAt: new Date().toISOString(),
				scenes: dataset,
			});

			return {
				sessionId: session.id,
				title,
				sceneCount: dataset.length,
				totalFrames: dataset.reduce((sum, s) => sum + s.durationInFrames, 0),
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
			sessions: db.list().map((s) => ({
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
		const record = db.get(match[1]);
		if (!record) return sendJson(res, 404, { error: 'Session not found' });
		return sendJson(res, 200, record);
	}

	// ── DELETE /api/sessions/:id ──────────────────────────────────────────
	if (match && req.method === 'DELETE') {
		const removed = await db.remove(match[1]);
		return removed
			? sendJson(res, 200, { ok: true })
			: sendJson(res, 404, { error: 'Session not found' });
	}

	// ── POST /api/render ───────────────────────────────────────────────────
	if (route === '/api/render' && req.method === 'POST') {
		const body = await readBody(req);
		const session = getSession(body.sessionId);
		if (!session) return sendJson(res, 404, { error: 'Session not found' });
		if (!session.dataset) {
			return sendJson(res, 400, { error: 'Generate the video before rendering.' });
		}

		const job = createJob('render', session.id);
		const datasetPath = path.join(sessionDir(session.id), 'dataset.json');
		const outFile = path.join(ROOT, 'out', 'web', `${session.id}.mp4`);

		// A session restored from the store may not have its dataset on disk
		// (e.g. after a server restart) — materialise it from the record.
		const ensureDataset = async () => {
			if (fs.existsSync(datasetPath)) return;
			const record = db.get(session.id);
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
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

	try {
		if (url.pathname.startsWith('/api/')) {
			return await handleApi(req, res, url);
		}

		if (url.pathname.startsWith('/audio/')) {
			// Note: serve from PUBLIC_DIR using the *full* path so that
			// /audio/<sessionId>/scene-N.mp3 maps to public/audio/<sessionId>/...
			return serveFile(res, PUBLIC_DIR, url.pathname);
		}

		const videoMatch = /^\/video\/([^/]+)$/.exec(url.pathname);
		if (videoMatch && req.method === 'GET') {
			const session = getSession(videoMatch[1]);
			if (!session || !session.renderPath) {
				return sendText(res, 404, 'No rendered video for this session yet.');
			}
			return serveFile(
				res,
				path.resolve(session.renderPath, '..'),
				`/${path.basename(session.renderPath)}`,
				{ download: `documentary-${session.id}.mp4` },
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

if (require.main === module) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	server.listen(PORT, HOST, () => {
		console.log('');
		console.log('  DocuBot — AI Documentary Generator');
		console.log(`  ready on   http://localhost:${PORT}`);
		const provider = getAiProvider();
		console.log(
			`  chat       ${provider ? provider.name : 'disabled (no LLM key configured)'}`,
		);
		console.log(
			`  voice clone ${process.env.ELEVENLABS_API_KEY ? 'ElevenLabs' : `fallback ${DEFAULT_EDGE_VOICE}`}`,
		);
		console.log('');
	});
}

module.exports = { server, createSession, sessions, jobs, db };

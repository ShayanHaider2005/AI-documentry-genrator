'use strict';

/**
 * db.js — Minimal JSON-file session store.
 *
 * All generated videos live in one file (`server/sessions.json`) so the project
 * needs no database. Writes are serialized in-process and performed atomically
 * (temp file + rename) so a crash mid-write can never truncate the store.
 *
 * Exports: createDb({ file, maxSessions }) → { list, get, add, update, remove }
 */

const fs = require('fs');
const path = require('path');

// Overridable so a test can run a throwaway instance without reading or writing
// the real session store.
const DEFAULT_FILE =
	process.env.DOCUBOT_SESSIONS_FILE || path.join(__dirname, 'sessions.json');
const DEFAULT_MAX_SESSIONS = 60;

const emptyStore = () => ({ version: 1, sessions: [] });

function createDb({ file = DEFAULT_FILE, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
	// Serializes writes; reads are served from the in-memory mirror.
	let writeChain = Promise.resolve();
	let cache = null;

	const readStore = () => {
		if (cache) return cache;
		try {
			const raw = fs.readFileSync(file, 'utf8');
			const parsed = JSON.parse(raw);
			cache =
				parsed && Array.isArray(parsed.sessions)
					? { version: parsed.version || 1, sessions: parsed.sessions }
					: emptyStore();
		} catch {
			cache = emptyStore();
		}
		return cache;
	};

	const writeStore = () => {
		const snapshot = JSON.stringify(readStore(), null, 2);
		const temp = `${file}.${process.pid}.tmp`;

		// Chain writes so they stay sequential, but never let a failure poison the
		// chain: a single rejected write would otherwise reject every later write
		// and the store would silently stop persisting.
		writeChain = writeChain
			.catch(() => undefined)
			.then(async () => {
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await fs.promises.writeFile(temp, `${snapshot}\n`, 'utf8');
				await fs.promises.rename(temp, file);
			})
			.catch((err) => {
				console.error(`[DB] Failed to persist ${file}: ${err.message}`);
				throw err;
			});

		return writeChain;
	};

	/** Newest first, trimmed to maxSessions. */
	const list = () =>
		readStore()
			.sessions.slice()
			.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

	const get = (id) => readStore().sessions.find((s) => s.id === id) || null;

	const add = async (session) => {
		const store = readStore();
		const record = {
			id: String(session.id),
			// The owner. Every read path below is scoped by it, so a record
			// without one is unreachable rather than everyone's.
			userId: session.userId ? String(session.userId) : null,
			title: String(session.title || 'Untitled Video'),
			createdAt: session.createdAt || new Date().toISOString(),
			scenes: Array.isArray(session.scenes) ? session.scenes : [],
		};
		store.sessions = store.sessions.filter((s) => s.id !== record.id);
		store.sessions.push(record);
		store.sessions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
		if (store.sessions.length > maxSessions) {
			store.sessions = store.sessions.slice(-maxSessions);
		}
		await writeStore();
		return record;
	};

	const update = async (id, patch) => {
		const store = readStore();
		const index = store.sessions.findIndex((s) => s.id === id);
		if (index === -1) return null;
		store.sessions[index] = { ...store.sessions[index], ...patch, id };
		await writeStore();
		return store.sessions[index];
	};

	const remove = async (id) => {
		const store = readStore();
		const before = store.sessions.length;
		store.sessions = store.sessions.filter((s) => s.id !== id);
		if (store.sessions.length === before) return false;
		await writeStore();
		return true;
	};

	/**
	 * Scoped reads.
	 *
	 * These exist alongside the unscoped ones rather than replacing them, so a
	 * missing ownership check is a visible call to `get` rather than an
	 * accidental omission. Every route that serves user data uses these.
	 *
	 * A record with a null owner is never returned by any of them: it predates
	 * isolation, and guessing which user "should" own it is not a safe default.
	 */
	const listFor = (userId) =>
		readStore()
			.sessions.filter((s) => s.userId === String(userId))
			.slice()
			.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

	const getFor = (userId, id) =>
		readStore().sessions.find(
			(s) => s.id === String(id) && s.userId === String(userId),
		) || null;

	const removeFor = async (userId, id) => {
		const store = readStore();
		const before = store.sessions.length;
		store.sessions = store.sessions.filter(
			(s) => !(s.id === String(id) && s.userId === String(userId)),
		);
		if (store.sessions.length === before) return false;
		await writeStore();
		return true;
	};

	return { list, get, add, update, remove, listFor, getFor, removeFor, file };
}

module.exports = { createDb, DEFAULT_FILE };

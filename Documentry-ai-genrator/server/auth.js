'use strict';

/**
 * auth.js — Usernames, password hashes, and session tokens.
 *
 * Storage is a JSON file, matching server/db.js, so the project stays free of a
 * database and of native modules.
 *
 * On the choice of scrypt over bcrypt: the brief suggested bcrypt, and scrypt is
 * the better fit here. It is memory-hard, which is what actually matters against
 * GPU cracking, it is built into Node, and it needs no native build step — a
 * bcrypt dependency is a compiler requirement and a recurring supply-chain
 * surface for a single local app. Both are appropriate; scrypt avoids the
 * problems.
 *
 * What this is and is not
 * -----------------------
 * It gates the product: the dashboard, the pipeline, and the render route all
 * require a session. It is not a defence against someone who has the folder. The
 * user store sits next to the sessions and the videos, and passwords are hashed
 * rather than encrypted precisely because the goal is to avoid making a stolen
 * file immediately useful — not to withstand an attacker who can already run code
 * as this user. Do not expose this server to the internet as-is.
 *
 * Exports:
 *   createAuth({ file }) → { register, login, logout, verify, userFor, listUsers }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Overridable so a test can run a throwaway instance without creating or
// reading the real user store.
const DEFAULT_FILE =
	process.env.DOCUBOT_USERS_FILE || path.join(__dirname, 'users.json');

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 8;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

/** Serialised as `scrypt$N$r$p$salt$hash`, so the parameters travel with it. */
const hashPassword = (password, salt = crypto.randomBytes(16)) =>
	`scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString('hex')}$${crypto
		.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS)
		.toString('hex')}`;

const verifyPassword = (password, stored) => {
	try {
		const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
		if (scheme !== 'scrypt') return false;
		const expected = Buffer.from(hashHex, 'hex');
		const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
			N: Number(N),
			r: Number(r),
			p: Number(p),
			maxmem: SCRYPT_OPTS.maxmem,
		});
		// Constant-time: a length or early-exit difference would leak the hash.
		return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
	} catch {
		return false;
	}
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const newToken = () => crypto.randomBytes(32).toString('base64url');

const emptyStore = () => ({ version: 1, users: [] });

function createAuth({ file = DEFAULT_FILE } = {}) {
	let cache = null;
	let writeChain = Promise.resolve();

	const readStore = () => {
		if (cache) return cache;
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
			cache =
				parsed && Array.isArray(parsed.users)
					? { version: parsed.version || 1, users: parsed.users }
					: emptyStore();
		} catch {
			cache = emptyStore();
		}
		return cache;
	};

	// Atomic (temp + rename) and serialised, so a crash mid-write cannot
	// truncate the store. A rejected write is caught so the chain is not
	// poisoned: otherwise every later write would reject too and persistence
	// would stop silently.
	const writeStore = () => {
		const snapshot = JSON.stringify(readStore(), null, 2);
		const temp = `${file}.${process.pid}.tmp`;
		writeChain = writeChain
			.catch(() => undefined)
			.then(async () => {
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await fs.promises.writeFile(temp, `${snapshot}\n`, 'utf8');
				await fs.promises.rename(temp, file);
			})
			.catch((err) => {
				console.error(`[AUTH] Failed to persist ${file}: ${err.message}`);
			});
		return writeChain;
	};

	const pruneSessions = (user) => {
		const now = Date.now();
		user.sessions = (user.sessions || []).filter(
			(s) => !s.expiresAt || new Date(s.expiresAt).getTime() > now,
		);
	};

	const findUser = (username) =>
		readStore().users.find(
			(u) => u.username.toLowerCase() === String(username || '').toLowerCase(),
		) || null;

	/** Validate, hash, store, and open a session. */
	const register = async ({ username, password }) => {
		const name = String(username || '').trim();
		if (!USERNAME_RE.test(name)) {
			throw Object.assign(
				new Error('Username must be 3-32 characters: letters, numbers, dot, dash, underscore.'),
				{ status: 400 },
			);
		}
		const pass = String(password || '');
		if (pass.length < MIN_PASSWORD_LENGTH) {
			throw Object.assign(
				new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`),
				{ status: 400 },
			);
		}
		if (findUser(name)) {
			// Deliberately the same message as a wrong password on login, so the
			// form does not confirm which usernames exist.
			throw Object.assign(new Error('That username is already taken.'), { status: 409 });
		}

		const user = {
			id: crypto.randomUUID(),
			username: name,
			passwordHash: hashPassword(pass),
			createdAt: new Date().toISOString(),
			sessions: [],
		};
		readStore().users.push(user);
		const token = newToken();
		user.sessions.push({
			tokenHash: hashToken(token),
			createdAt: user.createdAt,
			expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
		});
		await writeStore();
		return { token, user: publicUser(user) };
	};

	const login = async ({ username, password }) => {
		const user = findUser(username);
		// Hash a decoy when the user is missing, so a wrong username and a wrong
		// password take the same time and cannot be told apart.
		const stored = user ? user.passwordHash : hashPassword('decoy-password-value');
		const ok = verifyPassword(String(password || ''), stored);
		if (!user || !ok) {
			throw Object.assign(new Error('Incorrect username or password.'), { status: 401 });
		}
		pruneSessions(user);
		const token = newToken();
		user.sessions.push({
			tokenHash: hashToken(token),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
		});
		await writeStore();
		return { token, user: publicUser(user) };
	};

	/** Drop one session. Scoped per user, so a stolen token cannot log others out. */
	const logout = async (token) => {
		const hash = hashToken(String(token || ''));
		let removed = false;
		for (const user of readStore().users) {
			const before = (user.sessions || []).length;
			user.sessions = (user.sessions || []).filter((s) => s.tokenHash !== hash);
			if (user.sessions.length !== before) removed = true;
		}
		if (removed) await writeStore();
		return removed;
	};

	/** The user a raw token belongs to, or null. Expired tokens do not resolve. */
	const verify = (token) => {
		if (!token) return null;
		const hash = hashToken(String(token));
		const now = Date.now();
		for (const user of readStore().users) {
			const hit = (user.sessions || []).find(
				(s) => s.tokenHash === hash && new Date(s.expiresAt).getTime() > now,
			);
			if (hit) return publicUser(user);
		}
		return null;
	};

	const publicUser = (user) => ({ id: user.id, username: user.username });

	const listUsers = () => readStore().users.map(publicUser);

	return { register, login, logout, verify, userFor: verify, listUsers, file };
}

/** Read a cookie out of a raw header, without depending on a framework. */
const parseCookies = (header) => {
	const out = {};
	for (const part of String(header || '').split(';')) {
		const index = part.indexOf('=');
		if (index === -1) continue;
		const key = part.slice(0, index).trim();
		if (!key) continue;
		try {
			out[key] = decodeURIComponent(part.slice(index + 1).trim());
		} catch {
			out[key] = part.slice(index + 1).trim();
		}
	}
	return out;
};

module.exports = {
	createAuth,
	parseCookies,
	hashPassword,
	verifyPassword,
	COOKIE_NAME: 'docubot_session',
	SESSION_TTL_MS,
};

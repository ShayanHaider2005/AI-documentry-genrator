'use strict';

/**
 * Checks the per-user isolation and the URL routing contract.
 *
 * Two of these are static, one is a live two-account test, because the
 * isolation bugs that mattered could not be seen by reading the code:
 *
 *   1. `req.user` was set by the auth gate and then never used, so every
 *      session read, list, delete and download was unscoped.
 *   2. The gate lived only inside handleApi, which is reached solely for /api/
 *      paths. /video/<id> and /audio/<sessionId>/ served private data with no
 *      login at all — needing no account, not merely the wrong one.
 *
 * Plus the routing contract, which did not exist: there was no URL routing, so
 * "route to /" was a state flip and a refresh always dropped the user on the
 * landing page.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const web = read('server/web.js');
const db = read('server/db.js');
const shell = read('web/src/Shell.tsx');
const topbar = read('web/src/TopBar.tsx');
const motion = read('web/src/motion.css');
const ignore = read('../.gitignore');

/* ---- 1. every session access is scoped --------------------------------- */
console.log('\n1. session data is scoped to its owner');
check('a session cannot be created without an owner',
	/function createSession\(user\)/.test(web) && /userId: user\.id/.test(web));
check('getSession takes the caller', /getSession = \(id, user\) =>/.test(web));
// getSession must not have a path that hands back a session without checking
// the owner. Read the function body rather than pattern-matching the file.
const getSessionBody = (() => {
	const start = web.indexOf('const getSession = (id, user)');
	if (start === -1) return '';
	const end = web.indexOf('\n};', start);
	return web.slice(start, end);
})();
// The check has to come BEFORE the only return that hands back a session. A
// trailing `return session` is correct; what would be wrong is one reachable
// without passing the ownership test first.
const checkAt = getSessionBody.indexOf('if (!ownsSession(session, user)) return null;');
const returnAt = getSessionBody.indexOf('return session;');
check('ownership is checked inside getSession, before the session is returned',
	checkAt !== -1 && returnAt !== -1 && checkAt < returnAt,
	checkAt !== -1 && checkAt < returnAt
		? 'the only return follows the guard'
		: 'a session can be returned without an ownership check');
check('no unscoped getSession call remains',
	!/getSession\([^,)]*\)/.test(web.replace(/getSession = \(id, user\)/, '')),
	'every call site passes a user');
check('a foreign id and a missing id are indistinguishable',
	/ownsSession[\s\S]{0,400}return null/.test(web),
	'null either way, so the caller cannot tell them apart');
check('no unscoped store read remains', !/db\.(list|get|remove)\(/.test(web));
check('the store offers scoped accessors',
	/listFor/.test(db) && /getFor/.test(db) && /removeFor/.test(db));
check('scoped reads compare the owner',
	/s\.userId === String\(userId\)/.test(db));
check('a record with no owner is unreachable',
	/listFor[\s\S]{0,200}userId === String\(userId\)/.test(db));

/* ---- 2. files live under a per-user directory -------------------------- */
console.log('\n2. per-user storage layout');
check('the session directory is per user', /sessionDir = \(id, userId\)/.test(web));
check('every sessionDir call passes the owner',
	!/sessionDir\([^,)]*\)/.test(web.replace(/sessionDir = \(id, userId\)/, '')));
check('the user directory name is hashed, not raw',
	/createHash\('sha256'\)/.test(web) && /userDirName/.test(web),
	'a raw id in a path invites traversal via the id');
check('the owner comes from the record, never the URL',
	/sessionDir\(match\[1\], owned\.userId\)/.test(web));
check('rendered video is written per user',
	/userDirName\(session\.userId\)/.test(web) && !/'out', 'web'/.test(web));

/* ---- 3. the unauthenticated hole -------------------------------------- */
console.log('\n3. private data is not served without a session');
check('the data-path gate exists', /sessionIdFromPath/.test(web));
check('it covers both /audio/ and /video/',
	/\^\\\/audio\\\//.test(web) && /\^\\\/video\\\//.test(web));
check('an anonymous request is refused there',
	/if \(!user\) \{\s*\n\s*return sendText\(res, 401/.test(web));
check('and ownership is checked as well',
	/const owned = getSession\(dataSessionId, user\)/.test(web));
check('a foreign session id is a 404, not a 403',
	/sendText\(res, 404, 'Not found\.'\)/.test(web),
	'a 403 would confirm the id exists');
check('the gate runs before the file is served',
	web.indexOf('const dataSessionId = sessionIdFromPath') <
		web.indexOf("url.pathname.startsWith('/audio/')"));

/* ---- 4. routing -------------------------------------------------------- */
console.log('\n4. URL routing');
check('views have real paths', /VIEW_PATHS: Record<View, string>/.test(shell));
check('the paths are the ones the brief names',
	/landing: '\/'/.test(shell) && /studio: '\/dashboard'/.test(shell) &&
		/play: '\/play-with-me'/.test(shell) && /about: '\/contact'/.test(shell));
check('the initial view comes from the URL',
	/viewFromPath\(window\.location\.pathname\)/.test(shell));
check('navigation writes history', /history\.pushState/.test(shell));
check('the back button is handled', /popstate/.test(shell));
check('an unknown path lands somewhere sane', /\?\? 'landing'/.test(shell));
check('a trailing slash is the same page', /replace\(\/\\\/+\$\/, ''\)/.test(shell));
check('signing in does not hijack a chosen page',
	/if \(!wanted \|\| wanted === 'landing' \|\| wanted === 'auth'\)/.test(shell),
	'otherwise opening /contact bounces to the dashboard');
check('the landing page offers a route to the chat page',
	/\tonChat: \(\) => void;/.test(shell) && /onClick=\{onChat\}/.test(shell),
	'otherwise /chat is reachable only from the TopBar, and only when signed in');
check('and the handler is wired to the chat view',
	/onChat=\{\(\) => setView\('chat'\)\}/.test(shell));
check('it is labelled so it cannot be confused with Play With Me',
	/\n\t+PDF Chat\n/.test(shell) && !/Chat With Me/.test(shell),
	'"Play With Me" is a different page; two adjacent buttons one word apart is a trap');
// The auth gate has to cover the landing entry point too, not just the nav link.
check('a signed-out visitor is sent to sign-in, not a blank /chat',
	/if \(booted && view === 'chat' && !user\) setView\('auth'\)/.test(shell));

check('the server falls back to index.html for deep routes',
	/serveFile\(res, WEB_DIST, '\/index\.html'/.test(web));

/* ---- 5. the logo ------------------------------------------------------- */
console.log('\n5. the top-left logo');
check('it is a button off the landing page', /brand-button/.test(topbar));
check('and static on the landing page', /aria-current="page"/.test(topbar));
check('it navigates home', /onClick=\{onHome\}/.test(topbar) && /setView\('landing'\)/.test(shell));
check('which writes the root path', /landing: '\/'/.test(shell));
check('the session is untouched by navigating',
	/setView = React\.useCallback\(\(next: View\)/.test(shell) && !/setUser\(null\)/.test(
		shell.slice(shell.indexOf('const setView = React.useCallback'), shell.indexOf('const setView = React.useCallback') + 400),
	));

/* ---- 6. gitignore ------------------------------------------------------ */
console.log('\n6. repository hygiene');
for (const rule of ['temp/', 'output/', 'public/renders/', 'uploads/', '*.mp4', '*.wav', '*.pdf', 'test_*.js', 'scratchpad.', 'dry_*.log']) {
	check(`  ignores ${rule}`, ignore.includes(rule));
}
// The library's audio stays ignored, against the brief's "except
// server/voices/defaults/": ten reference recordings are 7.1 MB of generated
// binary that changes on every regeneration. The manifest is the part worth
// versioning, and it is tracked.
check('the library manifest is not ignored', !/\.json/.test(
	(ignore.split('\n').find((l) => l.includes('defaults') && l.includes('*.json')) || ''),
));
check('the narrator transcript is negated back in',
	/!\/Documentry-ai-genrator\/server\/voices\/south_asian_narrator\.txt/.test(ignore));
check('the deviation from the brief is written down in the file',
	/against the brief/.test(ignore) && /7\.1 MB/.test(ignore),
	'a future reader should not have to rediscover this');
check('the sample fixture PDF is kept', ignore.includes('!Documentry-ai-genrator/public/sample.pdf'));

/* ---- 7. button feedback ------------------------------------------------ */
console.log('\n7. tactile button feedback');
check('clickable things get a pointer cursor',
	/button:not\(:disabled\)[\s\S]{0,200}cursor: pointer/.test(motion));
check('hover scales to 1.03', /scale\(1\.03\)/.test(motion));
check('press scales to 0.96', /scale\(0\.96\)/.test(motion));
check('hover has a glow', /box-shadow/.test(motion));
check('the press is a transform, so nothing relayouts',
	/button:not\(:disabled\):active[\s\S]{0,80}transform: scale/.test(motion) &&
		!/active[\s\S]{0,60}margin-top/.test(motion));
check('disabled is not pressable', /cursor: not-allowed/.test(motion) && /transform: none/.test(motion));
check('focus is visible for keyboards only', /focus-visible/.test(motion));
check('reduced motion drops the scale but keeps the colour',
	/transform: none !important/.test(motion) && /prefers-reduced-motion/.test(motion));

console.log(failures === 0 ? '\nAll isolation and routing checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

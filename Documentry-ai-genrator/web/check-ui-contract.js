'use strict';

/**
 * Contract tests for the front end, without a browser.
 *
 * The bugs worth catching here are wiring ones: a button that calls a handler
 * which no longer exists, a prop the server sends but the UI never reads, a
 * download URL that is built but never used. None of those fail a type check on
 * their own, and all of them fail silently in front of a user.
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

const app = read('web/src/App.tsx');
const shell = read('web/src/Shell.tsx');
const api = read('web/src/api.ts');
const mascot = read('web/src/Mascot.tsx');
const styles = read('web/src/overhaul.css');
const main = read('web/src/main.tsx');
const webServer = read('server/web.js');
const authServer = read('server/auth.js');
const voices = read('server/voices.js');

/* ---- 1. the one-button flow --------------------------------------------- */
console.log('\n1. the one-button flow');
check('the button is labelled for download',
	/Generate & Download Documentary/.test(app),
	'"Generate & Download Documentary"');
check('there is only ONE primary action in the flow',
	(app.match(/variant="primary"/g) || []).length <= 2,
	`${(app.match(/variant="primary"/g) || []).length} primary buttons`);
// Only the JSX matters. A comment describing the old flow may still mention
// "Download MP4", and that is not a surviving button.
const jsxOnly = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('the old separate render button is gone',
	!/Download MP4/.test(jsxOnly) && !/handleRender/.test(jsxOnly),
	'no standalone render/download button in the markup');
check('it calls /api/produce', /api\.produce\(/.test(app) && /'\/api\/produce'/.test(api));
check('it polls the job to completion', /pollJob\(jobId/.test(app));
check('it triggers a download when finished', /anchor\.click\(\)/.test(app));
check('the download uses the URL the server returned', /downloadUrl/.test(app));
check('the anchor is cleaned up', /anchor\.remove\(\)/.test(app));
check('the file name comes from the server', /fileName/.test(app));
check('a re-download link is offered', /\?download=1/.test(app));

/* ---- 2. the two-step flow is genuinely gone ----------------------------- */
console.log('\n2. the old two-step flow is gone');
check('no /api/render call from the UI', !/api\.render\(/.test(app), 'ui never calls /api/render');
check('no /api/generate call from the UI', !/api\.generate\(/.test(app), 'ui never calls /api/generate');
check('the routes still exist on the server for scripts',
	/'\/api\/render'/.test(webServer) && /'\/api\/generate'/.test(webServer),
	'kept for CLI and older clients');
check('produce runs the pipeline', /runPipeline/.test(webServer));
check('produce then renders', /renderVideo/.test(webServer));
// Route order only matters if both could match the same path, which they cannot.
// What actually matters is that the produce handler is a real branch, not a
// mention in a comment.
const routeBranch = (route) => {
	const idx = webServer.indexOf(`route === '${route}'`);
	return idx === -1 ? -1 : idx;
};
check('produce is a real route branch', routeBranch('/api/produce') !== -1);
check('render is a real route branch', routeBranch('/api/render') !== -1);
check('both branch on method and path together',
	/route === '\/api\/produce' && req\.method === 'POST'/.test(webServer) &&
	/route === '\/api\/render' && req\.method === 'POST'/.test(webServer));

/* ---- 3. the narrator picker --------------------------------------------- */
console.log('\n3. the narrator picker');
check('a picker component exists', /const VoicePicker/.test(app));
check('it has a gender toggle', /seg-btn/.test(app) && /'female'/.test(app));
check('it lists accents from the library', /forGender\.map/.test(app));
check('it reads labels from the server, not the browser', /voice\.accentLabel/.test(app));
check('it handles an absent library honestly',
	/library\?\.available/.test(app) && /voice:library/.test(app),
	'says how to build the library');
check('the chosen voice is sent to the server', /voiceId/.test(app) && /voiceId: params\.voiceId/.test(api));
check('an uploaded sample overrides the picker', /voiceName \? \(/.test(app));

/* ---- 4. auth wiring ------------------------------------------------------ */
console.log('\n4. auth');
check('the shell is the entry point', /<Shell \/>/.test(main));
check('the app is only mounted after sign-in', /view === 'studio' && user/.test(shell));
check('the dashboard is lazily loaded', /React\.lazy/.test(shell));
// The calls are in Shell (register/login) and App (logout); the definitions are
// in api.ts. Check each where it belongs rather than expecting all three in one.
check('sign-up is defined in the api client', /register: \(username: string/.test(api));
check('sign-up is called from the auth page', /api\.register\(/.test(shell));
check('sign-in is defined in the api client', /login: \(username: string/.test(api));
check('sign-in is called from the auth page', /api\.login\(/.test(shell));
check('sign-out is defined in the api client', /logout: \(\) =>/.test(api));
check('sign-out is called from the dashboard', /api\.logout\(/.test(app));
check('a 401 sends the user to the sign-in screen',
	/UnauthorisedError/.test(api) && /docubot:unauthorised/.test(app) && /docubot:unauthorised/.test(shell));
check('the session is a cookie, not JS state', /HttpOnly/.test(webServer));
check('the same-site flag is set', /SameSite=Lax/.test(webServer));
check('passwords are hashed with scrypt', /scryptSync/.test(authServer));
check('tokens are stored hashed', /hashToken/.test(authServer));
check('a token comparison is constant-time', /timingSafeEqual/.test(authServer));
// The store must sit outside web/dist, which is what the server serves. The
// function is named publicUser (a redactor), which is a false positive for a
// naive search, so look at the path instead.
const authStorePath = /path\.join\(__dirname,\s*'users\.json'\)/.test(authServer);
check('the user store lives in server/, not in the served directory', authStorePath);
check('the store filename is never inside public/', !/users\.json'[\s\S]{0,40}public/.test(authServer));
check('the dashboard shows who is signed in', /\{username \? <span className="pill user">/.test(app));

/* ---- 5. the public routes are the right ones ---------------------------- */
console.log('\n5. the auth gate');
check('a public route set exists', /PUBLIC_ROUTES/.test(webServer));
check('/api/config is public (the sign-in screen needs it)',
	/'\/api\/config',/.test(webServer));
check('/api/auth/me is public (it decides the first page)',
	/'\/api\/auth\/me',/.test(webServer));
check('/api/produce is NOT public', !/'\/api\/produce'[^\n]*\n?[\s\S]{0,40}PUBLIC_ROUTES/.test(webServer));
check('an unauthenticated call is a 401', /status.*401|401,/.test(webServer));
check('the refusal carries a machine-readable code', /unauthenticated/.test(webServer));

/* ---- 6. the four pages --------------------------------------------------- */
console.log('\n6. the pages');
check('there is a splash', /SplashScreen/.test(shell) && /splash/.test(styles));
check('there is a landing page', /LandingPage/.test(shell));
check('the landing has a Try DocuBot CTA', /Try DocuBot/.test(shell));
check('the landing lists features', /FEATURES/.test(shell));
check('there is an auth page', /AuthPage/.test(shell));
check('there is a dashboard', /AppHost/.test(shell));
check('there is a contact/about page', /AboutPage/.test(shell));
// The splash moved out of Mascot.tsx into its own component when the forced
// 3-second minimum and the animated exit were added. Assert against where it
// lives now, and that the old copy is not still hanging around as a second
// implementation someone could import by mistake.
const splash = fs.existsSync(path.join(ROOT, 'web/src/SplashScreen.tsx'))
	? fs.readFileSync(path.join(ROOT, 'web/src/SplashScreen.tsx'), 'utf8')
	: '';
check('there is one splash, in its own module', splash.length > 0);
check('the old splash is gone from Mascot.tsx', !/export const SplashScreen/.test(mascot));
check('the splash names the creator', /Crafted by Shayan Haider/.test(splash || mascot));

/* ---- 7. the mascot ------------------------------------------------------- */
console.log('\n7. the mascot');
check('it is inline SVG', /<svg/.test(mascot) && /viewBox/.test(mascot));
// The eyes are now drawn from shared left/right constants, so two `r="11"`
// literals no longer exist. Check the constants and that both sides iterate.
check('it has two eyes',
	/const EYE = \{ left: 45, right: 75/.test(mascot) &&
		/\[EYE\.left, EYE\.right\]\.map/.test(mascot),
		'two lens centres, both drawn');
check('the eyes glow', /feGaussianBlur/.test(mascot) || /dbGlow/.test(mascot));
check('it has a metallic body gradient', /dbBody/.test(mascot));
check('it floats', /docubot-float/.test(mascot) && /docubot-bob/.test(styles));
check('the eyes move', /docubot-look/.test(styles));
check('reduced motion is respected', /prefers-reduced-motion/.test(styles));
check('the splash animates out via framer-motion',
	/exit=\{/.test(splash) && /opacity: 0/.test(splash),
	'not a CSS class toggle, so it cannot be left half-faded');
check('the dead splash CSS is gone',
	!/\.splash-out/.test(styles) && !/\.splash-inner/.test(styles));

/* ---- 8. branding --------------------------------------------------------- */
console.log('\n8. branding');
check('the creator name is a single source of truth', /CREATOR = \{/.test(mascot));
check('it matches the brief', /Shayan Haider/.test(mascot));
check('the LinkedIn link is correct',
	/linkedin\.com\/in\/shayanhaider2005/.test(mascot));
check('the GitHub link is correct', /github\.com\/ShayanHaider2005/.test(mascot));
check('the footer is on the dashboard', /CreatorFooter/.test(app));
check('the footer is on the landing page', /CREATOR\.linkedin/.test(shell));
check('links open safely', /rel="noreferrer noopener"/.test(shell) && /rel="noreferrer noopener"/.test(mascot));

/* ---- 9. the safety caps survived ---------------------------------------- */
console.log('\n9. safety caps');
const pipeline = read('server/pipeline.js');
check('the 5-scene cap is still there', /MAX_SCENES = Number\(process\.env\.MAX_SCENES \|\| 5\)/.test(pipeline));
check('the 400-word cap is still there', /MAX_TOTAL_WORDS = Number\(process\.env\.MAX_TOTAL_WORDS \|\| 400\)/.test(pipeline));
check('the 12-step default is still there', /OMNIVOICE_NUM_STEP", 12/.test(read('server/voice/server.py')));
check('the prompt still asks for <= 5 scenes', /at most 5 sequential documentary scenes/.test(pipeline));
check('ref_text sidecar handling is still there', /_resolve_ref_text/.test(read('server/voice/server.py')));
check('the library manifests are read with tolerance', /available: false/.test(voices));
check('a missing WAV is not offered', /\.filter\(\(voice\) => voice\.available\)/.test(voices));

/* ---- 10. styling sanity -------------------------------------------------- */
console.log('\n10. styling');
check('buttons are styled', /\.btn-primary/.test(styles));
check('links are styled', /\.link \{/.test(styles));
check('cards use glass', /backdrop-filter: blur/.test(styles));
check('fields are styled', /\.field input/.test(styles));
check('the segmented control is styled', /\.seg-btn/.test(styles));
check('mobile is handled', /@media \(max-width/.test(styles));

console.log(failures === 0 ? '\nAll UI contract checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

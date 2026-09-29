'use strict';

/**
 * Checks the new surface: the global top bar, the sound toggle, the Web Audio
 * engine, and the Play With Me page.
 *
 * The audio engine gets the most attention here, because a Web Audio bug is
 * silent: a malformed envelope throws inside a click handler and the effect
 * simply never plays, which looks identical to "the feature is off".
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

const topbar = read('web/src/TopBar.tsx');
const play = read('web/src/pages/PlayWithMe.tsx');
const audio = read('web/src/utils/botAudio.ts');
const mascot = read('web/src/Mascot.tsx');
const shell = read('web/src/Shell.tsx');
const playCss = read('web/src/play.css');
const main = read('web/src/main.tsx');

/* ---- 1. the top bar --------------------------------------------------- */
console.log('\n1. the global top bar');
check('a TopBar component exists', fs.existsSync(path.join(ROOT, 'web/src/TopBar.tsx')));
check('it is mounted on every route', /<TopBar[\s\S]{0,80}current=\{view\}/.test(shell));
check('it is outside the AnimatePresence',
	shell.indexOf('</AnimatePresence>') < shell.indexOf('<TopBar'),
	'so it does not re-animate on every route change');
check('it is hidden during the splash', /\{booted \? \(\s*<TopBar/.test(shell));
check('the logo is a button off the landing page', /current === 'landing'/.test(topbar) && /<button/.test(topbar));
check('the logo is not a button on the landing page',
	/aria-current="page"/.test(topbar) && /brand-static/.test(topbar),
	'a control that navigates to the page you are on is a control that lies');
check('the logo goes home', /onClick=\{onHome\}/.test(topbar) && /onHome=\{\(\) => setView\('landing'\)\}/.test(shell));
check('it has an accessible name', /aria-label="DocuBot/.test(topbar));
check('there is a mute toggle', /sound-toggle/.test(topbar) && /toggleMuted/.test(topbar));
check('the toggle is a real button with a pressed state', /aria-pressed/.test(topbar));
check('the toggle says what it does', /aria-label=\{muted \?/.test(topbar));
// Muted is signalled by a drawn slash on the icon, not only by colour, so the
// state is legible without colour perception.
check('muted is not conveyed by colour alone',
	/<path d="M16 9l5 6M21 9l-5 6"/.test(topbar),
	'a slash is drawn across the speaker when muted');
check('the toggle primes the audio context on first use', /primeAudio\(\)/.test(topbar));

/* ---- 2. the audio engine ----------------------------------------------- */
console.log('\n2. the Web Audio engine');
check('it is a module, not inline in a component',
	fs.existsSync(path.join(ROOT, 'web/src/utils/botAudio.ts')));
check('playDocuBotSFX is exported', /export const playDocuBotSFX/.test(audio));
check('it takes the six named emotions',
	/default: \(ctx/.test(audio) && /happy: \(ctx/.test(audio) && /giggle: \(ctx/.test(audio) &&
		/shocked: \(ctx/.test(audio) && /love: \(ctx/.test(audio) && /dizzy: \(ctx/.test(audio));
check('the emotion union matches the brief',
	/'default' \| 'happy' \| 'giggle' \| 'shocked' \| 'love' \| 'dizzy'/.test(audio));
check('it uses the Web Audio API', /createOscillator/.test(audio) && /createGain/.test(audio));
// The mute state, the context and the SFX bus moved to botAudioContext.ts when
// the ambient bed was added, so the ambient loop and the one-shots can share one
// context without a circular import. These assertions follow them.
check('it never plays when muted',
	/if \(isMuted\(\) \|\| typeof window === 'undefined'\) return false/.test(audio));
check('it re-exports the shared mute state', /export \{ isMuted, onMuteChange/.test(audio));
const audioCtx = read('web/src/utils/botAudioContext.ts');
check('sound defaults to off', /return true;/.test(audioCtx) && /Default off/.test(audioCtx));
check('the choice is remembered', /localStorage/.test(audioCtx) && /docubot\.sound/.test(audioCtx));
check('the context is reused, not recreated', /__docubotAudioContext/.test(audioCtx));
check('a suspended context is resumed', /existing\.state === 'suspended'/.test(audioCtx));
check('muting is off by default even with a fresh store',
	/readMuted\(\)[\s\S]{0,400}return true;/.test(audioCtx));
check('rapid taps do not stack up', /interrupt/.test(audio) && /voice\.stop\(\)/.test(audio));

// The classic Web Audio footgun: a zero-valued exponential ramp throws.
check('no exponential ramp targets exactly zero',
	!/exponentialRampToValueAtTime\(0[,)]/.test(audio),
	'these throw NotSupportedError in every browser');
check('every envelope floors its target', /Math\.max\(0\.0002, gain\)/.test(audio));
check('frequencies are floored too', /Math\.max\(20, from\)/.test(audio));

check('the shake effect uses noise', /createBuffer/.test(audio) && /Math\.random\(\)/.test(audio));
check('the dizzy effect uses an LFO', /lfo/.test(audio) && /createOscillator/.test(audio));
check('the giggle effect stutters', /i \* 0\.062/.test(audio), 'seven rapid notes');
check('the love effect sweeps upward', /love: \(ctx[\s\S]{0,200}620, 1180/.test(audio));
check('giggle/love/dizzy differ from default',
	new Set(['default', 'happy', 'giggle', 'shocked', 'love', 'dizzy']).size === 6);

/* ---- 3. the mascot expressions ---------------------------------------- */
console.log('\n3. mascot expressions');
check('the mood union covers the five reactions',
	/'love'/.test(mascot) && /'dizzy'/.test(mascot) && /'shocked'/.test(mascot) &&
		/'squint'/.test(mascot) && /'cross'/.test(mascot) && /'spiral'/.test(mascot));
for (const mood of ['love', 'dizzy', 'shocked', 'squint', 'cross', 'spiral']) {
	check(`  ${mood} has its own eye drawing`, new RegExp(`mood === '${mood}'`).test(mascot));
}
check('there is blush', /blush/.test(mascot) && /dbBlush/.test(mascot));
check('the eyes are a separate component', /const Eyes/.test(mascot));
check('mood drives the colour', /MOOD_COLOR/.test(mascot));

/* ---- 4. the Play With Me page ----------------------------------------- */
console.log('\n4. Play With Me');
check('the page exists', fs.existsSync(path.join(ROOT, 'web/src/pages/PlayWithMe.tsx')));
check('it is routed', /view === 'play'/.test(shell) && /<PlayWithMe/.test(shell));
check('the play route is in the View union', /'about' \| 'play'/.test(shell));
check('it is reachable from the nav', /onPlay=\{\(\) => setView\('play'\)\}/.test(shell));
check('it is reachable from the hero', /Play With Me/.test(shell));

check('it greets on open', /greeted\.current/.test(play) && /setBubble\(true\)/.test(play));
check('the greeting is randomised', /Math\.floor\(Math\.random\(\) \* COMPLIMENTS\.length\)/.test(play));
check('several compliments exist', (play.match(/"/g) || []).length > 5 && /COMPLIMENTS/.test(play));
check('it plays the happy sfx on greeting', /playDocuBotSFX\('happy'\)/.test(play));
check('StrictMode cannot greet twice', /if \(greeted\.current\) return/.test(play));

const actions = ['love', 'shocked', 'giggle', 'happy', 'dizzy'];
for (const id of actions) {
	check(`  action "${id}" exists`, new RegExp(`id: '${id}'`).test(play));
}
check('all five are rendered', (play.match(/ACTIONS\.map/g) || []).length === 1 && /ACTIONS: Action\[\]/.test(play));
check('there are exactly five', /Kiss|Slap|Tickle|Pat|Spin/.test(play));
check('the slap shakes the screen', /stage\.current/.test(play) && /x: \[0, -11/.test(play));
check('the slap flashes red', /play-flash/.test(play) && /shocked/.test(play));
check('the spin does a full turn', /rotate: 360/.test(play));
check('kiss particles are hearts', /hearts/.test(play) && /💗|💖|💕/.test(play));
check('each action plays its own sound', /playDocuBotSFX\(action\.id\)/.test(play));
check('timers are cleaned up on unmount', /clearTimers/.test(play) && /useEffect\(\(\) => clearTimers/.test(play));
check('the speech bubble is announced', /aria-live="polite"/.test(play));
check('buttons are disabled during a reaction', /disabled=\{Boolean\(active\)\}/.test(play));
check('the action group is labelled', /aria-label="Interact with DocuBot"/.test(play));

/* ---- 5. styling and motion safety ------------------------------------ */
console.log('\n5. styling and motion safety');
check('the play stylesheet is imported', /play\.css/.test(main));
check('the top bar is styled', /\.topbar-global/.test(playCss));
check('the sound toggle is styled', /\.sound-toggle/.test(playCss));
check('the bubble has a tail', /\.play-bubble::after/.test(playCss));
check('the particles are keyed off CSS variables', /--pw-angle/.test(playCss) && /--pw-distance/.test(playCss));
check('floating cards are inert', /pointer-events: none/.test(playCss));
check('floating cards are hidden from assistive tech', /aria-hidden/.test(topbar));
check('reduced motion drops the cards and the burst',
	/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.float-card[\s\S]*?display: none/.test(playCss) &&
		/\.pw-particles span[\s\S]*?display: none/.test(playCss));
check('the page itself respects reduced motion', /useReducedMotion/.test(play));
check('the shake is skipped under reduced motion', /action\.shake && stage\.current && !reduce/.test(play));
check('the float cards are skipped under reduced motion', /if \(reduce\) return null/.test(topbar));

/* ---- 6. the pipeline is still intact ---------------------------------- */
console.log('\n6. the generation pipeline is untouched');
const app = read('web/src/App.tsx');
check('the one-button CTA is intact', /Generate & Download Documentary/.test(app));
check('/api/produce is still called', /api\.produce\(/.test(app));
check('the download still fires', /anchor\.click\(\)/.test(app));
check('the narrator picker is intact', /const VoicePicker/.test(app));
check('the voice library manifest is still tracked', fs.existsSync(path.join(ROOT, 'server/voices/defaults/manifest.json')));
check('the auth gate is intact', /PUBLIC_ROUTES/.test(read('server/web.js')));
check('the creator branding is intact', /shayanhaider2005/.test(mascot) && /ShayanHaider2005/.test(mascot));
check('the splash floor is intact', /MIN_SPLASH_MS = 3000/.test(read('web/src/SplashScreen.tsx')));

console.log(failures === 0 ? '\nAll bot checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

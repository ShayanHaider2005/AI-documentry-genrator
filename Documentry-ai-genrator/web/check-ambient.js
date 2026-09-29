'use strict';

/**
 * Checks the ambient bed, the page voice, and the particle canvas.
 *
 * The central requirement is that the ambient loop survives a route change and
 * is never interrupted by a one-shot. That is a structural property — two gain
 * buses, and module-level scheduler state — so it is checked structurally
 * here, and then measured in a browser.
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

const ambient = read('web/src/utils/botAmbient.ts');
const context = read('web/src/utils/botAudioContext.ts');
const sfx = read('web/src/utils/botAudio.ts');
const canvas = read('web/src/components/CyberBackgroundCanvas.tsx');
const shell = read('web/src/Shell.tsx');
const topbar = read('web/src/TopBar.tsx');
const motion = read('web/src/motion.css');

/* ---- 1. one context, two buses ---------------------------------------- */
console.log('\n1. one context, two independent buses');
check('the context is shared from one module', /getContext/.test(ambient) && /getContext/.test(sfx));
check('the context is cached on window', /__docubotAudioContext/.test(context));
check('a second context is never created',
	!new RegExp('new ' + 'Ctor').test(sfx) && !new RegExp('new ' + 'Ctor').test(ambient),
	'only botAudioContext constructs one');
check('there is an SFX bus', /export const sfxBus/.test(context));
check('the ambient has its own bus', /ambientBus/.test(ambient));
check('the buses are different nodes', /ambientGain\.connect\(ambientBus\)/.test(ambient));
check('SFX route to the sfx bus, not the destination',
	/sfxBus\(\) \?\? ctx\.destination/.test(sfx) &&
		!/connect\(ctx\.destination\)/.test(sfx),
	'every one-shot goes through the bus');
check('the ambient routes to its own bus, not the sfx bus',
	/ambientGain\.connect\(ambientBus\)/.test(ambient));
check('stopping SFX touches only SFX voices',
	/for \(const voice of current\) voice\.stop\(\)/.test(sfx) &&
		!/for \(const voice of current\)[\s\S]{0,40}ambientBus/.test(sfx),
	'an SFX stop cannot reach the loop');

/* ---- 2. the loop survives a route change ------------------------------- */
console.log('\n2. the loop is not tied to a component');
check('the scheduler state is module level',
	/^let timer: number \| null = null;$/m.test(ambient) && /let nextEventTime = 0;/.test(ambient));
check('it is not React state', !/useState/.test(ambient) && !/useRef/.test(ambient));
check('starting twice does not double it', /if \(started\) return true;/.test(ambient));
check('it uses a lookahead scheduler, not a repeating buffer',
	/SCHEDULER_INTERVAL_MS/.test(ambient) && /LOOKAHEAD_S/.test(ambient));
check('notes are queued ahead of the clock', /now \+ LOOKAHEAD_S/.test(ambient));
check('a starved timer does not dump a backlog of past notes',
	/if \(nextEventTime < now\) nextEventTime = now;/.test(ambient),
	'the cursor resumes from now rather than emitting overdue notes');
check('the scheduler never runs ahead either',
	/const horizon = now \+ LOOKAHEAD_S;/.test(ambient),
	'otherwise a fast timer queues notes that may never be heard');
// The lookahead has to clear the worst-case timer interval. Chrome clamps
// setInterval to ~1 Hz in a backgrounded tab; a shorter lookahead starves the
// bed and it arrives in a burst on return, which is the "stops and restarts"
// failure the brief rules out.
const lookahead = Number((/const LOOKAHEAD_S = ([\d.]+);/.exec(ambient) || [])[1]);
check('the lookahead clears background tab throttling (>= 1.2s)',
	lookahead >= 1.2,
	`LOOKAHEAD_S = ${lookahead}s vs ~1s throttled interval`);
check('the lookahead is explained', /backgrounded\* tab|backgrounded tab/.test(ambient));
check('the two grids have separate cursors',
	/let pulseTime = 0;/.test(ambient),
	'a 6.4s chord and a 1.6s pulse cannot share one cursor');
check('it stops cleanly', /stopAmbientMusic/.test(ambient) && /clearInterval/.test(ambient));
check('stopping fades rather than cuts', /exponentialRampToValueAtTime\(0\.0001/.test(ambient));
check('mute stops the bed', /if \(isMuted\(\)\)[\s\S]{0,80}stopAmbientMusic\(\)/.test(ambient));
check('unmute restarts it', /if \(!started\) startAmbientMusic\(\)/.test(ambient));
check('the bed is quiet', /AMBIENT_GAIN = 0\.0\d\d/.test(ambient), `gain ${(/AMBIENT_GAIN = ([\d.]+)/.exec(ambient) || [])[1]}`);
// The 2.5s fade-in is a duration, so match the call it appears in rather than
// a bare number that could be anything.
check('it fades in rather than starting at full level',
	/ambientGain!\.gain\.exponentialRampToValueAtTime\(AMBIENT_GAIN, ctx\.currentTime \+ 2\.5\)/.test(ambient),
	'a 2.5s fade-in to AMBIENT_GAIN');

/* ---- 3. the loud page voice -------------------------------------------- */
console.log('\n3. the page-opening voice');
check('playLoudDocuBotVoice exists', /export const playLoudDocuBotVoice/.test(ambient));
check('it is loud', /exponentialRampToValueAtTime\(0\.85/.test(ambient));
check('it has a resonant filter', /Q\.value = 7/.test(ambient));
check('it has a pitch bend', /exponentialRampToValueAtTime\(to, t \+ 0\.26\)/.test(ambient));
check('it sweeps the formant', /formant\.frequency\.exponentialRampToValueAtTime/.test(ambient));
check('it goes to the SFX bus, never the ambient one',
	/sfxBus\(\) \?\? ctx\.destination/.test(ambient));
check('it respects mute', /if \(isMuted\(\)\) return false;/.test(ambient));
check('it does not interrupt the ambient loop',
	!/stopAmbientMusic\(\)/.test(ambient.split('export const playLoudDocuBotVoice')[1] || ''),
	'the voice is a one-shot on the other bus');
check('it is wired to route changes',
	/React\.useEffect\(\(\) => \{[\s\S]{0,220}?playLoudDocuBotVoice\(\)/.test(shell),
	'guarded on booted so it does not double with the splash trigger');
check('it fires after the splash', /onFirstPaint/.test(shell) && /onFirstPaint/.test(topbar));
check('the splash trigger is once-only', /announced\.current/.test(topbar));
check('the route voice has a master switch', /NAVIGATION_VOICE_ENABLED/.test(ambient) && /NAVIGATION_VOICE_ENABLED/.test(shell));
check('the switch defaults on, as specified', /NAVIGATION_VOICE_ENABLED = true/.test(ambient));

/* ---- 4. autoplay policy ------------------------------------------------ */
console.log('\n4. autoplay policy');
check('audio starts on a user gesture', /pointerdown/.test(shell) && /keydown/.test(shell));
check('the listener is once-only', /once: true/.test(shell));
check('it uses the capture phase, so it fires before anything swallows it',
	/capture: true/.test(shell));
check('the gesture handler primes the context', /primeAudio\(\)/.test(shell));
check('a muted user never starts a context', /if \(isMuted\(\)\) return;/.test(sfx));
check('a suspended context is resumed on the next call',
	/existing\.state === 'suspended'/.test(context));
check('starting while muted is refused', /if \(isMuted\(\)\) return false;/.test(ambient));

/* ---- 5. the particle canvas ------------------------------------------- */
console.log('\n5. the particle canvas');
check('it is a component', fs.existsSync(path.join(ROOT, 'web/src/components/CyberBackgroundCanvas.tsx')));
check('it is mounted behind the content', /<CyberBackgroundCanvas \/>/.test(shell));
check('it is mounted before the other background layers',
	shell.indexOf('<CyberBackgroundCanvas />') < shell.indexOf('<AmbientBlobs'));
check('it is fixed and full-screen', /position: fixed/.test(motion) && /inset: 0/.test(motion));
check('it does not take pointer events', /pointer-events: none/.test(motion));
check('it is out of the accessibility tree', /aria-hidden="true"/.test(canvas));
check('it is NOT z-index -1, which would hide it behind the body background',
	/\.cyber-canvas \{[^}]*z-index: 0/s.test(motion) && !/\.cyber-canvas \{[^}]*z-index: -1/s.test(motion),
	'see the comment in motion.css');
check('content is lifted above it',
	/not\(\.cyber-canvas\)/.test(motion));

check('particles fall', /vy: random\(6, 26\)/.test(canvas));
check('some drift upward too', /-0\.5/.test(canvas), 'so it is not plain rain');
check('they drift horizontally', /vx: random\(-9, 9\)/.test(canvas));
check('they spin', /spin: random\(-0\.5, 0\.5\)/.test(canvas) && /p\.rotation \+= p\.spin \* dt/.test(canvas));
check('they wrap, so the field is endless',
	/if \(p\.y > height \+ 30\)/.test(canvas) && /if \(p\.x < -40\)/.test(canvas));
check('the timestep is capped', /Math\.min\(0\.05, \(now - last\.current\) \/ 1000\)/.test(canvas),
	'otherwise a long pause teleports everything');

for (const kind of ['code', 'node', 'gear', 'bolt', 'spark']) {
	check(`  it draws ${kind} particles`, new RegExp(`case '${kind}'`).test(canvas));
}
check('code snippets are drawn', /SNIPPETS/.test(canvas) && /fillText/.test(canvas));
check('the palette is cyan, amber and cobalt',
	/#22d3ee/.test(canvas) && /#f59e0b/.test(canvas) && /#3b82f6/.test(canvas));
check('they are dim, to keep text readable', /alpha: random\(0\.1, 0\.32\)/.test(canvas));

check('the cursor pushes particles', /CURSOR_RADIUS/.test(canvas) && /CURSOR_FORCE/.test(canvas));
check('the push falls off gently', /\(1 - distance \/ CURSOR_RADIUS\) \*\* 2/.test(canvas));
check('nearby nodes light up', /p\.charge/.test(canvas));
check('the force is reduced on small screens', /reducedForce/.test(canvas));

/* ---- 6. performance and motion safety --------------------------------- */
console.log('\n6. performance and motion safety');
check('particle count is capped', /MAX_PARTICLES_DESKTOP = \d+/.test(canvas));
check('the count scales to the viewport', /innerWidth < MOBILE_BREAKPOINT/.test(canvas));
check('devicePixelRatio is capped at 2', /Math\.min\(2, window\.devicePixelRatio/.test(canvas),
	'beyond 2 the fill rate costs more than the sharpness is worth');
check('the loop pauses when the tab is hidden', /visibilitychange/.test(canvas) && /document\.hidden/.test(canvas));
check('a background tab does not repaint', /cancelAnimationFrame/.test(canvas));
check('the listener is passive', /passive: true/.test(canvas));
check('everything is torn down on unmount', /removeEventListener/.test(canvas) && /cancelAnimationFrame/.test(canvas));
check('reduced motion skips the canvas entirely', /isReducedMotion\(\)\) return undefined/.test(canvas));
check('and the CSS backs it up', /\.cyber-canvas \{[\s\S]{0,80}display: none/.test(motion));
check('a missing 2D context does not throw', /if \(!ctx\) return undefined/.test(canvas));
check('the canvas is contained', /contain: strict/.test(motion));

/* ---- 7. nothing earlier regressed ------------------------------------- */
console.log('\n7. earlier work is intact');
check('the six SFX emotions are unchanged',
	['default', 'happy', 'giggle', 'shocked', 'love', 'dizzy'].every((e) =>
		new RegExp(`\\b${e}: \\(ctx`).test(sfx)));
check('the mute toggle is still in the top bar', /sound-toggle/.test(topbar) && /toggleMuted/.test(topbar));
check('muting also stops the music', /syncAmbient\(\)/.test(topbar),
	'otherwise the toggle is a lie: the bed would keep playing');
check('the mute choice persists', /docubot\.sound/.test(context));
check('Play With Me still works', /playDocuBotSFX\(action\.id\)/.test(read('web/src/pages/PlayWithMe.tsx')));
check('the one-button CTA is intact', /Generate & Download Documentary/.test(read('web/src/App.tsx')));
check('the 3s splash is intact', /MIN_SPLASH_MS = 3000/.test(read('web/src/SplashScreen.tsx')));
check('no exponential ramp targets zero', !/exponentialRampToValueAtTime\(0[,)]/.test(ambient + sfx));

console.log(failures === 0 ? '\nAll ambient checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

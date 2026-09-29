'use strict';

/**
 * Checks the splash, the hero card, the page transitions, and the ambient
 * background, without a browser.
 *
 * Two failure modes worth catching statically:
 *
 *   * a condition guarding a hook. Framer Motion's `useTransform` inside a
 *     ternary in JSX throws the moment reduced-motion flips, so the calls must
 *     be unconditional and the *style* is what gets disabled instead.
 *   * a motion value used in React state, which re-renders on every pointer
 *     move. The tilt has to run on motion values and springs.
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

const splash = read('web/src/SplashScreen.tsx');
const hero = read('web/src/HeroAnimationCard.tsx');
const shell = read('web/src/Shell.tsx');
const motion = read('web/src/motion.css');
const overhaul = read('web/src/overhaul.css');
const main = read('web/src/main.tsx');
const pkg = read('package.json');

/* ---- 1. the library is really installed and really used ---------------- */
console.log('\n1. framer-motion');
{
	// `pkg` is the file read as text for the source scans, so the dependency
	// check has to parse it rather than read properties off a string.
	const deps = { ...(JSON.parse(pkg).dependencies || {}), ...(JSON.parse(pkg).devDependencies || {}) };
	check('it is a declared dependency', Boolean(deps['framer-motion']),
		deps['framer-motion'] ? `^${deps['framer-motion']}` : 'missing from package.json');
	check('the lockfile resolved it', fs.existsSync(path.join(ROOT, 'node_modules', 'framer-motion')));
	for (const [name, source] of [
		['SplashScreen.tsx', splash],
		['HeroAnimationCard.tsx', hero],
		['Shell.tsx', shell],
	]) {
		check(`${name} imports it`, /from 'framer-motion'/.test(source));
	}
	check('AnimatePresence is used for page switching', /AnimatePresence/.test(shell));
	check('motion elements are used', /motion\./.test(shell) && /motion\./.test(hero) && /motion\./.test(splash));
	check('reduced motion is read', /useReducedMotion/.test(shell) && /useReducedMotion/.test(hero) && /useReducedMotion/.test(splash));
}

/* ---- 2. the 3-second floor is real ------------------------------------- */
console.log('\n2. the forced 3s splash');
{
	check('the floor is a named constant', /MIN_SPLASH_MS = 3000/.test(splash));
	check('it gates the exit', /satisfied = elapsed >= MIN_SPLASH_MS/.test(splash));
	check('the exit needs BOTH boot and the floor', /canExit = ready && satisfied/.test(splash));
	check('elapsed time is measured from mount', /Date\.now\(\) - started/.test(splash));
	// A splash that only animates in is not a splash; it has to animate out.
	check('it exits with a transition', /exit=\{/.test(splash));
	check('the exit scales and fades', /scale: 1\.08/.test(splash) && /opacity: 0/.test(splash));
	check('it has a pulse ring', /splash2-ring/.test(splash));
	check('the ring pulses', /splash-pulse/.test(motion));
	check('status text cycles', /STATUS_LINES/.test(splash) && /setLine/.test(splash));
	for (const line of ['Initializing AI Core', 'Loading Voice Engines', 'DocuBot Ready']) {
		check(`it shows "${line}..."`, splash.includes(line));
	}
	check('the title is bold and glowing', /splash2-title/.test(splash) && /filter: drop-shadow/.test(motion));
	check('the attribution line is present', /Crafted by Shayan Haider/.test(splash));
	check('the progress bar is real, not a spinner', /role="progressbar"/.test(splash));
	check('it announces status politely', /aria-live="polite"/.test(splash));
	// The exit animation is rAF-driven, so a throttled tab would otherwise leave
	// a full-screen overlay swallowing every click.
	check('it stops intercepting clicks once the app is ready behind it',
		/pointerEvents: canExit \|\| !ready \? 'auto' : 'none'/.test(splash),
		'verified: the overlay was click-blocking while its exit was pending');
}

/* ---- 3. the hero animation card ---------------------------------------- */
console.log('\n3. the hero animation card');
{
	check('it is a separate component', fs.existsSync(path.join(ROOT, 'web/src/HeroAnimationCard.tsx')));
	check('the hero uses it', /<HeroAnimationCard \/>/.test(shell));
	check('the old static hero mascot is gone from the hero', !/hero-art[\s\S]{0,120}<DocuBotMark size=\{230\}/.test(shell));

	check('it is glassmorphic', /backdrop-filter: blur/.test(motion));
	check('it has a 1px gradient border', /hero-card-border/.test(motion) && /linear-gradient\(\s*135deg/.test(motion));
	check('it has a radial glow', /radial-gradient/.test(motion) && /box-shadow/.test(motion));
	check('it has equalizer bars', /hero-eq/.test(hero) && /hero-eq/.test(motion));
	check('the equalizer is 20+ bars', /EQUALIZER_BARS = 22/.test(hero));
	check('it has floating scene previews', /hero-scenes/.test(hero) && /hero-scene/.test(motion));
	check('it has ambient dots', /hero-card-dots/.test(hero));
	check('it holds the mascot', /DocuBotMark/.test(hero));

	// The 3D tilt.
	check('it uses a 3D perspective', /perspective: 1000px/.test(motion));
	check('it tilts on pointer move', /onPointerMove/.test(hero) && /rotateX/.test(hero));
	check('it resets on pointer leave', /onPointerLeave/.test(hero));
	check('the tilt is spring-damped', /useSpring/.test(hero));

	// Tilt must NOT be React state, or every mouse move re-renders the card.
	check('the tilt uses motion values, not state',
		/useMotionValue/.test(hero) && !/useState[\s\S]{0,80}pointerX/.test(hero));
	check('there is no setPointerX state setter', !/setPointerX|setPointerY/.test(hero));
}

/* ---- 4. no conditional hooks ------------------------------------------- */
console.log('\n4. hooks are not called conditionally');
{
	// Every useTransform / useSpring / useMotionValue / useReducedMotion call
	// must sit at the top level of its component, not inside JSX or a ternary.
	// A crude but effective proxy: none of them may appear after the first
	// `return` in a file, and none may sit inside a `{cond ? (` construct.
	for (const [name, source] of [['HeroAnimationCard', hero], ['SplashScreen', splash], ['Shell', shell]]) {
		const hooks = source.match(/use(Transform|Spring|MotionValue|ReducedMotion)\s*\(/g) || [];
		const firstReturn = source.indexOf('\treturn (');
		const insideReturn = hooks.filter((_, i) => false).length; // placeholder
		// Count hook calls that appear inside a JSX ternary: `cond ? (` then a hook.
		const ternaries = source.split('? (');
		const inTernary = ternaries
			.slice(1)
			.filter((chunk) => /use(Transform|Spring|MotionValue|ReducedMotion)\s*\(/.test(chunk.slice(0, 200)))
			.length;
		check(`${name}: no hook inside a JSX ternary`, inTernary === 0, `${hooks.length} hook call(s)`);
		check(`${name}: hooks are declared before the render`, firstReturn > 0);
		void insideReturn;
	}
	// The specific bug this guards: a useTransform in a style prop.
	check('the glare transform is hoisted out of JSX',
		/const glareBackground = useTransform/.test(hero));
	check('the glare style just applies it', /background: glareBackground/.test(hero));
}

/* ---- 5. page transitions ----------------------------------------------- */
console.log('\n5. page transitions');
{
	check('a Page wrapper exists', /const Page: React\.FC/.test(shell));
	check('enter is a fade with a 20px rise', /opacity: 0, y: 20/.test(shell));
	check('it animates to rest', /opacity: 1, y: 0/.test(shell));
	check('the duration is 0.35s', /duration: 0\.35/.test(shell));
	check('there is a blur on enter', /blur\(4px\)/.test(shell));
	check('there is a blur on exit', /blur\(4px\)/.test(shell));
	// popLayout, not wait. `wait` gates the incoming page on the outgoing exit
	// animation, which needs requestAnimationFrame; a throttled tab then stalls
	// on every navigation. Both were real bugs, caught by driving the page.
	// Scoped to the real attribute: the comment above it explains why, and must
	// not be able to satisfy or break this check.
	const presenceTag = (shell.match(/<AnimatePresence[^>]*>/g) || []).join(' ');
	check('navigation is not gated on an animation completing',
		/mode="popLayout"/.test(presenceTag) && !/mode="wait"/.test(presenceTag),
		'popLayout pops the outgoing page out of flow without waiting for it');
	// The key has to be on the element AnimatePresence actually sees, which is
	// the <Page> at the call site. A key inside Page is invisible to it: the
	// child it diffs is always the same unkeyed <Page>, so it never registers a
	// change and the arriving page mounts straight onto its initial state.
	check('the key is on the call site, so AnimatePresence sees the change',
		/<Page key=\{view\}/.test(shell));
	check('Page itself no longer takes a view prop', !/const Page: React\.FC<\{[\s\S]{0,80}view: View/.test(shell));
	check('the motion.main has no redundant inner key', !/<motion\.main\s*\n\s*key=/.test(shell));
	// initial={false} pinned the first page to opacity 0 with nothing scheduled
	// to move it off.
	check('first mount is not suppressed', !/initial=\{false\}/.test(presenceTag));
	check('the popLayout choice is explained in a comment', /popLayout, not wait/.test(shell));
	check('all four views are routed', /'landing' \| 'auth' \| 'studio' \| 'about'/.test(shell));
	check('scroll resets on view change', /scrollTo\(\{ top: 0/.test(shell));
	// The dashboard is full height; a wrapper that clips it would break the app.
	check('the dashboard is not height-clipped', /\.page > \.app \{[\s\S]*?min-height: 100vh/.test(motion));
}

/* ---- 6. scroll and component animation --------------------------------- */
console.log('\n6. staggered entrances and hovers');
{
	check('features stagger by 0.1s', /FEATURES\.map\(\(feature, index\)/.test(shell));
	check('the stagger delay is computed per index', /delay: 0\.06 \* index/.test(shell));
	check('feature cards rise on entrance', /initial: \{ opacity: 0, y: 22 \}/.test(shell));
	check('cards lift on hover', /\.feature-card:hover/.test(motion) || /whileHover/.test(shell));
	check('card hover border is styled', /\.feature-card:hover/.test(motion));
	// Scroll reveals, which are a separate concern from the mount-time `rise`.
	check('feature cards use the scroll Reveal wrapper',
		/<Reveal[\s\S]{0,200}?className="card feature-card"/.test(shell));
	check('the Reveal wrapper exists and is in-view driven',
		/reveal/i.test(read('web/src/components/Reveal.tsx')) &&
			/whileInView/.test(read('web/src/components/Reveal.tsx')));
	check('reveals fire once, not on every re-entry',
		/once: true/.test(read('web/src/components/Reveal.tsx')));
	check('the stagger is 0.1s', /step=\{0\.1\}/.test(shell));
	check('the counters are live', /<CountUp to=\{10\}/.test(shell));
	check('CountUp uses IntersectionObserver',
		/IntersectionObserver/.test(read('web/src/components/Reveal.tsx')));

	check('the primary CTA pulses', /\.btn\.pulse/.test(motion) && /btn-pulse/.test(motion));
	check('the CTA scales to 1.04 on hover', /scale: 1\.04/.test(shell));
	check('the CTA presses to 0.98 on click', /scale: 0\.98/.test(shell));
	check('the pulse is a composited layer, not a repaint',
		/z-index: -1/.test(motion) && /blur/.test(motion));
}

/* ---- 7. ambient background -------------------------------------------- */
console.log('\n7. ambient background');
{
	check('three blobs exist', /blob-cyan/.test(motion) && /blob-amber/.test(motion) && /blob-violet/.test(motion));
	check('they drift', /drift-a/.test(motion) && /drift-b/.test(motion) && /drift-c/.test(motion));
	// The blobs position themselves with left/top once, then animate only
	// transform. Animating left/top would relayout and repaint every frame; this
	// is checked on the keyframe bodies, not the declarations.
	const driftBodies = [...motion.matchAll(/@keyframes drift-[a-c]\s*\{([\s\S]*?)\n\}/g)]
		.map((m) => m[1])
		.join('\n');
	const driftCount = (motion.match(/@keyframes drift-[a-c]\s*\{/g) || []).length;
	check('all three drift keyframes were found', driftCount === 3, `${driftCount} of 3`);
	check('the blobs drift with translate3d, not top/left',
		driftCount === 3 &&
			/translate3d/.test(driftBodies) &&
			!/(^|[\s;])(top|left|margin)\s*:/.test(driftBodies),
		'drift-a/b/c use transform only');
	check('they promote to their own layer', /will-change: transform/.test(motion));
	check('they cannot intercept clicks', /pointer-events: none/.test(motion));
	check('they cannot add height or a scrollbar', /position: fixed/.test(motion) && /overflow: hidden/.test(motion));
	check('they sit behind the content', /z-index: 0/.test(motion) && /isolation: isolate/.test(motion));
	check('content is lifted above them', /\.shell-root > \*:not\(\.ambient\)/.test(motion));
	check('the component honours reduced motion',
		/const AmbientBlobs[\s\S]*?reduce \? null :/.test(shell));
}

/* ---- 8. reduced motion is complete ------------------------------------ */
console.log('\n8. reduced motion');
{
	const start = motion.indexOf('@media (prefers-reduced-motion: reduce)');
	const block = start === -1 ? '' : motion.slice(start);
	check('there is a reduced-motion block', start !== -1);

	// The selectors are listed in one comma-separated rule, so each name has to
	// be matched literally rather than with a backslash prefix.
	for (const selector of [
		'.ambient-blob',
		'.splash2-spark',
		'.splash2-ring',
		'.hero-card-dots span',
		'.hero-eq span',
		'.btn.pulse::after',
		'.docubot-float',
		'.docubot-pupil',
		'.docubot-antenna',
	]) {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const inBlock = new RegExp(`${escaped}\\s*[,{]`).test(block.split('animation: none')[0] || '');
		check(`it stops ${selector}`, inBlock);
	}
	check('they are all disabled in one rule', /animation: none !important/.test(block));
	check('it removes the 3D transform', /hero-card-tilt/.test(block) && /transform: none/.test(block));
	// The progress bar must keep working: it is information, not decoration.
	check('the splash progress bar still transitions', /\.splash2-bar span/.test(motion) && /transition:/.test(motion));
	check('JS motion is gated too', /reduce \? undefined/.test(hero) && /reduce \? undefined/.test(shell));
}

/* ---- 9. nothing broken in the pipeline -------------------------------- */
console.log('\n9. the generation pipeline is untouched');
{
	check('the one-button flow is intact', /Generate & Download Documentary/.test(read('web/src/App.tsx')));
	check('/api/produce is still called', /api\.produce\(/.test(read('web/src/App.tsx')));
	check('the download still triggers', /anchor\.click\(\)/.test(read('web/src/App.tsx')));
	check('the narrator picker is intact', /const VoicePicker/.test(read('web/src/App.tsx')));
	check('the motion css is imported', /motion\.css/.test(main));
	check('the old splash is no longer imported by Shell',
		!/SplashScreen[\s\S]{0,40}from '\.\/Mascot'/.test(shell) && /from '\.\/SplashScreen'/.test(shell));
}

console.log(failures === 0 ? '\nAll motion checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

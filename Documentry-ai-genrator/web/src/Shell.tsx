import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { api, UnauthorisedError } from './api';
import { CREATOR, DocuBotMark } from './Mascot';
import { SplashScreen } from './SplashScreen';
import { HeroAnimationCard } from './HeroAnimationCard';
import { TopBar, FloatingCards } from './TopBar';
import { Reveal, CountUp } from './components/Reveal';
import { CyberBackgroundCanvas } from './components/CyberBackgroundCanvas';
import { PlayWithMe } from './pages/PlayWithMe';
import { primeAudio } from './utils/botAudio';
import { playLoudDocuBotVoice, NAVIGATION_VOICE_ENABLED } from './utils/botAmbient';

type View = 'landing' | 'auth' | 'studio' | 'about' | 'play';
type AuthMode = 'login' | 'signup';

/**
 * URL <-> view.
 *
 * These are the paths the app has always used as state names, exposed as real
 * routes. The server already falls back to index.html for unknown paths, so no
 * server change was needed.
 *
 * The internal names are kept for `auth` and `studio` because renaming the view
 * union would churn every call site for no benefit; the URL is what users see.
 */
const VIEW_PATHS: Record<View, string> = {
	landing: '/',
	auth: '/sign-in',
	studio: '/dashboard',
	play: '/play-with-me',
	about: '/contact',
};

const PATH_VIEWS: Record<string, View> = Object.fromEntries(
	Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View]),
) as Record<string, View>;

/** A trailing slash is the same page, and a refresh should not lose it. */
const viewFromPath = (pathname: string): View | null => {
	const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
	return PATH_VIEWS[clean] ?? PATH_VIEWS[clean.replace(/\/$/, '')] ?? null;
};

/**
 * Page transition wrapper.
 *
 * Enter is a fade with a 20px rise, per the brief. Exit adds a blur so the
 * outgoing page dissolves rather than being swapped out, which is what makes it
 * read as a transition instead of a cut.
 *
 * The key belongs on the *call site* (`<Page key={view} …>`), not in here.
 * AnimatePresence diffs its own direct children, and a key on the element
 * returned from inside this component is invisible to it: the child it sees is
 * always the same unkeyed `<Page>`, so it never registers a change, never plays
 * exit, and mounts the arriving page straight onto its `initial` state. That bug
 * left every page after the first at `opacity: 0`, i.e. invisible.
 */
const Page: React.FC<{
	reduce: boolean;
	children: React.ReactNode;
}> = ({ reduce, children }) => (
	<motion.main
		className="page"
		initial={reduce ? { opacity: 0 } : { opacity: 0, y: 20, filter: 'blur(4px)' }}
		animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
		exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12, filter: 'blur(4px)' }}
		transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
	>
		{children}
	</motion.main>
);

/**
 * Gate, landing, and splash.
 *
 * The dashboard itself is <App/>, mounted only once there is a session, so an
 * unauthenticated visitor never mounts the pipeline UI at all — the server
 * rejects the calls regardless, but not rendering them is clearer than a page
 * full of failed requests.
 */
export const Shell: React.FC = () => {
	const [booted, setBooted] = React.useState(false);
	const [user, setUser] = React.useState<{ id: string; username: string } | null>(null);
	const [bootError, setBootError] = React.useState<string | null>(null);
	const reduce = useReducedMotion();

	// Start on the view the URL names, so a refresh or a shared link lands on the
	// right page. An unknown path falls back to the landing page rather than
	// showing nothing.
	const [view, setViewState] = React.useState<View>(
		() => viewFromPath(window.location.pathname) ?? 'landing',
	);

	/**
	 * Navigate.
	 *
	 * Writes history so the browser's back button and a page refresh both work.
	 * `pushState` rather than `replaceState`, so back returns to the previous
	 * page instead of leaving the app — which is what "stuck on one page" feels
	 * like from the inside.
	 */
	const setView = React.useCallback((next: View) => {
		setViewState(next);
		const path = VIEW_PATHS[next];
		if (window.location.pathname !== path) {
			window.history.pushState({ view: next }, '', path);
		}
	}, []);

	// The back and forward buttons. This is what makes the history entries
	// above meaningful rather than decorative.
	React.useEffect(() => {
		const onPop = () => {
			const fromPath = viewFromPath(window.location.pathname);
			// An unknown path on a back navigation should land somewhere sane,
			// not leave the previous view on screen with a different URL.
			setViewState(fromPath ?? 'landing');
		};
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);

	// Page transitions are scroll-aware: arriving on a new page at the previous
	// scroll offset is the classic "layout shift" artefact, and the brief asks for
	// none. Reset on every view change, after the new page has mounted.
	React.useEffect(() => {
		window.scrollTo({ top: 0, behavior: 'auto' });
	}, [view]);

	// The page-opening voice, on every route change.
	//
	// The `seen` ref is what stops it firing twice on launch. `booted` flipping
	// to true re-runs this effect exactly once, at the same moment the splash
	// hands over and onFirstPaint fires — so without the guard the voice played
	// twice simultaneously at startup. Measured: 4 oscillators where there should
	// have been 2.
	const announcedRoute = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (!booted || !NAVIGATION_VOICE_ENABLED) return;
		if (announcedRoute.current === view) return;
		announcedRoute.current = view;
		playLoudDocuBotVoice();
	}, [view, booted]);

	// Start audio on the first genuine user interaction.
	//
	// Browsers will not create or resume an AudioContext outside a gesture, so
	// this is the only moment the ambient bed can legally begin. `once: true` plus
	// the capture phase means it fires on the first click, tap or key anywhere,
	// and never again.
	React.useEffect(() => {
		const start = () => primeAudio();
		const opts = { once: true, capture: true, passive: true } as const;
		window.addEventListener('pointerdown', start, opts);
		window.addEventListener('keydown', start, opts);
		return () => {
			window.removeEventListener('pointerdown', start, true);
			window.removeEventListener('keydown', start, true);
		};
	}, []);

	React.useEffect(() => {
		// Config is fetched by App once signed in; here we only need to know who
		// the visitor is, and whether the server answered at all.
		api
			.me()
			.then(({ user: found }) => {
				if (!found) return;
				setUser(found);
				// Only redirect to the studio when the visitor did not ask for a
				// specific page. Bouncing someone who opened /play-with-me or
				// /contact straight into the dashboard is the "stuck on the wrong
				// page after signing in" complaint, in a different costume.
				const wanted = viewFromPath(window.location.pathname);
				if (!wanted || wanted === 'landing' || wanted === 'auth') {
					setView('studio');
				}
			})
			.catch(() => setBootError('Could not reach the DocuBot server.'))
			.finally(() => setBooted(true));
		// Runs once. `setView` is a stable useCallback and `view` is not read.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// A session expiring mid-use should not leave the user staring at a broken
	// page; drop them back to the sign-in screen.
	React.useEffect(() => {
		const onUnauthorised = () => {
			setUser(null);
			setView('auth');
		};
		window.addEventListener('docubot:unauthorised', onUnauthorised);
		return () => window.removeEventListener('docubot:unauthorised', onUnauthorised);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const signedIn = (found: { id: string; username: string }) => {
		setUser(found);
		setView('studio');
	};

	return (
		<div className="shell-root">
			{/* Behind everything. The canvas comes first, then the blobs and the
			    floating cards, so the canvas is the most distant layer. */}
			<CyberBackgroundCanvas />
			<AmbientBlobs reduce={Boolean(reduce)} />
			{/* Decorative glass cards drifting behind the content. */}
			<FloatingCards />

			<SplashScreen ready={booted} error={bootError} />

			{/* popLayout, not wait.

			    `mode="wait"` is the obvious choice for full pages, and it is what
			    this started as — but it holds the incoming page until the outgoing
			    page's exit animation has finished, which makes navigation depend on
			    requestAnimationFrame running. In a throttled or backgrounded tab rAF
			    does not run, so navigation silently stalls on the old page.
			    Verified by driving the page: with `wait`, clicking About left the
			    landing page mounted indefinitely; with a non-gating mode the view
			    changed immediately.

			    popLayout keeps what `wait` was actually buying. The outgoing page is
			    popped out of the flow while it fades, so two full pages never stack
			    and the document height does not jump — the layout shift the brief
			    rules out. Exactly one .page stays mounted at a time, measured.

			    No `initial={false}` either: it is meant to skip the first mount's
			    enter animation, but it left that page pinned to its initial inline
			    style (opacity 0, blur 4px) with nothing scheduled to move it off —
			    an invisible page. Letting the first page animate in is also simply
			    right, since the splash has just handed over. */}
			<AnimatePresence mode="popLayout">
				{!booted ? null : (
					<Page key={view} reduce={Boolean(reduce)}>
						{view === 'studio' && user ? (
							<AppHost
								onSignOut={() => {
									setUser(null);
									setView('landing');
								}}
								username={user.username}
							/>
						) : view === 'about' ? (
							<AboutPage
								onBack={() => setView(user ? 'studio' : 'landing')}
								signedIn={Boolean(user)}
							/>
						) : view === 'auth' ? (
							<AuthPage
								onAuthenticated={signedIn}
								onBack={() => setView('landing')}
								initialMode={user ? 'login' : 'signup'}
							/>
						) : view === 'play' ? (
							<PlayWithMe onBack={() => setView(user ? 'studio' : 'landing')} />
					) : (
							<LandingPage
								signedInAs={user?.username ?? null}
								onTry={() => setView(user ? 'studio' : 'auth')}
								onSignIn={() => setView('auth')}
								onAbout={() => setView('about')}
								onPlay={() => setView('play')}
							/>
						)}
					</Page>
				)}
			</AnimatePresence>

			{/* The persistent bar sits outside the transition, so it does not
			    re-animate on every route change and the way home is always
			    available. Hidden during the splash, where it is just clutter. */}
			{booted ? (
				<TopBar
					current={view}
					onHome={() => setView('landing')}
					onPlay={() => setView('play')}
					onAbout={() => setView('about')}
					signedIn={Boolean(user)}
					onStudio={() => setView('studio')}
					// The app has finished booting: announce it, once. The route
					// effect above records this same view, so the two cannot
					// double up.
					onFirstPaint={() => {
						announcedRoute.current = view;
						if (NAVIGATION_VOICE_ENABLED) playLoudDocuBotVoice();
					}}
				/>
			) : null}
		</div>
	);
};

/**
 * Drifting colour fields behind the whole app.
 *
 * Cyan, amber and purple, per the brief. `position: fixed` and `pointer-events:
 * none` so they never intercept a click or contribute to document height, which
 * would otherwise show up as a scrollbar that appears and disappears between
 * pages.
 */
const AmbientBlobs: React.FC<{ reduce: boolean }> = ({ reduce }) => (
	<div className="ambient" aria-hidden>
		{reduce ? null : (
			<>
				<span className="ambient-blob blob-cyan" />
				<span className="ambient-blob blob-amber" />
				<span className="ambient-blob blob-violet" />
			</>
		)}
	</div>
);

/** Loads the dashboard lazily so the landing page does not pull the player in. */
const AppHost: React.FC<{ onSignOut: () => void; username: string }> = ({
	onSignOut,
	username,
}) => {
	const App = React.lazy(() => import('./App').then((m) => ({ default: m.App })));
	return (
		<React.Suspense fallback={<div className="route-loading">Loading studio…</div>}>
			<App onSignOut={onSignOut} username={username} />
		</React.Suspense>
	);
};

/* ========================================================================= */
/* Landing                                                                    */
/* ========================================================================= */

const FEATURES = [
	{
		title: 'Your PDF becomes a documentary',
		body: 'Headings, prose and terminology are extracted from the real document, so the script is about your subject and not a generic template.',
	},
	{
		title: 'Narration in a voice you choose',
		body: 'Record three sentences and DocuBot clones your voice, or pick one of ten generated narrators across gender and accent.',
	},
	{
		title: 'Visuals that match what is said',
		body: 'Each scene resolves its own imagery and switches it mid-sentence, on the word the narration reaches.',
	},
	{
		title: 'One button, one finished file',
		body: 'Script, narration, visuals and the final MP4 are produced in a single run and downloaded as one file with the audio already in it.',
	},
	{
		title: 'Runs entirely on your machine',
		body: 'The voice model is local. No account with a voice vendor, no audio leaves the computer.',
	},
	{
		title: 'Kept deliberately short',
		body: 'Up to five scenes and 400 words, which is roughly two and a half minutes. The caps are there because synthesis time scales with audio length.',
	},
];

/**
 * The primary call to action.
 *
 * The border pulse is a separate absolutely-positioned layer behind the button
 * rather than an animated border, because animating `border-color` or a box
 * shadow on a primary CTA repaints on every frame and reads as a flicker. A
 * blurred pseudo-element scaling outwards costs one composited layer instead.
 */
const PrimaryButton: React.FC<{
	onClick: () => void;
	reduce: boolean;
	children: React.ReactNode;
}> = ({ onClick, reduce, children }) => (
	<motion.button
		type="button"
		className="btn btn-primary btn-lg pulse"
		onClick={onClick}
		initial={reduce ? undefined : { opacity: 0, y: 22 }}
		animate={reduce ? undefined : { opacity: 1, y: 0 }}
		transition={{ duration: 0.5, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
		whileHover={reduce ? undefined : { scale: 1.04 }}
		whileTap={reduce ? undefined : { scale: 0.98 }}
	>
		{children}
	</motion.button>
);

const LandingPage: React.FC<{
	signedInAs: string | null;
	onTry: () => void;
	onSignIn: () => void;
	onAbout: () => void;
	onPlay: () => void;
}> = ({ signedInAs, onTry, onSignIn, onAbout, onPlay }) => {
	const reduce = useReducedMotion();
	// Drives the staggered entrances. One flag rather than per-element state, so
	// every section animates in step and there is a single thing to disable.
	const [entered, setEntered] = React.useState(false);
	React.useEffect(() => {
		if (reduce) {
			setEntered(true);
			return undefined;
		}
		const frame = window.requestAnimationFrame(() => setEntered(true));
		return () => window.cancelAnimationFrame(frame);
	}, [reduce]);

	/** One helper so the stagger lives in one place. */
	const rise = (index: number) =>
		reduce
			? {}
			: {
					initial: { opacity: 0, y: 22 },
					animate: entered ? { opacity: 1, y: 0 } : { opacity: 0, y: 22 },
					transition: {
						duration: 0.5,
						delay: 0.06 * index,
						ease: [0.22, 1, 0.36, 1] as const,
					},
				};

	return (
		<div className="landing">
			{/* The brand and links now live in the global TopBar, which is
			    outside the page transition so it does not re-animate on every
			    route change. The hero below is the landing page's own content. */}
			<section className="hero">
			<motion.div className="hero-copy" {...rise(0)}>
				<h1>
					Turn a lecture PDF into a
					<br />
					narrated documentary.
				</h1>
				<p>
					DocuBot reads your document, writes the script, resolves the visuals, clones a
					narrator, and renders one finished MP4 with the audio already inside it.
				</p>
				<div className="hero-cta">
					<PrimaryButton onClick={onTry} reduce={Boolean(reduce)}>
						{signedInAs ? 'Open studio' : 'Try DocuBot'}
					</PrimaryButton>
					<motion.button
						type="button"
						className="btn btn-ghost btn-lg"
						onClick={onPlay}
						initial={reduce ? undefined : { opacity: 0, y: 22 }}
						animate={entered ? { opacity: 1, y: 0 } : undefined}
						transition={{ duration: 0.5, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
						whileHover={reduce ? undefined : { scale: 1.04 }}
						whileTap={reduce ? undefined : { scale: 0.98 }}
					>
						Play With Me
					</motion.button>
					<motion.button
						type="button"
						className="btn btn-ghost btn-lg"
						onClick={onAbout}
						initial={reduce ? undefined : { opacity: 0, y: 22 }}
						animate={entered ? { opacity: 1, y: 0 } : undefined}
						transition={{ duration: 0.5, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
						whileTap={reduce ? undefined : { scale: 0.98 }}
					>
						How it works
					</motion.button>
				</div>
				<ul className="hero-facts">
					<li>
						<strong>
							<CountUp to={10} />
						</strong>{' '}
						generated narrators
					</li>
					<li>
						<strong>
							<CountUp to={5} />
						</strong>{' '}
						scenes per video
					</li>
					<li>
						<strong>
							<CountUp to={100} suffix="%" />
						</strong>{' '}
						local voice
					</li>
				</ul>
			</motion.div>
			{/* The animated box, replacing the static mascot that stood here. */}
			<motion.div className="hero-art" {...rise(2)}>
				<HeroAnimationCard />
			</motion.div>
		</section>

		{/* Feature cards reveal on scroll, 0.1s apart. The hero above uses the
		    mount-time `rise` helper instead, because it is already on screen when
		    the page arrives — an in-view reveal there would never fire. */}
		<section className="features">
			{FEATURES.map((feature, index) => (
				<Reveal
					key={feature.title}
					as="article"
					index={index}
					step={0.1}
					className="card feature-card"
				>
					<h3>{feature.title}</h3>
					<p>{feature.body}</p>
				</Reveal>
			))}
		</section>

		<nav className="landing-foot">
			<span>Made by {CREATOR.name}</span>
			<span className="dot">·</span>
			<a href={CREATOR.linkedin} target="_blank" rel="noreferrer noopener">
				LinkedIn
			</a>
			<span className="dot">·</span>
			<a href={CREATOR.github} target="_blank" rel="noreferrer noopener">
				GitHub
			</a>
		</nav>
		</div>
	);
};

/* ========================================================================= */
/* Auth                                                                       */
/* ========================================================================= */

const AuthPage: React.FC<{
	onAuthenticated: (user: { id: string; username: string }) => void;
	onBack: () => void;
	initialMode: AuthMode;
}> = ({ onAuthenticated, onBack, initialMode }) => {
	const [mode, setMode] = React.useState<AuthMode>(initialMode);
	const [username, setUsername] = React.useState('');
	const [password, setPassword] = React.useState('');
	const [error, setError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setBusy(true);
		try {
			const { user } =
				mode === 'signup'
					? await api.register(username, password)
					: await api.login(username, password);
			onAuthenticated(user);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="auth">
			<button type="button" className="link auth-back" onClick={onBack}>
				← Back
			</button>
			<div className="auth-card card">
				<DocuBotMark size={92} float={false} mood="happy" />
				<h1>{mode === 'signup' ? 'Create an account' : 'Welcome back'}</h1>
				<p className="hint">
					Accounts are local to this machine. Passwords are hashed with scrypt and never
					stored in the clear.
				</p>

				<form onSubmit={submit}>
					<label className="field">
						<span>Username</span>
						<input
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="3-32 characters"
							required
						/>
					</label>
					<label className="field">
						<span>Password</span>
						<input
							type="password"
							autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder={mode === 'signup' ? 'at least 8 characters' : '••••••••'}
							required
						/>
					</label>

					{error ? <div className="notice notice-err">{error}</div> : null}

					<button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
						{busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
					</button>
				</form>

				<button
					type="button"
					className="link auth-switch"
					onClick={() => {
						setMode(mode === 'signup' ? 'login' : 'signup');
						setError(null);
					}}
				>
					{mode === 'signup'
						? 'Already have an account? Sign in'
						: 'Need an account? Sign up'}
				</button>
			</div>
		</div>
	);
};

/* ========================================================================= */
/* About                                                                      */
/* ========================================================================= */

const AboutPage: React.FC<{ onBack: () => void; signedIn: boolean }> = ({
	onBack,
	signedIn,
}) => (
	<div className="about">
		<button type="button" className="link auth-back" onClick={onBack}>
			← Back
		</button>
		<div className="about-card card">
			<DocuBotMark size={110} float={false} />
			<h1>About DocuBot</h1>
			<p>
				DocuBot turns a lecture or report into a short narrated documentary. It reads the
				document, writes a scene-by-scene script from the real content, resolves a visual for
				each beat, synthesises the narration with a local neural model, and renders a single
				MP4 with everything merged.
			</p>

			<h2>How it works</h2>
			<ol className="about-steps">
				<li>
					<strong>Parse.</strong> The PDF is sanitised: headers, footers, slide furniture and
					administrative lines are dropped, headings are preserved.
				</li>
				<li>
					<strong>Write.</strong> A model writes the script when one is configured; otherwise the
					scenes are built from the document's own sentences and terminology. Either way the
					result is capped at five scenes and 400 words.
				</li>
				<li>
					<strong>Illustrate.</strong> Each beat resolves a specific visual from the subject
					matter, falling back to a diagram drawn from the document itself.
				</li>
				<li>
					<strong>Speak.</strong> Narration is cloned from a reference recording, or generated
					by one of the built-in narrators. The reference transcript ships with it, so no
					transcription model is loaded.
				</li>
				<li>
					<strong>Render.</strong> Everything is merged into one MP4 and downloaded.
				</li>
			</ol>

			<h2>Creator</h2>
			<p>
				Designed and built by <strong>{CREATOR.name}</strong>.
			</p>
			<div className="about-links">
				<a className="btn btn-ghost" href={CREATOR.linkedin} target="_blank" rel="noreferrer noopener">
					LinkedIn
				</a>
				<a className="btn btn-ghost" href={CREATOR.github} target="_blank" rel="noreferrer noopener">
					GitHub
				</a>
			</div>
		</div>
		{signedIn ? null : null}
	</div>
);

/** Re-exported so App can raise the same event the shell listens for. */
export { UnauthorisedError };

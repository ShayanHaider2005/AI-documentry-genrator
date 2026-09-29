import React from 'react';
import { api, UnauthorisedError } from './api';
import { CREATOR, DocuBotMark, SplashScreen } from './Mascot';

type View = 'landing' | 'auth' | 'studio' | 'about';
type AuthMode = 'login' | 'signup';

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
	const [view, setView] = React.useState<View>('landing');
	const [bootError, setBootError] = React.useState<string | null>(null);

	React.useEffect(() => {
		// Config is fetched by App once signed in; here we only need to know who
		// the visitor is, and whether the server answered at all.
		api
			.me()
			.then(({ user: found }) => {
				if (found) {
					setUser(found);
					setView('studio');
				}
			})
			.catch(() => setBootError('Could not reach the DocuBot server.'))
			.finally(() => setBooted(true));
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
	}, []);

	const signedIn = (found: { id: string; username: string }) => {
		setUser(found);
		setView('studio');
	};

	return (
		<>
			<SplashScreen ready={booted} error={bootError} />

			{!booted ? null : view === 'studio' && user ? (
				<AppHost onSignOut={() => { setUser(null); setView('landing'); }} username={user.username} />
			) : view === 'about' ? (
				<AboutPage onBack={() => setView(user ? 'studio' : 'landing')} signedIn={Boolean(user)} />
			) : view === 'auth' ? (
				<AuthPage
					onAuthenticated={signedIn}
					onBack={() => setView('landing')}
					initialMode={user ? 'login' : 'signup'}
				/>
			) : (
				<LandingPage
					signedInAs={user?.username ?? null}
					onTry={() => setView(user ? 'studio' : 'auth')}
					onSignIn={() => setView('auth')}
					onAbout={() => setView('about')}
				/>
			)}
		</>
	);
};

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

const LandingPage: React.FC<{
	signedInAs: string | null;
	onTry: () => void;
	onSignIn: () => void;
	onAbout: () => void;
}> = ({ signedInAs, onTry, onSignIn, onAbout }) => (
	<div className="landing">
		<header className="landing-nav">
			<div className="brand">
				<DocuBotMark size={38} float={false} />
				<div>
					<div>DocuBot</div>
					<div className="brand-sub">AI Documentary Generator</div>
				</div>
			</div>
			<nav className="landing-links">
				<button type="button" className="link" onClick={onAbout}>
					About
				</button>
				{signedInAs ? (
					<button type="button" className="btn btn-primary" onClick={onTry}>
						Open studio
					</button>
				) : (
					<>
						<button type="button" className="link" onClick={onSignIn}>
							Sign in
						</button>
						<button type="button" className="btn btn-primary" onClick={onTry}>
							Try DocuBot
						</button>
					</>
				)}
			</nav>
		</header>

		<section className="hero">
			<div className="hero-copy">
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
					<button type="button" className="btn btn-primary btn-lg" onClick={onTry}>
						{signedInAs ? 'Open studio' : 'Try DocuBot'}
					</button>
					<button type="button" className="btn btn-ghost btn-lg" onClick={onAbout}>
						How it works
					</button>
				</div>
				<ul className="hero-facts">
					<li>
						<strong>10</strong> generated narrators
					</li>
					<li>
						<strong>5</strong> scenes per video
					</li>
					<li>
						<strong>100%</strong> local voice
					</li>
				</ul>
			</div>
			<div className="hero-art" aria-hidden>
				<DocuBotMark size={230} />
			</div>
		</section>

		<section className="features">
			{FEATURES.map((feature) => (
				<article className="card" key={feature.title}>
					<h3>{feature.title}</h3>
					<p>{feature.body}</p>
				</article>
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

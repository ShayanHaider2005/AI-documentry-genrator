import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { DocuBotMark } from './Mascot';
import { isMuted, toggleMuted, onMuteChange, primeAudio } from './utils/botAudio';

/**
 * The persistent top bar: logo, primary links, and a mute toggle.
 *
 * Present on every route, including the studio, so the way back to the landing
 * page is always one click away. On the landing page itself the logo is
 * rendered as plain text rather than a button, because a button that navigates
 * to the page you are already on is a control that lies.
 */

const SpeakerIcon: React.FC<{ muted: boolean }> = ({ muted }) => (
	<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
		<path
			d="M4 9v6h4l5 4V5L8 9H4z"
			fill="currentColor"
			opacity="0.9"
		/>
		{muted ? (
			/* A slash, so the muted state does not rely on colour alone. */
			<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		) : (
			<>
				<path d="M16.5 8.5a5 5 0 010 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
				<path d="M19 6a8.5 8.5 0 010 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			</>
		)}
	</svg>
);

export const TopBar: React.FC<{
	/** The view we are on, so the logo can be a link instead of a button. */
	current: string;
	onHome: () => void;
	onPlay: () => void;
	onAbout: () => void;
	signedIn: boolean;
	onStudio: () => void;
}> = ({ current, onHome, onPlay, onAbout, signedIn, onStudio }) => {
	const reduce = useReducedMotion();
	const [muted, setMuted] = React.useState(isMuted());

	React.useEffect(() => onMuteChange(setMuted), []);

	const onToggleSound = () => {
		// Browsers only allow audio after a gesture, and this click is it.
		const next = toggleMuted();
		if (!next) primeAudio();
	};

	const logo = (
		<>
			<DocuBotMark size={34} float={false} />
			<span>
				<span className="brand-name">DocuBot</span>
				<span className="brand-sub">AI Documentary Generator</span>
			</span>
		</>
	);

	return (
		<nav className="topbar topbar-global" aria-label="Primary">
			{current === 'landing' ? (
				<span className="brand brand-static" aria-current="page">
					{logo}
				</span>
			) : (
				<button
					type="button"
					className="brand brand-button"
					onClick={onHome}
					aria-label="DocuBot — back to the landing page"
				>
					{logo}
				</button>
			)}

			<span className="spacer" />

			<div className="topbar-links">
				<button type="button" className="link" onClick={onPlay}>
					Play With Me
				</button>
				<button type="button" className="link" onClick={onAbout}>
					About
				</button>
			</div>

			{signedIn ? (
				<button type="button" className="btn btn-primary btn-sm" onClick={onStudio}>
					Studio
				</button>
			) : null}

			<button
				type="button"
				className={`sound-toggle${muted ? ' muted' : ''}`}
				onClick={onToggleSound}
				aria-pressed={!muted}
				aria-label={muted ? 'Turn sound effects on' : 'Mute sound effects'}
				title={muted ? 'Sound effects off' : 'Sound effects on'}
			>
				<SpeakerIcon muted={muted} />
			</button>
		</nav>
	);
};

/**
 * A floating glass card for the background layer.
 *
 * Purely decorative and `aria-hidden`, so it never reaches a screen reader and
 * never intercepts a click. Slow drift, and skipped under reduced motion.
 */
export const FloatingCards: React.FC<{ count?: number }> = ({ count = 4 }) => {
	const reduce = useReducedMotion();
	if (reduce) return null;

	return (
		<div className="float-cards" aria-hidden>
			{Array.from({ length: count }, (_, i) => (
				<motion.div
					key={i}
					className="float-card"
					animate={{
						y: [0, i % 2 === 0 ? -26 : 26, 0],
						rotate: [0, i % 2 === 0 ? 3 : -3, 0],
					}}
					transition={{
						duration: 13 + i * 3.5,
						repeat: Infinity,
						ease: 'easeInOut',
						delay: i * 0.9,
					}}
					style={
						{
							'--fc-left': `${6 + i * 21}%`,
							'--fc-top': `${10 + ((i * 37) % 60)}%`,
							'--fc-delay': `${i * 0.6}s`,
						} as React.CSSProperties
					}
				>
					<span />
					<span />
					<span />
				</motion.div>
			))}
		</div>
	);
};

export default TopBar;

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { DocuBotMark } from './Mascot';

/**
 * The forced startup splash.
 *
 * The minimum duration is the point, not an accident. Without it the splash
 * appears and vanishes inside a single frame whenever the server answers
 * quickly, which reads as a flicker rather than an introduction. So the exit is
 * gated on BOTH the real boot finishing and 3 s having elapsed.
 *
 * Reduced motion is honoured: the content still appears for the same 3 s, but
 * without the pulse ring, the drifting particles, or the scale-up on exit. A
 * vestibular trigger should not cost someone the attribution line.
 */

/** The brief's floor. Do not lower this without a reason. */
export const MIN_SPLASH_MS = 3000;

const STATUS_LINES = [
	'Initializing AI Core…',
	'Loading Voice Engines…',
	'Preparing the Studio…',
	'DocuBot Ready',
] as const;

/** How long each status line holds before advancing. */
const STATUS_INTERVAL_MS = 850;

export const SplashScreen: React.FC<{ ready: boolean; error?: string | null }> = ({
	ready,
	error,
}) => {
	const reduce = useReducedMotion();
	const [elapsed, setElapsed] = React.useState(0);
	const [line, setLine] = React.useState(0);

	// Wall-clock since mount. The splash only leaves once this passes the floor
	// AND the caller says it is ready.
	React.useEffect(() => {
		const started = Date.now();
		const tick = window.setInterval(() => {
			setElapsed(Date.now() - started);
		}, 60);
		return () => window.clearInterval(tick);
	}, []);

	const satisfied = elapsed >= MIN_SPLASH_MS;
	const canExit = ready && satisfied;

	// Cycle the status text, stopping on the last line so the finished state
	// does not scroll back to a "loading" message.
	React.useEffect(() => {
		if (canExit || error) return undefined;
		const interval = window.setInterval(() => {
			setLine((current) => Math.min(current + 1, STATUS_LINES.length - 1));
		}, STATUS_INTERVAL_MS);
		return () => window.clearInterval(interval);
	}, [canExit, error]);

	const subtitle = error ? 'Could not reach the server' : STATUS_LINES[line];
	const progress = Math.min(1, elapsed / MIN_SPLASH_MS);

	return (
		<AnimatePresence>
			{canExit ? null : (
				<motion.div
					className="splash2"
					// Stops intercepting clicks the moment the floor is met and the
					// app is ready behind it, even if the exit animation has not
					// finished. Framer drives that exit with requestAnimationFrame,
					// which a backgrounded tab does not run — without this, a tab
					// loaded in the background comes back to a full-screen invisible
					// overlay sitting on top of an app nobody can click.
					style={{ pointerEvents: canExit || !ready ? 'auto' : 'none' }}
					initial={{ opacity: 1 }}
					exit={
						reduce
							? { opacity: 0, transition: { duration: 0.25 } }
							: {
									opacity: 0,
									scale: 1.08,
									filter: 'blur(6px)',
									transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
								}
					}
				>
					{/* Circuit / particle field. Purely decorative, so it is skipped
					    entirely under reduced motion rather than just slowed. */}
					{reduce ? null : (
						<div className="splash2-grid" aria-hidden>
							{Array.from({ length: 28 }, (_, i) => (
								<span
									key={i}
									className="splash2-spark"
									style={
										{
											'--sx': `${(i * 37) % 100}%`,
											'--sy': `${(i * 61) % 100}%`,
											'--sd': `${(i % 9) * 0.42}s`,
											'--ss': `${2.4 + (i % 5) * 0.7}s`,
										} as React.CSSProperties
									}
								/>
							))}
						</div>
					)}

					<motion.div
						className="splash2-inner"
						initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
					>
						<div className="splash2-figure">
							{reduce ? null : (
								<>
									<span className="splash2-ring" />
									<span className="splash2-ring splash2-ring-lag" />
								</>
							)}
							<DocuBotMark
								size={168}
								mood={canExit || error ? 'happy' : 'working'}
								float={!reduce}
							/>
						</div>

						<h1 className="splash2-title">DocuBot</h1>

						<p className="splash2-status" role="status" aria-live="polite">
							{subtitle}
						</p>

						{error ? <p className="splash2-error">{error}</p> : null}

						{/* The bar tracks real elapsed time to the 3 s floor, so it is
						    honest about waiting rather than a fake indeterminate
						    spinner. It keeps going past full while the server loads. */}
						<div
							className="splash2-bar"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(progress * 100)}
						>
							<span
								style={{
									width: `${progress * 100}%`,
									opacity: canExit ? 1 : 0.55 + 0.45 * progress,
								}}
							/>
						</div>

						<p className="splash2-by">Crafted by Shayan Haider</p>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};

export default SplashScreen;

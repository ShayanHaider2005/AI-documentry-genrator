import React from 'react';
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from 'framer-motion';
import { DocuBotMark } from './Mascot';

/**
 * The hero animation card.
 *
 * A single glass panel holding several layers that move independently: an
 * equalizer driven by React state, floating scene previews, ambient dots, and
 * the mascot. The layers drift on their own timers so the card is never static,
 * which is what the hero needs to do before anyone has scrolled to it.
 *
 * The 3D tilt is pointer-driven rather than autoplaying, and disabled under
 * reduced motion along with everything else that moves on its own.
 */

/** Deterministic pseudo-random, so the layout is identical every load. */
const seeded = (index: number, salt: number) => {
	const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
	return value - Math.floor(value);
};

const EQUALIZER_BARS = 22;
const SCENE_PREVIEWS = 4;
const AMBIENT_DOTS = 18;

export const HeroAnimationCard: React.FC = () => {
	const reduce = useReducedMotion();
	const container = React.useRef<HTMLDivElement | null>(null);

	/* ---- pointer tilt ---------------------------------------------------- */
	// Motion values, not state: a tilt driven by React state re-renders on every
	// mouse move, which is exactly the jank this is meant to avoid.
	const pointerX = useMotionValue(0);
	const pointerY = useMotionValue(0);
	const springX = useSpring(pointerX, { stiffness: 120, damping: 18, mass: 0.6 });
	const springY = useSpring(pointerY, { stiffness: 120, damping: 18, mass: 0.6 });

	const rotateY = useTransform(springX, [-0.5, 0.5], [-9, 9]);
	const rotateX = useTransform(springY, [-0.5, 0.5], [9, -9]);
	// A small lift towards the viewer as the pointer moves, so the parallax is
	// felt as depth rather than as a flat rotation.
	const lift = useTransform(springY, [-0.5, 0.5], [1.012, 0.988]);
	const glareX = useTransform(springX, [-0.5, 0.5], ['18%', '82%']);
	// Declared unconditionally: a hook inside JSX, or inside a ternary in JSX,
	// breaks the rules of hooks the moment the condition flips. The reduced-motion
	// branch below chooses not to *apply* it instead.
	const glareBackground = useTransform(
		glareX,
		(x) => `radial-gradient(60% 60% at ${x} 0%, rgba(255,255,255,0.14), transparent 70%)`,
	);

	const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
		if (reduce) return;
		const node = container.current;
		if (!node) return;
		const rect = node.getBoundingClientRect();
		pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
		pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
	};

	const handleLeave = () => {
		pointerX.set(0);
		pointerY.set(0);
	};

	/* ---- equalizer ------------------------------------------------------- */
	// Bar heights cycle on a timer. Pausing it when the tab is hidden avoids
	// animating 22 elements nobody can see.
	const [frame, setFrame] = React.useState(0);
	React.useEffect(() => {
		if (reduce) return undefined;
		const interval = window.setInterval(() => {
			if (document.hidden) return;
			setFrame((value) => value + 1);
		}, 130);
		return () => window.clearInterval(interval);
	}, [reduce]);

	const bars = React.useMemo(
		() =>
			Array.from({ length: EQUALIZER_BARS }, (_, i) => {
				// A travelling wave with a per-bar offset, so it reads as music
				// rather than as noise.
				const wave = Math.sin((frame * 0.34 + i * 0.55) * Math.PI) * 0.5 + 0.5;
				const jitter = seeded(i, 3) * 0.35;
				return 12 + (wave * 0.65 + jitter) * 52;
			}),
		[frame],
	);

	return (
		<div
			className="hero-card"
			ref={container}
			onPointerMove={handleMove}
			onPointerLeave={handleLeave}
		>
			<motion.div
				className="hero-card-tilt"
				style={reduce ? undefined : { rotateX, rotateY, scale: lift }}
			>
				<div className="hero-card-border" aria-hidden />

				{/* Ambient dots behind everything inside the card. */}
				{reduce ? null : (
					<div className="hero-card-dots" aria-hidden>
						{Array.from({ length: AMBIENT_DOTS }, (_, i) => (
							<span
								key={i}
								style={
									{
										left: `${seeded(i, 1) * 100}%`,
										top: `${seeded(i, 2) * 100}%`,
										animationDelay: `${(i % 7) * 0.6}s`,
										animationDuration: `${5 + (i % 6)}s`,
									} as React.CSSProperties
								}
							/>
						))}
					</div>
				)}

				{/* Floating scene previews: the product's output, hinted at. */}
				<div className="hero-scenes" aria-hidden>
					{Array.from({ length: SCENE_PREVIEWS }, (_, i) => (
						<motion.div
							key={i}
							className={`hero-scene hero-scene-${i}`}
							animate={
								reduce
									? undefined
									: { y: [0, i % 2 === 0 ? -9 : 9, 0], rotate: [-1.5, 1.5, -1.5] }
							}
							transition={{
								duration: 7 + i * 1.6,
								repeat: Infinity,
								ease: 'easeInOut',
								delay: i * 0.4,
							}}
						>
							<div className="hero-scene-bar" style={{ width: `${42 + seeded(i, 7) * 34}%` }} />
							<div className="hero-scene-bar dim" style={{ width: `${64 + seeded(i, 8) * 24}%` }} />
							<div className="hero-scene-bar dim" style={{ width: `${28 + seeded(i, 9) * 22}%` }} />
						</motion.div>
					))}
				</div>

				<motion.div
					className="hero-card-mascot"
					animate={reduce ? undefined : { y: [0, -7, 0] }}
					transition={{ duration: 4.4, repeat: Infinity, ease: 'easeInOut' }}
				>
					<DocuBotMark size={128} mood="idle" float={false} />
				</motion.div>

				{/* Equalizer: the audio the pipeline will produce. */}
				<div className="hero-eq" aria-hidden>
					{bars.map((height, i) => (
						<span
							key={i}
							style={{
								height: `${reduce ? 20 + seeded(i, 4) * 40 : height}%`,
								animationDelay: `${(i % 9) * 0.11}s`,
							}}
						/>
					))}
				</div>

				<div className="hero-card-caption">
					<span className="hero-card-chip">Script</span>
					<span className="hero-card-arrow">→</span>
					<span className="hero-card-chip">Visuals</span>
					<span className="hero-card-arrow">→</span>
					<span className="hero-card-chip active">Voice</span>
					<span className="hero-card-arrow">→</span>
					<span className="hero-card-chip active">MP4</span>
				</div>

				{/* Pointer glare. Sits above the content but ignores pointer events. */}
				<motion.div
					className="hero-card-glare"
					aria-hidden
					style={reduce ? undefined : { background: glareBackground }}
				/>
			</motion.div>
		</div>
	);
};

export default HeroAnimationCard;

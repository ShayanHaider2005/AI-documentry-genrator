import React from 'react';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'framer-motion';
import { DocuBotMark, type MascotMood } from '../Mascot';
import { playDocuBotSFX, type Emotion } from '../utils/botAudio';

/**
 * "Play With Me" — the mascot on a stage you can poke.
 *
 * The point is that the mascot reacts, so the whole page is built around one
 * piece of state: which emotion it is currently in, and for how long. Every
 * action sets that state, plays a matching sound, and triggers a particle
 * burst, then a timer puts it back to idle.
 *
 * Timers are tracked in a ref and cleared on unmount, because a pending
 * `setTimeout` that fires after the page is gone would call setState on an
 * unmounted component.
 */

/** Randomised openers, so a reload is not the same greeting twice. */
const COMPLIMENTS = [
	"Hey, beautiful human! You're looking amazing today! ✨",
	"Your intelligence is off the charts!",
	"I'm so happy you came to visit me! 🤖💙",
	"You have the energy of someone who ships things. I respect it.",
	"That is a very good brain you brought with you today.",
	"I would listen to you read a whole document out loud. 🧡",
	"You showed up. That is the best part of my day already.",
] as const;

type Action = {
	id: Emotion;
	label: string;
	emoji: string;
	button: string;
	hint: string;
	mood: MascotMood;
	blush: boolean;
	particles: 'hearts' | 'stars' | 'sparks' | 'rings' | 'none';
	shake: boolean;
	/** A one-line reaction, so the interaction has a readable outcome. */
	says: string;
};

const ACTIONS: Action[] = [
	{
		id: 'love',
		label: 'Give Love',
		emoji: '💋',
		button: 'Kiss',
		hint: 'A little affection',
		mood: 'love',
		blush: true,
		particles: 'hearts',
		shake: false,
		says: 'Oh! That was… very kind of you. 💗',
	},
	{
		id: 'shocked',
		label: 'Light Tap',
		emoji: '👋',
		button: 'Slap',
		hint: 'Ouch. That one registered.',
		mood: 'shocked',
		blush: false,
		particles: 'sparks',
		shake: true,
		says: 'I felt that. My circuits are filing a complaint. ⚡',
	},
	{
		id: 'giggle',
		label: 'Tickle Bot',
		emoji: '👈',
		button: 'Tickle',
		hint: 'Tickles are… ticklish.',
		mood: 'squint',
		blush: true,
		particles: 'stars',
		shake: false,
		says: 'Hee hee hee! Stop it! That is my panel! 😆',
	},
	{
		id: 'happy',
		label: 'Head Pat',
		emoji: '🤚',
		button: 'Pat',
		hint: 'A gentle pat on the head',
		mood: 'happy',
		blush: true,
		particles: 'rings',
		shake: false,
		says: 'That is the best place to pat. Thank you! ✨',
	},
	{
		id: 'dizzy',
		label: 'Poke / Dizzy',
		emoji: '🌀',
		button: 'Spin',
		hint: 'One full rotation',
		mood: 'spiral',
		blush: false,
		particles: 'none',
		shake: false,
		says: 'Everything is spinning. In a good way. Mostly. 🌀',
	},
];

/** How long an emotion holds before returning to idle. */
const REACTION_MS = 2100;

const PARTICLE_COUNT = 18;

/** Seeded so the burst pattern is the same on every render of a given action. */
const spread = (index: number, salt: number) => {
	const raw = Math.sin(index * 45.233 + salt * 12.9898) * 43758.5453;
	return raw - Math.floor(raw);
};

const Particles: React.FC<{ kind: Action['particles']; seed: number }> = ({ kind, seed }) => {
	if (kind === 'none') return null;

	const glyphs = {
		hearts: ['💗', '💖', '💕', '💘'],
		stars: ['✨', '⭐', '✦', '💫'],
		sparks: ['⚡', '💢', '✳', '🔥'],
		rings: ['○', '◎', '●'],
	} as const;

	// The @keyframes live in play.css; each particle gets its own angle, delay
	// and drift so the burst does not look like one rigid shape.
	return (
		<div className={`pw-particles pw-${kind}`} aria-hidden>
			{Array.from({ length: PARTICLE_COUNT }, (_, i) => {
				const angle = (i / PARTICLE_COUNT) * 360 + spread(i, seed) * 24;
				const distance = 110 + spread(i, seed + 1) * 90;
				return (
					<span
						key={i}
						style={
							{
								'--pw-angle': `${angle}deg`,
								'--pw-distance': `${distance}px`,
								'--pw-delay': `${spread(i, seed + 2) * 0.22}s`,
								'--pw-scale': `${0.7 + spread(i, seed + 3) * 0.7}`,
							} as React.CSSProperties
						}
					>
						{glyphs[kind][i % glyphs[kind].length]}
					</span>
				);
			})}
		</div>
	);
};

export const PlayWithMe: React.FC<{ onBack: () => void }> = ({ onBack }) => {
	const reduce = useReducedMotion();
	const [active, setActive] = React.useState<Action | null>(null);
	const [speech, setSpeech] = React.useState<string>('');
	const [bubble, setBubble] = React.useState(false);
	const [stage, animate] = useAnimate();

	// Timers live in a ref so unmounting can cancel them.
	const timers = React.useRef<number[]>([]);
	const greeted = React.useRef(false);

	const clearTimers = React.useCallback(() => {
		timers.current.forEach((id) => window.clearTimeout(id));
		timers.current = [];
	}, []);

	React.useEffect(() => clearTimers, [clearTimers]);

	/** Pick a different line each time, so the same action does not repeat. */
	const pick = (pool: readonly string[], used: Set<string>) => {
		const fresh = pool.filter((line) => !used.has(line));
		return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : pool[0];
	};

	/* ---- the opening greeting ------------------------------------------ */
	React.useEffect(() => {
		// StrictMode double-invokes effects in development, which would greet
		// twice and leave two timers running.
		if (greeted.current) return;
		greeted.current = true;

		setSpeech(COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)]);
		setBubble(true);
		playDocuBotSFX('happy');

		timers.current.push(
			window.setTimeout(() => setBubble(false), 5200),
		);
	}, []);

	const react = (action: Action) => {
		clearTimers();
		setActive(action);
		setSpeech(action.says);
		setBubble(true);
		playDocuBotSFX(action.id);

		// The one-off screen shake, only for the slap.
		if (action.shake && stage.current && !reduce) {
			void animate(
				stage.current,
				{
					x: [0, -11, 9, -7, 5, -3, 0],
					rotate: [0, -1.6, 1.4, -0.9, 0.6, 0],
				},
				{ duration: 0.52, ease: 'easeOut' },
			);
		}

		timers.current.push(
			window.setTimeout(() => {
				setActive(null);
				setBubble(false);
			}, REACTION_MS),
		);
	};

	const mood: MascotMood = active?.mood ?? 'idle';

	/* ---- stage motion per action --------------------------------------- */
	// The target and its transition are returned separately rather than merged.
	// Framer's `animate` prop takes a Target and `transition` takes a
	// Transition, and folding them into one object means hand-rolling a type
	// that is stricter than the library's own.
	type MotionSpec = {
		animate: Record<string, number | number[]>;
		transition: Record<string, unknown>;
	};

	const stageMotion = (): MotionSpec => {
		if (reduce) return { animate: {}, transition: {} };
		switch (active?.id) {
			case 'love':
				// A soft forward lean, as if leaning into it.
				return { animate: { scale: 1.06, y: 8, rotate: 0 }, transition: { duration: 0.5 } };
			case 'shocked':
				return { animate: { scale: 0.94, y: -4 }, transition: { duration: 0.3 } };
			case 'giggle':
				// A rapid shake, which is what being tickled looks like.
				return {
					animate: { x: [0, -7, 7, -5, 5, -3, 0], rotate: [0, 3, -3, 2, -2, 1, 0] },
					transition: { duration: 0.6, repeat: 1, ease: 'easeInOut' },
				};
			case 'happy':
				// A gentle sway.
				return {
					animate: { rotate: [-3, 3, -2, 0] },
					transition: { duration: 0.9, ease: 'easeInOut' },
				};
			case 'dizzy':
				// The full 360 the brief asks for.
				return {
					animate: { rotate: 360 },
					transition: { duration: 1.5, ease: [0.3, 0.1, 0.2, 1] },
				};
			default:
				return { animate: {}, transition: {} };
		}
	};

	const motionSpec = stageMotion();

	return (
		<div className="play">
			<header className="play-nav">
				<button type="button" className="link" onClick={onBack}>
					← Back
				</button>
				<h1 className="play-title">Play With Me</h1>
				<span className="spacer" />
			</header>

			{/* Speech bubble above the bot's head. */}
			<div className="play-stage" ref={stage}>
				<AnimatePresence>
					{bubble && speech ? (
						<motion.div
							className="play-bubble"
							initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.92 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.96 }}
							transition={{ type: 'spring', stiffness: 260, damping: 22 }}
							role="status"
							aria-live="polite"
						>
							{speech}
						</motion.div>
					) : null}
				</AnimatePresence>

				<div className="play-bot">
					<motion.div
						className="play-bot-inner"
						animate={motionSpec.animate}
						transition={motionSpec.transition}
					>
						<DocuBotMark
							size={260}
							mood={mood}
							float={!active && !reduce}
							blush={Boolean(active?.blush)}
							ariaLabel={`DocuBot, looking ${mood}`}
						/>
					</motion.div>
					<Particles kind={active?.particles ?? 'none'} seed={active ? ACTIONS.indexOf(active) : 0} />
				</div>

				{/* The slap's red flash, layered behind the bot. */}
				<AnimatePresence>
					{active?.shake ? (
						<motion.div
							className="play-flash"
							initial={{ opacity: 0 }}
							animate={{ opacity: [0, 0.42, 0] }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.45 }}
							aria-hidden
						/>
					) : null}
				</AnimatePresence>
			</div>

			<div className="play-actions" role="group" aria-label="Interact with DocuBot">
				{ACTIONS.map((action) => (
					<motion.button
						type="button"
						key={action.id}
						className={`play-action${active?.id === action.id ? ' on' : ''}`}
						onClick={() => react(action)}
						disabled={Boolean(active)}
						whileHover={reduce ? undefined : { scale: 1.05, y: -3 }}
						whileTap={reduce ? undefined : { scale: 0.97 }}
						aria-pressed={active?.id === action.id}
					>
						<span className="play-action-emoji" aria-hidden>
							{action.emoji}
						</span>
						<span className="play-action-label">{action.button}</span>
						<span className="play-action-hint">{action.hint}</span>
					</motion.button>
				))}
			</div>

			<p className="hint play-footnote">
				Sound effects are off by default. Use the speaker icon in the top bar to turn
				them on.
			</p>
		</div>
	);
};

export default PlayWithMe;

import React from 'react';

/**
 * DocuBot mascot — a metallic boxy chassis with two glowing binocular eyes.
 *
 * Drawn as inline SVG so it animates via CSS and needs no image asset, and so
 * the glow colour is driven by the same tokens as the rest of the interface.
 *
 * The eyes carry the expression. They are the whole face — there is no mouth —
 * so every mood is a different eye shape rather than a different picture:
 *
 *   idle      round lens, drifting pupil
 *   happy     upward arc, a smile with no mouth
 *   working   narrowed, cyan
 *   love      heart-shaped pupil
 *   dizzy     spiral, for being spun
 *   shocked   wide, with a small pupil
 *   squint    closed upward curves, for being tickled
 *   cross     X X, for a slap
 *   spiral    @-like concentric rings
 *
 * Props:
 *   size        pixel height of the whole figure
 *   mood        drives the eye shape, colour and blush
 *   float       whether to idle-bob (off when a parent already animates it)
 *   blush       cheek glow, for the affectionate moods
 */
export type MascotMood =
	| 'idle'
	| 'working'
	| 'happy'
	| 'love'
	| 'dizzy'
	| 'shocked'
	| 'squint'
	| 'cross'
	| 'spiral';

const MOOD_COLOR: Record<MascotMood, string> = {
	idle: '#facc15',
	working: '#38bdf8',
	happy: '#4ade80',
	love: '#fb7185',
	dizzy: '#c084fc',
	shocked: '#f87171',
	squint: '#4ade80',
	cross: '#f87171',
	spiral: '#c084fc',
};

/** Left and right lens centres, and the lens radius. */
const EYE = { left: 45, right: 75, y: 44, r: 11 } as const;

/** The two eyes, as a function of mood. */
const Eyes: React.FC<{ mood: MascotMood; color: string }> = ({ mood, color }) => {
	const common = { fill: 'none', stroke: color, strokeWidth: 2.4, strokeLinecap: 'round' as const };

	// Arcs and crosses: drawn rather than filled, so they read as a face.
	if (mood === 'happy' || mood === 'squint') {
		// An upward arc per eye. Together they read as a closed, pleased squint.
		return (
			<g>
				<path d={`M ${EYE.left - 7} ${EYE.y + 3} Q ${EYE.left} ${EYE.y - 8} ${EYE.left + 7} ${EYE.y + 3}`} {...common} />
				<path d={`M ${EYE.right - 7} ${EYE.y + 3} Q ${EYE.right} ${EYE.y - 8} ${EYE.right + 7} ${EYE.y + 3}`} {...common} />
			</g>
		);
	}

	if (mood === 'cross') {
		// X X.
		const s = 6;
		return (
			<g>
				{[
					[EYE.left, EYE.y],
					[EYE.right, EYE.y],
				].map(([cx, cy]) => (
					<g key={cx}>
						<line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} {...common} />
						<line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} {...common} />
					</g>
				))}
			</g>
		);
	}

	if (mood === 'spiral') {
		// Concentric rings, which is what reads as "@" at this size.
		return (
			<g fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
				{[EYE.left, EYE.right].map((cx) => (
					<g key={cx}>
						<circle cx={cx} cy={EYE.y} r={2} fill={color} stroke="none" />
						<path
							d={`M ${cx} ${EYE.y} a 4 4 0 1 1 -3.5 6.4`}
							fill="none"
						/>
						<path
							d={`M ${cx - 3.5} ${EYE.y + 6.4} a 7.5 7.5 0 1 0 6.5 -12.4`}
							fill="none"
						/>
					</g>
				))}
			</g>
		);
	}

	const pupil = mood === 'shocked' ? 3 : 5.2;

	return (
		<g>
			{[EYE.left, EYE.right].map((cx) => (
				<circle
					key={cx}
					cx={cx}
					cy={EYE.y}
					r={mood === 'shocked' ? EYE.r + 1.5 : EYE.r}
					fill="none"
					stroke={color}
					strokeWidth={2}
					opacity={0.75}
				/>
			))}
			{[EYE.left, EYE.right].map((cx) => (
				<g key={`p${cx}`}>
					{mood === 'love' ? (
						// A small heart, drawn as a path.
						<path
							d={`M ${cx} ${EYE.y + 5} C ${cx - 8} ${EYE.y - 2} ${cx - 4} ${EYE.y - 8} ${cx} ${EYE.y - 3.5} C ${cx + 4} ${EYE.y - 8} ${cx + 8} ${EYE.y - 2} ${cx} ${EYE.y + 5} Z`}
							fill={color}
						/>
					) : mood === 'dizzy' ? (
						<circle cx={cx} cy={EYE.y} r={pupil} fill={color}>
							<animateTransform
								attributeName="transform"
								type="rotate"
								from={`0 ${cx} ${EYE.y}`}
								to={`360 ${cx} ${EYE.y}`}
								dur="1.1s"
								repeatCount="indefinite"
							/>
						</circle>
					) : (
						<circle
							cx={cx}
							cy={EYE.y}
							r={pupil}
							fill={color}
							className="docubot-pupil"
						/>
					)}
					{/* Catchlight, so the eyes read as glass rather than flat discs. */}
					<circle cx={cx - 2.6} cy={EYE.y - 2.6} r={1.7} fill="#ffffff" fillOpacity={0.9} />
				</g>
			))}
		</g>
	);
};

export const DocuBotMark: React.FC<{
	size?: number;
	mood?: MascotMood;
	float?: boolean;
	blush?: boolean;
	className?: string;
	ariaLabel?: string;
}> = ({ size = 120, mood = 'idle', float = true, blush = false, className = '', ariaLabel = 'DocuBot' }) => {
	const eyeColor = MOOD_COLOR[mood] ?? MOOD_COLOR.idle;

	return (
		<svg
			className={`docubot-mark${float ? ' docubot-float' : ''}${className ? ` ${className}` : ''}`}
			width={size}
			height={size}
			viewBox="0 0 120 130"
			role="img"
			aria-label={ariaLabel}
		>
			<defs>
				{/* Body: a vertical metal gradient, the thing that reads as "steel". */}
				<linearGradient id="dbBody" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor="#e2e8f0" />
					<stop offset="45%" stopColor="#94a3b8" />
					<stop offset="100%" stopColor="#475569" />
				</linearGradient>
				<linearGradient id="dbChest" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stopColor="#334155" />
					<stop offset="100%" stopColor="#1e293b" />
				</linearGradient>
				<radialGradient id="dbLens">
					<stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
					<stop offset="45%" stopColor={eyeColor} stopOpacity="0.75" />
					<stop offset="100%" stopColor={eyeColor} stopOpacity="0" />
				</radialGradient>
				<radialGradient id="dbBlush">
					<stop offset="0%" stopColor="#fb7185" stopOpacity="0.75" />
					<stop offset="100%" stopColor="#fb7185" stopOpacity="0" />
				</radialGradient>
				<filter id="dbGlow" x="-60%" y="-60%" width="220%" height="220%">
					<feGaussianBlur stdDeviation="3.2" result="blur" />
					<feMerge>
						<feMergeNode in="blur" />
						<feMergeNode in="SourceGraphic" />
					</feMerge>
				</filter>
			</defs>

			{/* Antenna */}
			<g className="docubot-antenna">
				<line x1="60" y1="18" x2="60" y2="6" stroke="#64748b" strokeWidth="2.5" />
				<circle cx="60" cy="4" r="3.4" fill={eyeColor} filter="url(#dbGlow)" />
			</g>

			{/* Head: the boxy WALL-E chassis, slightly wider than it is tall */}
			<rect x="18" y="18" width="84" height="52" rx="9" fill="url(#dbBody)" />
			<rect
				x="18"
				y="18"
				width="84"
				height="52"
				rx="9"
				fill="none"
				stroke="#0f172a"
				strokeOpacity="0.35"
				strokeWidth="1.5"
			/>
			{/* Face plate, recessed */}
			<rect x="26" y="28" width="68" height="32" rx="14" fill="url(#dbChest)" />

			{/* Blush cheeks, outside the lenses so they read as cheeks. */}
			{blush ? (
				<g>
					<ellipse cx="32" cy="57" rx="7" ry="4" fill="url(#dbBlush)" />
					<ellipse cx="88" cy="57" rx="7" ry="4" fill="url(#dbBlush)" />
				</g>
			) : null}

			{/* Binocular eyes: two lenses on a shared bar, the signature shape */}
			<g filter="url(#dbGlow)">
				<rect x="30" y="33" width="60" height="3" rx="1.5" fill="#64748b" />
				<circle cx={EYE.left} cy={EYE.y} r={EYE.r} fill="url(#dbLens)" />
				<circle cx={EYE.right} cy={EYE.y} r={EYE.r} fill="url(#dbLens)" />
				<Eyes mood={mood} color={eyeColor} />
			</g>

			{/* Torso with a chest panel and a speaker grille */}
			<rect x="28" y="76" width="64" height="38" rx="7" fill="url(#dbBody)" />
			<rect x="36" y="84" width="48" height="16" rx="3" fill="url(#dbChest)" />
			{[0, 1, 2, 3, 4].map((i) => (
				<rect
					key={i}
					x={39 + i * 9}
					y="87"
					width="4"
					height="10"
					rx="2"
					fill="#0f172a"
					fillOpacity="0.55"
				/>
			))}

			{/* Treads */}
			<rect x="22" y="116" width="76" height="11" rx="5.5" fill="#334155" />
			{[0, 1, 2, 3, 4, 5, 6].map((i) => (
				<rect
					key={i}
					x={27 + i * 10}
					y="118"
					width="3.4"
					height="7"
					rx="1.7"
					fill="#94a3b8"
					fillOpacity="0.5"
				/>
			))}
		</svg>
	);
};

export const CREATOR = {
	name: 'Shayan Haider',
	linkedin: 'https://www.linkedin.com/in/shayanhaider2005',
	github: 'https://github.com/ShayanHaider2005',
} as const;

/** Creator attribution, shown on the landing page and the dashboard. */
export const CreatorFooter: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
	<footer className={`creator-footer${compact ? ' compact' : ''}`}>
		<span>
			Built by <strong>{CREATOR.name}</strong>
		</span>
		<span className="dot">·</span>
		<a href={CREATOR.linkedin} target="_blank" rel="noreferrer noopener">
			LinkedIn
		</a>
		<span className="dot">·</span>
		<a href={CREATOR.github} target="_blank" rel="noreferrer noopener">
			GitHub
		</a>
	</footer>
);

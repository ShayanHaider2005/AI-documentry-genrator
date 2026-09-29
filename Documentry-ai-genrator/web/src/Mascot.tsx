import React from 'react';

/**
 * DocuBot mascot — a metallic boxy chassis with two glowing binocular eyes.
 *
 * Drawn as inline SVG so it animates via CSS and needs no image asset, and so
 * the glow colour is driven by the same tokens as the rest of the interface.
 *
 * Props:
 *   size      pixel height of the whole figure
 *   mood      'idle' | 'working' | 'happy'  — drives the eye and antenna
 *   float     whether to idle-bob (off when a parent already animates it)
 */
export const DocuBotMark: React.FC<{
	size?: number;
	mood?: 'idle' | 'working' | 'happy';
	float?: boolean;
	className?: string;
}> = ({ size = 120, mood = 'idle', float = true, className = '' }) => {
	const eyeColor =
		mood === 'working' ? '#38bdf8' : mood === 'happy' ? '#4ade80' : '#facc15';

	return (
		<svg
			className={`docubot-mark${float ? ' docubot-float' : ''}${className ? ` ${className}` : ''}`}
			width={size}
			height={size}
			viewBox="0 0 120 130"
			role="img"
			aria-label="DocuBot"
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

			{/* Binocular eyes: two lenses on a shared bar, the signature shape */}
			<g filter="url(#dbGlow)">
				<rect x="30" y="33" width="60" height="3" rx="1.5" fill="#64748b" />
				<circle cx="45" cy="44" r="11" fill="url(#dbLens)" />
				<circle cx="75" cy="44" r="11" fill="url(#dbLens)" />
				<circle cx="45" cy="44" r="5.2" fill={eyeColor} className="docubot-pupil" />
				<circle cx="75" cy="44" r="5.2" fill={eyeColor} className="docubot-pupil" />
				{/* Catchlights, so the eyes read as glass rather than flat discs */}
				<circle cx="42.4" cy="41.4" r="1.7" fill="#ffffff" fillOpacity="0.9" />
				<circle cx="72.4" cy="41.4" r="1.7" fill="#ffffff" fillOpacity="0.9" />
			</g>

			{/* Torso with a chest panel and a speaker grille */}
			<rect x="28" y="76" width="64" height="38" rx="7" fill="url(#dbBody)" />
			<rect
				x="36"
				y="84"
				width="48"
				height="16"
				rx="3"
				fill="url(#dbChest)"
			/>
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

/** Full-screen startup animation, fading out once `ready` flips. */
export const SplashScreen: React.FC<{ ready: boolean; error?: string | null }> = ({
	ready,
	error,
}) => (
	<div className={`splash${ready ? ' splash-out' : ''}`} aria-hidden={ready}>
		<div className="splash-inner">
			<DocuBotMark size={168} mood={ready ? 'happy' : 'idle'} />
			<h1 className="splash-title">DocuBot</h1>
			<p className="splash-sub">
				{error ? 'Could not reach the server' : ready ? 'Ready' : 'Waking up…'}
			</p>
			{!ready && !error ? <div className="splash-bar"><span /></div> : null}
			{error ? <p className="splash-error">{error}</p> : null}
			<p className="splash-by">Made by Shayan Haider</p>
		</div>
	</div>
);

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

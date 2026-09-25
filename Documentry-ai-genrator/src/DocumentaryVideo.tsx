import React, { useMemo } from 'react';
import {
	AbsoluteFill,
	Audio,
	Img,
	interpolate,
	OffthreadVideo,
	Series,
	staticFile,
	useCurrentFrame,
} from 'remotion';
import type { CSSProperties } from 'react';
import type { DocumentaryProps, Scene, WordTiming } from './types';

const resolveAssetUrl = (assetUrl?: string) => {
	if (!assetUrl) return staticFile('images/scene-placeholder.svg');
	return /^https?:\/\//.test(assetUrl) ? assetUrl : staticFile(assetUrl);
};

// ---------------------------------------------------------------------------
// Single Scene: Online Classroom Lecture Slide
// ---------------------------------------------------------------------------
interface SceneContentProps {
	scene: Scene;
	index: number;
	totalScenes: number;
	videoTitle: string;
	teacherName: string;
	clientAvatarUrl: string;
}

const SceneContent: React.FC<SceneContentProps> = ({
	scene,
	index,
	totalScenes,
	videoTitle,
	teacherName,
	clientAvatarUrl,
}) => {
	const frame = useCurrentFrame();
	const duration = Math.max(1, scene.durationInFrames);

	// Slow zoom for concept artwork (Ken-Burns)
	const imageScale = interpolate(frame, [0, duration], [1, 1.06], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Progress in current scene (0 to 1)
	const progress = Math.min(1, Math.max(0, frame / duration));

	// Compute word-level timings (from dataset or proportional fallback)
	const words: WordTiming[] = useMemo(() => {
		if (scene.wordTimings && scene.wordTimings.length > 0) {
			return scene.wordTimings;
		}
		const rawWords = (scene.narrationText || '').trim().split(/\s+/).filter(Boolean);
		if (rawWords.length === 0) return [];
		const weights = rawWords.map((w) => {
			let weight = Math.max(1, w.length);
			if (/[,;:]$/.test(w)) weight += 3;
			if (/[.!?]$/.test(w)) weight += 6;
			return weight;
		});
		const totalWeight = weights.reduce((sum, v) => sum + v, 0);
		let currentFrame = 0;
		return rawWords.map((word, idx) => {
			const wordDuration = Math.max(2, Math.round((weights[idx] / totalWeight) * duration));
			const startFrame = currentFrame;
			const endFrame =
				idx === rawWords.length - 1 ? duration : Math.min(duration, startFrame + wordDuration);
			currentFrame = endFrame;
			return { word, startFrame, endFrame };
		});
	}, [scene.wordTimings, scene.narrationText, duration]);

	const currentWordIndex = words.findIndex(
		(w) => frame >= w.startFrame && frame <= w.endFrame,
	);

	// Key takeaways / bullet points
	const bulletPoints =
		scene.summaryBulletPoints && scene.summaryBulletPoints.length > 0
			? scene.summaryBulletPoints
			: [
					'Core conceptual principles and structural requirements',
					'Systematic quality assurance and validation standards',
					'Measurable outcomes for high-reliability execution',
			  ];

	const chapterTitle = scene.title || `Module ${scene.sceneNumber || index + 1}: Conceptual Summary`;

	return (
		<AbsoluteFill
			style={{
				backgroundColor: '#0a0d14',
				color: '#f8fafc',
				fontFamily:
					'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
				overflow: 'hidden',
			}}
		>
			{/* Ambient studio backdrop */}
			<div
				style={{
					position: 'absolute',
					top: -150,
					left: -150,
					width: 900,
					height: 900,
					borderRadius: '50%',
					background: 'radial-gradient(circle, rgba(37,99,235,0.12) 0%, rgba(10,13,20,0) 70%)',
					filter: 'blur(80px)',
					pointerEvents: 'none',
				}}
			/>
			<div
				style={{
					position: 'absolute',
					bottom: -150,
					right: -150,
					width: 800,
					height: 800,
					borderRadius: '50%',
					background: 'radial-gradient(circle, rgba(234,179,8,0.08) 0%, rgba(10,13,20,0) 70%)',
					filter: 'blur(80px)',
					pointerEvents: 'none',
				}}
			/>

			{/* Audio Track */}
			{scene.audioUrl ? <Audio src={staticFile(scene.audioUrl)} /> : null}

			{/* ================================================================= */}
			{/* TOP CLASSROOM HEADER */}
			{/* ================================================================= */}
			<div
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					right: 0,
					height: 92,
					padding: '0 64px',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					borderBottom: '1px solid rgba(255,255,255,0.08)',
					backgroundColor: 'rgba(15, 23, 42, 0.75)',
					backdropFilter: 'blur(16px)',
					zIndex: 10,
				}}
			>
				{/* Course & Live Indicator */}
				<div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							backgroundColor: 'rgba(239, 68, 68, 0.16)',
							border: '1px solid rgba(239, 68, 68, 0.4)',
							borderRadius: 24,
							padding: '6px 16px',
							fontSize: 14,
							fontWeight: 700,
							letterSpacing: '0.08em',
							color: '#f87171',
							textTransform: 'uppercase',
						}}
					>
						<span
							style={{
								width: 10,
								height: 10,
								borderRadius: '50%',
								backgroundColor: '#ef4444',
								boxShadow: '0 0 10px #ef4444',
								display: 'inline-block',
							}}
						/>
						Online Lecture
					</div>
					<div style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9' }}>
						{videoTitle}
					</div>
				</div>

				{/* Module / Scene Counter */}
				<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
					<div
						style={{
							backgroundColor: 'rgba(59, 130, 246, 0.14)',
							border: '1px solid rgba(59, 130, 246, 0.35)',
							borderRadius: 20,
							padding: '6px 18px',
							fontSize: 15,
							fontWeight: 600,
							color: '#60a5fa',
							letterSpacing: '0.04em',
						}}
					>
						TOPIC {index + 1} OF {totalScenes}
					</div>
				</div>
			</div>

			{/* ================================================================= */}
			{/* MAIN CLASSROOM BOARD */}
			{/* ================================================================= */}
			<div
				style={{
					position: 'absolute',
					top: 92,
					bottom: 24,
					left: 0,
					right: 0,
					padding: '44px 64px',
					display: 'grid',
					gridTemplateColumns: '1.25fr 0.75fr',
					gap: 48,
				}}
			>
				{/* ------------------------------------------------------------- */}
				{/* LEFT: TEACHER'S WHITEBOARD & LIVE HIGHLIGHTED TRANSCRIPT     */}
				{/* ------------------------------------------------------------- */}
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-between',
					}}
				>
					{/* Module Title & Core Whiteboard Summary */}
					<div>
						{/* Small Chapter Label */}
						<div
							style={{
								fontSize: 16,
								fontWeight: 700,
								letterSpacing: '0.12em',
								textTransform: 'uppercase',
								color: '#38bdf8',
								marginBottom: 10,
							}}
						>
							Lesson Summary
						</div>

						{/* Main Topic Heading */}
						<h1
							style={{
								fontSize: 44,
								fontWeight: 800,
								lineHeight: 1.15,
								color: '#ffffff',
								margin: '0 0 24px 0',
								letterSpacing: '-0.02em',
							}}
						>
							{chapterTitle}
						</h1>

						{/* Whiteboard Summary Points */}
						<div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
							{bulletPoints.map((point, ptIdx) => (
								<div
									key={ptIdx}
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 16,
										backgroundColor: 'rgba(30, 41, 59, 0.55)',
										border: '1px solid rgba(255, 255, 255, 0.08)',
										borderRadius: 14,
										padding: '14px 20px',
									}}
								>
									<div
										style={{
											width: 28,
											height: 28,
											borderRadius: 8,
											backgroundColor: 'rgba(56, 189, 248, 0.16)',
											border: '1px solid rgba(56, 189, 248, 0.4)',
											color: '#38bdf8',
											display: 'flex',
											alignItems: 'center',
											justifyContent: 'center',
											fontSize: 14,
											fontWeight: 700,
											flexShrink: 0,
										}}
									>
										{ptIdx + 1}
									</div>
									<div
										style={{
											fontSize: 20,
											fontWeight: 500,
											color: '#cbd5e1',
											lineHeight: 1.3,
										}}
									>
										{point}
									</div>
								</div>
							))}
						</div>
					</div>

					{/* --------------------------------------------------------- */}
					{/* LIVE SPOKEN NARRATION BOX (TEACHER'S VOICE HIGHLIGHTER)   */}
					{/* --------------------------------------------------------- */}
					<div
						style={{
							backgroundColor: 'rgba(15, 23, 42, 0.92)',
							border: '2px solid rgba(234, 179, 8, 0.45)',
							borderRadius: 20,
							padding: '24px 30px',
							boxShadow: '0 12px 36px rgba(0, 0, 0, 0.5), 0 0 20px rgba(234, 179, 8, 0.12)',
							position: 'relative',
						}}
					>
						{/* Teacher badge header */}
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								marginBottom: 14,
								borderBottom: '1px solid rgba(255,255,255,0.08)',
								paddingBottom: 10,
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
								<span style={{ fontSize: 20 }}>👨‍🏫</span>
								<span
									style={{
										fontSize: 15,
										fontWeight: 700,
										letterSpacing: '0.06em',
										color: '#facc15',
										textTransform: 'uppercase',
									}}
								>
									{teacherName} — Spoken Explanation
								</span>
							</div>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 6,
									fontSize: 13,
									color: '#94a3b8',
								}}
							>
								<span>Real-Time Pen Tracking</span>
								<span style={{ fontSize: 16 }}>✏️</span>
							</div>
						</div>

						{/* Spoken Narration Words with Teacher Highlighter & Underline */}
						<div
							style={{
								fontSize: 34,
								fontWeight: 600,
								lineHeight: 1.6,
								color: '#f8fafc',
								wordBreak: 'break-word',
							}}
						>
							{words.map((item, wIdx) => {
								const isCurrent = wIdx === currentWordIndex;
								const isPast =
									currentWordIndex >= 0 ? wIdx < currentWordIndex : frame > item.endFrame;

								let wordStyle: CSSProperties = {
									display: 'inline-block',
									marginRight: '0.32em',
									position: 'relative',
									transition: 'all 0.1s ease',
									borderRadius: 6,
									padding: '0 4px',
								};

								if (isCurrent) {
									// ACTIVE WORD: Teacher highlighter glowing box + active marker underline
									wordStyle = {
										...wordStyle,
										backgroundColor: '#facc15',
										color: '#0f172a',
										fontWeight: 800,
										boxShadow: '0 0 16px rgba(250, 204, 21, 0.85)',
										transform: 'scale(1.05)',
									};
								} else if (isPast) {
									// PAST WORD: Highlighted lesson progress
									wordStyle = {
										...wordStyle,
										color: '#ffffff',
										backgroundColor: 'rgba(234, 179, 8, 0.22)',
										borderBottom: '3px solid #eab308',
									};
								} else {
									// UPCOMING WORD: Muted crisp text
									wordStyle = {
										...wordStyle,
										color: 'rgba(226, 232, 240, 0.65)',
									};
								}

								return (
									<span key={wIdx} style={wordStyle}>
										{item.word}
										{/* Teacher Pointer / Stylus Indicator on active word */}
										{isCurrent && (
											<span
												style={{
													position: 'absolute',
													bottom: -22,
													left: '50%',
													transform: 'translateX(-50%)',
													fontSize: 16,
													lineHeight: 1,
													filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
												}}
											>
												▲
											</span>
										)}
									</span>
								);
							})}
						</div>
					</div>
				</div>

				{/* ------------------------------------------------------------- */}
				{/* RIGHT: CONCEPT VISUAL & TEACHER AVATAR PIP                    */}
				{/* ------------------------------------------------------------- */}
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: 24,
					}}
				>
					{/* Concept Artwork Card */}
					<div
						style={{
							flex: 1,
							position: 'relative',
							borderRadius: 24,
							overflow: 'hidden',
							border: '1px solid rgba(255, 255, 255, 0.12)',
							boxShadow: '0 16px 40px rgba(0, 0, 0, 0.6)',
							backgroundColor: '#1e293b',
						}}
					>
						<Img
							src={resolveAssetUrl(scene.bRollImageUrl)}
							style={{
								width: '100%',
								height: '100%',
								objectFit: 'cover',
								transform: `scale(${imageScale})`,
							}}
						/>
						{/* Gradient scrim */}
						<div
							style={{
								position: 'absolute',
								bottom: 0,
								left: 0,
								right: 0,
								height: '40%',
								background:
									'linear-gradient(to top, rgba(15,23,42,0.95) 0%, rgba(15,23,42,0) 100%)',
							}}
						/>
						{/* Visual Prompt Tag */}
						<div
							style={{
								position: 'absolute',
								bottom: 20,
								left: 20,
								right: 20,
								fontSize: 15,
								fontWeight: 500,
								color: '#e2e8f0',
								lineHeight: 1.4,
								textShadow: '0 2px 6px rgba(0,0,0,0.8)',
							}}
						>
							💡 {scene.bRollPrompt || 'Visual representation of the core educational concept'}
						</div>
					</div>

					{/* Teacher Avatar & Lecture Status Card */}
					<div
						style={{
							backgroundColor: 'rgba(30, 41, 59, 0.75)',
							border: '1px solid rgba(255, 255, 255, 0.1)',
							borderRadius: 20,
							padding: '18px 24px',
							display: 'flex',
							alignItems: 'center',
							gap: 18,
						}}
					>
						<div
							style={{
								position: 'relative',
								width: 58,
								height: 58,
								borderRadius: '50%',
								overflow: 'hidden',
								border: '2px solid #38bdf8',
								flexShrink: 0,
								backgroundColor: '#0f172a',
							}}
						>
							<Img
								src={resolveAssetUrl(clientAvatarUrl)}
								style={{ width: '100%', height: '100%', objectFit: 'cover' }}
							/>
							<div
								style={{
									position: 'absolute',
									bottom: 2,
									right: 2,
									width: 12,
									height: 12,
									borderRadius: '50%',
									backgroundColor: '#22c55e',
									border: '2px solid #0f172a',
								}}
							/>
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>
								{teacherName}
							</div>
							<div style={{ fontSize: 14, color: '#94a3b8' }}>
								Instructor Voice Active
							</div>
						</div>
						{/* Animated audio bar indicator */}
						<div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 24 }}>
							{[0.6, 0.9, 0.4, 0.8, 0.5].map((h, barIdx) => {
								const bounce = Math.sin(frame * 0.25 + barIdx) * 0.4 + 0.6;
								return (
									<div
										key={barIdx}
										style={{
											width: 4,
											height: `${Math.round(24 * h * bounce)}px`,
											backgroundColor: '#facc15',
											borderRadius: 2,
										}}
									/>
								);
							})}
						</div>
					</div>
				</div>
			</div>

			{/* ================================================================= */}
			{/* BOTTOM TIMELINE SCRUBBER                                         */}
			{/* ================================================================= */}
			<div
				style={{
					position: 'absolute',
					bottom: 0,
					left: 0,
					right: 0,
					height: 6,
					backgroundColor: 'rgba(255, 255, 255, 0.08)',
				}}
			>
				<div
					style={{
						height: '100%',
						width: `${progress * 100}%`,
						backgroundColor: '#facc15',
						boxShadow: '0 0 10px #facc15',
					}}
				/>
			</div>
		</AbsoluteFill>
	);
};

// ---------------------------------------------------------------------------
// Main Composition
// ---------------------------------------------------------------------------
export const DocumentaryVideo = (
	props: (DocumentaryProps & Record<string, unknown>) | Scene[],
) => {
	const scenes: Scene[] = Array.isArray(props)
		? props
		: props.scenes && Array.isArray(props.scenes)
		? props.scenes
		: [];

	const videoTitle =
		(!Array.isArray(props) && (props.title as string)) || 'Educational Masterclass';
	const teacherName =
		(!Array.isArray(props) && (props.teacherName as string)) || 'Online Instructor';
	const clientAvatarUrl =
		(!Array.isArray(props) && (props.clientAvatarUrl as string)) || 'images/scene-placeholder.svg';
	const talkingHeadVideoUrl = !Array.isArray(props)
		? (props.talkingHeadVideoUrl as string | undefined)
		: undefined;

	return (
		<AbsoluteFill style={{ backgroundColor: '#0a0d14' }}>
			<Series>
				{scenes.map((scene, idx) => (
					<Series.Sequence
						key={scene.id || `scene-${idx}`}
						durationInFrames={Math.max(1, scene.durationInFrames)}
					>
						<SceneContent
							scene={scene}
							index={idx}
							totalScenes={scenes.length}
							videoTitle={videoTitle}
							teacherName={teacherName}
							clientAvatarUrl={clientAvatarUrl}
						/>
					</Series.Sequence>
				))}
			</Series>

			{/* Picture-in-picture video if supplied */}
			{talkingHeadVideoUrl ? (
				<OffthreadVideo
					src={staticFile(talkingHeadVideoUrl)}
					style={{
						position: 'absolute',
						top: 110,
						right: 64,
						width: '20%',
						height: '24%',
						objectFit: 'cover',
						borderRadius: 16,
						border: '2px solid #38bdf8',
						boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
						zIndex: 50,
					}}
				/>
			) : null}
		</AbsoluteFill>
	);
};


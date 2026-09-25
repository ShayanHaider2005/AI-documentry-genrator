import React from 'react';
import {
	AbsoluteFill,
	Audio,
	Img,
	interpolate,
	Series,
	staticFile,
	useCurrentFrame,
} from 'remotion';
import type { Scene } from './types';

const resolveImageUrl = (url?: string) => {
	if (!url) {
		return 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1920&q=80';
	}
	return /^https?:\/\//.test(url) ? url : staticFile(url);
};

const resolveAudioUrl = (audioPath?: string) => {
	if (!audioPath) return staticFile('audio/scene-1.mp3');
	return /^https?:\/\//.test(audioPath) ? audioPath : staticFile(audioPath);
};

interface SceneContentProps {
	scene: Scene;
	totalScenes: number;
}

const SceneContent: React.FC<SceneContentProps> = ({ scene, totalScenes }) => {
	const frame = useCurrentFrame();
	const duration = Math.max(1, scene.durationInFrames);

	// Subtle Ken-Burns zoom on the high-res visual
	const scale = interpolate(frame, [0, duration], [1, 1.08], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Smooth scene fade-in
	const opacity = interpolate(frame, [0, 15], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{ backgroundColor: '#090d16', overflow: 'hidden' }}>
			{/* High-resolution cinematic background visual */}
			<Img
				src={resolveImageUrl(scene.imageUrl)}
				style={{
					width: '100%',
					height: '100%',
					objectFit: 'cover',
					transform: `scale(${scale})`,
					opacity,
				}}
			/>

			{/* Scene Voiceover Audio */}
			{scene.audioPath ? <Audio src={resolveAudioUrl(scene.audioPath)} /> : null}

			{/* Cinematic vignette & shadow gradients */}
			<div
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					right: 0,
					height: 180,
					background:
						'linear-gradient(to bottom, rgba(0, 0, 0, 0.75) 0%, rgba(0, 0, 0, 0) 100%)',
					pointerEvents: 'none',
				}}
			/>
			<div
				style={{
					position: 'absolute',
					bottom: 0,
					left: 0,
					right: 0,
					height: 360,
					background:
						'linear-gradient(to top, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0) 100%)',
					pointerEvents: 'none',
				}}
			/>

			{/* Top Header Badge */}
			<div
				style={{
					position: 'absolute',
					top: 48,
					left: 64,
					right: 64,
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					zIndex: 10,
				}}
			>
				<div
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: 10,
						backgroundColor: 'rgba(15, 23, 42, 0.8)',
						border: '1px solid rgba(255, 255, 255, 0.15)',
						borderRadius: 30,
						padding: '8px 20px',
						backdropFilter: 'blur(12px)',
						color: '#f8fafc',
						fontSize: 15,
						fontWeight: 700,
						letterSpacing: '0.08em',
						textTransform: 'uppercase',
					}}
				>
					<span
						style={{
							width: 8,
							height: 8,
							borderRadius: '50%',
							backgroundColor: '#facc15',
							boxShadow: '0 0 10px #facc15',
						}}
					/>
					Documentary Chapter
				</div>
				<div
					style={{
						backgroundColor: 'rgba(15, 23, 42, 0.8)',
						border: '1px solid rgba(255, 255, 255, 0.15)',
						borderRadius: 30,
						padding: '8px 20px',
						backdropFilter: 'blur(12px)',
						color: '#94a3b8',
						fontSize: 15,
						fontWeight: 600,
						letterSpacing: '0.04em',
					}}
				>
					SCENE {scene.sceneNumber} OF {totalScenes}
				</div>
			</div>

			{/* Clean, Unified Subtitle Box (Requirement 6: smooth text block, bg-slate-900/80, text-yellow-400) */}
			<div
				style={{
					position: 'absolute',
					bottom: 72,
					left: '10%',
					right: '10%',
					backgroundColor: 'rgba(15, 23, 42, 0.82)',
					border: '1px solid rgba(250, 204, 21, 0.28)',
					borderRadius: 16,
					padding: '24px 36px',
					boxShadow:
						'0 16px 40px rgba(0, 0, 0, 0.65), 0 0 24px rgba(0, 0, 0, 0.4)',
					backdropFilter: 'blur(16px)',
					textAlign: 'center',
					zIndex: 10,
				}}
			>
				<p
					style={{
						margin: 0,
						color: '#facc15',
						fontSize: 38,
						fontWeight: 600,
						lineHeight: 1.38,
						letterSpacing: '-0.01em',
						textShadow: '0 2px 8px rgba(0, 0, 0, 0.8)',
						fontFamily:
							'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
					}}
				>
					{scene.narratorText}
				</p>
			</div>
		</AbsoluteFill>
	);
};

export const DocumentaryVideo = (props: { scenes?: Scene[] } | Scene[]) => {
	const scenes: Scene[] = Array.isArray(props)
		? props
		: props.scenes && Array.isArray(props.scenes)
		? props.scenes
		: [];

	return (
		<AbsoluteFill style={{ backgroundColor: '#090d16' }}>
			<Series>
				{scenes.map((scene, idx) => (
					<Series.Sequence
						key={scene.sceneNumber || idx}
						durationInFrames={Math.max(1, scene.durationInFrames)}
					>
						<SceneContent scene={scene} totalScenes={scenes.length} />
					</Series.Sequence>
				))}
			</Series>
		</AbsoluteFill>
	);
};

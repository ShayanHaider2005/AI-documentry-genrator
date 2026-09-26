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
import type { DocumentaryProps, Scene } from './types';

const FADE_IN_FRAMES = 15;
const KEN_BURNS_SCALE = 1.08;

const isRemote = (value: string) => /^https?:\/\//i.test(value);

/** Resolve a dataset image reference. Returns null when the scene has no visual. */
const resolveImageUrl = (imageUrl?: string): string | null => {
	if (!imageUrl) {
		return null;
	}
	return isRemote(imageUrl) ? imageUrl : staticFile(imageUrl);
};

const resolveAudioUrl = (audioPath: string): string =>
	isRemote(audioPath) ? audioPath : staticFile(audioPath);

/** Deterministic, data-derived backdrop used when a scene ships no image. */
const placeholderBackdrop = (sceneNumber: number): string => {
	const hue = ((sceneNumber || 0) * 47) % 360;
	return `radial-gradient(circle at 30% 25%, hsl(${hue} 45% 22%) 0%, hsl(${
		(hue + 40) % 360
	} 40% 10%) 45%, #090d16 100%)`;
};

const VIGNETTE_TOP = {
	position: 'absolute' as const,
	top: 0,
	left: 0,
	right: 0,
	height: 180,
	background:
		'linear-gradient(to bottom, rgba(0, 0, 0, 0.75) 0%, rgba(0, 0, 0, 0) 100%)',
	pointerEvents: 'none' as const,
};

const VIGNETTE_BOTTOM = {
	position: 'absolute' as const,
	bottom: 0,
	left: 0,
	right: 0,
	height: 360,
	background:
		'linear-gradient(to top, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0) 100%)',
	pointerEvents: 'none' as const,
};

const HEADER_ROW = {
	position: 'absolute' as const,
	top: 48,
	left: 64,
	right: 64,
	display: 'flex' as const,
	justifyContent: 'space-between' as const,
	alignItems: 'center' as const,
	gap: 24,
	zIndex: 10,
};

const CHIP_BASE = {
	display: 'inline-flex' as const,
	alignItems: 'center' as const,
	gap: 10,
	backgroundColor: 'rgba(15, 23, 42, 0.8)',
	border: '1px solid rgba(255, 255, 255, 0.15)',
	borderRadius: 30,
	padding: '8px 20px',
	backdropFilter: 'blur(12px)',
};

const CAPTION_BOX = {
	position: 'absolute' as const,
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
	textAlign: 'center' as const,
	zIndex: 10,
};

interface SceneContentProps {
	scene: Scene;
	index: number;
	totalScenes: number;
}

const SceneContent: React.FC<SceneContentProps> = ({
	scene,
	index,
	totalScenes,
}) => {
	const frame = useCurrentFrame();
	const duration = Math.max(1, scene.durationInFrames || 1);
	const imageUrl = resolveImageUrl(scene.imageUrl);

	// Subtle Ken-Burns zoom on the high-res visual
	const scale = interpolate(frame, [0, duration], [1, KEN_BURNS_SCALE], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Smooth scene fade-in
	const opacity = interpolate(frame, [0, FADE_IN_FRAMES], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	const progress = totalScenes > 0 ? (index + 1) / totalScenes : 1;
	const hasHeading = Boolean(scene.badge || scene.title);

	return (
		<AbsoluteFill style={{ backgroundColor: '#090d16', overflow: 'hidden' }}>
			{/* High-resolution cinematic background visual */}
			{imageUrl ? (
				<Img
					src={imageUrl}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						transform: `scale(${scale})`,
						opacity,
					}}
				/>
			) : (
				<AbsoluteFill style={{ background: placeholderBackdrop(scene.sceneNumber) }} />
			)}

			{/* Scene Voiceover Audio */}
			{scene.audioPath ? <Audio src={resolveAudioUrl(scene.audioPath)} /> : null}

			{/* Cinematic vignette & shadow gradients */}
			<div style={VIGNETTE_TOP} />
			<div style={VIGNETTE_BOTTOM} />

			{/* Data-driven header: chapter heading + numeric progress only */}
			{hasHeading || totalScenes > 0 ? (
				<div style={HEADER_ROW}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
						{scene.badge ? (
							<div
								style={{
									...CHIP_BASE,
									color: '#f8fafc',
									fontSize: 15,
									fontWeight: 700,
									letterSpacing: '0.08em',
									textTransform: 'uppercase',
									whiteSpace: 'nowrap',
								}}
							>
								<span
									style={{
										width: 8,
										height: 8,
										borderRadius: '50%',
										backgroundColor: '#facc15',
										boxShadow: '0 0 10px #facc15',
										flexShrink: 0,
									}}
								/>
								{scene.badge}
							</div>
						) : null}

						{scene.title ? (
							<div
								style={{
									color: '#f8fafc',
									fontSize: 26,
									fontWeight: 700,
									letterSpacing: '0.01em',
									textShadow: '0 2px 10px rgba(0, 0, 0, 0.8)',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
							>
								{scene.title}
							</div>
						) : null}
					</div>

					{totalScenes > 0 ? (
						<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
							<div
								style={{
									...CHIP_BASE,
									color: '#94a3b8',
									fontSize: 15,
									fontWeight: 600,
									letterSpacing: '0.04em',
									fontVariantNumeric: 'tabular-nums',
								}}
							>
								{scene.sceneNumber} / {totalScenes}
							</div>
							<div
								style={{
									width: 180,
									height: 3,
									borderRadius: 2,
									backgroundColor: 'rgba(255, 255, 255, 0.18)',
									overflow: 'hidden',
								}}
							>
								<div
									style={{
										width: `${Math.round(progress * 100)}%`,
										height: '100%',
										backgroundColor: '#facc15',
									}}
								/>
							</div>
						</div>
					) : null}
				</div>
			) : null}

			{/* Unified caption box — text comes straight from the dataset */}
			{scene.narratorText ? (
				<div style={CAPTION_BOX}>
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
			) : null}
		</AbsoluteFill>
	);
};

export const DocumentaryVideo = ({ scenes }: DocumentaryProps) => {
	const safeScenes: Scene[] = Array.isArray(scenes) ? scenes : [];

	return (
		<AbsoluteFill style={{ backgroundColor: '#090d16' }}>
			<Series>
				{safeScenes.map((scene, idx) => (
					<Series.Sequence
						key={scene.id ?? scene.sceneNumber ?? idx}
						durationInFrames={Math.max(1, scene.durationInFrames || 1)}
					>
						<SceneContent
							scene={scene}
							index={idx}
							totalScenes={safeScenes.length}
						/>
					</Series.Sequence>
				))}
			</Series>
		</AbsoluteFill>
	);
};

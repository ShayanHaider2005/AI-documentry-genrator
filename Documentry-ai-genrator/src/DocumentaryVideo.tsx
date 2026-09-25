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
import type { DocumentaryProps, Scene } from './types';

const backgroundStyle: CSSProperties = {
	backgroundColor: '#111',
	overflow: 'hidden',
};

const subtitleStyle: CSSProperties = {
	backgroundColor: 'rgba(0, 0, 0, 0.78)',
	borderRadius: 8,
	bottom: 72,
	color: '#fff',
	fontSize: 42,
	left: '8%',
	lineHeight: 1.25,
	padding: '18px 28px',
	position: 'absolute',
	right: '8%',
	textAlign: 'center',
};

const pictureInPictureStyle: CSSProperties = {
	border: '3px solid #fff',
	borderRadius: 12,
	boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
	height: '28%',
	objectFit: 'cover',
	position: 'absolute',
	right: 48,
	top: 48,
	width: '22%',
};

const resolveAssetUrl = (assetUrl: string) =>
	/^https?:\/\//.test(assetUrl) ? assetUrl : staticFile(assetUrl);

const SceneContent = ({ scene }: { scene: Scene }) => {
	const frame = useCurrentFrame();
	const scale = interpolate(frame, [0, scene.durationInFrames], [1, 1.08], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={backgroundStyle}>
			<Img
				src={resolveAssetUrl(scene.bRollImageUrl)}
				style={{
					height: '100%',
					objectFit: 'cover',
					transform: `scale(${scale})`,
					width: '100%',
				}}
			/>
			<Audio src={staticFile(scene.audioUrl)} />
			<div style={subtitleStyle}>{scene.narrationText}</div>
		</AbsoluteFill>
	);
};

export const DocumentaryVideo = ({
	talkingHeadVideoUrl,
	scenes,
}: DocumentaryProps) => {
	return (
		<AbsoluteFill>
			<Series>
				{scenes.map((scene) => (
					<Series.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
						<SceneContent scene={scene} />
					</Series.Sequence>
				))}
			</Series>
			{talkingHeadVideoUrl ? (
				<OffthreadVideo
					src={staticFile(talkingHeadVideoUrl)}
					style={pictureInPictureStyle}
				/>
			) : null}
		</AbsoluteFill>
	);
};

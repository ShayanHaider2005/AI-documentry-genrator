import { Composition } from 'remotion';
import { DocumentaryVideo } from './DocumentaryVideo';
import type { DocumentaryProps } from './types';

const sampleProps: DocumentaryProps = {
	title: 'The Story of Our Coastline',
	clientAvatarUrl: 'https://images.unsplash.com/photo-1500534623283-312aade485b7',
	talkingHeadVideoUrl: undefined,
	totalDurationInFrames: 0,
	scenes: [
		{
			id: 'coastline-introduction',
			narrationText: 'Every coastline carries a history shaped by wind, water, and time.',
			audioUrl: 'audio/scene-1.mp3',
			durationInFrames: 150,
			bRollPrompt: 'A wide cinematic view of a rugged coastline at sunrise',
			bRollImageUrl:
				'https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=1920&q=80',
		},
		{
			id: 'coastline-community',
			narrationText: 'For generations, communities have built their lives around this changing edge.',
			audioUrl: 'audio/scene-2.mp3',
			durationInFrames: 180,
			bRollPrompt: 'A fishing village beside calm blue water in soft afternoon light',
			bRollImageUrl:
				'https://images.unsplash.com/photo-1498623116890-37e912163d5d?auto=format&fit=crop&w=1920&q=80',
		},
	],
};

const totalDurationInFrames = sampleProps.scenes.reduce(
	(totalDuration, scene) => totalDuration + scene.durationInFrames,
	0,
);

sampleProps.totalDurationInFrames = totalDurationInFrames;

export const RemotionRoot = () => {
	return (
		<Composition<any, any>
			id="Documentary"
			component={DocumentaryVideo}
			fps={30}
			width={1920}
			height={1080}
			durationInFrames={Math.max(1, totalDurationInFrames)}
			defaultProps={sampleProps}
			calculateMetadata={({ props }: { props: any }) => {
				const scenes = Array.isArray(props)
					? props
					: props?.scenes && Array.isArray(props.scenes)
					? props.scenes
					: [];
				const duration = scenes.reduce(
					(sum: number, s: any) => sum + (s.durationInFrames || 150),
					0,
				);
				return {
					durationInFrames: Math.max(1, duration),
				};
			}}
		/>
	);
};

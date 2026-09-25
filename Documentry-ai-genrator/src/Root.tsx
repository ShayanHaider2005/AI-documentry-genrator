import { Composition } from 'remotion';
import { DocumentaryVideo } from './DocumentaryVideo';
import type { Scene } from './types';

const defaultScenes: Scene[] = [
	{
		sceneNumber: 1,
		narratorText:
			'Every complex software system begins as an abstract architecture, demanding rigorous engineering standards to endure.',
		visualPrompt: 'Cinematic visual of high-tech digital software architecture',
		imageKeyword: 'digital software architecture',
		imageUrl:
			'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1920&q=80',
		audioPath: 'audio/scene-1.mp3',
		durationInFrames: 210,
	},
	{
		sceneNumber: 2,
		narratorText:
			'Quality is not an accidental triumph, but the deliberate outcome of structured testing and continuous verification.',
		visualPrompt: 'Automated software testing matrix and data flow',
		imageKeyword: 'software testing matrix',
		imageUrl:
			'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1920&q=80',
		audioPath: 'audio/scene-2.mp3',
		durationInFrames: 240,
	},
];

const totalDurationInFrames = defaultScenes.reduce(
	(totalDuration, scene) => totalDuration + scene.durationInFrames,
	0,
);

export const RemotionRoot = () => {
	return (
		<Composition<any, any>
			id="Documentary"
			component={DocumentaryVideo}
			fps={30}
			width={1920}
			height={1080}
			durationInFrames={Math.max(1, totalDurationInFrames)}
			defaultProps={defaultScenes}
			calculateMetadata={({ props }: { props: any }) => {
				const scenes: Scene[] = Array.isArray(props)
					? props
					: props?.scenes && Array.isArray(props.scenes)
					? props.scenes
					: defaultScenes;
				const duration = scenes.reduce(
					(sum: number, s: any) => sum + (s.durationInFrames || 150),
					0,
				);
				return {
					durationInFrames: Math.max(1, duration),
					props: Array.isArray(props) ? { scenes: props } : props,
				};
			}}
		/>
	);
};

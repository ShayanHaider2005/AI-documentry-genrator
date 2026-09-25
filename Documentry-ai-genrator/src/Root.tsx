import { Composition } from 'remotion';
import { DocumentaryVideo } from './DocumentaryVideo';
import type { Scene } from './types';
import generatedScenes from './dataset.json';

const defaultScenes: Scene[] = generatedScenes;

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

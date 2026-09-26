import { Composition } from 'remotion';
import type { AnyZodObject } from 'remotion';
import { DocumentaryVideo } from './DocumentaryVideo';
import type { DocumentaryProps, Scene } from './types';
import generatedScenes from './dataset.json';

const FPS = 30;
const MIN_DURATION_IN_FRAMES = 30;
const DEFAULT_SCENE_DURATION_IN_FRAMES = 150;

/** Runtime dataset — a plain array of scenes produced by the backend pipeline. */
const dataset: Scene[] = generatedScenes;

/** Remotion requires `defaultProps` to be a key-value object, never a raw array. */
const defaultProps: DocumentaryProps = { scenes: dataset };

const sumSceneFrames = (scenes: Scene[]): number =>
	scenes.reduce(
		(total, scene) =>
			total + (scene.durationInFrames || DEFAULT_SCENE_DURATION_IN_FRAMES),
		0,
	);

const totalFrames = sumSceneFrames(dataset);

export const RemotionRoot = () => {
	return (
		<Composition<AnyZodObject, DocumentaryProps>
			id="Documentary"
			component={DocumentaryVideo}
			fps={FPS}
			width={1920}
			height={1080}
			durationInFrames={Math.max(totalFrames, MIN_DURATION_IN_FRAMES)}
			defaultProps={defaultProps}
			calculateMetadata={({ props }) => {
				const scenes: Scene[] =
					Array.isArray(props?.scenes) && props.scenes.length > 0
						? props.scenes
						: dataset;

				return {
					durationInFrames: Math.max(
						sumSceneFrames(scenes),
						MIN_DURATION_IN_FRAMES,
					),
					props: { scenes },
				};
			}}
		/>
	);
};

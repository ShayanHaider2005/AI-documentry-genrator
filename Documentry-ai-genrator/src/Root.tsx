import { Composition } from 'remotion';
import type { AnyZodObject } from 'remotion';
import { DocumentaryVideo } from './DocumentaryVideo';
import type { DocumentaryProps, Scene } from './types';
import generatedScenes from './dataset.json';

const FPS = 30;
const MIN_DURATION_IN_FRAMES = 30;
const DEFAULT_SCENE_DURATION_IN_FRAMES = 150;

/**
 * Runtime dataset — a plain array of scenes produced by the backend pipeline.
 * Cast at the import boundary: TypeScript widens JSON string fields (e.g.
 * `imageSource`) to `string`, which would not match the narrow union on Scene.
 */
const dataset = generatedScenes as Scene[];

/** Remotion requires `defaultProps` to be a key-value object, never a raw array. */
const defaultProps: DocumentaryProps = { scenes: dataset };

const sumSceneFrames = (scenes: Scene[]): number =>
	scenes.reduce(
		(total, scene) =>
			total + (scene.durationInFrames || DEFAULT_SCENE_DURATION_IN_FRAMES),
		0,
	);

const totalFrames = sumSceneFrames(dataset);

/**
 * Pull the scenes out of whatever shape the props arrived in.
 *
 * The backend writes a raw array to the session's dataset.json and passes it
 * with `--props`, while `defaultProps` is `{scenes: [...]}`. Reading only
 * `props.scenes` therefore missed every server render and silently substituted
 * the bundled dataset — so "render" produced the same stale video from an old
 * session, usually with no narration, instead of the one just generated.
 *
 * Accepts both shapes, and only falls back to the bundled dataset when there is
 * genuinely nothing to render.
 */
export const resolveScenes = (props: unknown): Scene[] => {
	const candidate =
		(props as { scenes?: unknown } | null)?.scenes ??
		(Array.isArray(props) ? props : undefined);

	if (Array.isArray(candidate) && candidate.length > 0) {
		return candidate as Scene[];
	}
	return dataset;
};

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
				const scenes = resolveScenes(props);

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

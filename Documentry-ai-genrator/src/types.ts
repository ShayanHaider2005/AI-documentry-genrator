export interface WordTiming {
	word: string;
	startFrame: number;
	endFrame: number;
}

export interface Scene {
	sceneNumber: number;
	narratorText: string;
	visualPrompt: string;
	imageKeyword: string;
	imageUrl: string;
	audioPath: string;
	durationInFrames: number;
	/** Short chapter heading rendered above the caption (optional). */
	title?: string;
	/** Short category chip rendered in the header (optional). */
	badge?: string;
	/**
	 * Frame-accurate word timings (relative to the start of the scene) used for
	 * progressive highlighting. Produced by the TTS step; when absent the
	 * renderer estimates them proportionally.
	 */
	wordTimings?: WordTiming[];
	id?: string;
}

/**
 * Props contract for the composition. Declared as a type alias (not an interface)
 * so it satisfies Remotion's `Record<string, unknown>` constraint.
 */
export type DocumentaryProps = {
	scenes?: Scene[];
};

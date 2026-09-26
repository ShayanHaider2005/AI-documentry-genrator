export interface WordTiming {
	word: string;
	startFrame: number;
	endFrame: number;
}

/**
 * Normalised region of a visual (0..1, origin top-left) that the narrator is
 * describing. Drives the highlight box and the animated pointer.
 */
export interface FocusArea {
	x: number;
	y: number;
	w: number;
	h: number;
	label?: string;
	/** Fraction of the scene (0..1) at which the pointer arrives here. */
	focus?: number;
}

/**
 * One "beat" of a scene: a distinct visual plus the region the narrator is
 * pointing at while that visual is on screen. A scene is a sequence of beats,
 * each anchored to a word so the image and the pointer change in time with the
 * speech.
 */
export interface SceneBeat {
	imageUrl: string;
	imageSource?: 'pexels' | 'document-diagram';
	visualPrompt?: string;
	imageKeyword?: string;
	/** Where the pointer sits on this beat's visual. */
	focusArea?: FocusArea;
	/** Callout label shown beside the pointer. */
	label?: string;
	/** Index into the scene's narratorText where this beat begins. */
	startWord?: number;
	/**
	 * Alternative to `startWord`: the word itself at which this beat starts.
	 * Preferred for LLM output because it survives rewording.
	 */
	atWord?: string;
}

export interface Scene {
	sceneNumber: number;
	narratorText: string;
	visualPrompt: string;
	imageKeyword: string;
	imageUrl: string;
	audioPath: string;
	durationInFrames: number;
	/** Where the visual came from: a contextual photo or a document diagram. */
	imageSource?: 'pexels' | 'document-diagram';
	/**
	 * Per-beat visuals. When present the renderer swaps image and pointer on each
	 * beat boundary; otherwise the scene uses the single `imageUrl`/`focusArea`.
	 */
	beats?: SceneBeat[];
	/** Highlight target(s) for the animated pointer overlay. */
	focusArea?: FocusArea | FocusArea[];
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

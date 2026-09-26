export interface WordTiming {
	word: string;
	startFrame: number;
	endFrame: number;
}

/**
 * Normalised region of the visual (0..1, origin top-left) that the narrator is
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

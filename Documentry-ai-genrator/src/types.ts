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
	id?: string;
}

/**
 * Props contract for the composition. Declared as a type alias (not an interface)
 * so it satisfies Remotion's `Record<string, unknown>` constraint.
 */
export type DocumentaryProps = {
	scenes?: Scene[];
};

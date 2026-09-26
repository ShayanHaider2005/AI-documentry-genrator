import type { Scene, WordTiming } from './types';

const MIN_WORD_FRAMES = 2;

/**
 * Weight a word by its length and punctuation so the estimate drifts far less
 * than a plain "characters per frame" split. Mirrors the proportional
 * estimator in server/tts.js — keep the two in sync.
 */
const wordWeight = (word: string): number => {
	let weight = Math.max(1, word.length);
	if (/[,;:]$/.test(word)) weight += 3;
	if (/[.!?]$/.test(word)) weight += 6;
	return weight;
};

const estimateWordTimings = (
	text: string,
	durationInFrames: number,
): WordTiming[] => {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];

	const weights = words.map(wordWeight);
	const totalWeight = weights.reduce((sum, value) => sum + value, 0);
	if (totalWeight <= 0) return [];

	let cursor = 0;
	return words.map((word, index) => {
		const share = Math.max(
			MIN_WORD_FRAMES,
			Math.round((weights[index] / totalWeight) * durationInFrames),
		);
		const startFrame = Math.min(cursor, durationInFrames);
		const endFrame =
			index === words.length - 1
				? durationInFrames
				: Math.min(durationInFrames, startFrame + share);
		cursor = endFrame;
		return { word, startFrame, endFrame };
	});
};

const isUsable = (timings: WordTiming[] | undefined): timings is WordTiming[] =>
	Array.isArray(timings) && timings.length > 0;

/**
 * Resolve the word timings for a scene: prefer the timings measured during
 * synthesis, and fall back to a proportional estimate so older datasets still
 * highlight correctly.
 */
export const resolveWordTimings = (scene: Scene): WordTiming[] => {
	const durationInFrames = Math.max(1, scene.durationInFrames || 1);

	if (isUsable(scene.wordTimings)) {
		return scene.wordTimings.map((timing) => ({
			word: timing.word,
			startFrame: Math.max(0, Math.min(timing.startFrame, durationInFrames)),
			endFrame: Math.max(
				Math.min(timing.endFrame, durationInFrames),
				Math.min(timing.startFrame, durationInFrames) + 1,
			),
		}));
	}

	return estimateWordTimings(scene.narratorText, durationInFrames);
};

export type WordState = 'todo' | 'current' | 'done';

/** Classify every word of a scene relative to the current scene-relative frame. */
export const resolveWordStates = (
	timings: WordTiming[],
	frame: number,
): WordState[] =>
	timings.map((timing) => {
		if (frame >= timing.endFrame) return 'done';
		if (frame >= timing.startFrame) return 'current';
		return 'todo';
	});

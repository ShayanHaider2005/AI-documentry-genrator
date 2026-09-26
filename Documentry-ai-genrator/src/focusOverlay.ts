import type { FocusArea, Scene, SceneBeat, WordTiming } from './types';

const clamp01 = (value: number | undefined, fallback = 0) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(1, Math.max(0, parsed));
};

const easeInOut = (progress: number) =>
	progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

/** A focus target with its arrival time resolved to a definite number. */
type ResolvedArea = FocusArea & { focus: number };

/**
 * A beat that is ready to render: its visual, its highlight region, and the
 * scene-relative frame at which it takes over.
 */
export interface ResolvedBeat {
	imageUrl: string;
	label: string;
	area: ResolvedArea | null;
	/** Frame (scene-relative) at which this beat becomes active. */
	startFrame: number;
}

const normalizeArea = (raw: FocusArea | undefined): ResolvedArea | null => {
	if (!raw) return null;
	const x = clamp01(raw.x);
	const y = clamp01(raw.y);
	const w = Number(raw.w);
	const h = Number(raw.h);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
	return {
		x,
		y,
		w: Math.min(1 - x, Math.max(0.03, w)),
		h: Math.min(1 - y, Math.max(0.03, h)),
		label: raw.label ?? '',
		focus: clamp01(raw.focus, 0.3),
	};
};

/** The raw beats of a scene, falling back to the scene's single visual. */
const rawBeats = (scene: Scene): SceneBeat[] => {
	if (Array.isArray(scene.beats) && scene.beats.length > 0) {
		return scene.beats;
	}
	if (Array.isArray(scene.focusArea)) {
		return scene.focusArea.map((area) => ({
			imageUrl: scene.imageUrl,
			imageSource: scene.imageSource,
			focusArea: area,
			label: area.label,
		}));
	}
	return [
		{
			imageUrl: scene.imageUrl,
			imageSource: scene.imageSource,
			focusArea: normalizeArea(scene.focusArea as FocusArea | undefined) ?? undefined,
		},
	];
};

/**
 * Resolve the frame at which `beat` takes over.
 *
 * Preference order:
 *  1. `startWord` — an index into the measured word timings (exact).
 *  2. `atWord`    — matched against the spoken words (survives rewording).
 *  3. Even split  — last-resort fallback so a beat is never unscheduled.
 */
const beatStartFrame = (
	beat: SceneBeat,
	timings: WordTiming[],
	durationInFrames: number,
	fallbackFrame: number,
): number => {
	if (timings.length > 0) {
		if (
			Number.isInteger(beat.startWord) &&
			beat.startWord! >= 0 &&
			beat.startWord! < timings.length
		) {
			return clamp01(timings[beat.startWord!].startFrame / durationInFrames) * durationInFrames;
		}

		if (beat.atWord) {
			const needle = beat.atWord.toLowerCase().replace(/[^a-z0-9]/g, '');
			if (needle.length > 2) {
				const hit = timings.findIndex((timing) => {
					const word = timing.word.toLowerCase().replace(/[^a-z0-9]/g, '');
					// exact, then prefix match (handles plurals/inflections)
					return word === needle || word.startsWith(needle) || needle.startsWith(word);
				});
				if (hit > 0) {
					return (
						clamp01(timings[hit].startFrame / durationInFrames) * durationInFrames
					);
				}
			}
		}
	}

	return fallbackFrame;
};

/**
 * Resolve every beat of a scene into render-ready data, ordered by start frame.
 * This is what synchronises the visual changes and the pointer to the speech.
 */
export const resolveBeats = (scene: Scene): ResolvedBeat[] => {
	const duration = Math.max(1, scene.durationInFrames || 1);
	const timings = Array.isArray(scene.wordTimings) ? scene.wordTimings : [];
	const beats = rawBeats(scene);

	const resolved = beats.map((beat, index) => {
		const evenFrame = Math.round((index / beats.length) * duration);
		return {
			imageUrl: beat.imageUrl || scene.imageUrl,
			label: beat.label ?? beat.focusArea?.label ?? '',
			area: normalizeArea(beat.focusArea),
			startFrame: beatStartFrame(beat, timings, duration, evenFrame),
		};
	});

	resolved.sort((a, b) => a.startFrame - b.startFrame);

	// The first beat must own the opening frame, and beats must not collide.
	resolved[0].startFrame = 0;
	for (let i = 1; i < resolved.length; i++) {
		const minimum = resolved[i - 1].startFrame + 1;
		if (resolved[i].startFrame < minimum) {
			resolved[i].startFrame = minimum;
		}
	}

	return resolved;
};

/** Index of the beat that should be on screen at `frame`. */
export const activeBeatIndex = (beats: ResolvedBeat[], frame: number): number => {
	let index = 0;
	for (let i = 0; i < beats.length; i++) {
		if (frame >= beats[i].startFrame) index = i;
		else break;
	}
	return index;
};

/** Frames spent cross-fading between two visuals. */
const CROSSFADE_FRAMES = 6;

/**
 * Opacities for the outgoing and incoming visual around a beat boundary, so the
 * image changes smoothly instead of popping.
 */
export const beatCrossfade = (
	beats: ResolvedBeat[],
	beatIndex: number,
	frame: number,
): { previousOpacity: number; currentOpacity: number; previousIndex: number } => {
	if (beatIndex === 0) {
		return { previousOpacity: 0, currentOpacity: 1, previousIndex: -1 };
	}

	const start = beats[beatIndex].startFrame;
	const elapsed = frame - start;

	if (elapsed >= CROSSFADE_FRAMES) {
		return { previousOpacity: 0, currentOpacity: 1, previousIndex: -1 };
	}

	const t = easeInOut(clamp01(elapsed / CROSSFADE_FRAMES, 0));
	return {
		previousOpacity: 1 - t,
		currentOpacity: t,
		previousIndex: beatIndex - 1,
	};
};

/** Frames the pointer takes to travel between two targets. */
const TRAVEL_FRAMES = 12;

/** Where the pointer should be for the active beat, plus its travel progress. */
export const resolvePointerState = (
	beat: ResolvedBeat,
	frame: number,
): { area: FocusArea; progress: number; settled: boolean } | null => {
	const area = beat.area;
	if (!area) return null;

	// Fly in from below on the first beat of the scene.
	if (beat.startFrame === 0) {
		const ENTRY_FRAMES = 10;
		if (frame < ENTRY_FRAMES) {
			return {
				area: { ...area, y: area.y + (1.08 - area.y) * (1 - easeInOut(frame / ENTRY_FRAMES)) },
				progress: easeInOut(frame / ENTRY_FRAMES),
				settled: false,
			};
		}
	}

	// Travel in from the previous beat's region when the visual changes.
	const sinceStart = frame - beat.startFrame;
	if (sinceStart >= 0 && sinceStart < TRAVEL_FRAMES) {
		return {
			area: { ...area },
			progress: easeInOut(sinceStart / TRAVEL_FRAMES),
			settled: sinceStart >= TRAVEL_FRAMES - 2,
		};
	}

	return { area: { ...area }, progress: 1, settled: true };
};

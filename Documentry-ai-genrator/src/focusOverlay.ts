import type { FocusArea, Scene } from './types';

const clamp01 = (value: number | undefined, fallback = 0) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(1, Math.max(0, parsed));
};

/** A focus target with its arrival time resolved to a definite number. */
type ResolvedArea = FocusArea & { focus: number };

const easeInOut = (progress: number) =>
	progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

/** Normalize the dataset's focusArea into an ordered list of targets. */
export const resolveFocusAreas = (scene: Scene): ResolvedArea[] => {
	const raw = scene.focusArea;
	const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

	const usable = list.filter(
		(area) =>
			area &&
			Number.isFinite(area.x) &&
			Number.isFinite(area.y) &&
			Number.isFinite(area.w) &&
			Number.isFinite(area.h) &&
			area.w > 0 &&
			area.h > 0,
	);

	if (usable.length === 0) return [];

	return usable.map((area, index): ResolvedArea => {
		const x = clamp01(area.x);
		const y = clamp01(area.y);
		return {
			x,
			y,
			w: Math.min(1 - x, Math.max(0.03, area.w)),
			h: Math.min(1 - y, Math.max(0.03, area.h)),
			label: area.label ?? '',
			// Guarantee a sensible arrival time even if the model omits it.
			focus:
				usable.length === 1
					? clamp01(area.focus, 0.3)
					: index / (usable.length - 1 || 1),
		};
	});
};

/** Frames the pointer takes to travel between two targets. */
const TRAVEL_FRAMES = 12;

interface PointerState {
	area: ResolvedArea;
	/** 0..1 travel progress into this target. */
	progress: number;
	/** True once the pointer has settled on this target. */
	settled: boolean;
}

/**
 * Walk the focus targets across the scene.
 *
 * The pointer travels to each target and holds there while the narrator
 * explains that part, so the viewer always sees *which* element is being
 * discussed. Returns null before the pointer enters the frame.
 */
export const resolvePointerState = (
	areas: ResolvedArea[],
	frame: number,
	durationInFrames: number,
): PointerState | null => {
	if (areas.length === 0) return null;

	const duration = Math.max(1, durationInFrames);

	// The pointer flies in from off-frame during the opening beat.
	const ENTRY_FRAMES = 10;
	if (frame < ENTRY_FRAMES) {
		return {
			area: { ...areas[0], x: areas[0].x, y: 1.08 },
			progress: easeInOut(frame / ENTRY_FRAMES),
			settled: false,
		};
	}

	for (let index = 0; index < areas.length; index++) {
		const arriveFrame = areas[index].focus * duration;

		if (frame < arriveFrame) {
			// Travelling towards this target from the previous one.
			const from = index === 0 ? { x: areas[0].x, y: 1.08 } : areas[index - 1];
			const travel = Math.max(1, arriveFrame - TRAVEL_FRAMES);
			const raw = Math.min(1, Math.max(0, (frame - (travel - TRAVEL_FRAMES)) / TRAVEL_FRAMES));
			const t = easeInOut(raw);
			return {
				area: {
					...areas[index],
					x: from.x + (areas[index].x - from.x) * t,
					y: from.y + (areas[index].y - from.y) * t,
				},
				progress: t,
				settled: false,
			};
		}

		// Check whether the next target takes over before this one releases.
		const next = areas[index + 1];
		if (next) {
			const nextArrive = next.focus * duration;
			if (frame < nextArrive - TRAVEL_FRAMES) {
				return { area: areas[index], progress: 1, settled: true };
			}
		}
	}

	return { area: areas[areas.length - 1], progress: 1, settled: true };
};

/**
 * botAudioContext.ts — the one AudioContext, and the two gain buses off it.
 *
 * Split out of botAudio.ts so the ambient bed and the one-shot effects share a
 * single context and a single mute state, while remaining structurally
 * independent: nothing that stops a sound effect can reach the ambient bus.
 *
 * Two contexts would be a real bug. Browsers cap the number of live AudioContexts
 * (Chrome around six), and a second one is suspended until its own gesture, so
 * the ambient loop could silently never start.
 */

const CONTEXT_KEY = '__docubotAudioContext';
const SFX_BUS_KEY = '__docubotSfxBus';
const MUTE_KEY = 'docubot.sound';

let muted = readMuted();
const listeners = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
	try {
		const stored = localStorage.getItem(MUTE_KEY);
		if (stored === 'muted') return true;
		if (stored === 'on') return false;
	} catch {
		/* private mode, or storage blocked */
	}
	// Default off. Unsolicited sound on navigation is hostile, and a user who
	// muted once should stay muted across reloads.
	return true;
}

export const isMuted = (): boolean => muted;

export const onMuteChange = (fn: (muted: boolean) => void): (() => void) => {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
};

export const setMuted = (next: boolean): void => {
	muted = next;
	try {
		localStorage.setItem(MUTE_KEY, next ? 'muted' : 'on');
	} catch {
		/* the session still respects it */
	}
	for (const fn of listeners) fn(next);
};

export const toggleMuted = (): boolean => {
	setMuted(!muted);
	return muted;
};

/**
 * The shared context, or null.
 *
 * Created lazily. Browsers refuse to start audio before a user gesture, so this
 * returns null in that case rather than throwing — a suspended context is
 * resumed on the next call, which is what makes the first interaction enough.
 */
export const getContext = (): AudioContext | null => {
	if (typeof window === 'undefined') return null;

	const existing = (window as unknown as Record<string, AudioContext>)[CONTEXT_KEY];
	if (existing) {
		if (existing.state === 'suspended') void existing.resume();
		return existing;
	}

	const Ctor =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;

	try {
		const created = new Ctor();
		(window as unknown as Record<string, AudioContext>)[CONTEXT_KEY] = created;
		return created;
	} catch {
		return null;
	}
};

/**
 * The bus one-shot effects go through.
 *
 * Cutting the voices attached to this bus is what stops an SFX. Because the
 * ambient bed is wired to a different bus, that operation cannot touch it.
 */
export const sfxBus = (): GainNode | null => {
	const ctx = getContext();
	if (!ctx) return null;

	const existing = (window as unknown as Record<string, GainNode>)[SFX_BUS_KEY];
	if (existing) return existing;

	try {
		const bus = ctx.createGain();
		bus.gain.setValueAtTime(1, ctx.currentTime);
		bus.connect(ctx.destination);
		(window as unknown as Record<string, GainNode>)[SFX_BUS_KEY] = bus;
		return bus;
	} catch {
		return null;
	}
};

/** Is a usable AudioContext available in this browser at all? */
export const audioSupported = (): boolean =>
	typeof window !== 'undefined' &&
	Boolean(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);

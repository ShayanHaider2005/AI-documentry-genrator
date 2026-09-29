/**
 * botAudio.ts — DocuBot's sound effects, synthesised in the browser.
 *
 * Everything here is generated with the Web Audio API. There are no audio
 * files, so nothing to download, cache, or fail to load.
 *
 * On what this actually sounds like
 * ---------------------------------
 * Each effect is a pitched, filtered, pitch-modulated robotic chirp. That is a
 * deliberate limit, not a shortcut: saying the words "DOC-U-BOT!" as speech
 * would need either the SpeechSynthesis API (unreliable across platforms,
 * with a different voice on every OS and no control over timbre) or recorded
 * audio. This produces a consistent, characterful, tunable voice everywhere.
 * It is a cartoon robot making a noise, not a talking robot. If you want
 * literal speech, that is a different feature and worth saying so out loud.
 *
 * Autoplay rules
 * --------------
 * Browsers refuse to start audio before a user gesture, and rightly so. The
 * context is created lazily on the first gesture, and `play()` is a no-op if
 * that has not happened yet rather than throwing.
 *
 * Sound is off by default and the choice is remembered. Unsolicited audio on
 * page navigation is hostile, and a user who muted once should stay muted.
 */

export type Emotion = 'default' | 'happy' | 'giggle' | 'shocked' | 'love' | 'dizzy';

const STORAGE_KEY = 'docubot.sound';
const CONTEXT_KEY = '__docubotAudioContext';

/** Read by the UI to show the right icon. */
let muted = true;
const listeners = new Set<(muted: boolean) => void>();

const readStoredMuted = (): boolean => {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'muted') return true;
		if (stored === 'on') return false;
	} catch {
		/* private mode, or storage disabled */
	}
	return true; // default: off
};

muted = readStoredMuted();

export const isMuted = () => muted;

/** Subscribe to mute changes. Returns an unsubscribe function. */
export const onMuteChange = (fn: (muted: boolean) => void): (() => void) => {
	listeners.add(fn);
	return () => listeners.delete(fn);
};

export const setMuted = (next: boolean) => {
	muted = next;
	try {
		localStorage.setItem(STORAGE_KEY, next ? 'muted' : 'on');
	} catch {
		/* nothing to do; the session still respects it */
	}
	for (const fn of listeners) fn(next);
};

export const toggleMuted = (): boolean => {
	setMuted(!muted);
	return muted;
};

/**
 * The shared AudioContext.
 *
 * Kept on the window object so a second call before the first is still
 * resolving reuses the same context. Creating two would leave one of them
 * suspended forever.
 */
const context = (): AudioContext | null => {
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

/** One voice: an oscillator through a filter, with its own envelope. */
interface Voice {
	/** Oscillators, stopped and disconnected when the note ends. */
	stop: () => void;
}

/**
 * Play one note.
 *
 * @param ctx      the shared context
 * @param at       when to start, in context time
 * @param duration seconds
 * @param from     start frequency, Hz
 * @param to       end frequency, Hz (equal to `from` for a steady tone)
 * @param gain     peak gain, 0-1
 * @param wave     oscillator type
 * @param cutoff   low-pass cutoff, Hz; gives the tone a body rather than a buzz
 */
const note = (
	ctx: AudioContext,
	at: number,
	duration: number,
	from: number,
	to: number,
	gain: number,
	wave: OscillatorType = 'square',
	cutoff = 2600,
): Voice => {
	const osc = ctx.createOscillator();
	const filter = ctx.createBiquadFilter();
	const amp = ctx.createGain();

	osc.type = wave;
	osc.frequency.setValueAtTime(Math.max(20, from), at);
	// Exponential ramps cannot reach zero, so the target is floored.
	osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + duration);

	filter.type = 'lowpass';
	filter.frequency.setValueAtTime(cutoff, at);
	filter.Q.value = 6;

	// A short attack and a longer release: a hard gate sounds like a click.
	amp.gain.setValueAtTime(0.0001, at);
	amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.012);
	amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

	osc.connect(filter).connect(amp).connect(ctx.destination);
	osc.start(at);
	osc.stop(at + duration + 0.05);

	return {
		stop: () => {
			try {
				osc.stop();
			} catch {
				/* already stopped */
			}
			osc.disconnect();
			filter.disconnect();
			amp.disconnect();
		},
	};
};

/**
 * A pitch wobble, for the dizzy effect.
 *
 * An LFO on the oscillator frequency, which is what makes it read as "wobbling"
 * rather than as a slide.
 */
const wobble = (
	ctx: AudioContext,
	at: number,
	duration: number,
	frequency: number,
	gain: number,
	depth = 90,
	rate = 11,
): Voice => {
	const osc = ctx.createOscillator();
	const filter = ctx.createBiquadFilter();
	const amp = ctx.createGain();
	const lfo = ctx.createOscillator();
	const lfoDepth = ctx.createGain();

	osc.type = 'sine';
	osc.frequency.setValueAtTime(frequency, at);

	lfo.type = 'sine';
	lfo.frequency.setValueAtTime(rate, at);
	lfoDepth.gain.setValueAtTime(depth, at);
	lfo.connect(lfoDepth).connect(osc.frequency);

	filter.type = 'lowpass';
	filter.frequency.setValueAtTime(2200, at);
	filter.Q.value = 8;

	amp.gain.setValueAtTime(0.0001, at);
	amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.02);
	amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

	osc.connect(filter).connect(amp).connect(ctx.destination);
	osc.start(at);
	lfo.start(at);
	osc.stop(at + duration + 0.05);
	lfo.stop(at + duration + 0.05);

	return {
		stop: () => {
			try {
				osc.stop();
				lfo.stop();
			} catch {
				/* already stopped */
			}
			[osc, lfo, filter, amp, lfoDepth].forEach((node) => node.disconnect());
		},
	};
};

/**
 * A burst of filtered noise, for the glitch/slap effect.
 *
 * Generated into a buffer rather than looping a sample: a two-second buffer
 * costs nothing and gives the glitch some grain.
 */
const noiseBurst = (
	ctx: AudioContext,
	at: number,
	duration: number,
	gain: number,
): Voice => {
	const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
	const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < frames; i += 1) {
		// Decaying white noise: sharp onset, quick fall.
		data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
	}

	const source = ctx.createBufferSource();
	const filter = ctx.createBiquadFilter();
	const amp = ctx.createGain();

	source.buffer = buffer;
	filter.type = 'bandpass';
	// Sweeping the band upward is what makes it read as a glitch rather than a thud.
	filter.frequency.setValueAtTime(400, at);
	filter.frequency.exponentialRampToValueAtTime(4200, at + duration);
	filter.Q.value = 3;

	amp.gain.setValueAtTime(gain, at);
	amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

	source.connect(filter).connect(amp).connect(ctx.destination);
	source.start(at);

	return {
		stop: () => {
			try {
				source.stop();
			} catch {
				/* already stopped */
			}
			source.disconnect();
			filter.disconnect();
			amp.disconnect();
		},
	};
};

/* -------------------------------------------------------------------------- */
/* The six effects                                                            */
/* -------------------------------------------------------------------------- */

/** Sequences, in seconds from `t`, for a two-syllable robotic call. */
const call = (
	ctx: AudioContext,
	t: number,
	base: number,
	gain: number,
	wave: OscillatorType,
	syllables: Array<[number, number, number, number]>,
): Voice[] =>
	syllables.map(([offset, duration, from, to]) =>
		note(ctx, t + offset, duration, from, to, gain, wave),
	);

const EFFECTS: Record<Emotion, (ctx: AudioContext, t: number) => Voice[]> = {
	/** Page switch: a short, bright two-note chirp. The one you hear most. */
	default: (ctx, t) => [
		note(ctx, t, 0.09, 720, 980, 0.14, 'square', 3000),
		note(ctx, t + 0.1, 0.13, 980, 1240, 0.12, 'square', 3400),
	],

	/** Pat: a cheerful double chirp, the same shape but a third higher. */
	happy: (ctx, t) => [
		note(ctx, t, 0.08, 880, 1180, 0.15, 'square', 3200),
		note(ctx, t + 0.09, 0.07, 1180, 1320, 0.12, 'square', 3400),
		note(ctx, t + 0.18, 0.16, 1320, 1560, 0.14, 'square', 3600),
	],

	/** Tickle: a rapid stutter, so the accents blur together. */
	giggle: (ctx, t) => {
		const voices: Voice[] = [];
		for (let i = 0; i < 7; i += 1) {
			const at = t + i * 0.062;
			voices.push(note(ctx, at, 0.05, 1180 + (i % 2) * 190, 1420, 0.1, 'square', 3600));
		}
		voices.push(note(ctx, t + 0.5, 0.18, 1180, 1680, 0.12, 'square', 3800));
		return voices;
	},

	/** Slap: a low thump, an upward glitch, and a short cry. */
	shocked: (ctx, t) => [
		note(ctx, t, 0.1, 300, 90, 0.2, 'sawtooth', 1400),
		noiseBurst(ctx, t + 0.02, 0.14, 0.11),
		note(ctx, t + 0.16, 0.14, 420, 1500, 0.14, 'square', 4200),
	],

	/** Kiss: a soft ascending sweep, deliberately gentle. */
	love: (ctx, t) => [
		note(ctx, t, 0.26, 620, 1180, 0.1, 'sine', 2400),
		note(ctx, t + 0.1, 0.3, 780, 1480, 0.08, 'sine', 2600),
		note(ctx, t + 0.22, 0.34, 940, 1760, 0.06, 'sine', 2800),
	],

	/** Poke: a wobbling tone that slowly spins down. */
	dizzy: (ctx, t) => {
		const voices = [
			wobble(ctx, t, 0.62, 560, 0.12, 110, 10),
			// A slow fall underneath, so it reads as losing balance.
			note(ctx, t, 0.6, 620, 300, 0.06, 'triangle', 2000),
		];
		return voices;
	},
};

/** Total length of an effect, so callers can sequence or cancel it. */
const DURATION: Record<Emotion, number> = {
	default: 0.3,
	happy: 0.4,
	giggle: 0.7,
	shocked: 0.34,
	love: 0.6,
	dizzy: 0.7,
};

export const effectDuration = (emotion: Emotion): number => DURATION[emotion] ?? 0.4;

/** Everything currently sounding, so a new effect can cut the last one off. */
let current: Voice[] = [];

/**
 * Play an effect.
 *
 * @param emotion which sound
 * @param opts.interrupt  stop whatever is playing first (default true, so rapid
 *   taps do not pile up into a wall of noise)
 * @returns whether anything was actually played
 */
export const playDocuBotSFX = (
	emotion: Emotion = 'default',
	opts: { interrupt?: boolean } = {},
): boolean => {
	// Muted, or the browser has not seen a gesture yet. Both are normal.
	if (muted || typeof window === 'undefined') return false;

	const ctx = context();
	if (!ctx) return false;

	const { interrupt = true } = opts;
	if (interrupt) {
		for (const voice of current) voice.stop();
		current = [];
	}

	try {
		current = EFFECTS[emotion]?.(ctx, ctx.currentTime + 0.01) ?? [];
	} catch {
		// A suspended context throws on scheduling. Silently doing nothing is
		// better than a sound effect breaking a click handler.
		current = [];
		return false;
	}

	// Let finished voices fall out of the list so it does not grow forever.
	window.setTimeout(
		() => {
			current = current.filter((voice) => voice);
		},
		(DURATION[emotion] ?? 0.4) * 1000 + 400,
	);

	return current.length > 0;
};

/** Stop everything immediately. */
export const stopAllSFX = () => {
	for (const voice of current) voice.stop();
	current = [];
};

/**
 * Warm the context up on the first user gesture.
 *
 * Safari in particular will not resume an AudioContext created outside a
 * gesture, so this is called from a click handler at app start.
 */
export const primeAudio = (): void => {
	if (muted) return;
	context();
};

export const EMOTIONS: Emotion[] = ['default', 'happy', 'giggle', 'shocked', 'love', 'dizzy'];

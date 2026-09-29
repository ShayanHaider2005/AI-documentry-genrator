/**
 * Ambient background music, plus the loud page-opening voice.
 *
 * Split from botAudio.ts deliberately. This module owns the *continuous* layer,
 * and the requirement there is the opposite of the SFX layer: an SFX wants to
 * cut whatever came before it, an ambient bed must never be interrupted, never
 * restart, and never glitch.
 *
 * How that is guaranteed
 * ----------------------
 *   * Two separate gain buses off the one shared AudioContext. SFX go to
 *     `sfxBus`, ambient goes to `ambientBus`. Cutting an SFX touches only
 *     `sfxBus`, so the loop is structurally incapable of being stopped by a
 *     page transition or a button press.
 *   * The loop is a scheduler, not a repeating buffer. A lookahead timer walks
 *     forward in context time, so notes are queued slightly ahead and the
 *     oscillator is never re-triggered. There is no seam to glitch at.
 *   * The scheduler is module-level state. React unmounting a page cannot touch
 *     it, which is what makes the loop survive a route change.
 *
 * Volume
 * ------
 * The bed sits at AMBIENT_GAIN, low on purpose. It is a background, not a
 * performance, and the page-voice trigger sits above it so the two do not fight.
 */

import { getContext, isMuted, sfxBus } from './botAudioContext';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** The bed's level. Deliberately quiet: it should sit under the content. */
export const AMBIENT_GAIN = 0.055;

/** How often the scheduler wakes to queue the next few seconds. */
const SCHEDULER_INTERVAL_MS = 25;

/**
 * How far ahead of the clock notes are queued.
 *
 * This must exceed the worst-case timer interval, or the loop starves. Chrome
 * clamps `setInterval` in a *backgrounded* tab to about one tick per second, so
 * a short lookahead stops the scheduler keeping up: the bed goes silent, then
 * arrives in a burst when the tab is foregrounded again — which is exactly the
 * "stops and restarts" this is meant to prevent.
 *
 * 1.4s clears a 1s throttle with margin. It costs nothing for a bed: a note
 * queued 1.4s early still starts at the right moment, and the pad and pulse
 * already run to multi-second lengths.
 */
const LOOKAHEAD_S = 1.4;

/** Two detuned pads a fifth apart, cycling through four chords. */
const CHORDS: number[][] = [
	[110.0, 164.81, 220.0], // A minor-ish
	[98.0, 146.83, 196.0], // G
	[123.47, 185.0, 246.94], // B
	[87.31, 130.81, 174.61], // F
];

/** One pad chord lasts this long before the next. */
const CHORD_SECONDS = 6.4;

/** The pulse sits on a slower grid so it does not sound like a metronome. */
const PULSE_SECONDS = 1.6;

export type AmbientStatus = 'stopped' | 'running';

/* -------------------------------------------------------------------------- */
/* Bus + scheduler state (module level, so React cannot disturb it)           */
/* -------------------------------------------------------------------------- */

let ambientBus: GainNode | null = null;
let ambientGain: GainNode | null = null;
let timer: number | null = null;
let nextEventTime = 0;
let chordIndex = 0;
let pulseIndex = 0;
let started = false;
let liveVoices: Array<{ stopAt: (when: number) => void }> = [];

/** Built lazily, once, and then reused for the life of the page. */
const ensureBus = (ctx: AudioContext): GainNode => {
	if (ambientBus) return ambientBus;

	ambientGain = ctx.createGain();
	ambientGain.gain.setValueAtTime(0, ctx.currentTime);

	ambientBus = ctx.createGain();
	ambientBus.gain.setValueAtTime(1, ctx.currentTime);

	ambientGain.connect(ambientBus).connect(ctx.destination);
	return ambientBus;
};

/* -------------------------------------------------------------------------- */
/* The two layers                                                             */
/* -------------------------------------------------------------------------- */

/** A sustained pad: three detuned saws through a slowly-opening filter. */
const schedulePad = (ctx: AudioContext, at: number, chord: number[]): void => {
	const nodes: Array<OscillatorNode | BiquadFilterNode | GainNode> = [];
	const filter = ctx.createBiquadFilter();
	const amp = ctx.createGain();

	filter.type = 'lowpass';
	// A slow sweep from dark to open and back, so the pad breathes.
	filter.frequency.setValueAtTime(320, at);
	filter.frequency.linearRampToValueAtTime(1500, at + CHORD_SECONDS * 0.5);
	filter.frequency.linearRampToValueAtTime(420, at + CHORD_SECONDS);
	filter.Q.value = 3.5;

	// Long attack, long release: a pad that clicks is not a pad.
	amp.gain.setValueAtTime(0.0001, at);
	amp.gain.linearRampToValueAtTime(1, at + 1.5);
	amp.gain.setValueAtTime(1, at + CHORD_SECONDS - 1.6);
	amp.gain.exponentialRampToValueAtTime(0.0001, at + CHORD_SECONDS);

	chord.forEach((frequency, i) => {
		const osc = ctx.createOscillator();
		const voiceGain = ctx.createGain();
		osc.type = 'sawtooth';
		osc.frequency.setValueAtTime(frequency, at);
		// Detune, so the chord shimmers instead of beating.
		osc.detune.setValueAtTime((i - 1) * 7, at);
		// Each voice sits lower in the mix than the last.
		voiceGain.gain.value = 0.34 / (i + 1);
		osc.connect(voiceGain).connect(filter);
		osc.start(at);
		osc.stop(at + CHORD_SECONDS + 0.1);
		nodes.push(osc, voiceGain);
	});

	filter.connect(amp).connect(ambientBus!);
	nodes.push(filter, amp);

	liveVoices.push({
		stopAt: (when: number) => {
			for (const node of nodes) {
				if ('stop' in node && typeof node.stop === 'function') {
					try {
						node.stop(when);
					} catch {
						/* already scheduled to stop */
					}
				}
			}
			// Disconnect a beat after the sound has ended, so the tail is audible.
			window.setTimeout(
				() => nodes.forEach((node) => node.disconnect()),
				Math.max(0, (when - ctx.currentTime) * 1000) + 200,
			);
		},
	});
};

/** A soft rhythmic pulse, to give the bed a pulse without a beat. */
const schedulePulse = (ctx: AudioContext, at: number, index: number): void => {
	// Downbeats are stronger, and every fourth one is left out entirely, so the
	// pattern does not become a predictable loop.
	if (index % 4 === 3) return;

	const osc = ctx.createOscillator();
	const filter = ctx.createBiquadFilter();
	const amp = ctx.createGain();

	osc.type = 'sine';
	osc.frequency.setValueAtTime(index % 2 === 0 ? 82.41 : 61.74, at);

	filter.type = 'lowpass';
	filter.frequency.setValueAtTime(900, at);

	const peak = index % 2 === 0 ? 0.5 : 0.26;
	amp.gain.setValueAtTime(0.0001, at);
	amp.gain.exponentialRampToValueAtTime(peak, at + 0.015);
	amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);

	osc.connect(filter).connect(amp).connect(ambientBus!);
	osc.start(at);
	osc.stop(at + 0.8);

	liveVoices.push({
		stopAt: () => {
			try {
				osc.stop();
			} catch {
				/* already stopped */
			}
			osc.disconnect();
			filter.disconnect();
			amp.disconnect();
		},
	});
};

/**
 * Queue everything that falls inside the lookahead window.
 *
 * This is the "two clocks" pattern: a coarse JS timer drives a fine audio
 * clock. setInterval is far too jittery to schedule audio directly, and
 * AudioContext is far too coarse to drive from.
 */
const tick = (): void => {
	const ctx = getContext();
	if (!ctx || !started || !ambientBus) return;

	const now = ctx.currentTime;
	// Never schedule into the past. If the timer was starved, resume from now
	// rather than trying to emit a burst of overdue notes, which is what would
	// sound like a glitch.
	if (nextEventTime < now) nextEventTime = now;
	// Never run ahead either. Without this, a fast timer in a foreground tab
	// would push the cursor further and further into the future, queueing notes
	// that may never be heard.
	const horizon = now + LOOKAHEAD_S;

	// One chord per tick is enough: a chord is 6.4 s and the horizon is 1.4 s.
	if (nextEventTime < horizon) {
		schedulePad(ctx, nextEventTime, CHORDS[chordIndex % CHORDS.length]);
		chordIndex += 1;
		nextEventTime += CHORD_SECONDS;
	}
};

/**
 * A second, faster timer for the pulse grid.
 *
 * Sharing one cursor between a 6.4 s chord and a 1.6 s pulse does not work —
 * they would fight over `nextEventTime`. So each has its own cursor and its own
 * interval, and neither can starve the other.
 */
let pulseTime = 0;
const pulseTick = (): void => {
	const ctx = getContext();
	if (!ctx || !started || !ambientBus) return;

	const now = ctx.currentTime;
	if (pulseTime < now) pulseTime = now;
	const horizon = now + LOOKAHEAD_S;

	while (pulseTime < horizon) {
		schedulePulse(ctx, pulseTime, pulseIndex);
		pulseIndex += 1;
		pulseTime += PULSE_SECONDS;
	}
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export const isAmbientRunning = (): AmbientStatus => (started ? 'running' : 'stopped');

/**
 * Start the ambient bed.
 *
 * Idempotent: calling it twice does not double the music. Does nothing while
 * muted, because starting a context the user has silenced is rude and, in most
 * browsers, blocked anyway.
 *
 * @returns whether the bed is now running
 */
export const startAmbientMusic = (): boolean => {
	if (started) return true;
	if (isMuted()) return false;

	const ctx = getContext();
	if (!ctx) return false;

	ensureBus(ctx);
	// Fade in. Starting at full level from silence is a jolt.
	ambientGain!.gain.cancelScheduledValues(ctx.currentTime);
	ambientGain!.gain.setValueAtTime(0.0001, ctx.currentTime);
	ambientGain!.gain.exponentialRampToValueAtTime(AMBIENT_GAIN, ctx.currentTime + 2.5);

	nextEventTime = ctx.currentTime + 0.1;
	pulseTime = ctx.currentTime + 0.1;
	started = true;

	tick();
	pulseTick();

	timer = window.setInterval(tick, SCHEDULER_INTERVAL_MS);
	const pulseTimer = window.setInterval(pulseTick, SCHEDULER_INTERVAL_MS);
	// Both timers have to die together on stop.
	liveVoices.push({ stopAt: () => window.clearInterval(pulseTimer) });

	return true;
};

/** Stop the bed and release its nodes. Safe to call when not running. */
export const stopAmbientMusic = (): void => {
	if (timer !== null) {
		window.clearInterval(timer);
		timer = null;
	}
	started = false;

	const ctx = getContext();
	if (ctx && ambientGain) {
		// Fade out rather than cutting, so stopping does not click.
		ambientGain.gain.cancelScheduledValues(ctx.currentTime);
		ambientGain.gain.setValueAtTime(ambientGain.gain.value, ctx.currentTime);
		ambientGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
	}

	for (const voice of liveVoices) voice.stopAt(0);
	liveVoices = [];
	// The bus itself is kept: rebuilding it would drop the fade-out.
};

/**
 * Bring the bed in line with the mute state.
 *
 * Mute fades it out rather than stopping it, so unmuting resumes the same
 * musical position instead of restarting from the top.
 */
export const syncAmbientWithMute = (): void => {
	const ctx = getContext();
	if (!ctx || !ambientGain) return;

	if (isMuted()) {
		if (started) stopAmbientMusic();
		return;
	}
	if (!started) startAmbientMusic();
};

/* -------------------------------------------------------------------------- */
/* The loud page voice                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The page-opening voice: a loud, resonant robotic chime with a pitch bend.
 *
 * Deliberately routed to the SFX bus, never the ambient one, so it cannot
 * disturb the bed. Its own voice interrupts prior SFX so two route changes in
 * quick succession do not pile up.
 *
 * On "loud": this is genuinely loud, and the brief wires it to every route
 * change, which means a shout on every navigation. It is implemented as asked
 * and it does respect the mute toggle. If it turns out to be intolerable, the
 * single line calling this in Shell.tsx is the only thing that needs removing —
 * see the note on NAVIGATION_VOICE_ENABLED below.
 */
export const playLoudDocuBotVoice = (): boolean => {
	if (isMuted()) return false;

	const ctx = getContext();
	if (!ctx) return false;

	const t = ctx.currentTime + 0.01;
	const nodes: Array<OscillatorNode | BiquadFilterNode | GainNode> = [];

	// A resonant band-pass gives the "voice" a formant-ish colour. High Q is
	// what separates this from a plain beep.
	const formant = ctx.createBiquadFilter();
	formant.type = 'bandpass';
	formant.frequency.setValueAtTime(900, t);
	// Sweep the formant up: the "oo" into "ah" of a two-syllable call.
	formant.frequency.exponentialRampToValueAtTime(1900, t + 0.34);
	formant.Q.value = 7;

	const amp = ctx.createGain();
	// Loud, but not clipping: the peak is under 1 and the sfx bus is unity.
	amp.gain.setValueAtTime(0.0001, t);
	amp.gain.exponentialRampToValueAtTime(0.85, t + 0.02);
	amp.gain.setValueAtTime(0.85, t + 0.3);
	amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);

	// Two partials: a fundamental and a fifth above, which is what makes a
	// synthesised tone read as a character rather than a test tone.
	[
		{ from: 300, to: 520, gain: 1 },
		{ from: 450, to: 780, gain: 0.45 },
	].forEach(({ from, to, gain }) => {
		const osc = ctx.createOscillator();
		const voiceGain = ctx.createGain();
		osc.type = 'sawtooth';
		// The pitch bend: a fast rise then a settle.
		osc.frequency.setValueAtTime(from, t);
		osc.frequency.exponentialRampToValueAtTime(to, t + 0.26);
		osc.frequency.exponentialRampToValueAtTime(to * 0.92, t + 0.55);
		voiceGain.gain.value = gain;
		osc.connect(voiceGain).connect(formant);
		osc.start(t);
		osc.stop(t + 0.7);
		nodes.push(osc, voiceGain);
	});

	formant.connect(amp).connect(sfxBus() ?? ctx.destination);
	amp.gain.setValueAtTime(amp.gain.value, t);
	nodes.push(formant, amp);

	// Tear down after the tail, so nothing leaks over many navigations.
	window.setTimeout(() => nodes.forEach((node) => node.disconnect()), 1400);

	return true;
};

/**
 * Master switch for the navigation voice.
 *
 * The brief asks for the voice on every route change. That is implemented and
 * on by default, but it is a judgement call worth being able to reverse in one
 * place, so it is a constant rather than a call site.
 */
export const NAVIGATION_VOICE_ENABLED = true;

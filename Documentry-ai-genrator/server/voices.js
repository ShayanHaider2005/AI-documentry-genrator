'use strict';

/**
 * voices.js — The generated narrator library.
 *
 * server/voices/make_voice_library.py writes ten reference recordings plus a
 * manifest describing them. This module reads that manifest so the web layer can
 * offer a narrator choice to a user who has not uploaded a sample of their own.
 *
 * The manifest records, per voice, the exact `instruct` string that produced the
 * audio. That matters: OmniVoice's instruct vocabulary is a closed list with no
 * "african accent", so the library is built from accents that genuinely exist and
 * the manifest is the record of which is which. The UI must read the label from
 * here rather than inventing one, or the picker will claim an accent the audio
 * does not have.
 *
 * Reading is tolerant on purpose. A missing library is normal — it has to be
 * generated once — so the app reports it as unavailable instead of failing.
 *
 * Exports:
 *   readVoiceLibrary()  → { available, voices, accents, note }
 *   defaultLibraryVoice() → voiceId or null
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VOICES_DIR = path.join(ROOT, 'server', 'voices');
const DEFAULTS_DIR = path.join(VOICES_DIR, 'defaults');
const MANIFEST = path.join(DEFAULTS_DIR, 'manifest.json');

/** Prefer these when the manifest offers several of a kind. */
const PREFERRED_DEFAULTS = ['male_indian', 'female_indian', 'male_usa', 'female_usa'];

let cache = null;
let cacheStamp = 0;

/** Re-read when the manifest's mtime changes, so a rebuild is picked up live. */
const manifestStamp = () => {
	try {
		return fs.statSync(MANIFEST).mtimeMs;
	} catch {
		return 0;
	}
};

const unavailable = (note) => ({
	available: false,
	voices: [],
	accents: {},
	note: note || 'No narrator library has been generated yet.',
});

/**
 * The library, filtered to voices whose audio is actually on disk.
 *
 * The manifest is the source of truth for labels, but a WAV that has been
 * deleted must not be offered: the failure would only surface minutes later,
 * mid-render, as a synthesis error.
 */
function readVoiceLibrary() {
	const stamp = manifestStamp();
	if (cache && stamp === cacheStamp) return cache;

	if (!stamp) {
		cache = unavailable(
			'No narrator library yet. Run "npm run voice:library" once to build it.',
		);
		cacheStamp = stamp;
		return cache;
	}

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
	} catch (err) {
		cache = unavailable(`The narrator manifest could not be read: ${err.message}`);
		cacheStamp = stamp;
		return cache;
	}

	const voices = (Array.isArray(manifest.voices) ? manifest.voices : [])
		.filter((voice) => voice && voice.voiceId && voice.audioPath)
		.map((voice) => {
			const onDisk = path.isAbsolute(voice.audioPath)
				? voice.audioPath
				: path.join(ROOT, voice.audioPath);
			return {
				voiceId: voice.voiceId,
				name: voice.name || voice.voiceId,
				gender: voice.gender === 'female' ? 'female' : 'male',
				accent: voice.accent || 'other',
				accentLabel: voice.accentLabel || voice.accent || 'Other',
				audioPath: voice.audioPath,
				// Inlined in the manifest, so the transcript survives a missing
				// sidecar and the caller never has to read a second file.
				refText: voice.refText || '',
				instruct: voice.instruct || '',
				seconds: Number(voice.seconds) || 0,
				available: fs.existsSync(onDisk) && Boolean(voice.refText),
			};
		})
		// A voice with no audio, or no transcript, would force Whisper. Hide it
		// rather than offer a slow, lower-quality choice without saying so.
		.filter((voice) => voice.available);

	cache = {
		available: voices.length > 0,
		voices,
		accents: manifest.accents || {},
		note: manifest.note || '',
		sampleRate: manifest.sampleRate || 24000,
	};
	cacheStamp = stamp;
	return cache;
}

/** Which narrator to use when the user has not chosen one. */
function defaultLibraryVoice() {
	const library = readVoiceLibrary();
	if (!library.available) return null;
	for (const preferred of PREFERRED_DEFAULTS) {
		if (library.voices.some((v) => v.voiceId === preferred)) return preferred;
	}
	return library.voices[0].voiceId;
}

/** One voice by id, or null. */
const voiceById = (voiceId) => readVoiceLibrary().voices.find((v) => v.voiceId === voiceId) || null;

module.exports = { readVoiceLibrary, defaultLibraryVoice, voiceById, MANIFEST };

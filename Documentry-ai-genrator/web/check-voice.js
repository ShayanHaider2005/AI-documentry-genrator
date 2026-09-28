'use strict';

/**
 * check-voice.js — prove the local voice service clones a voice end to end.
 *
 * Uploads a reference, then asks the service to speak a known sentence in it
 * twice: once with a real reference (cloning) and once with none (voice design).
 * Verifies the output files exist, are non-empty, and are real audio rather than
 * a container of silence.
 *
 * Run: node web/check-voice.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const omnivoice = require('../server/omnivoice');
const { VOICE_SAMPLE_SCRIPT } = require('../server/tts');

const SENTENCE =
	'The quality of a system is never an accident, it is engineered one careful decision at a time.';

const REPO = path.join(__dirname, '..');
const OUT_DIR = path.join(os.tmpdir(), 'docubot-voice-check');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

function findReference() {
	// Prefer a real narration clip, then the bundled default narrator.
	const candidates = [
		path.join(REPO, 'server', 'voices', 'south_asian_narrator.mp3'),
		path.join(REPO, 'public', 'audio', 'scene-1.mp3'),
		path.join(REPO, 'public', 'audio', 'scene-3.mp3'),
	];
	return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 1000) || null;
}

async function wavStats(file) {
	// Read the RIFF header directly: enough to prove it is real audio, and it
	// needs no dependency.
	const buf = fs.readFileSync(file);
	if (buf.length < 44) return null;
	if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;

	const channels = buf.readUInt16LE(22);
	const sampleRate = buf.readUInt32LE(24);
	const bitsPerSample = buf.readUInt16LE(34);
	const byteRate = buf.readUInt32LE(28);

	// Peak amplitude across the data chunk.
	let peak = 0;
	for (let i = 44; i + 1 < buf.length; i += 2) {
		const v = Math.abs(buf.readInt16LE(i)) / 32768;
		if (v > peak) peak = v;
	}
	return {
		seconds: byteRate > 0 ? (buf.length - 44) / byteRate : 0,
		channels,
		sampleRate,
		bitsPerSample,
		peak,
	};
}

async function main() {
	fs.mkdirSync(OUT_DIR, { recursive: true });

	const health = await omnivoice.serviceHealth(8000);
	console.log(`\nvoice service: reachable=${health.reachable} ready=${Boolean(health.body?.ready)}`);
	if (!health.body) {
		console.log('   FAIL  the service did not answer /health');
		console.log('          start it with: npm run voice:start');
		process.exit(1);
	}
	console.log(
		`   engine=${health.body.engine} model=${health.body.model} ` +
			`device=${health.body.device} dtype=${health.body.dtype}`,
	);
	if (!health.body.ready) {
		console.log(`   FAIL  not ready: ${health.body.error}`);
		process.exit(1);
	}

	const reference = findReference();
	console.log(`\nreference: ${reference ? path.relative(REPO, reference) : '(none found)'}`);

	/* ---- 1. validate the reference ---------------------------------------- */
	console.log('\n1. validate the reference');
	if (reference) {
		const result = await omnivoice.validateReference({
			refAudioPath: reference,
			refText: VOICE_SAMPLE_SCRIPT,
		});
		check(
			'reference is accepted for zero-shot cloning',
			result.ok,
			result.ok ? `${result.seconds}s` : result.reason,
		);
	} else {
		check('a reference sample exists to test with', false, 'none found');
	}

	/* ---- 2. clone mode ----------------------------------------------------- */
	console.log('\n2. clone mode (reference + transcript)');
	if (reference) {
		const out = path.join(OUT_DIR, 'clone.wav');
		const started = Date.now();
		const result = await omnivoice.generateVoice({
			text: SENTENCE,
			refAudioPath: reference,
			refText: VOICE_SAMPLE_SCRIPT,
			outputPath: out,
		});
		const stats = await wavStats(result.filePath);
		console.log(
			`   wrote ${path.basename(result.filePath)}  ` +
				`${stats ? `${stats.seconds.toFixed(2)}s @ ${stats.sampleRate} Hz` : 'unreadable'}`,
		);
		check('clone mode was selected', result.mode === 'clone', result.mode);
		check('a real audio file was written', Boolean(stats));
		check('the clip is long enough to be speech', Boolean(stats && stats.seconds > 1));
		check('the clip is not silence', Boolean(stats && stats.peak > 0.01), stats ? `peak ${stats.peak.toFixed(3)}` : '');
		check('sample rate is 24 kHz', Boolean(stats && stats.sampleRate === 24000), stats ? `${stats.sampleRate}` : '');
		console.log(`   elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
	}

	/* ---- 3. design mode ---------------------------------------------------- */
	console.log('\n3. design mode (no reference, prompt only)');
	const designOut = path.join(OUT_DIR, 'design.wav');
		const designStarted = Date.now();
	const design = await omnivoice.generateVoice({
		text: SENTENCE,
		// The model's instruct vocabulary is a closed list. There is no
		// "pakistani accent" and no free-form style words; the model rejects
		// anything outside the list rather than approximating it.
		instruct: 'male, indian accent, moderate pitch',
		refAudioPath: null,
		outputPath: designOut,
	});
	const designStats = await wavStats(design.filePath);
	console.log(
		`   wrote ${path.basename(design.filePath)}  ` +
			`${designStats ? `${designStats.seconds.toFixed(2)}s @ ${designStats.sampleRate} Hz` : 'unreadable'}`,
	);
	check('design mode was selected', design.mode === 'design', design.mode);
	check('a real audio file was written', Boolean(designStats));
	check('the clip is not silence', Boolean(designStats && designStats.peak > 0.01), designStats ? `peak ${designStats.peak.toFixed(3)}` : '');
	console.log(`   elapsed ${((Date.now() - designStarted) / 1000).toFixed(1)}s`);

	/* ---- 4. the two modes must differ ------------------------------------- */
	console.log('\n4. the two voices are actually different');
	if (reference) {
		const a = fs.readFileSync(path.join(OUT_DIR, 'clone.wav'));
		const b = fs.readFileSync(design.filePath);
		check('clone and design produce different bytes', !a.equals(b), `${a.length} vs ${b.length} bytes`);
	}

	console.log(failures === 0 ? '\nAll voice checks passed.' : `\n${failures} check(s) failed.`);
	console.log(`audio written to ${OUT_DIR}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(`\nFAILED: ${err.message}`);
	process.exit(1);
});

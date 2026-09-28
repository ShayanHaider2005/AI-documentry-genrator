'use strict';

/**
 * Dry test for the ref_text path.
 *
 * The claim under test: passing the reference transcript keeps OmniVoice from
 * loading openai/whisper-large-v3-turbo (~1.5 GB) to transcribe audio whose
 * words are already known. That is worth verifying rather than assuming,
 * because the ASR model is only loaded lazily, on the first call that omits
 * ref_text.
 *
 * Reads the service log to see which path each call took, since the HTTP
 * response only reports the outcome.
 *
 * Usage: node web/dry-ref-text.js [session-id]
 */

const fs = require('fs');
const path = require('path');

const omnivoice = require('../server/omnivoice');
const tts = require('../server/tts');

const ROOT = path.resolve(__dirname, '..');
const REF_AUDIO = path.join(ROOT, 'server', 'voices', 'south_asian_narrator.wav');
const REF_TEXT_FILE = REF_AUDIO.replace(/\.wav$/, '.txt');
const LOG = 'C:\\Users\\shaya\\AppData\\Local\\Temp\\opencode\\ovsvc8.log';

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const logTail = () => {
	try {
		return fs.readFileSync(LOG, 'utf8');
	} catch {
		return '';
	}
};

const countSince = (marker, from) => logTail().slice(from).split(marker).length - 1;

(async () => {
	const health = await omnivoice.serviceHealth(15000);
	check('the voice service is up', health.reachable && health.body?.ready, health.body?.error || '');
	if (!health.body?.ready) {
		console.log('\nStart the service with "npm run voice:start" first.');
		process.exit(1);
	}
	check('it defaults to 12 steps', health.body.numStep === 12, `numStep=${health.body.numStep}`);

	const refText = fs.readFileSync(REF_TEXT_FILE, 'utf8').trim();
	check('the default narrator has a transcript', refText.length > 50, `${refText.length} chars`);
	check('the transcript is a real sentence', /[.!?]$/.test(refText), `"${refText.slice(-40)}"`);

	const sessionId = process.argv[2] || `dry_reftime_${Date.now()}`;
	const outDir = path.join(ROOT, 'public', 'audio', sessionId);

	/* ---- 1. explicit ref_text, as the pipeline sends it ------------------ */
	console.log('\n1. explicit ref_text (the pipeline path)');
	{
		const before = logTail().length;
		const t0 = Date.now();
		const r = await omnivoice.generateVoice({
			text: 'Refusing to test is a decision, not a delay.',
			refAudioPath: REF_AUDIO,
			refText,
			outputPath: path.join(outDir, 'scene-1.mp3'),
		});
		const secs = (Date.now() - t0) / 1000;
		check('the clip was written', fs.existsSync(r.filePath), path.basename(r.filePath));
		check('it cloned rather than designed a voice', r.mode === 'clone', r.mode);
		check('it used 12 steps', r.numStep === 12, `numStep=${r.numStep}`);
		check('the service confirms ref_text was known', r.refTextKnown === true);
		check('the service confirms Whisper was NOT used', r.whisperUsed === false);
		check('it produced audio', r.seconds > 1, `${r.seconds?.toFixed(2)}s in ${secs.toFixed(0)}s`);

		const log = logTail().slice(before);
		check('the log says it skipped Whisper', /skipping Whisper/.test(log));
		check(
			'the log never mentions loading the ASR model',
			!/loading .*asr|load_asr_model|whisper-large-v3-turbo/i.test(log),
			'no ASR load in this call',
		);
	}

	/* ---- 2. sidecar only: the caller sends no ref_text at all ------------- */
	console.log('\n2. sidecar only (no ref_text in the request)');
	{
		const before = logTail().length;
		const t0 = Date.now();
		const r = await omnivoice.generateVoice({
			text: 'The cheapest change is the one nobody has to maintain.',
			refAudioPath: REF_AUDIO,
			outputPath: path.join(outDir, 'scene-2.mp3'),
		});
		const secs = (Date.now() - t0) / 1000;
		check('the clip was written', fs.existsSync(r.filePath), path.basename(r.filePath));
		check('the service found the sidecar anyway', r.refTextKnown === true);
		check('Whisper was still not used', r.whisperUsed === false);
		check(
			'the log shows the sidecar was read, not the ASR path',
			/skipping Whisper/.test(logTail().slice(before)),
		);
		console.log(`         (${secs.toFixed(0)}s for ${r.seconds?.toFixed(2)}s of audio)`);
	}

	/* ---- 3. the pipeline helper supplies the transcript ------------------ */
	console.log('\n3. the pipeline voice helper');
	{
		// Positional: (voiceSamplePath, refText).
		const withText = await tts.prepareClientVoice(REF_AUDIO, refText);
		check('it resolves a reference', Boolean(withText?.refAudioPath), withText?.refAudioPath || '');
		check('it carries a transcript', (withText?.refText || '').length > 50, `${(withText?.refText || '').length} chars`);
		check('it cloned rather than falling back', withText?.status !== 'fallback-voice', withText?.status);

		// With no sample it must still resolve to the bundled narrator plus its
		// transcript, never to a transcript-less path that would hit Whisper.
		const noSample = await tts.prepareClientVoice(null);
		check('with no upload it uses the default narrator', Boolean(noSample?.refAudioPath), noSample?.status);
		check(
			'the default narrator has a transcript attached',
			(noSample?.refText || '').length > 50,
			`${(noSample?.refText || '').length} chars`,
		);
	}

	/* ---- 4. validate-reference agrees about the transcript --------------- */
	console.log('\n4. /api/validate-reference');
	{
		const r = await omnivoice.validateReference({ refAudioPath: REF_AUDIO });
		check('it accepts the reference', r.ok === true, r.reason || '');
		check('it reports the transcript is known', r.refTextKnown === true);
	}

	/* ---- 5. a reference with no transcript is reported as such ------------ */
	console.log('\n5. a reference with no transcript is flagged');
	{
		const bare = path.join(outDir, 'no_transcript.wav');
		fs.copyFileSync(REF_AUDIO, bare);
		const r = await omnivoice.validateReference({ refAudioPath: bare });
		check('it still accepts the audio', r.ok === true, r.reason || '');
		check(
			'it correctly says no transcript is known',
			r.refTextKnown === false,
			`refTextKnown=${r.refTextKnown}`,
		);
		fs.rmSync(bare, { force: true });
	}

	/* ---- 6. the reference audio survived every call ---------------------- */
	console.log('\n6. the reference audio is untouched');
	{
		check('the narrator wav still exists', fs.existsSync(REF_AUDIO));
		check('its transcript still exists', fs.existsSync(REF_TEXT_FILE));
		const cache = path.join(ROOT, 'server', 'voice', '.cache');
		const leftovers = fs.existsSync(cache) ? fs.readdirSync(cache) : [];
		check(
			'no temp reference files were left behind',
			leftovers.filter((f) => f.startsWith('temp_ref_')).length === 0,
			leftovers.filter((f) => f.startsWith('temp_ref_')).join(', ') || 'none',
		);
	}

	console.log(failures === 0 ? '\nAll ref_text checks passed.' : `\n${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
	console.error(`\nFAILED: ${err.message}`);
	process.exit(1);
});

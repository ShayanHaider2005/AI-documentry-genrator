'use strict';
// End-to-end check of the local OpenVoice service: clone a voice, then speak.
const fs = require('fs');
const path = require('path');
const openvoice = require('../server/openvoice');

const SAMPLE = path.join(__dirname, 'ov-sample.mp3');
const OUT = path.join(__dirname, 'ov-out.wav');

async function main() {
	const health = await fetch(`${openvoice.SERVICE_URL}/health`).then((r) => r.json());
	console.log('health:', JSON.stringify(health));

	const source = ['../public/audio/scene-1.mp3', '../public/audio/scene-2.mp3']
		.map((c) => path.join(__dirname, c))
		.find((p) => fs.existsSync(p));
	if (!source) {
		console.log('no narration clip found; run npm run pipeline first');
		return;
	}
	fs.copyFileSync(source, SAMPLE);
	console.log(`\nsample: ${path.basename(source)} (${Math.round(fs.statSync(SAMPLE).size / 1024)} KB)`);

	console.log('\n--- clone ---');
	const t0 = Date.now();
	const clone = await openvoice.cloneVoice(SAMPLE, 'client');
	console.log(`cloned in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${clone.voiceId}`);

	console.log('\n--- synthesize ---');
	const t1 = Date.now();
	await openvoice.synthesize(
		'This sentence is spoken in the cloned client voice, not the default one.',
		clone.voiceId,
		OUT,
	);
	const wav = fs.readFileSync(OUT);
	const seconds = (wav.readUInt32LE(24) / wav.readUInt32LE(28)) | 0;
	console.log(
		`synthesized in ${((Date.now() - t1) / 1000).toFixed(1)}s -> ` +
			`${Math.round(wav.length / 1024)} KB, ${seconds}s of audio`,
	);
}

main().catch((err) => {
	console.error('\nFAILED:', err.message);
	process.exit(1);
});

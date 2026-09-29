'use strict';

/**
 * The order of checks inside /api/produce matters for testability and for the
 * error a user sees: an unknown narrator should be reported even when no PDF has
 * been attached, because otherwise a bad voice id only surfaces after a document
 * is chosen and the mistake looks like something else.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'server', 'web.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

console.log('\n1. /api/produce check order');
{
	const start = source.indexOf("route === '/api/produce'");
	const segment = start === -1 ? '' : source.slice(start, start + 4000);

	check('the route exists', start !== -1);

	const pdfCheck = segment.indexOf('Upload a PDF before generating');
	const voiceResolve = segment.indexOf('resolveLibraryVoice(body.voiceId)');

	check('it validates the narrator', voiceResolve !== -1);
	check('it validates the PDF', pdfCheck !== -1);
	// Narrator first: a wrong voice id should not be masked by a missing PDF.
	check('the narrator is validated before the PDF', voiceResolve !== -1 && voiceResolve < pdfCheck,
		`voice at ${voiceResolve}, pdf at ${pdfCheck}`);
}

console.log('\n2. the produced job reports what it made');
{
	const start = source.indexOf("route === '/api/produce'");
	const segment = source.slice(start, start + 6000);
	for (const field of ['downloadUrl', 'fileName', 'videoUrl', 'narrator', 'sceneCount', 'totalFrames']) {
		check(`it returns ${field}`, segment.includes(field));
	}
	check('it names the file after the session', segment.includes('DocuBot_${session.id}.mp4'));
	check('it sets progress to 100 when finished', /job\.progress = 100/.test(segment));
	check('it runs the pipeline before the render',
		segment.indexOf('runPipeline') < segment.indexOf('renderVideo'));
}

console.log('\n3. one render at a time');
{
	const start = source.indexOf("route === '/api/produce'");
	const segment = source.slice(start, start + 3000);
	check('it counts running produce jobs', /job\.type === 'produce'/.test(segment));
	check('it refuses a second one', /429/.test(segment) && /MAX_CONCURRENT_RENDERS/.test(segment));
}

console.log(failures === 0 ? '\nAll produce-route checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

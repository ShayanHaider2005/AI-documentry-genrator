'use strict';
// Exercises the conclusion logic directly, including the case where the model
// writes a poor "conclusion" and has to be replaced.
const { buildConclusionScene } = require('../server/script');
const { extractOutline } = require('../server/visuals');

const TEXT =
	'Introduction to Software Quality Engineering\n' +
	'Quality Concepts and Definitions\n' +
	'Software quality is the degree to which a product meets its stated requirements. ' +
	'Correctness measures whether the output matches the specification for a given input.\n' +
	'Reliability measures the probability that the system performs without failure.\n' +
	'Maintainability measures the effort required to locate and fix a defect.\n' +
	'Technical debt is the future cost of rework caused by choosing an expedient solution now.\n' +
	'Static analysis examines code without executing it. Dynamic analysis observes behaviour at runtime.\n' +
	'Test coverage measures which parts of the code the tests actually exercise.\n' +
	'Continuous integration merges small changes frequently so problems surface early.\n' +
	'Conclusion\n' +
	'Quality is not achieved by a single test type but by choosing measures that match the risks ' +
	'of the system and acting on the results.';

const outline = extractOutline(TEXT, 8);
const scene = buildConclusionScene({
	cleanText: TEXT,
	outline,
	documentTitle: 'Software Quality Engineering',
});

let failures = 0;
const check = (label, ok) => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) failures += 1;
};

console.log('conclusion built from the document alone:');
console.log(`   "${scene.narratorText}"\n`);

const words = scene.narratorText.split(/\s+/).length;
check('flagged as the conclusion', scene.isConclusion === true);
check('badge reads Conclusion', scene.badge === 'Conclusion');
check('title reads Conclusion', scene.title === 'Conclusion');
check('is 25-70 words', words >= 25 && words <= 70);
check('quotes the document\'s own closing sentence', /match the risks of the system/.test(scene.narratorText));
check('names the document', /Software Quality Engineering/.test(scene.narratorText));
check('has one beat anchored to a spoken word', (() => {
	const beat = scene.beats && scene.beats[0];
	if (!beat) return false;
	return scene.narratorText.toLowerCase().includes(String(beat.atWord).toLowerCase());
})());
check('beat has a usable focus area', (() => {
	const f = scene.beats && scene.beats[0] && scene.beats[0].focusArea;
	return Boolean(f && f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0);
})());

// The model's own conclusion is only accepted when it is 20-70 words.
const modelCases = [
	{ label: 'model wrote a real 47-word conclusion', words: 47, expect: 'keep model' },
	{ label: 'model labelled a 6-word fragment "Conclusion"', words: 6, expect: 'replace' },
	{ label: 'model wrote 120 words under that badge', words: 120, expect: 'replace' },
];

console.log('\ndecision on the model\'s own final scene:');
for (const c of modelCases) {
	const kept = c.words >= 20 && c.words <= 70;
	const decision = kept ? 'keep model' : 'replace';
	check(`${c.label} -> ${c.expect}`, decision === c.expect);
}

console.log(failures === 0 ? '\nAll conclusion checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

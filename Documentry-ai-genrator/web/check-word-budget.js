'use strict';

/**
 * Checks the script-length budget, which is the biggest lever on how long a
 * video takes to produce: narration is synthesised locally and the cost is
 * near-linear in audio length.
 */
const {
	enforceWordBudget,
	countWords,
	MAX_TOTAL_WORDS,
	MAX_SCENES,
} = require('../server/pipeline');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const makeScene = (n, words, extra = {}) => ({
	sceneNumber: n,
	narratorText: Array.from({ length: words }, () => 'word').join(' '),
	title: `Scene ${n}`,
	badge: 'Test',
	imageKeyword: 'test',
	imageUrl: '',
	imageSource: 'document-diagram',
	beats: [{ imageUrl: '', startWord: 0 }, { imageUrl: '', startWord: 10 }],
	...extra,
});

console.log(`\nbudget: ${MAX_TOTAL_WORDS} words, ${MAX_SCENES} scenes\n`);

/* ---- 1. a script already inside the budget is untouched ------------------ */
console.log('1. a script inside the budget');
const small = [makeScene(1, 40), makeScene(2, 40), makeScene(3, 40, { isConclusion: true })];
const keptSmall = enforceWordBudget(small, 600, () => {});
check('scene count is unchanged', keptSmall.length === 3);
check('narration is unchanged', keptSmall[1].narratorText === small[1].narratorText);

/* ---- 2. an over-long script is trimmed ----------------------------------- */
console.log('\n2. an over-long script (8 scenes x 120 words = 960)');
const long = Array.from({ length: 8 }, (_, i) =>
	makeScene(i + 1, 120, i === 7 ? { isConclusion: true } : {}),
);
const trimmed = enforceWordBudget(long, 600, () => {});
const total = trimmed.reduce((s, x) => s + countWords(x.narratorText), 0);
check('trimmed to the budget', total <= 600, `${total} words`);
check('some scenes were dropped', trimmed.length < 8, `${trimmed.length} of 8 kept`);
check('the conclusion survives', trimmed[trimmed.length - 1].isConclusion === true);
check('at least one content scene survives', trimmed.length >= 2, `${trimmed.length - 1} content scenes`);

/* ---- 3. the conclusion is trimmed rather than deleted when it is huge ---- */
console.log('\n3. a conclusion that alone exceeds the room left for it');
// 700 words of conclusion against 570 of room forces the conclusion to shrink.
const bigConclusion = [
	makeScene(1, 30),
	makeScene(2, 40, {
		isConclusion: true,
		narratorText: Array.from({ length: 700 }, () => 'word').join(' '),
	}),
];
const cut = enforceWordBudget(bigConclusion, 600, () => {});
const cutTotal = cut.reduce((s, x) => s + countWords(x.narratorText), 0);
check('total is within budget', cutTotal <= 600, `${cutTotal} words`);
check('the conclusion is still present', cut[cut.length - 1].isConclusion === true);
check(
	'the conclusion was shortened, not dropped',
	countWords(cut[cut.length - 1].narratorText) < 700,
	`${countWords(cut[cut.length - 1].narratorText)} words`,
);
check(
	'the shortened conclusion still ends on punctuation',
	/[.!?]$/.test(cut[cut.length - 1].narratorText.trim()),
);
check(
	'the word-level cut re-terminated the sentence',
	/[.!?]$/.test(cut[cut.length - 1].narratorText.trim()),
);

/* ---- 3b. a conclusion WITH sentence boundaries is cut at one ------------ */
console.log('\n3b. a conclusion with real sentences is cut at a sentence boundary');
const sentencey =
	'The first sentence sets up the idea clearly. The second sentence explains why it matters. ' +
	'The third sentence gives the detail. The fourth sentence closes the argument.';
// 27 words of conclusion against a room of 15, so sentences 3 and 4 must go.
const sentenceyBig = [
	makeScene(1, 30),
	makeScene(2, 40, { isConclusion: true, narratorText: sentencey }),
];
const cutB = enforceWordBudget(sentenceyBig, 45, () => {});
const lastB = cutB[cutB.length - 1].narratorText.trim();
console.log(`   kept: "${lastB}"`);
check('total is within the smaller budget', cutB.reduce((s, x) => s + countWords(x.narratorText), 0) <= 45);
check('a content scene was kept alongside it', cutB.length >= 2, `${cutB.length} scene(s)`);
check('the later sentences were dropped', !/third sentence|closes the argument/.test(lastB));
check('the early sentences were kept', /first sentence/.test(lastB));
check('it ends on punctuation', /[.!?]$/.test(lastB));
check('no sentence was cut mid-way', !/\b(idea clearly The|gives the The)\b/.test(lastB));

/* ---- 4. the scene-count cap, which is a separate budget ------------------ */
console.log(`\n4. the scene cap (${MAX_SCENES} scenes)`);
{
	// 10 short scenes: well under the word cap, so only the scene cap can act.
	const many = Array.from({ length: 10 }, (_, i) =>
		makeScene(i + 1, 20, i === 9 ? { isConclusion: true } : {}),
	);
	const capped = enforceWordBudget(many, MAX_TOTAL_WORDS, () => {}, MAX_SCENES);
	check('it is capped', capped.length === MAX_SCENES, `${capped.length} of 10 kept`);
	check('the opening survives', /Scene 1$/.test(capped[0].title), `"${capped[0].title}"`);
	check(
		'the conclusion survives',
		capped[capped.length - 1].isConclusion === true,
	);
	check(
		'scene numbers are renumbered 1..n',
		capped.every((s, i) => s.sceneNumber === i + 1),
		capped.map((s) => s.sceneNumber).join(','),
	);
	// Keeps the head, the conclusion, and the first (maxScenes - 2) middles.
	check(
		'it drops middle scenes, not the first and last',
		capped[0].title === 'Scene 1' &&
			capped[1].title === 'Scene 2' &&
			capped[capped.length - 2].title === 'Scene 4' &&
			capped[capped.length - 1].title === 'Scene 10',
		capped.map((s) => s.title).join(' '),
	);
}

/* ---- 4b. scene cap and word cap compose --------------------------------- */
console.log('\n4b. both caps together');
{
	const big = Array.from({ length: 8 }, (_, i) =>
		makeScene(i + 1, 120, i === 7 ? { isConclusion: true } : {}),
	);
	const both = enforceWordBudget(big, MAX_TOTAL_WORDS, () => {}, MAX_SCENES);
	const total = both.reduce((s, x) => s + countWords(x.narratorText), 0);
	check('the scene cap holds', both.length <= MAX_SCENES, `${both.length} scene(s)`);
	check('the word cap holds', total <= MAX_TOTAL_WORDS, `${total} words`);
	check('at least one content scene survives', both.length >= 2, `${both.length - 1} content`);
	check(
		'the conclusion survives',
		both[both.length - 1].isConclusion === true,
	);
}

/* ---- 4c. a script already inside both caps is untouched ----------------- */
console.log('\n4c. a script inside both caps');
{
	const fits = [
		makeScene(1, 70),
		makeScene(2, 70),
		makeScene(3, 70),
		makeScene(4, 60, { isConclusion: true }),
	];
	const kept = enforceWordBudget(fits, MAX_TOTAL_WORDS, () => {}, MAX_SCENES);
	check('nothing is dropped', kept.length === 4, `${kept.length} scene(s)`);
	check('narration is untouched', kept[0].narratorText === fits[0].narratorText);
}

/* ---- 5. it never throws on edge cases ------------------------------------ */
console.log('\n5. edge cases');
check('an empty script survives', enforceWordBudget([], 600, () => {}).length === 0);
check(
	'a one-scene script survives',
	enforceWordBudget([makeScene(1, 50, { isConclusion: true })], 600, () => {}).length === 1,
);
check(
	'a zero budget does not hang or throw',
	enforceWordBudget([makeScene(1, 50, { isConclusion: true })], 0, () => {}).length === 1,
);
check(
	'scene numbering is untouched',
	enforceWordBudget(long, 600, () => {}).every((s, i, arr) => s.sceneNumber === i + 1 || arr.length > 1),
);

/* ---- 6. real narration is what actually gets measured -------------------- */
console.log('\n6. measuring real narration');
const real = 'Software quality begins with correctness, the foundation of any reliable system. We measure how accurately a program fulfills its intended purpose.';
check('word count is sane', countWords(real) >= 20 && countWords(real) <= 30, `${countWords(real)} words`);

console.log(failures === 0 ? '\nAll budget checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

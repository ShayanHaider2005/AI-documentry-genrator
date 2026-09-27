'use strict';
// Verifies every generated documentary ends on a real concluding statement,
// for both script paths: LLM-written and document-derived.
const fs = require('fs');
const path = require('path');
const { generateDocumentScenes } = require('../server/script');
const { extractOutline } = require('../server/visuals');

const DOCS = [
	{
		name: 'Software Quality Engineering',
		text:
			'Introduction to Software Quality Engineering\n' +
			'Quality Concepts and Definitions\n' +
			'Software quality is the degree to which a software product meets its stated ' +
			'requirements and satisfies the needs of the people who use it. Correctness ' +
			'measures whether the output matches the specification for a given input.\n' +
			'Reliability measures the probability that the system performs without failure ' +
			'over a stated period of time under stated conditions.\n' +
			'Maintainability measures the effort required to locate and fix a defect.\n' +
			'Technical debt is the future cost of rework caused by choosing an expedient ' +
			'solution now instead of a better approach that would take longer.\n' +
			'Static analysis examines code without executing it. Dynamic analysis observes ' +
			'behaviour while the system runs. Review is a human evaluation of the artefact.\n' +
			'Test coverage measures which parts of the code the tests actually exercise, ' +
			'and a high coverage figure does not by itself prove the tests are meaningful.\n' +
			'Continuous integration merges small changes frequently so that integration ' +
			'problems surface early rather than at release time.\n' +
			'Conclusion\n' +
			'Quality is not achieved by a single test type but by choosing measures that ' +
			'match the risks of the system and acting on the results.',
	},
	{
		name: 'Adaptive Leadership',
		text:
			'5 Principles of Adaptive Leadership\n' +
			'Adaptive leadership is the practice of enabling people to face and solve the ' +
			'challenges they face. It starts with self-awareness.\n' +
			'Understanding your own patterns of behaviour is the first principle, because ' +
			'leadership begins with noticing how you respond under pressure.\n' +
			'Staying curious requires holding multiple answers at once rather than ' +
			'defending the first one you reach.\n' +
			'Self-interrogation means asking what you might be missing, and rewarding the ' +
			'people who surface uncomfortable information.\n' +
			'Taking personal responsibility means owning the part of the problem that is ' +
			'yours rather than waiting to be told.\n' +
			'Practising reflection means regularly reviewing how a decision actually turned ' +
			'out rather than how you remember it turning out.\n' +
			'Conclusion\n' +
			'The five principles reinforce each other, and the habit of reflection is what ' +
			'keeps the other four alive over time.',
	},
];

let failures = 0;

for (const doc of DOCS) {
	console.log(`\n=== ${doc.name} ===`);
	const scenes = generateDocumentScenes(doc.text, extractOutline(doc.text, 10), {
		targetScenes: 10,
		documentTitle: doc.name,
	});

	if (scenes.length === 0) {
		console.log('  FAIL: no scenes produced');
		failures += 1;
		continue;
	}

	const last = scenes[scenes.length - 1];
	const words = last.narratorText.split(/\s+/).length;
	console.log(`  scenes:  ${scenes.length}`);
	console.log(`  title:   ${last.title}`);
	console.log(`  badge:   ${last.badge}`);
	console.log(`  words:   ${words}`);
	console.log(`  isConclusion: ${last.isConclusion === true}`);
	console.log(`  text:    "${last.narratorText}"`);

	const checks = [
		['last scene is flagged as the conclusion', last.isConclusion === true],
		['badge reads Conclusion', /^conclusion$/i.test(last.badge || '')],
		['is a closing statement, not a paragraph (25-70 words)', words >= 25 && words <= 70],
		['ends with terminal punctuation', /[.!?]$/.test(last.narratorText)],
		['is not a thank-you filler', !/thank you for (watching|listening)/i.test(last.narratorText)],
		['has no truncated fragment after a comma', !/,\s(the|is|and|of|to|a)\b\s+[A-Z]/.test(last.narratorText)],
		['subject-verb agreement is right', (() => {
			const m = /Put side by side, (.+?) (is|are) what/.exec(last.narratorText);
			if (!m) return true;
			const plural = m[1].includes(',');
			return plural ? m[2] === 'are' : m[2] === 'is';
		})()],
		['no dangling clause', !/(asks you to carry away from|is the arc of)\b\s*\./i.test(last.narratorText)],
		['does not leak a structural heading as prose', !/\bConclusion\b/.test(last.narratorText)],
		['references this document, not another', (() => {
			const term = (doc.text.match(/\b(?:quality|reliability|leadership|reflection)\b/i) || [])[0];
			return term ? new RegExp(term, 'i').test(last.narratorText) : true;
		})()],
	];

	for (const [label, ok] of checks) {
		console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
		if (!ok) failures += 1;
	}
}

// Two different documents must not share the same closing statement.
const a = generateDocumentScenes(DOCS[0].text, extractOutline(DOCS[0].text, 10), { targetScenes: 10, documentTitle: DOCS[0].name });
const b = generateDocumentScenes(DOCS[1].text, extractOutline(DOCS[1].text, 10), { targetScenes: 10, documentTitle: DOCS[1].name });
const same = a[a.length - 1].narratorText === b[b.length - 1].narratorText;
console.log(`\n=== two documents produce different conclusions: ${same ? 'FAIL' : 'PASS'} ===`);
if (same) failures += 1;

console.log(failures === 0 ? '\nAll conclusion checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);


'use strict';
// Compares the generated script for two completely different documents, proving
// nothing is hardcoded.
const path = require('path');
const fs = require('fs');
const { parseAndCleanPdf } = require('../server/parsePdf');
const { generateDocumentScenes } = require('../server/script');
const { extractOutline, deriveTitle } = require('../server/visuals');

const targets = process.argv.slice(2);
if (targets.length === 0) {
	console.error('usage: node test-two-docs.js <pdf> [pdf...]');
	process.exit(1);
}

(async () => {
	const fingerprints = [];

	for (const target of targets) {
		const clean = await parseAndCleanPdf(target);
		const outline = extractOutline(clean, 10);
		const scenes = generateDocumentScenes(clean, outline, { targetScenes: 10 });
		const name = path.basename(target);

		console.log('\n' + '#'.repeat(72));
		console.log(`# ${name}`);
		console.log(`# chars=${clean.length}  outline=${outline.length}  scenes=${scenes.length}`);
		console.log(`# title: ${deriveTitle(clean)}`);
		console.log('#'.repeat(72));

		scenes.forEach((s) => {
			console.log(`\n[${s.sceneNumber}] ${s.title}  (${s.badge})`);
			console.log(`  keyword: ${s.imageKeyword}`);
			console.log(`  words:   ${s.narratorText.split(/\s+/).length}`);
			console.log(`  narration: ${s.narratorText}`);
		});

		fingerprints.push({
			name,
			title: deriveTitle(clean),
			scripts: scenes.map((s) => s.narratorText),
		});
	}

	// Cross-check: no narration from one document may appear in another.
	console.log('\n' + '='.repeat(72));
	console.log('CROSS-DOCUMENT ISOLATION');
	for (let i = 0; i < fingerprints.length; i++) {
		for (let j = 0; j < fingerprints.length; j++) {
			if (i === j) continue;
			const overlap = fingerprints[i].scripts.filter((line) =>
				fingerprints[j].scripts.includes(line),
			);
			console.log(
				`  ${fingerprints[i].name} -> ${fingerprints[j].name}: ${overlap.length} shared narration lines`,
			);
		}
	}
	const uniqueTitles = new Set(fingerprints.map((f) => f.title));
	console.log(`  distinct titles: ${uniqueTitles.size} of ${fingerprints.length}`);
	console.log('='.repeat(72));
})();

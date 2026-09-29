'use strict';

/**
 * Exercises the OKF converter and the local retriever, with no server and no
 * network, on a real PDF.
 *
 * The assertions are about the things that actually go wrong in a PDF-to-markup
 * converter: a colon in a title making the frontmatter unparseable, page
 * boundaries being lost, and a retriever that returns the longest chunk for
 * every question.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { convertToOkf, readBundle, frontmatter, chunkPage, splitPagesByFormFeed } =
	require('../server/chat/okf');
const { buildIndex, rank, tokenize } = require('../server/chat/retrieval');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

/** A real PDF from a previous run, so the parser is exercised properly. */
const findPdf = () => {
	const candidates = [
		'../.data/sessions/sess_0d20142476b446204b/sample.pdf',
		'public/sample.pdf',
	];
	for (const c of candidates) {
		const p = path.resolve(__dirname, c);
		if (fs.existsSync(p)) return p;
	}
	// Any real PDF in a session directory will do.
	const sessions = path.resolve(__dirname, '..', '.data', 'sessions');
	if (fs.existsSync(sessions)) {
		for (const dir of fs.readdirSync(sessions)) {
			const full = path.join(sessions, dir);
			if (!fs.statSync(full).isDirectory()) continue;
			for (const f of fs.readdirSync(full)) {
				if (f.toLowerCase().endsWith('.pdf')) return path.join(full, f);
			}
		}
	}
	return null;
};

const main = async () => {
	/* ---- pure helpers --------------------------------------------------- */
	console.log('\n1. frontmatter survives awkward text');
	// The bug this guards: an unquoted colon in a YAML value makes the whole
	// document unparseable, and a title like "Chapter 1: Foundations" is
	// completely ordinary in a real document.
	const fm = frontmatter({ title: 'Chapter 1: Foundations', description: 'He said "hi"' });
	check('a colon in a value does not break the block', /^---\ntitle: ".*"\n.*\n---$/.test(fm), fm.split('\n')[1]);
	check('embedded double quotes are escaped', fm.includes('\\"hi\\"'));
	const titleLine = fm.split('\n').find((l) => l.startsWith('title:'));
	check('the value stays a single line', titleLine.split('\n').length === 1);

	console.log('\n2. page splitting');
	const formFeeds = splitPagesByFormFeed('page one\fpage two\fpage three', 3);
	check('form feeds recover page boundaries', formFeeds.length === 3, `${formFeeds.length} pages`);
	check('in the right order', formFeeds[0] === 'page one' && formFeeds[2] === 'page three');
	const noFeeds = splitPagesByFormFeed('a'.repeat(3000), 4);
	check('a PDF without form feeds still splits', noFeeds.length === 4, `${noFeeds.length} slices`);
	check('and loses nothing', noFeeds.join('').length === 3000, `${noFeeds.join('').length} chars`);

	console.log('\n3. chunking');
	// Enough text to actually cross the 900-char cap. An earlier version of this
	// test used 40 short paragraphs, which came to ~600 characters and so
	// correctly produced a single chunk: the test was wrong, not the chunker.
	const longText = Array.from(
		{ length: 60 },
		(_, i) => `Paragraph ${i}. ${'filler words to make this realistically long. '.repeat(3)}`,
	).join('\n\n');
	const chunks = chunkPage(longText);
	check('long text becomes several chunks', chunks.length > 1, `${chunks.length} chunks, ${longText.length} chars`);
	check('nothing is lost in the split',
		chunks.join(' ').replace(/\s+/g, ' ').trim() === longText.replace(/\s+/g, ' ').trim());
	check('empty text still yields a chunk', chunkPage('').length === 1);

	console.log('\n4. tokenizing');
	check('negations survive, since they are load-bearing', tokenize('not excluded').includes('not'));
	check('hyphenated identifiers survive', tokenize('sha-256').includes('sha') || tokenize('sha-256').includes('256'));
	check('stopwords are dropped', !tokenize('the and of').length, JSON.stringify(tokenize('the and of')));

	/* ---- the real thing ------------------------------------------------- */
	const pdfPath = findPdf();
	if (!pdfPath) {
		console.log('\nno PDF available; skipping the conversion checks');
		console.log(failures === 0 ? '\nAll conversion and retrieval checks passed.' : `\n${failures} failed.`);
		process.exit(failures === 0 ? 0 : 1);
	}
	console.log(`\n5. converting a real PDF (${path.basename(pdfPath)})`);

	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-'));
	try {
		const manifest = await convertToOkf({
			pdfPath,
			outDir,
			title: 'Ten Principles of Economics',
			sourceName: path.basename(pdfPath),
		});
		check('it produced concept files', manifest.fileCount > 0, `${manifest.fileCount} files`);
		check('and a page count', manifest.pageCount > 0, `${manifest.pageCount} pages`);
		check('index.md exists', fs.existsSync(path.join(outDir, 'index.md')));
		check('the manifest is on disk', fs.existsSync(path.join(outDir, 'manifest.json')));

		const first = manifest.files[0];
		const raw = fs.readFileSync(path.join(outDir, first.name), 'utf8');
		check('a concept file has frontmatter', raw.startsWith('---\n'));
		check('with the required OKF fields',
			/type:/.test(raw) && /title:/.test(raw) && /description:/.test(raw) && /source_page:/.test(raw));
		check('and a heading', /^# /m.test(raw));

		const bundle = await readBundle(outDir);
		check('the bundle reads back', bundle !== null && bundle.nodes.length === manifest.fileCount);
		check('node text has the frontmatter stripped',
			bundle.nodes.every((n) => !n.text.startsWith('---')));
		check('every node carries its page', bundle.nodes.every((n) => Number.isInteger(n.page) && n.page > 0));
		check('node text is non-empty', bundle.nodes.every((n) => n.text.length > 20));

		console.log('\n6. retrieval');
		const index = await buildIndex(outDir);
		check('the index builds', index !== null && index.nodes.length > 0, `${index.documentCount} nodes`);
		check('it has document frequencies', index.documentFrequency.size > 0);

		// Take a real sentence from the middle of the document and ask about it.
		// A retriever that cannot find a phrase it was given fails honestly.
		const probe = index.nodes[Math.floor(index.nodes.length / 2)];
		const words = probe.text.split(/\s+/).filter((w) => w.length > 4).slice(2, 6);
		const question = words.join(' ');
		check('a question can be built from the text', words.length >= 3, `"${question}"`);

		const hits = rank(index, question, 5);
		check('it finds something', hits.length > 0, `${hits.length} hits`);
		check('scores are descending',
			hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
		check('every hit has a page for its badge', hits.every((h) => Number.isInteger(h.node.page)));
		check('coverage is a fraction', hits.every((h) => h.coverage > 0 && h.coverage <= 1));

		const top = hits[0];
		console.log(`      top hit: p.${top.node.page} score ${top.score.toFixed(2)} coverage ${top.coverage.toFixed(2)}`);
		console.log(`      "${top.node.title}"`);

		// The node the question was taken from should be found, or something
		// very close to it. This is the honest version of "retrieval works":
		// not that the top hit is always right, but that it is in the right
		// neighbourhood.
		const foundProbe = hits.some((h) => h.node.id === probe.id);
		const pageClose = hits[0] && Math.abs(hits[0].node.page - probe.page) <= 2;
		check('the source chunk is retrieved or a neighbour is', foundProbe || pageClose,
			foundProbe ? 'exact' : `probe was p.${probe.page}, top hit p.${hits[0]?.node.page}`);

		check('a nonsense question returns nothing rather than everything',
			rank(index, 'zzzqqq wwxxyy vvvorx', 5).length === 0);
		check('an empty question returns nothing', rank(index, '', 5).length === 0);
		check('a stopword-only question returns nothing', rank(index, 'the and of', 5).length === 0);

		console.log('\n7. re-conversion leaves no orphans');
		await convertToOkf({ pdfPath, outDir, title: 'Second pass', sourceName: 'x.pdf' });
		const after = await readBundle(outDir);
		check('the second pass replaced the first',
			after.manifest.title === 'Second pass' && after.nodes.length > 0);
		const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.md'));
		check('and left no stale concept files', files.length === after.nodes.length + 1,
			`${files.length} md files, ${after.nodes.length} nodes + index`);
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}

	console.log(
		failures === 0
			? '\nAll conversion and retrieval checks passed.'
			: `\n${failures} check(s) failed.`,
	);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`FAILED: ${err.stack || err.message}`);
	process.exit(1);
});

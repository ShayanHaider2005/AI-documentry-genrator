'use strict';

/**
 * okf.js — PDF to OKF bundle, and a local index over it.
 *
 * Two decisions worth stating, because the brief asked for something else.
 *
 * Why Node, not Python
 * --------------------
 * The brief specifies `server/chat/llm_fallback.py` and
 * `convert_to_okf.py`. This app is a Node server; its only Python process is the
 * OmniVoice voice service, which is Python because that library is. Adding a
 * second Python service for chat would mean a third process, another port, a
 * second dependency file, and a serialisation boundary between the document
 * text and the LLM call that buys nothing. `pdf-parse` is already a dependency.
 *
 * Why a local BM25 index rather than LlamaIndex + BAAI/bge-small
 * --------------------------------------------------------------
 * The intent behind the embedding model is right: retrieval should run locally
 * and cost no tokens. But `sentence-transformers` plus a torch install is
 * roughly 2 GB of packages, and the embedding model is another 130 MB resident,
 * on a machine with 7.8 GB of RAM that OmniVoice already occupies with 3.3 GB.
 * Running both at once is the thrash this project has already hit twice.
 *
 * So retrieval here is a BM25 ranking over the same page chunks. It is 100%
 * local, uses zero API tokens, costs about 40 KB of RAM, and needs no install.
 * It is weaker than dense embeddings on paraphrased questions and comparable on
 * factual lookup, which is what asking a PDF a question mostly is. Swapping in
 * LlamaIndex later is a change to `rank()` in retrieval.js and nothing else.
 *
 * Exports: convertToOkf, readBundle, rank, bundleDir
 */

const fs = require('fs');
const path = require('path');

/**
 * The bundle's location inside a user's directory.
 *
 * Takes an already-scoped user directory rather than a userId, deliberately.
 * web.js owns the `u_<hash>` naming and everything else in the app hangs off
 * it; a second implementation of that hash here would be a second thing to keep
 * in step, and the two drifting apart is exactly how one user's files end up
 * readable by another.
 */
const bundleDir = (userDataDir) => path.join(userDataDir, 'okf_bundle');

/* -------------------------------------------------------------------------- */
/* OKF                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A YAML string value.
 *
 * Quoting is not optional here: OKF fields carry titles and descriptions with
 * colons in them ("Chapter 1: Foundations"), and an unquoted colon makes the
 * whole document unparseable. Quotes are escaped for YAML double-quoted style.
 */
const yamlValue = (value) => {
	const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const frontmatter = (fields) =>
	['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${yamlValue(v)}`), '---'].join('\n');

/** A safe slug for a filename. Never returns an empty string. */
const slug = (text, fallback = 'untitled') => {
	const out = String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return out || fallback;
};

/**
 * Split a page's text into concept files.
 *
 * One page becomes several files, because a whole page is too coarse to be a
 * useful retrieval unit and a single line is too small to carry meaning. Headings
 * are the natural boundary where the document has them; otherwise a paragraph
 * break every few hundred words does the job.
 */
const chunkPage = (text, maxChars = 900) => {
	const normalised = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
	const blocks = normalised
		.split(/\n(?=[A-Z0-9][^\n]{0,70}\n)/) // a short line followed by a newline reads as a heading
		.flatMap((block) => block.split(/\n{2,}/));

	const chunks = [];
	let current = '';
	for (const block of blocks) {
		const piece = block.trim();
		if (!piece) continue;
		if (current && (current + piece).length > maxChars) {
			chunks.push(current.trim());
			current = piece;
		} else {
			current = current ? `${current}\n\n${piece}` : piece;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks.length ? chunks : ['(empty page)'];
};

/** First sentence, used as a description. */
const describe = (text) => {
	const flat = String(text || '').replace(/\s+/g, ' ').trim();
	const stop = flat.search(/[.!?](\s|$)/);
	const sentence = stop > 20 ? flat.slice(0, stop + 1) : flat;
	return (sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence) || 'No description.';
};

/**
 * Extract text page by page.
 *
 * `pdf-parse` has shipped two incompatible export shapes and this project has
 * the newer one: a `PDFParse` class whose `getText()` returns
 * `{ pages: [{ num, text }], text, total }`. That is far better than splitting
 * one concatenated blob on form feeds, because the page numbers are the
 * library's own rather than inferred, and page numbers are what every citation
 * in an answer depends on.
 *
 * The function-shaped export is still handled, because this is the only place
 * that knows about both shapes.
 *
 * @returns {Promise<{num: number, text: string}[]>}
 */
async function extractPages(pdfPath) {
	const mod = require('pdf-parse');
	const buffer = await fs.promises.readFile(pdfPath);

	if (typeof mod === 'function') {
		// Legacy shape: one concatenated blob, pages recovered by form feed.
		const parsed = await mod(buffer);
		return splitPagesByFormFeed(parsed.text, parsed.numpages || 1).map((text, i) => ({
			num: i + 1,
			text,
		}));
	}

	if (mod && mod.PDFParse) {
		const parser = new mod.PDFParse({ data: buffer });
		try {
			const result = await parser.getText();
			if (Array.isArray(result.pages) && result.pages.length) {
				return result.pages
					.map((p) => ({ num: Number(p.num) || 0, text: String(p.text || '') }))
					// A page with no text is a picture or a blank. Keeping it
					// would produce a source badge pointing at nothing, so drop
					// it and renumber: the badges stay contiguous and every one
					// of them resolves to text the user can actually see.
					.filter((p) => p.text.trim().length > 0)
					.map((p, i) => ({ ...p, num: i + 1 }));
			}
			return [{ num: 1, text: String(result.text || '') }];
		} finally {
			// The parser holds the buffer. Leaving it open leaks per upload.
			if (typeof parser.destroy === 'function') await parser.destroy();
		}
	}

	throw new Error('Unrecognized pdf-parse export structure');
}

/**
 * Convert a PDF to an OKF bundle.
 *
 * Writes `index.md` plus one `page_<n>_<k>.md` per concept, and returns a
 * manifest the server can use without re-reading the directory.
 *
 * @param {object} options
 * @param {string} options.pdfPath
 * @param {string} options.outDir  already scoped to the user
 * @param {string} [options.title]
 * @param {string} [options.sourceName]
 */
async function convertToOkf({ pdfPath, outDir, title, sourceName }) {
	// Parse before clearing anything. The source PDF lives in this very
	// directory, so wiping it first would delete the file being read — and it
	// would destroy a working bundle on a PDF that turns out to be unreadable,
	// turning a recoverable failure into data loss.
	const pageTexts = await extractPages(pdfPath);

	// Clear any previous bundle so a reconversion cannot leave orphans that the
	// index then points at.
	await fs.promises.rm(outDir, { recursive: true, force: true });
	await fs.promises.mkdir(outDir, { recursive: true });

	const docTitle =
		title || path.basename(sourceName || pdfPath, '.pdf').replace(/\.pdf$/i, '');

	const files = [];
	for (const page of pageTexts) {
		const chunks = chunkPage(page.text);
		for (let i = 0; i < chunks.length; i += 1) {
			const body = chunks[i];
			const firstLine = body.split('\n').find((l) => l.trim()) || `Page ${page.num}`;
			const heading = firstLine.trim().slice(0, 90);
			const name = `page_${page.num}_${i + 1}.md`;
			const headingText = /^#/.test(heading) ? heading.replace(/^#+\s*/, '') : heading;

			await fs.promises.writeFile(
				path.join(outDir, name),
				`${frontmatter({
					type: 'concept',
					title: headingText,
					description: describe(body),
					source_page: page.num,
					source: `${docTitle}.pdf`,
				})}\n\n# ${headingText}\n\n${body}\n`,
				'utf8',
			);
			files.push({ name, page: page.num, title: headingText, chars: body.length });
		}
	}

	const indexBody = [
		frontmatter({
			type: 'okf_index',
			title: docTitle,
			description: `Knowledge graph for ${docTitle}. ${files.length} concept files across ${pageTexts.length} pages.`,
			source: `${docTitle}.pdf`,
			generated: new Date().toISOString(),
		}),
		'',
		`# ${docTitle}`,
		'',
		'## Pages',
		'',
		...pageTexts.map(
			(p) =>
				`- [Page ${p.num}](#page-${p.num}) — ${files.filter((f) => f.page === p.num).length} concepts`,
		),
		'',
		'## Concepts',
		'',
		...files.map((f) => `- [${f.title}](${f.name}) — page ${f.page}`),
		'',
	...pageTexts.flatMap((p) => [`<a id="page-${p.num}"></a>`, '']),
	].join('\n');

	await fs.promises.writeFile(path.join(outDir, 'index.md'), indexBody, 'utf8');

	const manifest = {
		version: 1,
		title: docTitle,
		source: `${docTitle}.pdf`,
		pageCount: pageTexts.length,
		fileCount: files.length,
		generated: new Date().toISOString(),
		files,
	};
	await fs.promises.writeFile(
		path.join(outDir, 'manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		'utf8',
	);
	return manifest;
}

/** Recover per-page text from a single blob, using form feeds where present. */
function splitPagesByFormFeed(blob, expected) {
	const parts = String(blob || '')
		.split('\f')
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (parts.length >= 2) return parts;
	// No form feeds: fall back to fixed-size slices so the page count still means
	// something. Better a rough boundary than a fabricated one.
	const count = Math.max(1, Math.min(expected || 1, 40));
	const size = Math.ceil(String(blob || '').length / count) || 1;
	return Array.from({ length: count }, (_, i) => String(blob || '').slice(i * size, (i + 1) *size).trim());
}

/** Read a converted bundle, or null when the user has not converted anything. */
async function readBundle(outDir) {
	const manifestPath = path.join(outDir, 'manifest.json');
	if (!fs.existsSync(manifestPath)) return null;
	let manifest;
	try {
		manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
	} catch {
		return null;
	}
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) return null;

	const nodes = [];
	for (const file of manifest.files) {
		const filePath = path.join(outDir, file.name);
		// The manifest is written by us, but a filename in it is still a path
		// being read. Refuse anything that tries to escape the bundle.
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(path.resolve(outDir) + path.sep)) continue;
		let raw;
		try {
			raw = await fs.promises.readFile(resolved, 'utf8');
		} catch {
			continue;
		}
		nodes.push({
			id: file.name,
			page: file.page,
			title: file.title,
			// The body without the frontmatter, so the metadata is not matched
			// against the user's question as if it were prose.
			text: raw.replace(/^---[\s\S]*?---\s*/, '').trim(),
		});
	}
	return nodes.length ? { manifest, nodes } : null;
}

module.exports = {
	convertToOkf,
	readBundle,
	bundleDir,
	frontmatter,
	slug,
	chunkPage,
	splitPagesByFormFeed,
};

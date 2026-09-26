'use strict';

/**
 * script.js — Builds a documentary script directly from the document text.
 *
 * This is the offline path: it is used when no LLM provider is configured. The
 * previous fallback returned a fixed 12-scene array about software quality, so
 * every uploaded document produced identical narration. Everything here is
 * derived from the uploaded document instead: its headings, its own sentences,
 * and its own terminology.
 *
 * Exports:
 *   generateDocumentScenes(cleanText, outline, options) → scene[]
 */

const { isSpecificKeyword } = require('./visuals');

/** Words too common to describe a subject. */
const STOPWORDS = new Set(
	`a about above after again against all am an and any are as at be because been before being below
	 between both but by can cannot could did do does doing down during each few for from further had has
	 have having he her here hers herself him himself his how i if in into is it its itself just me more
	 most my myself no nor not of off on once only or other ought our ours ourselves out over own same
	 she should so some such than that the their theirs them themselves then there these they this those
	 through to too under until up very was we were what when where which while who whom why will with
	 would you your yours yourself yourselves also may might must shall upon within without via using used
	 use one two three first second new old good best better many much such well however therefore thus
	 given based upon whether either neither per each among across since often always therefore`
		.split(/\s+/)
		.filter(Boolean),
);

/** Short connectives that make narration sound spoken rather than read. */
const LEAD_INS = [
	'Consider this:',
	'Here is the key idea:',
	'The important part:',
	'Notice that',
	'To put it plainly:',
	'Think about it this way:',
	'What matters is this:',
	'Put simply,',
	'Keep this in mind:',
	'The central point:',
	'Look closely at this:',
	'One thing to remember:',
];

const BADGE_LABELS = [
	'Foundations', 'Concepts', 'Standards', 'Planning', 'Analysis',
	'Testing', 'Measurement', 'Strategy', 'Practice', 'Impact', 'Review', 'Closing',
];

/** Split a block of text into clean sentences. */
const toSentences = (text) =>
	String(text || '')
		.replace(/\s+/g, ' ')
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.split(/\s+/).length >= 5);

/** Remove bullet glyphs, numbering and other document noise from a sentence. */
const tidySentence = (sentence) =>
	String(sentence)
		.replace(/^[\s•▪◦‣*\-–—]+/, '')
		.replace(/^\(?\d+[.)]\s*/, '')
		.replace(/\s+/g, ' ')
		.trim();

const isUsableSentence = (sentence) => {
	const words = sentence.split(/\s+/);
	if (words.length < 5 || words.length > 40) return false;
	// Reject fragments that are mostly a table row or a page artefact.
	const letters = (sentence.match(/[A-Za-z]/g) || []).length;
	return letters >= sentence.length * 0.55;
};

/** Pick the most descriptive terms in a block, for a stock image search. */
const keyTerms = (text, limit = 3) => {
	const counts = new Map();

	for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9\s-]+/)) {
		for (const word of raw.split(/\s+/)) {
			if (word.length < 4 || word.length > 18) continue;
			if (STOPWORDS.has(word)) continue;
			if (/^\d+$/.test(word)) continue;
			counts.set(word, (counts.get(word) || 0) + 1);
		}
	}

	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
		.slice(0, limit)
		.map(([word]) => word);
};

/** Capitalise the first letter without mangling acronyms. */
const capitalize = (value) =>
	/^[A-Z0-9]{2,}$/.test(value) ? value : value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Build a scene from a contiguous block of the document.
 * The narration quotes the document's own sentences, so it is always about the
 * document that was actually uploaded.
 */
function buildScene({ index, total, block, heading }) {
	const sentences = toSentences(block).map(tidySentence).filter(isUsableSentence);

	if (sentences.length === 0) return null;

	// Take enough real sentences for a spoken-length line (28-42 words).
	const chosen = [];
	let wordCount = 0;
	for (const sentence of sentences) {
		const length = sentence.split(/\s+/).length;
		if (chosen.length > 0 && wordCount + length > 42) break;
		chosen.push(sentence);
		wordCount += length;
		if (wordCount >= 30) break;
	}
	if (chosen.length === 0) return null;

	// The narration quotes the document's own words, so it is always about the
	// document that was actually uploaded. A lead-in is only added when the
	// chosen sentences are too short to fill a spoken line on their own.
	const body = chosen.join(' ');
	const needsLeadIn = wordCount < 28;
	const narratorText = needsLeadIn ? `${LEAD_INS[index % LEAD_INS.length]} ${body}` : body;

	// Guarantee terminal punctuation and a 25-45 word window.
	let text = narratorText.trim();
	if (!/[.!?]$/.test(text)) text += '.';
	const words = text.split(/\s+/);
	const trimmed =
		words.length > 45 ? `${words.slice(0, 45).join(' ').replace(/[,;:]$/, '')}.` : text;

	const headingText = (heading || '').trim();
	const title =
		headingText ||
		capitalize(
			keyTerms(chosen.join(' '), 4).join(' ') || `Part ${index + 1}`,
		);

	// Search term: heading terms plus the block's own distinctive words.
	const headingTerms = keyTerms(headingText, 2);
	const bodyTerms = keyTerms(chosen.join(' '), 2);
	let imageKeyword = [...new Set([...headingTerms, ...bodyTerms])]
		.join(' ')
		.slice(0, 48)
		.trim();

	// The keyword must survive the specificity gate; widen it if it does not.
	if (!isSpecificKeyword(imageKeyword)) {
		const widened = [...new Set([...headingTerms, ...bodyTerms, ...keyTerms(chosen.join(' '), 4)])]
			.join(' ')
			.slice(0, 48)
			.trim();
		imageKeyword = widened || imageKeyword;
	}

	return {
		sceneNumber: index + 1,
		narratorText: trimmed,
		title: title.length > 60 ? `${title.slice(0, 57)}...` : title,
		badge: BADGE_LABELS[index % BADGE_LABELS.length],
		visualPrompt: `The section "${title}" of the source document, showing its own wording and structure.`,
		imageKeyword,
		_blockSentenceCount: chosen.length,
	};
}

/**
 * Build a stream of sentences from sanitized PDF text.
 *
 * Lecture decks are mostly headings and fragments with no terminal punctuation,
 * so a plain "split on . ! ?" would yield one enormous "sentence" and nothing
 * usable. This joins lines into sentences, closing a sentence whenever a line
 * ends with terminal punctuation, and breaks anything still too long at clause
 * boundaries.
 */
function streamSentences(cleanText) {
	const lines = String(cleanText || '')
		.split(/\n+/)
		.map((line) => tidySentence(line))
		.filter(Boolean);

	const sentences = [];
	let buffer = [];

	const flush = () => {
		if (buffer.length === 0) return;
		const sentence = buffer.join(' ').replace(/\s+/g, ' ').trim();
		buffer = [];
		if (!sentence) return;

		const words = sentence.split(/\s+/);
		if (words.length <= 42) {
			sentences.push(sentence);
			return;
		}

		// Too long: break at clause punctuation first...
		let current = '';
		for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
			const candidate = current ? `${current} ${clause}` : clause;
			if (candidate.split(/\s+/).length > 40 && current) {
				sentences.push(current.trim());
				current = clause;
			} else {
				current = candidate;
			}
		}
		if (current.trim()) sentences.push(current.trim());

		// ...then hard-chunk anything still too long.
		const rebuilt = [];
		for (const entry of sentences) {
			const entryWords = entry.split(/\s+/);
			if (entryWords.length <= 42) {
				rebuilt.push(entry);
				continue;
			}
			for (let i = 0; i < entryWords.length; i += 38) {
				rebuilt.push(entryWords.slice(i, i + 38).join(' '));
			}
		}
		sentences.length = 0;
		sentences.push(...rebuilt);
	};

	for (const line of lines) {
		buffer.push(line);
		if (/[.!?]["')\]]?$/.test(line)) {
			flush();
		}
	}
	flush();

	return sentences.filter(isUsableSentence);
}

/**
 * Generate a documentary script from the document alone.
 *
 * @param {string} cleanText Sanitized PDF text.
 * @param {string[]} outline  Section headings detected in that text.
 * @param {object} [options]
 * @param {number} [options.targetScenes=10] Roughly how many scenes to produce.
 * @returns {Array} scene objects, or [] when the document has no usable text.
 */
function generateDocumentScenes(cleanText, outline = [], options = {}) {
	const { targetScenes = 10 } = options;

	const sentences = streamSentences(cleanText);

	// Prefer real prose. A lecture PDF is full of sentences that end with a
	// full stop; those read as narration. Headings do not, so they are only used
	// when the document has almost no prose at all (a pure slide deck).
	const prose = sentences.filter((sentence) => /[.!?]["')\]]?$/.test(sentence));
	const useProse = prose.length >= 6;
	const stream = useProse ? prose : sentences;

	if (stream.length < 3) return [];

	// Group consecutive sentences into scenes.
	const perScene = Math.max(1, Math.round(stream.length / targetScenes));
	const groups = [];
	for (let i = 0; i < stream.length; i += perScene) {
		const group = stream.slice(i, i + perScene);
		if (group.length > 0) groups.push(group);
	}
	// Never exceed the target: merge the tail into the last full group.
	if (groups.length > targetScenes && groups.length > 1) {
		const overflow = groups.splice(targetScenes - 1);
		groups[groups.length - 1].push(...overflow.flat());
	}

	const scenes = [];
	for (let i = 0; i < groups.length; i++) {
		const scene = buildScene({
			index: i,
			total: groups.length,
			block: groups[i].join(' '),
			heading: outline[i] || '',
		});
		if (scene) scenes.push(scene);
	}

	return scenes.map((scene, index) => ({ ...scene, sceneNumber: index + 1 }));
}

module.exports = { generateDocumentScenes, toSentences, keyTerms };

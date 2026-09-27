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

const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

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

	const numbered = scenes.map((scene, index) => ({ ...scene, sceneNumber: index + 1 }));

	// Replace the final content scene with the closing statement, so the video
	// ends on a conclusion rather than trailing off mid-topic.
	const conclusion = buildConclusionScene({
		cleanText,
		outline,
		documentTitle: options.documentTitle || '',
	});
	if (!conclusion) return numbered;

	return [
		...numbered.slice(0, -1),
		{ ...numbered[numbered.length - 1], ...conclusion, sceneNumber: numbered.length },
	];
}

/**
 * Build the closing statement as a standalone scene.
 *
 * A documentary needs a landing, and it has to be about THIS document. The
 * substance comes from the document itself: its own final sentence supplies the
 * takeaway, its own key terms name what the video was about, and its own title
 * frames the close. Only the connective tissue is written here, and it is kept
 * short — a closing statement is 30 to 60 words, not a paragraph.
 *
 * This is used for BOTH script paths. Asking a model to write the conclusion
 * does not work reliably: it labels its last content scene "Conclusion" and
 * leaves it as an ordinary paragraph. Building it here means every documentary
 * ends the same way, and the wording is still document-specific.
 *
 * @returns {object} a scene, or null when the document has too little text.
 */
function buildConclusionScene({ cleanText, outline = [], documentTitle = '' }) {
	const text = String(cleanText || '').trim();
	if (!text) return null;

	// The document's own closing sentence, quoted rather than paraphrased. Later
	// lines are often "Thank you" or "Questions", so take the last substantive
	// one that is not boilerplate.
	const sentences = streamSentences(text);
	const ownClosing = sentences
		.map((s) =>
			// A heading on its own line gets joined to the sentence below it, so
			// "Conclusion Quality is not achieved by..." arrives with the heading
			// still attached. Strip it wherever it appears.
			String(s)
				.replace(
					/^\s*(?:conclusion|concluding|conclude|in summary|to conclude|overview|references|bibliography|thank you|thanks|questions?)\s*[:\-—]?\s*/i,
					'',
				)
				.replace(
					/\s+(?:conclusion|concluding|in summary|to conclude|references|bibliography|thank you|thanks|questions?)\s+(?=[A-Z])/gi,
					' ',
				)
				.trim(),
		)
		.filter(
			(s) =>
				wordCount(s) >= 12 &&
				wordCount(s) <= 45 &&
				// Must be a complete sentence. The sentence stream breaks
				// over-long text at clause boundaries, so a candidate can be a
				// fragment ending mid-word ("...uncomfortable informatio").
				// Quoting that as the takeaway reads as a bug.
				/[.!?]$/.test(s) &&
				/\p{L}{3,}[.!?]$/u.test(s) &&
				!/^(thank you|thanks|questions?|q&a|summary|references|bibliography)\b/i.test(s),
		)
		.pop() || '';

	// A short label for the subject. Outline entries are only usable when they
	// are real headings: lecture decks put whole sentences on one line, and
	// quoting a truncated sentence reads terribly.
	const headingSubjects = outline
		.map((h) => String(h).trim().replace(/\s*[.:;]\s*$/, ''))
		.filter((h) => {
			const n = wordCount(h);
			return n >= 1 && n <= 5 && /^[A-Za-z]/.test(h);
		})
		.filter((h) => !STRUCTURAL_HEADING.test(h));

	// Fall back to the document's own distinctive words, preferring nouns. A bare
	// frequency list reads as a word salad ("measures quality software"), so
	// -tion/-ment endings are preferred over verbs and adverbs.
	const candidates = text.match(/[A-Za-z][A-Za-z-]{3,18}/g) || [];
	const nouns = candidates.filter((w) => /(?:tion|ment|ness|ity|ance|ence|ism|ics|ology)$/i.test(w));
	const ranked = (list) => {
		const counts = new Map();
		for (const w of list) {
			const k = w.toLowerCase();
			if (STOPWORDS.has(k) || STRUCTURAL_HEADING.test(k)) continue;
			counts.set(k, (counts.get(k) || 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
			.slice(0, 3)
			.map(([w]) => w);
	};
	const subjectTerms = headingSubjects.length >= 2
		? headingSubjects.slice(0, 3)
		: ranked(nouns).length >= 2
			? ranked(nouns)
			: ranked(candidates);

	const subject = subjectTerms.join(', ') || 'what this document sets out to explain';
	// A list of three is plural, so the verb has to agree.
	const agrees = subjectTerms.length === 1 ? 'is' : 'are';

	const title = String(documentTitle || '').trim().replace(/\s*[.:;]\s*$/, '');

	const parts = [
		title
			? `Put side by side, ${subject} ${agrees} what ${title} has been building towards.`
			: `Put side by side, ${subject} ${agrees} what this material builds towards.`,
		ownClosing ||
			`If you keep one thing from it, keep this: ${subject} ${agrees} the thread running through all of it.`,
		'That is where this leaves us.',
	];

	const narratorText = parts
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/\s+([.!?])/g, '$1')
		.trim();

	const imageKeyword = (keyTerms(text, 3).join(' ') || 'key takeaway summary')
		.slice(0, 48)
		.trim();

	// One beat: the closing card holds for the whole statement.
	const beatAnchor = narratorText.split(' ').find((w) => w.length > 3) || 'Put';

	return {
		narratorText,
		title: 'Conclusion',
		badge: 'Conclusion',
		visualPrompt:
			"The closing statement, with the document's own key terms shown together as a summary.",
		imageKeyword,
		beats: [
			{
				atWord: beatAnchor,
				imageKeyword,
				label: 'Key takeaway',
				focusArea: { x: 0.3, y: 0.35, w: 0.4, h: 0.22 },
			},
		],
		isConclusion: true,
	};
}

/** Headings that organise a document rather than describe its subject. */
const STRUCTURAL_HEADING =
	/^(summary|conclusion|concluding|overview|introduction|contents|agenda|references|bibliography|objectives|goals?|outline|topics?|questions?|q&a|thank you|appendix|notes?)$/i;

module.exports = { generateDocumentScenes, buildConclusionScene, toSentences, keyTerms };

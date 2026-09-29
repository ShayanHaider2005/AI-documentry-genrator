'use strict';

/**
 * query.js — answer a question about a user's own PDF.
 *
 * Retrieval is local (retrieval.js). Synthesis goes through llm.js, which walks
 * Groq -> Gemini -> Grok -> OpenAI and every candidate model each provider
 * offers. The caller gets the answer, the pages it came from, and which provider
 * actually answered, so the UI can show it and a failure can be diagnosed.
 *
 * Exports: answerQuestion, RAG_SYSTEM_PROMPT
 */

const { buildIndex, rank } = require('./retrieval');
const { chatCompletion, getAiProvider, getAiProviders } = require('../llm');

/**
 * The system prompt.
 *
 * The two instructions that matter are the citation one — without it the model
 * paraphrases the source and attaches whatever page badges look plausible —
 * and the abstention one. A PDF chatbot that invents an answer when the document
 * is silent is worse than one that says the document does not say, because the
 * user cannot tell which they got.
 */
const RAG_SYSTEM_PROMPT = `You are DocuBot, answering questions about one specific document.

Rules:
- Answer ONLY from the CONTEXT blocks given to you. They are excerpts of the document, each labelled with its page.
- CITE EVERY FACT. End each sentence that draws on the document with its page in square brackets, like [p.4] or [p.4, p.7]. An uncited sentence reads as guesswork to the user, so there must be no uncited sentences.
- If the CONTEXT does not contain the answer, say so plainly: "The document does not cover this." Then say what it does cover, if that is useful. Never guess, and never fill a gap with general knowledge about the subject.
- If the CONTEXT contradicts itself, say that the document states both, with each page.
- Be concise and concrete. Two or three sentences for a simple question. No preamble, no restating the question, no offers of further help.
- Plain prose. No markdown headings, no bullet lists unless the question asked for a list. Write the citation as "[p.4]" in plain text, not as a link or a footnote.`;

const MAX_CONTEXT_CHARS = 12000;

/**
 * Words that ask about a document rather than about its content.
 *
 * A question made entirely of these is a request for an overview. "What is
 * this document about?" survives stopword removal as exactly these three, and
 * no document contains the word "document" as a searchable topic.
 */
const META_WORDS = new Set(
	`about document documents paper article section sections chapter chapters
	summarise summarize summary overview contents content main key keys
	define defines definition definitions explain description tell
	conclusion conclude conclusions overall brief gist
	what which where when who how why does doing do is are this these those it`
		.split(/\s+/)
		.filter(Boolean),
);

/** Whether a question is asking about the document in general. */
function isOverviewRequest(question) {
	const { tokenize } = require('./retrieval');
	const terms = [...new Set(tokenize(question))];
	// An empty question is not an overview request, it is a non-question.
	return terms.length > 0 && terms.every((t) => META_WORDS.has(t));
}

/**
 * The document's most distinctive vocabulary.
 *
 * Used to build a real retrieval query for an overview, so the context is the
 * document's actual subject matter rather than whichever page happened to come
 * first. Terms appearing across several chunks are the ones characteristic of
 * the document, so a term in only one chunk is skipped: that is a detail, not
 * a subject.
 */
function subjectTerms(index, limit = 8) {
	const floor = Math.max(2, Math.ceil(index.documentCount / 5));
	const scored = [];
	for (const [term, df] of index.documentFrequency) {
		if (df < floor) continue;
		scored.push([term, df]);
	}
	scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return scored.slice(0, limit).map(([t]) => t);
}

/**
 * Answer a question from a user's bundle.
 *
 * @param {object} options
 * @param {string} options.bundleDir  the user's own bundle directory
 * @param {string} options.question
 * @param {number} [options.limit=5]  how many chunks to retrieve
 * @returns {Promise<{answer: string, sources: object[], activeProvider: string|null,
 *   degraded?: string, retrieved?: number, indexed?: number}>}
 */
async function answerQuestion({ bundleDir, question, limit = 5 }) {
	const clean = String(question || '').trim();
	if (!clean) {
		return { answer: 'Ask me something about the document.', sources: [], activeProvider: null };
	}

	const index = await buildIndex(bundleDir);
	if (!index) {
		return {
			answer:
				'I do not have a document to read yet. Drop a PDF on the left and I will convert it, then answer from it.',
			sources: [],
			activeProvider: null,
		};
	}

	// An overview question is answered from the document's vocabulary rather
	// than the user's, because the user's words are meta-words by definition.
	// A nonsense question is left alone: its terms are in no vocabulary at all,
	// so "no match" remains the honest answer for it.
	const subject = subjectTerms(index);
	const overview = subject.length > 0 && isOverviewRequest(clean);
	const hits = rank(index, overview ? subject.join(' ') : clean, limit);

	// A real search that found nothing is a distinct outcome from a failed
	// search, and conflating them would either send the model off to invent
	// something or make it look like the tool is broken.
	if (!hits.length) {
		return {
			answer: `I could not find anything about that in "${index.manifest.title}". Try the document's own vocabulary, or ask about one of the page links on the left.`,
			sources: [],
			activeProvider: null,
			// Reported so the UI can say "nothing matched" rather than leaving
			// the user to wonder whether the search ran at all.
			retrieved: 0,
			indexed: index.documentCount,
		};
	}

	// Cap the context by characters, not by chunk count: a dense table page
	// costs five times what a paragraph does, and a fixed count of five could
	// either waste the window or miss the sixth chunk that held the answer.
	const used = [];
	let contextChars = 0;
	for (const hit of hits) {
		const block = `[p.${hit.node.page}] ${hit.node.title}\n${hit.node.text}`;
		if (contextChars + block.length > MAX_CONTEXT_CHARS) break;
		used.push({ hit, block });
		contextChars += block.length;
	}
	if (!used.length) {
		// The single best chunk is bigger than the whole window. Truncating it
		// beats refusing to answer.
		const block = `[p.${hits[0].node.page}] ${hits[0].node.title}\n${hits[0].node.text.slice(0, MAX_CONTEXT_CHARS)}`;
		used.push({ hit: hits[0], block });
	}

	if (!getAiProvider()) {
		// No key. Retrieval still works, so show what was found rather than
		// failing outright — it is genuinely useful and it proves the index
		// built.
		return {
			answer:
				'I found the relevant pages but no AI provider is configured, so I cannot summarise them. Add a GROQ_API_KEY or GEMINI_API_KEY to the .env file and I will answer in full.',
			sources: used.map(toSource),
			activeProvider: null,
			indexed: index.documentCount,
			retrieved: used.length,
		};
	}

	const context = used.map((u) => u.block).join('\n\n---\n\n');
	// The citation requirement is restated at the end of the user message, not
	// only in the system prompt. Repetition here is deliberate: the system
	// prompt alone did not survive contact with the model.
/**
 * Extra instruction for an overview question.
 *
 * Without it, a general question like "what is this about?" is answered as
 * though it were a specific lookup, and the result is a thin summary with no
 * orientation. The context for these is chosen from the document's own
 * vocabulary rather than the user's, so the model is told that is what happened.
 */
const OVERVIEW_INSTRUCTION =
	'\n\n(The question asks about the document in general rather than about one specific detail, so introduce the document: what it is, what it covers, and how it is organised.)';

	const citationReminder =
		'\n\nRemember: cite the page for every fact, in square brackets like [p.4].';
	const providers = getAiProviders()
		.map((p) => p.name)
		.join(' -> ');

	let result;
	try {
		result = await chatCompletion({
			system: RAG_SYSTEM_PROMPT,
			user: `DOCUMENT: ${index.manifest.title}\n\nCONTEXT:\n"""\n${context}\n"""\n\nQUESTION: ${clean}${overview ? OVERVIEW_INSTRUCTION : ''}${citationReminder}`,
			temperature: 0.2,
			maxTokens: 800,
		});
	} catch (err) {
		// Every provider and every model failed. Returning the error text is
		// more useful than a generic apology, and it says what to fix.
		return {
			answer: `I could not reach any AI provider. Tried ${providers}. The last error was: ${err.message}`,
			sources: used.map(toSource),
			activeProvider: null,
			degraded: 'providers-exhausted',
			indexed: index.documentCount,
			retrieved: used.length,
		};
	}

	// Groq first, so an answer served by Gemini means something was wrong with
	// the primary. Reported to the UI, which labels it.
	const degraded =
		providers.startsWith(result.provider) || result.provider === providers.split(' -> ')[0]
			? undefined
			: `served by ${result.provider} after the primary provider failed`;

	return {
		answer: ensureCitations(result.text.trim(), used),
		sources: used.map(toSource),
		activeProvider: result.provider,
		model: result.model,
		degraded,
		indexed: index.documentCount,
		retrieved: used.length,
	};
}

/**
 * Guarantee the answer points at pages.
 *
 * A strengthened prompt is still a request, and the model does not always
 * comply. Rather than ship an answer the UI cannot substantiate, append the
 * retrieved pages when the model cited nothing.
 *
 * Deliberately coarse: it lists the pages retrieval returned, not which page
 * supports which clause. Mapping clauses to pages would mean guessing, and a
 * wrong citation is worse than an honest one. The structured `sources` array
 * carries the real per-chunk detail for the UI.
 */
function ensureCitations(answer, used) {
	if (!answer) return answer;
	if (/\[p\.[\d,\s]+\]/.test(answer)) return answer;
	if (!used.length) return answer;
	const pages = [...new Set(used.map((u) => u.hit.node.page))].sort((a, b) => a - b);
	const listed = pages.map((p) => `[p.${p}]`).join(', ');
	return `${answer.trim()}\n\nDrawn from page${pages.length === 1 ? '' : 's'} ${listed} of the document.`;
}

/** A source badge: which page, and why it was retrieved. */
const toSource = ({ hit }) => ({
	page: hit.node.page,
	title: hit.node.title,
	file: hit.node.id,
	score: Number(hit.score.toFixed(3)),
	coverage: Number(hit.coverage.toFixed(2)),
});

module.exports = { answerQuestion, RAG_SYSTEM_PROMPT };

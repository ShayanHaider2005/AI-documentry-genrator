'use strict';

/**
 * retrieval.js — local BM25 ranking over an OKF bundle.
 *
 * 100% local, zero API tokens, no model weights, no network. See the header of
 * okf.js for why this is BM25 and not LlamaIndex plus BAAI/bge-small.
 *
 * Exports: buildIndex, rank, isStopword
 */

const { readBundle } = require('./okf');

/**
 * Words that match everything and therefore discriminate nothing.
 *
 * The list is short on purpose. Aggressive stopword removal is the usual way a
 * hand-rolled retriever quietly loses the words that matter — "not", "no",
 * "only", "than" — and a document question is frequently a negation question
 * ("what does the paper *not* conclude"). Those four stay in.
 */
const STOPWORDS = new Set(
	`a an and are as at be but by for from has have he her his i if in into is it its of on or
	she that the their them there these they this to was were will with you your`
		.split(/\s+/)
		.filter(Boolean),
);

/** Very short words cannot carry a document question's meaning. */
const isStopword = (word) => STOPWORDS.has(word) || word.length < 3;

/**
 * Split into terms.
 *
 * Keeps digits and interior punctuation so `sha-256` and `v1.2` survive as
 * searchable tokens, which is exactly the kind of token a technical document
 * question is about.
 */
const tokenize = (text) =>
	String(text || '')
		.toLowerCase()
		.split(/[^a-z0-9][^a-z0-9.+#_-]*/g)
		.flatMap((chunk) => chunk.split(/[-._+#/]/))
		.map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
		.filter((w) => w && !isStopword(w));

/** BM25 term-frequency saturation. */
const tf = (count) => {
	const k1 = 1.2;
	return (count * (k1 + 1)) / (count + k1);
};

/**
 * Build an index over a converted bundle.
 *
 * Reads the bundle from disk on every call rather than caching, because the
 * bundle is per-user and mutable — a cached index keyed on the wrong user is
 * precisely the cross-user leak this feature must not have. Bundles are a few
 * hundred small files, so the read is cheap and correctness is worth more.
 *
 * @param {string} outDir already scoped to one user
 */
async function buildIndex(outDir) {
	const bundle = await readBundle(outDir);
	if (!bundle) return null;

	const nodes = bundle.nodes.map((node) => {
		const terms = tokenize(node.text);
		const counts = new Map();
		for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
		return {
			...node,
			terms,
			counts,
			length: terms.length,
			// The title is repeated so a document question that names a heading
			// ranks the chunk under that heading above an incidental mention.
			titleTerms: tokenize(node.title),
		};
	});

	const totalLength = nodes.reduce((sum, n) => sum + n.length, 0) || 1;

	// Document frequency: how many nodes contain each term.
	const documentFrequency = new Map();
	for (const node of nodes) {
		for (const term of node.counts.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
		}
	}

	return {
		manifest: bundle.manifest,
		nodes,
		totalLength,
		averageLength: totalLength / nodes.length,
		documentFrequency,
		documentCount: nodes.length,
	};
}

/**
 * Rank nodes against a question.
 *
 * @param {object} index   from buildIndex
 * @param {string} question
 * @param {number} [limit=5]
 * @returns {{node, score}[]} best first; empty when nothing matches
 */
function rank(index, question, limit = 5) {
	if (!index || !index.nodes.length) return [];
	const queryTerms = [...new Set(tokenize(question))];
	if (!queryTerms.length) return [];

	const N = index.documentCount;
	const k1 = 1.2;
	const b = 0.75;
	const scored = [];

	for (const node of index.nodes) {
		let score = 0;
		let matched = 0;

		for (const term of queryTerms) {
			const count = node.counts.get(term) || 0;
			const df = index.documentFrequency.get(term) || 0;
			if (!count || !df) continue;
			matched += 1;

			// Robertson/Sparck Jones idf, floored at a small positive so a term
			// appearing in every node contributes its tf but not a negative
			// score, which would let an irrelevant long chunk outrank a
			// relevant short one.
			const idf = Math.max(
				0.05,
				Math.log(1 + (N - df + 0.5) / (df + 0.5)),
			);
			const lengthNorm =
				1 - b + (b * node.length) / index.averageLength;

			let contribution = idf * tf(count) * (k1 + 1) / (count + k1 * lengthNorm);

			// A hit in the heading is a strong signal that this chunk is the one
			// being asked about.
			if (node.titleTerms.includes(term)) contribution *= 1.6;

			score += contribution;
		}

		// Require a real match, not one incidental common word.
		if (!matched || score <= 0) continue;
		scored.push({ node, score, matchedTerms: matched });
	}

	scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

	// Coverage matters more than raw score when a question spans two pages: a
	// chunk matching three of four query terms beats one matching four terms
	// twice as strongly, so nudge by how much of the question was found.
	const top = scored.slice(0, limit);
	return top.map((entry) => ({
		...entry,
		coverage: entry.matchedTerms / queryTerms.length,
		score: entry.score * (0.6 + 0.4 * (entry.matchedTerms / queryTerms.length)),
	}));
}

module.exports = { buildIndex, rank, tokenize, isStopword, STOPWORDS };

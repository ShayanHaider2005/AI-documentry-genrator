'use strict';

/**
 * visuals.js — Contextual visual generation for the documentary engine.
 *
 * The engine must never fall back to a generic stock photo. When a contextual
 * photo is unavailable (no Pexels key, a non-specific keyword, or a rate limit)
 * we synthesise a *document diagram* from the actual PDF content instead: a page
 * layout built from the real heading outline of the source document.
 *
 * Exports:
 *   deriveTitle(cleanText)                    → clean subject title for a session
 *   extractOutline(cleanText, limit)          → ordered section headings
 *   isSpecificKeyword(keyword)                → rejects vague stock queries
 *   buildDocumentDiagram(opts)                → data-URI SVG of the document layout
 *   buildFocusArea(outline, index, box)       → normalised focus rectangle
 */

const DIAGRAM_WIDTH = 1920;
const DIAGRAM_HEIGHT = 1080;

/** Vague terms that make a stock query meaningless as documentation. */
const GENERIC_KEYWORDS = new Set(
	[
		'technology', 'tech', 'business', 'team', 'work', 'office', 'computer',
		'internet', 'data', 'digital', 'future', 'modern', 'abstract', 'background',
		'concept', 'idea', 'system', 'systems', 'network', 'server', 'code', 'coding',
		'software', 'computer science', 'programming', 'development', 'engineering',
		'professional', 'success', 'growth', 'innovation', 'solution', 'solutions',
		'generic', 'misc', 'other', 'stock', 'photo', 'image', 'wallpaper',
	].reduce((set, word) => {
		set.add(word);
		// also block the plural/singular variants
		if (word.endsWith('s')) set.add(word.slice(0, -1));
		else set.add(`${word}s`);
		return set;
	}, new Set()),
);

/** Document scaffolding that should never become a "section". */
const NON_SECTION = /^(introduction|conclusion|overview|objectives?|aims?|summary|contents?|references?|appendix|notes?|agenda|outline|abstract|keywords?)\b/i;

/** Instructor credentials and bio fragments that pollute heading detection. */
const CREDENTIAL_LINE =
	/\b(graduat|bachelor|masters?|phd|doctorate)\b|\b(b\.?s\.?|m\.?s\.?|bsse|msse|bscs|mscs)\b/i;

/** Administrative headings that describe the course, not the subject. */
const ADMIN_HEADING =
	/\b(course|syllabus|credits?|grading|instructor|professor|lecturer|faculty|university|department|assessment\s+criteria|topics?\s+of\s+the\s+course)\b/i;

/**
 * Derive a clean human-readable subject title from sanitized PDF text.
 */
function deriveTitle(cleanText) {
	const lines = String(cleanText || '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines.slice(0, 25)) {
		const cleaned = line
			.replace(/^[\d]+[.)]\s*/, '')
			.replace(/^[-–—•*]+\s*/, '')
			.trim();

		const words = cleaned.split(/\s+/);
		const isHeadingish =
			cleaned.length >= 8 &&
			cleaned.length <= 70 &&
			words.length <= 10 &&
			!/[.;,]$/.test(cleaned) &&
			!/[=~]{2,}/.test(cleaned);

		if (isHeadingish) return toTitleCase(cleaned);
	}

	const fallback = lines[0] || 'Untitled Document';
	return toTitleCase(fallback.split(/[.!?]/)[0].slice(0, 70));
}

const toTitleCase = (value) =>
	String(value)
		.split(/\s+/)
		.map((word) =>
			word.length <= 4 && /^(of|and|or|the|in|for|to|a|an)$/i.test(word)
				? word.toLowerCase()
				: word.charAt(0).toUpperCase() + word.slice(1),
		)
		.join(' ');

/**
 * Extract an ordered outline (section headings) from sanitized PDF text.
 * Falls back to evenly sampled sentences when no headings are detectable, so a
 * diagram always reflects the real document.
 */
function extractOutline(cleanText, limit = 8) {
	const lines = String(cleanText || '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	// Headings live in the first part of a document; the tail is references.
	const scanLimit = Math.max(20, Math.floor(lines.length * 0.65));

	const headings = [];
	const seen = new Set();

	for (const line of lines.slice(0, scanLimit)) {
		if (headings.length >= limit) break;

		// Drop trailing page numbers ("SOFTWARE QUALITY ENGINEERING 6").
		const cleaned = line
			.replace(/^[\d]+[.)]\s*/, '')
			.replace(/^[-–—•*]+\s*/, '')
			.replace(/\s+\d{1,3}\s*$/, '')
			.trim();
		const words = cleaned.split(/\s+/);

		if (words.length < 1 || words.length > 9) continue;
		if (cleaned.length < 4 || cleaned.length > 68) continue;
		if (/[.;,:]$/.test(cleaned)) continue;
		if (/^[\d\s.,%/-]+$/.test(cleaned)) continue;
		if (NON_SECTION.test(cleaned)) continue;
		if (CREDENTIAL_LINE.test(cleaned)) continue;
		if (ADMIN_HEADING.test(cleaned)) continue;
		// A heading is title-ish: most words start uppercase (first char of line).
		const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
		if (capitalised < Math.max(1, Math.ceil(words.length / 2) - 1)) continue;

		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		headings.push(cleaned);
	}

	if (headings.length >= 3) return headings;

	// No detectable structure: derive topics from the prose itself.
	const sentences = String(cleanText || '')
		.replace(/\n+/g, ' ')
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.split(/\s+/).length >= 6);

	if (sentences.length === 0) return ['Document Overview'];

	const step = Math.max(1, Math.floor(sentences.length / limit));
	const derived = [];
	for (let i = 0; i < sentences.length && derived.length < limit; i += step) {
		derived.push(toTitleCase(sentences[i].split(/\s+/).slice(0, 7).join(' ')));
	}
	return derived.length > 0 ? derived : ['Document Overview'];
}

/**
 * Reject stock queries that carry no documentary meaning. A specific keyword
 * must be 2+ words and must contain at least one content-bearing term.
 */
function isSpecificKeyword(keyword) {
	const words = String(keyword || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.split(/\s+/)
		.filter(Boolean);

	if (words.length < 2 || words.length > 5) return false;
	return words.some((word) => !GENERIC_KEYWORDS.has(word));
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * The single source of truth for the diagram geometry.
 *
 * Both the SVG renderer and the focus-area calculator use this, so the animated
 * pointer always lands exactly on the block it highlights. The page stops above
 * the caption band (the lower ~28% of the frame) so no diagram content is ever
 * hidden behind the subtitles.
 */
function computeDiagramLayout(itemCount, columns = 2) {
	const cols = Math.max(1, columns);
	const rows = Math.max(1, Math.ceil(itemCount / cols));

	const pageX = 0.2;
	const pageY = 0.09;
	const pageW = 0.6;
	const pageH = 0.6;
	const headerH = 0.075;
	const padX = 0.03;
	const padY = 0.022;

	const gridX = pageX + padX;
	const gridY = pageY + headerH + padY;
	const gridW = pageW - padX * 2;
	const gridH = pageH - headerH - padY * 2;

	const cellW = gridW / cols;
	const cellH = gridH / rows;
	const blockW = cellW * 0.82;
	const blockH = cellH * 0.7;

	/** Normalised rectangle of the block at `index`. */
	const rectAt = (index) => {
		const col = index % cols;
		const row = Math.floor(index / cols);
		return {
			x: gridX + col * cellW + (cellW - blockW) / 2,
			y: gridY + row * cellH + (cellH - blockH) / 2,
			w: blockW,
			h: blockH,
		};
	};

	return {
		pageX, pageY, pageW, pageH, headerH, padX,
		cols, rows, cellW, cellH, blockW, blockH, rectAt,
	};
}

/**
 * Compute a normalised focus rectangle (0..1) over the diagram for a scene.
 * `focus` is the fraction of the scene where the narrator reaches this point.
 */
function buildFocusArea(outline, index, { focus = 0.5, columns = 2 } = {}) {
	const items = outline.length > 0 ? outline : ['Document Overview'];
	const layout = computeDiagramLayout(items.length, columns);
	const safeIndex = Math.min(Math.max(index, 0), items.length - 1);
	const rect = layout.rectAt(safeIndex);

	return {
		x: Number(clamp01(rect.x).toFixed(4)),
		y: Number(clamp01(rect.y).toFixed(4)),
		w: Number(clamp01(rect.w).toFixed(4)),
		h: Number(clamp01(rect.h).toFixed(4)),
		label: items[safeIndex] || '',
		focus: Number(clamp01(focus).toFixed(3)),
	};
}

const escapeXml = (value) =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

/** Break a label into at most two lines that fit inside a block. */
const wrapLabel = (label, maxChars = 26) => {
	const words = String(label || '').split(/\s+/);
	const lines = [];
	let current = '';
	for (const word of words) {
		if ((current + ' ' + word).trim().length > maxChars) {
			lines.push(current.trim());
			current = word;
			if (lines.length === 2) break;
		} else {
			current = `${current} ${word}`;
		}
	}
	if (lines.length < 2 && current.trim()) lines.push(current.trim());
	return lines.slice(0, 2);
};

/**
 * Render a document-structure diagram as an SVG data URI.
 *
 * The visual mirrors the composition's layout (a centred page over a dark
 * backdrop) so the animated cursor overlay in the composition lands exactly on
 * the highlighted block.
 */
function buildDocumentDiagram({
	title = 'Document',
	outline = [],
	imageKeyword = '',
	sceneNumber = 1,
	totalScenes = 1,
	columns = 2,
} = {}) {
	const W = DIAGRAM_WIDTH;
	const H = DIAGRAM_HEIGHT;

	const items = outline.length > 0 ? outline : ['Document Overview'];
	const layout = computeDiagramLayout(items.length, columns);
	const {
		pageX, pageY, pageW, pageH, headerH, padX, cols, rows, rectAt,
	} = layout;

	const blocks = items
		.map((label, index) => {
			const rect = rectAt(index);
			const bx = rect.x * W;
			const by = rect.y * H;
			const bw = rect.w * W;
			const bh = rect.h * H;
			const [line1, line2] = wrapLabel(label);
			const textX = bx + bw / 2;
			const textY = by + bh / 2 - (line2 ? 11 : 0);
			const fontSize = Math.max(18, Math.min(26, bw / 15));

			return `
    <g>
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(
				1,
			)}" height="${bh.toFixed(1)}" rx="12" fill="#1e293b" stroke="#334155" stroke-width="2"/>
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(
				1,
			)}" width="6" height="${bh.toFixed(1)}" rx="3" fill="#0ea5e9"/>
      <text x="${textX.toFixed(1)}" y="${textY.toFixed(1)}" text-anchor="middle" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize.toFixed(
				0,
			)}" font-weight="600" fill="#e2e8f0">${escapeXml(line1)}</text>${
				line2
					? `<text x="${textX.toFixed(1)}" y="${(textY + fontSize + 8).toFixed(
							1,
					  )}" text-anchor="middle" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize.toFixed(
								0,
					  )}" font-weight="600" fill="#e2e8f0">${escapeXml(line2)}</text>`
					: ''
			}
    </g>`;
		})
		.join('');

	// Connector arrows between the columns of each row, derived from the same
	// rects the blocks use so they always line up.
	const arrows =
		cols > 1
			? Array.from({ length: rows }, (_, row) => {
					const left = rectAt(row * cols);
					const right = rectAt(row * cols + (cols - 1));
					const y = (left.y + left.h / 2) * H;
					const fromX = (left.x + left.w + 0.012) * W;
					const toX = Math.max(fromX + 12, (right.x - 0.012) * W);
					return `<line x1="${fromX.toFixed(1)}" y1="${y.toFixed(
						1,
					)}" x2="${toX.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#475569" stroke-width="3" marker-end="url(#arrow)"/>`;
				}).join('')
			: '';

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/>
    </marker>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#111c31"/>
      <stop offset="100%" stop-color="#0b1424"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#070b14"/>
  <rect x="${(pageX * W).toFixed(1)}" y="${(pageY * H).toFixed(1)}" width="${(
		pageW * W
	).toFixed(1)}" height="${(pageH * H).toFixed(1)}" rx="18" fill="url(#page)" stroke="#1e293b" stroke-width="3"/>
  <rect x="${(pageX * W).toFixed(1)}" y="${(pageY * H).toFixed(1)}" width="${(
		pageW * W
	).toFixed(1)}" height="${(headerH * H).toFixed(1)}" rx="18" fill="#0f1b30"/>
  <text x="${((pageX + padX) * W).toFixed(1)}" y="${(
		(pageY + headerH * 0.7) * H
	).toFixed(1)}" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#f8fafc">${escapeXml(
		String(title).slice(0, 60),
	)}</text>
  <text x="${((pageX + pageW - padX) * W).toFixed(1)}" y="${(
		(pageY + headerH * 0.7) * H
	).toFixed(1)}" text-anchor="end" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="22" font-weight="600" fill="#64748b">Scene ${sceneNumber} / ${totalScenes}</text>${blocks}${arrows}
  <text x="${(pageX * W).toFixed(1)}" y="${((pageY + pageH) * H + 40).toFixed(
		1,
	)}" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="22" fill="#475569">Visual derived from the source document${
		imageKeyword ? ` · ${escapeXml(String(imageKeyword).slice(0, 70))}` : ''
	}</text>
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

module.exports = {
	deriveTitle,
	extractOutline,
	isSpecificKeyword,
	buildDocumentDiagram,
	buildFocusArea,
};

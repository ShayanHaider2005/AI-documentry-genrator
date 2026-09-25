'use strict';

/**
 * parsePdf.js — PDF extraction + aggressive junk sanitization.
 * Exports: parseAndCleanPdf(pdfPath) → Promise<string>
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Fallback PDF generator (used when no real PDF is found)
// ---------------------------------------------------------------------------
function createFallbackPdf(text) {
	const escapePdfText = (value) =>
		value.replace(/([\\/()])/g, '\\$1').replace(/[^\x20-\x7E]/g, ' ');
	const content = `BT\n/F1 16 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		`<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(Buffer.byteLength(pdf, 'ascii'));
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(pdf, 'ascii');
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let i = 1; i < offsets.length; i++) {
		pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf, 'ascii');
}

// ---------------------------------------------------------------------------
// Junk-line patterns — lines matching ANY of these are dropped entirely
// ---------------------------------------------------------------------------
const JUNK_LINE_PATTERNS = [
	// Administrative headings
	/^\s*(?:office\s+hours?|email|e-mail|phone|telephone|contact|room|building)\b/i,
	// Structural slide labels as standalone lines
	/^\s*(?:agenda|outline|table\s+of\s+contents|references?)\s*:?\s*$/i,
	// Course codes on their own line (e.g. "SE-3002" or "CS101")
	/^\s*[A-Z]{2,}[A-Z0-9]*[\s-]\d{2,}\s*$/,
	// Bare URLs
	/^\s*(?:https?:\/\/|www\.)/i,
	// Slide-footer patterns: "-- 5 of 63 -" or "Page 5 of 63"
	/^\s*[-–—]*\s*\d+\s+of\s+\d+\s*[-–—]*\s*$/i,
	// Standalone numbers / roman numerals (section labels with no text)
	/^\s*(?:\d{1,3}\.?|[ivxlcdm]+\.?)\s*$/i,
	// Grading / mark distribution lines
	/^\s*(?:assignments?|quizzes?|mid\s*exam|final\s*exam|grading|mark\s*distribution|absolute\s*grading)\s*[:%]?/i,
];

// Admin keyword density guard — drops lines where >25% of words are admin terms
const ADMIN_KEYWORDS_RE =
	/\b(?:office\s+hours?|room\s+\d|building|course\s+code|section|semester|instructor|professor|lecture\s+#|slide\s+#|page\s+\d|assignment|grading|attendance|exam|quiz|deadline|submission|presentation|project\s+proposal)\b/gi;

// ---------------------------------------------------------------------------
// Core per-line sanitizer
// ---------------------------------------------------------------------------
function sanitizeRawText(rawText) {
	return (
		String(rawText)
			// Strip non-printable / control characters
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
			// Rejoin words hyphenated across a line break
			.replace(/-\s*\r?\n\s*/g, '')
			.split(/\r?\n/)
			.map((line) => {
				let l = line
					// Strip bullet symbols and list markers
					.replace(/^\s*(?:[-*+•▪◦‣→➜➤■□▶➢]|\d+[.)])\s+/, '')
					// Strip email addresses
					.replace(/\b\S+@\S+\b/g, '')
					// Strip phone numbers
					.replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '')
					// Strip course codes (SE-3002, CS101, etc.)
					.replace(/\b[A-Z]{2,}[A-Z0-9]*[-\s]?\d{2,}\b/g, '')
					// Strip slide / lecture / page references
					.replace(/\b(?:slide|lecture|page)\s*#?\s*\d+(?:\s+of\s+\d+)?\b/gi, '')
					// Strip slide-footer dash patterns: "-- N of M -"
					.replace(/[-–—]+\s*\d+\s+of\s+\d+\s*[-–—]*/g, '')
					// Strip dates
					.replace(/\b(?:\d{1,2}[/-]){2}\d{2,4}\b/g, '')
					// Strip remaining Unicode bullet / arrow glyphs
					.replace(/[\u2022\u25AA\u25E6\u2023\u2192\u2794\u27A4\u25A0\u25A1\u25B6\u27A2]/g, '')
					// Strip non-alphanumeric / non-punctuation characters
					.replace(/[^\p{L}\p{N}\s.,!?;:'"()\-/]/gu, ' ')
					// Collapse whitespace
					.replace(/\s+/g, ' ')
					.trim();

				// Drop line if it matches a hard junk pattern
				if (JUNK_LINE_PATTERNS.some((pat) => pat.test(l))) return '';

				// Drop line if >25% of its words are administrative keywords
				const wordCount = l.split(/\s+/).filter(Boolean).length;
				const adminHits = (l.match(ADMIN_KEYWORDS_RE) || []).length;
				if (wordCount > 0 && adminHits / wordCount >= 0.25) return '';

				// Drop very short lines that carry no real educational content (<4 words)
				if (wordCount < 4) return '';

				return l;
			})
			.filter(Boolean)
			.join('\n')
			.replace(/[ \t]+/g, ' ')
			.replace(/\n{2,}/g, '\n')
			.trim()
	);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a PDF file and return a sanitized plain-text string containing ONLY
 * substantive educational content — all administrative noise is stripped.
 *
 * @param {string} pdfPath  Path to the PDF file.
 * @returns {Promise<string>} Clean, sanitized text.
 */
async function parseAndCleanPdf(pdfPath) {
	if (typeof pdfPath !== 'string' || pdfPath.trim() === '') {
		throw new TypeError('pdfPath must be a non-empty file path string');
	}

	let fileBuffer;

	if (fs.existsSync(pdfPath)) {
		console.log(`[PDF] Reading: ${pdfPath}`);
		fileBuffer = fs.readFileSync(pdfPath);
	} else {
		console.warn(`[PDF] File not found: ${pdfPath} — generating fallback PDF`);
		await fs.promises.mkdir(path.dirname(pdfPath), { recursive: true });
		const fallbackText =
			'This is a fallback documentary source. Place a real PDF at server/sample.pdf to replace it.';
		fileBuffer = createFallbackPdf(fallbackText);
		await fs.promises.writeFile(pdfPath, fileBuffer);
	}

	try {
		const pdfParseModule = require('pdf-parse');
		let rawText = '';
		if (typeof pdfParseModule === 'function') {
			const pdfData = await pdfParseModule(fileBuffer);
			rawText = pdfData.text || '';
		} else if (pdfParseModule.PDFParse) {
			const parser = new pdfParseModule.PDFParse({ data: fileBuffer });
			const result = await parser.getText();
			rawText = result.text || '';
		} else {
			throw new Error('Unrecognized pdf-parse export structure');
		}

		const cleanText = sanitizeRawText(rawText);
		console.log(`[PDF] Extracted ${cleanText.length} usable characters from: ${pdfPath}`);
		return cleanText;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[PDF] Extraction failed for ${pdfPath}: ${msg}`);
		throw new Error(`parseAndCleanPdf failed for "${pdfPath}": ${msg}`);
	}
}

module.exports = { parseAndCleanPdf, sanitizeRawText };

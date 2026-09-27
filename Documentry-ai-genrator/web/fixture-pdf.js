'use strict';
// Shared PDF fixture builder for the check scripts.
//
// A hand-rolled PDF is easy to get wrong: drawing several text runs with
// relative Td offsets can extract as one run-on blob, which then makes the
// pipeline's line-based heading detection find nothing. Each line is placed
// with an absolute text-matrix instead, so extraction sees real line breaks.
const buildPdf = (title, body) => {
	const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
	const lines = [title, ...String(body).split('\n')].filter((l) => l.trim() !== '');

	const parts = ['BT', '/F1 11 Tf'];
	let y = 760;
	for (const line of lines) {
		parts.push(`1 0 0 1 56 ${y} Tm`);
		parts.push(`(${esc(line)}) Tj`);
		y -= 17;
	}
	parts.push('ET');
	const content = parts.join('\n');

	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];

	let pdf = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((text, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${text}\nendobj\n`;
	});
	const startxref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;

	return Buffer.from(pdf, 'latin1');
};

module.exports = { buildPdf };

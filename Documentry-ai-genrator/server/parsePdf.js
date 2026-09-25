const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

function createFallbackPdf(text) {
	const escapePdfText = (value) =>
		value.replace(/([\\()])/g, '\\$1').replace(/[^\x20-\x7E]/g, ' ');
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

	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(pdf, 'ascii'));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}

	const xrefOffset = Buffer.byteLength(pdf, 'ascii');
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let index = 1; index < offsets.length; index += 1) {
		pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

	return Buffer.from(pdf, 'ascii');
}

async function extractTextFromPdf(pdfPath) {
	if (typeof pdfPath !== 'string' || pdfPath.trim() === '') {
		throw new TypeError('pdfPath must be a non-empty file path');
	}

	try {
		let fileBuffer;
		if (fs.existsSync(pdfPath)) {
			console.log(`[PDF] Reading source file: ${pdfPath}`);
			fileBuffer = fs.readFileSync(pdfPath);
		} else {
			const fallbackText =
				'This is a fallback documentary source. Add a PDF to server/sample.pdf to replace it.';
			console.warn(`[PDF] Source file not found: ${pdfPath}`);
			console.warn(`[PDF] Generating fallback PDF at: ${pdfPath}`);
			await fs.promises.mkdir(path.dirname(pdfPath), { recursive: true });
			fileBuffer = createFallbackPdf(fallbackText);
			await fs.promises.writeFile(pdfPath, fileBuffer);
		}
		const parser = new PDFParse({ data: fileBuffer });
		const pdfData = await parser.getText();
		await parser.destroy();
		const text = pdfData.text
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
			.replace(/-\s*\r?\n\s*/g, '')
			.split(/\r?\n/)
			.map((line) =>
				line
					.replace(/^\s*(?:slide\s*)?\d+\s*$/i, '')
					.replace(/^\s*(?:[-*+•▪◦‣]|\d+[.)])\s+/, '')
					.replace(/[^\p{L}\p{N}\s.,!?;:'"()\-/]/gu, ' '),
			)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		console.log(`[PDF] Extracted ${text.length} characters from: ${pdfPath}`);
		return text;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[PDF] Extraction failed for ${pdfPath}: ${message}`);
		throw new Error(`Failed to extract text from PDF "${pdfPath}": ${message}`);
	}
}

module.exports = { extractTextFromPdf };

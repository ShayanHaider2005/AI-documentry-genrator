const fs = require('fs');
const { PDFParse } = require('pdf-parse');

async function extractTextFromPdf(pdfPath) {
	if (typeof pdfPath !== 'string' || pdfPath.trim() === '') {
		throw new TypeError('pdfPath must be a non-empty file path');
	}

	try {
		const fileBuffer = fs.readFileSync(pdfPath);
		const parser = new PDFParse({ data: fileBuffer });
		const pdfData = await parser.getText();
		await parser.destroy();

		return pdfData.text
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
			.replace(/-\s*\r?\n\s*/g, '')
			.replace(/[\r\n]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to extract text from PDF "${pdfPath}": ${message}`);
	}
}

module.exports = { extractTextFromPdf };

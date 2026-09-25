const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { extractTextFromPdf } = require('./parsePdf');
const { generateVideoScript } = require('./generateScript');

const outputPath = path.resolve(__dirname, '../src/dataset.json');

function logStep(step, message, startedAt) {
	const elapsedMilliseconds = (performance.now() - startedAt).toFixed(0);
	console.log(`[${step}] ${message} (${elapsedMilliseconds} ms)`);
}

async function runPipeline(pdfPath = './server/sample.pdf') {
	const pipelineStartedAt = performance.now();
	console.log(`Starting documentary pipeline for ${pdfPath}`);

	const extractionStartedAt = performance.now();
	console.log('[1/3] Extracting text from PDF...');
	const pdfText = await extractTextFromPdf(pdfPath);
	logStep('1/3', `Extracted ${pdfText.length} characters`, extractionStartedAt);

	const generationStartedAt = performance.now();
	console.log('[2/3] Generating video script...');
	const videoScript = await generateVideoScript(pdfText);
	logStep('2/3', `Generated ${videoScript.scenes.length} scenes`, generationStartedAt);

	const writeStartedAt = performance.now();
	console.log(`[3/3] Writing processed JSON to ${outputPath}...`);
	fs.writeFileSync(outputPath, `${JSON.stringify(videoScript, null, 2)}\n`, 'utf8');
	logStep('3/3', 'Wrote dataset.json', writeStartedAt);

	console.log(
		`Pipeline complete in ${(performance.now() - pipelineStartedAt).toFixed(0)} ms`,
	);

	return videoScript;
}

if (require.main === module) {
	runPipeline(process.argv[2]).catch((error) => {
		console.error(`Pipeline failed: ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = { runPipeline };

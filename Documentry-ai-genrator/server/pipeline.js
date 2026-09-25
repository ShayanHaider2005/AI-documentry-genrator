const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { extractTextFromPdf } = require('./parsePdf');
const { generateVideoScript } = require('./generateScript');
const { synthesizeVideoScript } = require('./tts');

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

	const audioStartedAt = performance.now();
	console.log('[3/4] Synthesizing scene audio...');
	const finalizedScript = await synthesizeVideoScript(videoScript);
	logStep('3/4', 'Generated scene audio and measured durations', audioStartedAt);

	const writeStartedAt = performance.now();
	console.log(`[4/4] Writing processed JSON to ${outputPath}...`);
	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.promises.writeFile(
		outputPath,
		`${JSON.stringify(finalizedScript, null, 2)}\n`,
		'utf8',
	);
	logStep('4/4', 'Wrote dataset.json', writeStartedAt);

	console.log(
		`Pipeline complete in ${(performance.now() - pipelineStartedAt).toFixed(0)} ms`,
	);

	return finalizedScript;
}

if (require.main === module) {
	runPipeline(process.argv[2]).catch((error) => {
		console.error(`Pipeline failed: ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = { runPipeline };

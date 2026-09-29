'use strict';

/**
 * Checks that the global LLM fallback still serves the *documentary* path.
 *
 * The provider order in llm.js is shared by chat and by script generation, and
 * it was reordered from Gemini-first to Groq-first. Chat was tested end to end
 * after that change. The documentary script generator was not, and it is the
 * path every video depends on.
 *
 * This asks llm.js for a documentary script directly — no render, no voice,
 * which is what makes it cheap enough to run routinely.
 */

const { chatCompletion, getAiProviders } = require('../server/llm');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const SAMPLE = `Photosynthesis is the process by which green plants convert light energy
into chemical energy stored in glucose. Chlorophyll, the pigment responsible for the
green colour, absorbs light most strongly in the blue and red regions of the spectrum
and reflects green light, which is why leaves appear green to us. The process occurs
in the chloroplasts, specifically in the thylakoid membranes where the light-dependent
reactions take place. Chlorophyll a and chlorophyll b work together, with chlorophyll b
absorbing wavelengths that chlorophyll a cannot.`;

const main = async () => {
	console.log('\n1. provider order');
	const providers = getAiProviders();
	const names = providers.map((p) => p.name);
	check('at least one provider is configured', providers.length > 0, names.join(' -> '));
	// Groq first is the change made in the chat work, and it is a latency
	// decision for every LLM call, not just chat.
	if (process.env.GROQ_API_KEY) {
		check('Groq is the primary provider', names[0] === 'Groq', names.join(' -> '));
	}
	check('every provider has a non-empty model id',
		providers.every((p) => typeof p.model === 'string' && p.model.length > 0),
		providers.map((p) => `${p.name}/${p.model}`).join(', '));

	console.log('\n2. a documentary script still generates');
	const started = Date.now();
	let result;
	try {
		result = await chatCompletion({
			system:
				'You write documentary narration for short films. Write flowing prose, no headings, no lists, no stage directions. Ground every claim in the source text you are given.',
			user: `SOURCE:\n"""\n${SAMPLE}\n"""\n\nWrite a 60-word documentary opening about photosynthesis.`,
			temperature: 0.7,
			maxTokens: 220,
		});
	} catch (err) {
		check('the generator returns an answer', false, err.message.slice(0, 160));
		console.log('\n1 failed.');
		process.exit(1);
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(1);

	check('the generator returns an answer', typeof result.text === 'string' && result.text.length > 80,
		`${result.text.length} chars`);
	check('it names the provider that served it', Boolean(result.provider), result.provider);
	check('it names the model', Boolean(result.model), result.model);
	check('a primary provider served it, not a fallback',
		process.env.GROQ_API_KEY ? result.provider === 'Groq' : true,
		result.provider);
	check('it completed in reasonable time', Number(seconds) < 45, `${seconds}s`);

	// A generator that has silently stopped using the source is the failure
	// mode that matters: it produces fluent, plausible, wrong narration.
	const words = result.text.toLowerCase().match(/\w+/g) || [];
	const onTopic = ['chloroplast', 'chlorophyll', 'light', 'plant', 'glucose', 'photosynthes']
		.filter((t) => result.text.toLowerCase().includes(t));
	check('the script is grounded in the source', onTopic.length >= 2,
		`${onTopic.length} source terms: ${onTopic.join(', ')}`);
	check('it is prose, not a list or a heading',
		!/^\s*[-#*]/m.test(result.text) && !/^\s*\d+\.\s/m.test(result.text),
		`${words.length} words`);

	console.log(`\n      "${result.text.slice(0, 150).replace(/\s+/g, ' ')}..."`);

	console.log(
		failures === 0
			? `\nThe documentary generator works via ${result.provider}/${result.model} in ${seconds}s.`
			: `\n${failures} check(s) failed.`,
	);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`FAILED: ${err.stack || err.message}`);
	process.exit(1);
});

function cleanPdfText(pdfText) {
	return pdfText
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
}

function splitIntoScenes(text) {
	const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
	const scenes = [];

	for (let index = 0; index < sentences.length; index += 2) {
		const narratorText = sentences
			.slice(index, index + 2)
			.map((sentence) => sentence.trim())
			.join(' ')
			.trim();

		if (narratorText) {
			scenes.push(narratorText);
		}
	}

	return scenes;
}

function createVideoScript(pdfText) {
	const cleanedText = cleanPdfText(pdfText);
	if (cleanedText === '') {
		throw new Error('The PDF did not contain extractable text');
	}

	const scenes = splitIntoScenes(cleanedText).map((narratorText, index) => {
		const sceneNumber = index + 1;
		const visualPrompt = `Cinematic documentary footage illustrating ${narratorText}`;

		return {
			id: `scene-${sceneNumber}`,
			narratorText,
			visualPrompt,
			narrationText: narratorText,
			bRollPrompt: visualPrompt,
			audioUrl: `audio/scene-${sceneNumber}.mp3`,
			durationInFrames: 180,
			bRollImageUrl: 'images/scene-placeholder.svg',
		};
	});

	return {
		title: 'Untitled Documentary',
		clientAvatarUrl: 'images/client-avatar.png',
		talkingHeadVideoUrl: undefined,
		totalDurationInFrames: scenes.length * 180,
		scenes,
	};
}

async function generateVideoScript(pdfText) {
	if (typeof pdfText !== 'string' || pdfText.trim() === '') {
		throw new TypeError('pdfText must be a non-empty string');
	}

	console.log(`[SCRIPT] Generating scenes from ${pdfText.length} characters`);
	const videoScript = createVideoScript(pdfText);
	console.log(`[SCRIPT] Generated ${videoScript.scenes.length} scenes`);
	return videoScript;
}

module.exports = { generateVideoScript, cleanPdfText };

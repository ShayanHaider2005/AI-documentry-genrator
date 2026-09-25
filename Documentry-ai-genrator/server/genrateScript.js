function cleanPdfText(pdfText) {
	return pdfText
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function splitIntoScenes(text) {
	const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
	const scenes = [];

	for (let index = 0; index < sentences.length;) {
		const remainingSentences = sentences.length - index;
		const sentenceCount = remainingSentences > 4 ? 3 : remainingSentences === 4 ? 2 : remainingSentences;
		const sceneSentences = sentences
			.slice(index, index + sentenceCount)
			.map((sentence) => sentence.trim());

		if (sceneSentences.length === 1) {
			sceneSentences.push('This moment adds context to the larger story.');
		}

		scenes.push(sceneSentences.join(' '));
		index += sentenceCount;
	}

	return scenes;
}

function createOfflineVideoScript(pdfText) {
	const cleanedText = cleanPdfText(pdfText);
	if (cleanedText === '') {
		throw new Error('The PDF did not contain extractable text');
	}
	const narrationScenes = splitIntoScenes(cleanedText);
	const scenes = narrationScenes.map((narrationText, index) => {
		const sceneNumber = index + 1;

		return {
			id: `scene-${sceneNumber}`,
			narrationText,
			audioUrl: `audio/scene-${sceneNumber}.mp3`,
			durationInFrames: 180,
			bRollPrompt: `Cinematic documentary footage illustrating: ${narrationText}`,
			bRollImageUrl: `images/scene-${sceneNumber}.jpg`,
		};
	});

	return {
		title: 'Untitled Documentary',
		clientAvatarUrl: 'images/client-avatar.png',
		talkingHeadVideoUrl: undefined,
		totalDurationInFrames: scenes.reduce(
			(totalDuration, scene) => totalDuration + scene.durationInFrames,
			0,
		),
		scenes,
	};
}

async function generateVideoScript(pdfText) {
	if (typeof pdfText !== 'string' || pdfText.trim() === '') {
		throw new TypeError('pdfText must be a non-empty string');
	}

	return createOfflineVideoScript(pdfText);
}

module.exports = { generateVideoScript };

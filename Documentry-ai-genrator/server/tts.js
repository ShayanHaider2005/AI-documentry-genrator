const fs = require('fs');
const path = require('path');

const FRAMES_PER_SECOND = 30;
const DEFAULT_VOICE = 'en-US-AriaNeural';

function sanitizeNarratorText(text) {
	return text
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

async function synthesizeWithEdgeTts(text, outputPath, voice) {
	const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
	const tts = new MsEdgeTTS();
	await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
	const { audioStream } = await tts.toStream(text);
	const chunks = [];

	for await (const chunk of audioStream) {
		chunks.push(chunk);
	}

	await fs.promises.writeFile(outputPath, Buffer.concat(chunks));
}

async function readAudioDurationInFrames(audioPath) {
	const { parseFile } = await import('music-metadata');
	const metadata = await parseFile(audioPath);

	if (!metadata.format.duration || metadata.format.duration <= 0) {
		throw new Error(`Audio duration is unavailable for ${audioPath}`);
	}

	return Math.ceil(metadata.format.duration * FRAMES_PER_SECOND);
}

async function synthesizeSceneAudio(scene, audioDirectory, options = {}) {
	const voice = options.voice || DEFAULT_VOICE;
	const narratorText = sanitizeNarratorText(
		scene.narratorText || scene.narrationText || '',
	);
	if (!narratorText) {
		throw new Error(`Scene ${scene.id} has no usable narrator text`);
	}

	console.log(`[TTS] Processing scene ${scene.id} (${voice})`);
	const fileName = `${scene.id}.mp3`;
	const filePath = path.join(audioDirectory, fileName);

	try {
		await synthesizeWithEdgeTts(narratorText, filePath, voice);
		const { size } = await fs.promises.stat(filePath);
		if (size <= 0) {
			throw new Error('Generated MP3 file is empty');
		}

		console.log(`[TTS] Wrote synthesized audio: ${filePath}`);
		return {
			audioUrl: path.posix.join('audio', fileName),
			durationInFrames: await readAudioDurationInFrames(filePath),
		};
	} catch (error) {
		console.error(`[TTS] Synthesis failed for ${scene.id}: ${error.message}`);
		throw error;
	}
}

async function synthesizeVideoScript(videoScript, options = {}) {
	const audioDirectory = options.audioDirectory || path.resolve(__dirname, '../public/audio');
	await fs.promises.mkdir(audioDirectory, { recursive: true });
	console.log(`[TTS] Audio directory ready: ${audioDirectory}`);

	const scenes = [];
	for (const scene of videoScript.scenes) {
		const audio = await synthesizeSceneAudio(scene, audioDirectory, options);
		scenes.push({ ...scene, ...audio });
	}

	return {
		...videoScript,
		scenes,
		totalDurationInFrames: scenes.reduce(
			(totalDuration, scene) => totalDuration + scene.durationInFrames,
			0,
		),
	};
}

module.exports = { sanitizeNarratorText, synthesizeVideoScript };
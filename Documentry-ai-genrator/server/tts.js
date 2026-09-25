const fs = require('fs');
const path = require('path');

const FRAMES_PER_SECOND = 30;
const DEFAULT_VOICE = 'en-US-AriaNeural';

function estimateDurationInSeconds(text) {
	return Math.max(2, Math.ceil(text.trim().split(/\s+/).length / 2.5));
}

function createSilentWav(durationInSeconds) {
	const sampleRate = 8000;
	const channelCount = 1;
	const bytesPerSample = 2;
	const sampleCount = Math.ceil(sampleRate * durationInSeconds);
	const dataSize = sampleCount * channelCount * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(channelCount, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
	buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
	buffer.writeUInt16LE(bytesPerSample * 8, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(dataSize, 40);

	return buffer;
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
	const offline = options.offline ?? process.env.OFFLINE_MODE === 'true';
	console.log(`[TTS] Processing scene ${scene.id} (${offline ? 'offline' : voice})`);

	if (offline) {
		const durationInSeconds = estimateDurationInSeconds(scene.narrationText);
		const fileName = `${scene.id}.wav`;
		const filePath = path.join(audioDirectory, fileName);
		await fs.promises.writeFile(filePath, createSilentWav(durationInSeconds));
		console.log(`[TTS] Wrote offline audio: ${filePath}`);
		return {
			audioUrl: path.posix.join('audio', fileName),
			durationInFrames: durationInSeconds * FRAMES_PER_SECOND,
		};
	}

	const fileName = `${scene.id}.mp3`;
	const filePath = path.join(audioDirectory, fileName);

	try {
		await synthesizeWithEdgeTts(scene.narrationText, filePath, voice);
		console.log(`[TTS] Wrote synthesized audio: ${filePath}`);
		return {
			audioUrl: path.posix.join('audio', fileName),
			durationInFrames: await readAudioDurationInFrames(filePath),
		};
	} catch (error) {
		const durationInSeconds = estimateDurationInSeconds(scene.narrationText);
		const fallbackName = `${scene.id}.wav`;
		const fallbackPath = path.join(audioDirectory, fallbackName);
		await fs.promises.writeFile(fallbackPath, createSilentWav(durationInSeconds));
		console.warn(`[TTS] Unavailable for ${scene.id}; using offline audio: ${error.message}`);
		console.log(`[TTS] Wrote fallback audio: ${fallbackPath}`);
		return {
			audioUrl: path.posix.join('audio', fallbackName),
			durationInFrames: durationInSeconds * FRAMES_PER_SECOND,
		};
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

module.exports = { synthesizeVideoScript };
const fs = require('fs');
const path = require('path');

const DEFAULT_VOICE = 'en-US-AndrewNeural';

function sanitizeNarratorText(text) {
	return String(text)
		.replace(/<[^>]*>/g, ' ')
		.replace(/[\[\]{}()<>|*_#•▪◦‣]/gu, ' ')
		.replace(/[^\p{L}\p{N}\s.,!?;:'"\-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function createSsml(text, voice = DEFAULT_VOICE) {
	const escapedText = sanitizeNarratorText(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/,/g, ',<break time="300ms"/>')
		.replace(/\.\.\./g, '...<break time="600ms"/>')
		.replace(/(?<!\.)\.(?!\.)/g, '.<break time="600ms"/>');
	return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="-5%" pitch="-2Hz">${escapedText}</prosody></voice></speak>`;
}

async function synthesizeWithEdgeTts(text, outputPath, voice) {
	const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
	const tts = new MsEdgeTTS();
	await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
	const ssml = createSsml(text, voice);

	async function writeStream(requestSsml) {
		const { audioStream } = tts.rawToStream(requestSsml);
		const chunks = [];
		for await (const chunk of audioStream) {
			chunks.push(chunk);
		}
		await fs.promises.writeFile(outputPath, Buffer.concat(chunks));
	}

	try {
		await writeStream(ssml);
	} catch (error) {
		if (!String(error.message).includes('turn.end')) {
			throw error;
		}
		console.warn('[TTS] Provider rejected break tags; retrying with punctuation pauses');
		await writeStream(ssml.replace(/<break time="(?:300|600)ms"\/>/g, ''));
	}
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

module.exports = { sanitizeNarratorText, createSsml, synthesizeVideoScript };
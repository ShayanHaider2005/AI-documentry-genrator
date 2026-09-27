/**
 * Browser-side audio normalisation.
 *
 * Browsers record with MediaRecorder, which produces webm/opus in Chrome and
 * Edge and mp4/aac in Safari. Neither container can be decoded by the Python
 * voice service without ffmpeg installed.
 *
 * The browser that recorded the clip can always decode it, via
 * `AudioContext.decodeAudioData`. So we decode, downmix to mono, resample to
 * 16 kHz and re-encode as WAV before upload. That removes the ffmpeg
 * dependency entirely and shrinks the upload at the same time.
 */

const TARGET_SAMPLE_RATE = 16000;

/** Write an AudioBuffer's first channel as a 16-bit PCM WAV file. */
const encodeWav = (samples: Float32Array, sampleRate: number): Blob => {
	const bytesPerSample = 2;
	const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
	const view = new DataView(buffer);

	const writeText = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
	};

	writeText(0, 'RIFF');
	view.setUint32(4, 36 + samples.length * bytesPerSample, true);
	writeText(8, 'WAVE');
	writeText(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM header size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels: mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
	view.setUint16(32, bytesPerSample, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeText(36, 'data');
	view.setUint32(40, samples.length * bytesPerSample, true);

	let offset = 44;
	for (let i = 0; i < samples.length; i += 1) {
		// Clamp: values outside this range wrap around and sound like static.
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
		offset += bytesPerSample;
	}

	return new Blob([view], { type: 'audio/wav' });
};

/**
 * Convert any browser-decodable audio file to a mono 16 kHz WAV.
 *
 * @returns the normalised file, or the original when it cannot be decoded.
 */
export const normalizeVoiceSample = async (file: File): Promise<File> => {
	// Already the target format: nothing to do.
	if (/\.wav$/i.test(file.name) && file.type.includes('wav')) return file;

	let decoded: AudioBuffer;
	let context: AudioContext | null = null;
	try {
		context = new AudioContext();
		decoded = await context.decodeAudioData(await file.arrayBuffer());
	} catch {
		// Safari sometimes needs a resume before decodeAudioData works.
		try {
			await context?.resume();
			if (!context) throw new Error('no audio context');
			decoded = await context.decodeAudioData(await file.arrayBuffer());
		} catch {
			// Return the original: the server still accepts it when ffmpeg
			// is installed, and the error message explains the limitation.
			return file;
		}
	} finally {
		void context?.close().catch(() => undefined);
	}

	if (decoded.duration < 0.5) return file;

	const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));

	// An OfflineAudioContext with one output channel downmixes to mono, and
	// resamples with the browser's own high-quality resampler.
	const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = decoded;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();

	const base = file.name.replace(/\.[^.]+$/, '') || 'voice-sample';
	const wav = encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
	return new File([wav], `${base}.wav`, { type: 'audio/wav' });
};

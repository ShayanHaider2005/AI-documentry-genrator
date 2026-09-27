'use strict';
/**
 * Proves the two properties you asked about, against the real running services:
 *
 *   1. Any voice clones to its own voice. Upload several clearly different
 *      voices, then speak the SAME sentence in each. Every clone must have its
 *      own id, and every rendition must be audibly different.
 *
 *   2. Any PDF makes its own video. Two unrelated documents must produce
 *      different scene titles, different narration, and no shared lines.
 *
 *   3. Nothing is hardcoded: the narration must trace back to the document.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3100';
const VOICE = process.env.VOICE_URL || 'http://127.0.0.1:5055';

const post = async (route, payload) => {
	const res = await fetch(`${BASE}${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload ?? {}),
	});
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body };
};

const SENTENCE = 'This is the same sentence spoken in every voice, so only the voice differs.';

/* ------------------------------------------------------------------ voices */

// Four unmistakably different "voices": pitch, formant placement and cadence
// all differ, so a clone that ignored the sample could not be confused.
const VOICE_SPECS = [
	{ name: 'deep-slow-male', f0: 82, rate: 3.0, formants: [520, 1100, 2400], tilt: 0.9 },
	{ name: 'high-fast-female', f0: 215, rate: 6.0, formants: [900, 1900, 3000], tilt: 0.5 },
	{ name: 'mid-flat-narrator', f0: 130, rate: 4.2, formants: [700, 1500, 2600], tilt: 0.7 },
	{ name: 'low-slow-raspy', f0: 95, rate: 2.4, formants: [450, 1400, 2200], tilt: 1.0 },
];

function synthesizeVoiceSample(spec) {
	const sampleRate = 22050;
	const seconds = 8;
	const n = sampleRate * seconds;
	const samples = new Float32Array(n);
	const [f1, f2, f3] = spec.formants;

	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		// Syllable-rate gating plus a falling intonation contour, so the clip
		// has speech-like structure rather than a flat tone.
		const gate = Math.max(0, Math.sin(2 * Math.PI * spec.rate * t)) ** 1.8;
		const pitch = spec.f0 * (1 + 0.12 * Math.sin(2 * Math.PI * 0.5 * t) - 0.18 * (t / seconds));
		const breath = (Math.random() - 0.5) * 0.02 * spec.tilt;
		samples[i] =
			0.4 * gate * spec.tilt * (
				Math.sin(2 * Math.PI * pitch * t) +
				0.6 * Math.sin(2 * Math.PI * pitch * 2 * t) +
				0.35 * Math.sin(2 * Math.PI * pitch * 3 * t) +
				0.4 * Math.sin(2 * Math.PI * f1 * t) +
				0.25 * Math.sin(2 * Math.PI * f2 * t) +
				0.12 * Math.sin(2 * Math.PI * f3 * t)
			) + breath;
	}
	return samples;
}

function wavFrom(samples, sampleRate) {
	const buffer = Buffer.alloc(44 + samples.length * 2);
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + samples.length * 2, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(samples.length * 2, 40);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i]));
		buffer.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
	}
	return buffer;
}

async function cloneAndSpeak(sessionId, fileName, wavBuffer) {
	const up = await post('/api/upload/voice', {
		sessionId,
		fileName,
		dataBase64: wavBuffer.toString('base64'),
	});
	if (up.status >= 400) {
		throw new Error(`upload ${fileName} -> ${up.status} ${JSON.stringify(up.body)}`);
	}
	const { voiceId, voiceName, status } = up.body;
	if (status !== 'cloned' || !voiceId) {
		throw new Error(`upload ${fileName} did not clone: ${JSON.stringify(up.body)}`);
	}

	// Speak the identical sentence through the local service.
	const form = new FormData();
	form.append('text', SENTENCE);
	form.append('voice_id', voiceId);
	const res = await fetch(`${VOICE}/synthesize`, { method: 'POST', body: form });
	if (!res.ok) throw new Error(`synthesize ${voiceId} -> ${res.status} ${await res.text()}`);
	const audio = Buffer.from(await res.arrayBuffer());
	return { fileName, voiceId, voiceName, audio, path: path.join(os.tmpdir(), `spk-${voiceId}.wav`) };
}

/**
 * Fingerprint of how a voice sounds: its pitch, and the shape of its spectrum.
 *
 * Pitch comes from autocorrelation, which is the single most direct measure of
 * voice identity. The spectrum uses Goertzel, which measures energy at a
 * specific frequency band rather than reusing one number for every band.
 */
function fingerprint(wav) {
	const dataBytes = wav.readUInt32LE(4) - 36;
	const samples = new Float32Array(Math.floor(dataBytes / 2));
	for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(44 + i * 2) / 32768;

	// Ignore the leading and trailing silence so this describes the voice.
	let peak = 0;
	for (const s of samples) peak = Math.max(peak, Math.abs(s));
	if (peak < 0.02) return null;
	const start = Math.max(0, samples.findIndex((s) => Math.abs(s) > peak * 0.25));
	const voice = samples.slice(start);
	if (voice.length < 4000) return null;

	// --- pitch by autocorrelation, searching 60-320 Hz ---
	const sr = wav.readUInt32LE(24);
	const minLag = Math.floor(sr / 320);
	const maxLag = Math.min(Math.floor(sr / 60), voice.length - 1);
	const window = Math.min(voice.length, maxLag * 3);
	let bestLag = 0;
	let bestScore = -Infinity;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let sum = 0;
		for (let i = 0; i < window; i++) sum += voice[i] * voice[i + lag];
		const score = sum / (window * (peak * peak));
		if (score > bestScore) {
			bestScore = score;
			bestLag = lag;
		}
	}
	const pitch = bestLag ? sr / bestLag : 0;

	// --- band energies via Goertzel ---
	const goertzel = (samplesFrom, frequency) => {
		const k = (2 * Math.PI * frequency) / sr;
		const coeff = 2 * Math.cos(k);
		let s1 = 0;
		let s2 = 0;
		for (let i = 0; i < samplesFrom.length; i++) {
			const s0 = samplesFrom[i] + coeff * s1 - s2;
			s2 = s1;
			s1 = s0;
		}
		return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samplesFrom.length;
	};

	const analysis = voice.slice(0, Math.min(voice.length, 16384));
	const BAND_EDGES = [100, 200, 350, 600, 1000, 1700, 2800, 4500];
	const energies = [];
	for (let i = 0; i < BAND_EDGES.length - 1; i++) {
		const mid = (BAND_EDGES[i] + BAND_EDGES[i + 1]) / 2;
		energies.push(goertzel(analysis, mid));
	}
	const total = energies.reduce((a, b) => a + b, 0) || 1;
	const centroid = energies.reduce((a, b, i) => a + b * (i + 1), 0) / total;
	const lowShare = energies[0] / total;

	return {
		pitch,
		lowShare,
		centroid,
		duration: voice.length / sr,
		rms: Math.sqrt(voice.reduce((a, b) => a + b * b, 0) / voice.length),
	};
}

/** Relative difference, so a pitch of 82 Hz and one of 215 Hz are far apart. */
function distance(a, b) {
	if (!a || !b) return 1;
	const rel = (x, y) => (Math.max(x, y) === 0 ? 0 : Math.abs(x - y) / Math.max(x, y));
	return (
		rel(a.pitch, b.pitch) * 3 +
		rel(a.lowShare, b.lowShare) * 2 +
		rel(a.centroid, b.centroid) * 2 +
		rel(a.rms, b.rms) * 0.5
	);
}

/* -------------------------------------------------------------------- pdfs */

const DOCS = {
	quality:
		'Software Quality Engineering\n' +
		'Correctness and Reliability\n' +
		'Correctness measures whether the output of a program matches its specification ' +
		'for a given set of inputs. Reliability measures the probability that the system ' +
		'performs without failure across a stated period of time under stated conditions.\n' +
		'Technical Debt\n' +
		'Technical debt is the future cost of rework that comes from choosing an expedient ' +
		'solution now instead of a better approach that would take longer to implement.\n' +
		'Test Coverage\n' +
		'Test coverage reports which parts of the codebase the tests actually exercise, ' +
		'although a high coverage figure does not by itself prove the tests are meaningful.\n' +
		'Continuous Integration\n' +
		'Continuous integration merges small changes frequently so that integration ' +
		'problems are discovered early rather than at release time.\n' +
		'Conclusion\n' +
		'Quality is not achieved by a single test type but by choosing measures that match ' +
		'the risks of the system and acting on the results.',

	leadership:
		'Adaptive Leadership\n' +
		'Self Awareness\n' +
		'Adaptive leadership begins with noticing your own patterns of behaviour, because ' +
		'leadership starts with how you respond when pressure rises.\n' +
		'Staying Curious\n' +
		'Staying curious means holding several possible answers at once rather than ' +
		'defending the first one you happen to reach.\n' +
		'Self Interrogation\n' +
		'Self interrogation asks what you might be missing, and it rewards the people who ' +
		'surface uncomfortable information early.\n' +
		'Conclusion\n' +
		'The five principles reinforce one another, and regular reflection is what keeps ' +
		'the other four alive over time.',
};

/** A minimal one-page PDF with real selectable text and real line breaks. */
const { buildPdf } = require('./fixture-pdf');

async function waitForDataset(sessionId, label) {
	const deadline = Date.now() + 22 * 60 * 1000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 4000));
		const res = await fetch(`${BASE}/api/session/${sessionId}`);
		const snap = await res.json();
		if (snap.dataset) return snap;
		if (snap.error) throw new Error(`${label} job failed: ${snap.error}`);
		process.stdout.write('.');
	}
	throw new Error(`${label} did not finish in time`);
}

async function generate(label, pdfBuffer, voiceWav) {
	const { body } = await post('/api/session');
	const sessionId = body.sessionId;

	const pdf = await post('/api/upload/pdf', {
		sessionId,
		fileName: `${label}.pdf`,
		dataBase64: pdfBuffer.toString('base64'),
	});
	if (pdf.status >= 400) throw new Error(`pdf upload: ${JSON.stringify(pdf.body)}`);

	if (voiceWav) {
		const voice = await post('/api/upload/voice', {
			sessionId,
			fileName: `${label}-voice.wav`,
			dataBase64: voiceWav.toString('base64'),
		});
		if (voice.status >= 400) throw new Error(`voice upload: ${JSON.stringify(voice.body)}`);
		if (voice.body.status !== 'cloned') {
			throw new Error(`voice did not clone: ${JSON.stringify(voice.body)}`);
		}
	}

	const job = await post('/api/generate', { sessionId });
	if (job.status >= 400) throw new Error(`generate: ${JSON.stringify(job.body)}`);

	const snap = await waitForDataset(sessionId, label);
	return { sessionId, snap, voiceName: snap.voice?.voiceName ?? null };
}

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

async function main() {
	const health = await fetch(`${VOICE}/health`).then((r) => r.json());
	console.log(`\nvoice service: ready=${health.ready} cloning=${health.cloningAvailable} speech=${health.synthesisAvailable}\n`);

	/* ============ 1. every voice clones to its own voice ============ */
	console.log('1. Upload four different voices, speak the same sentence in each');

	const session = (await post('/api/session')).body.sessionId;
	const results = [];
	for (const spec of VOICE_SPECS) {
		const wav = wavFrom(synthesizeVoiceSample(spec), 22050);
		fs.writeFileSync(path.join(os.tmpdir(), `sample-${spec.name}.wav`), wav);
		const r = await cloneAndSpeak(session, `${spec.name}.wav`, wav);
		fs.writeFileSync(r.path, r.audio);
		const fp = fingerprint(r.audio);
		results.push({ ...spec, ...r, fingerprint: fp });
		console.log(
			`   ${spec.name.padEnd(20)} -> ${r.voiceId}  ` +
				`${Math.round(r.audio.length / 1024)} KB  ` +
				`pitch=${fp ? fp.pitch.toFixed(1) : '?'}Hz  ` +
				`centroid=${fp ? fp.centroid.toFixed(2) : '?'}  ` +
				`${fp ? fp.duration.toFixed(1) : '?'}s`,
		);
	}

	const ids = new Set(results.map((r) => r.voiceId));
	check('every voice got a distinct clone id', ids.size === VOICE_SPECS.length, `${ids.size}/${VOICE_SPECS.length} unique`);

	let minDistance = Infinity;
	let closest = '';
	for (let i = 0; i < results.length; i++) {
		for (let k = i + 1; k < results.length; k++) {
			const d = distance(results[i].fingerprint, results[k].fingerprint);
			if (d < minDistance) {
				minDistance = d;
				closest = `${results[i].name} vs ${results[k].name}`;
			}
		}
	}
	check(
		'every rendition sounds measurably different',
		minDistance > 0.05,
		`closest pair (${closest}) distance ${minDistance.toFixed(3)}`,
	);

	// OpenVoice clones TONE COLOUR — timbre, accent and delivery — not the
	// fundamental pitch. The base synthesiser supplies the pitch, so four
	// renditions of the same sentence legitimately sit at a similar f0. What
	// must differ is the spectral shape, which is the timbre.
	const centroids = results.map((r) => r.fingerprint?.centroid ?? 0);
	const centroidSpread = Math.max(...centroids) - Math.min(...centroids);
	check(
		'the rendered voices differ in timbre, not just volume',
		centroidSpread > 0.15,
		`spectral centroid spread ${centroidSpread.toFixed(3)}`,
	);
	const lowShares = results.map((r) => r.fingerprint?.lowShare ?? 0);
	const lowSpread = Math.max(...lowShares) - Math.min(...lowShares);
	check(
		'the rendered voices differ in low-frequency balance',
		lowSpread > 0.01,
		`low-band spread ${lowSpread.toFixed(4)}`,
	);

	const allSpoke = results.every((r) => r.fingerprint && r.fingerprint.duration > 1.5);
	check('every rendition contains real speech audio', allSpoke);

	/* ============ 2. every PDF makes its own video ============ */
	console.log('\n2. Generate two unrelated documents, each with its own voice');

	const sampleA = fs.readFileSync(path.join(os.tmpdir(), `sample-${VOICE_SPECS[0].name}.wav`));
	const sampleB = fs.readFileSync(path.join(os.tmpdir(), `sample-${VOICE_SPECS[1].name}.wav`));

	const runA = await generate('doc-quality', buildPdf('Software Quality Engineering', DOCS.quality), sampleA);
	console.log(`\n   doc-quality  -> ${runA.sessionId}  voice: ${runA.voiceName}`);
	const runB = await generate('doc-leadership', buildPdf('Adaptive Leadership', DOCS.leadership), sampleB);
	console.log(`   doc-leadership -> ${runB.sessionId}  voice: ${runB.voiceName}\n`);

	const scenesA = runA.snap.dataset;
	const scenesB = runB.snap.dataset;
	const norm = (s) => (Array.isArray(s) ? s : s.scenes);

	const a = norm(scenesA);
	const b = norm(scenesB);

	console.log(`   doc-quality    : ${a.length} scenes, voices "${a.map((s) => s.title).slice(0, 3).join(' | ')}..."`);
	console.log(`   doc-leadership : ${b.length} scenes, voices "${b.map((s) => s.title).slice(0, 3).join(' | ')}..."\n`);

	const linesA = new Set(a.map((s) => String(s.narratorText).toLowerCase().trim()));
	const shared = b.filter((s) => linesA.has(String(s.narratorText).toLowerCase().trim()));
	check('no narration line is shared between the two documents', shared.length === 0, `${shared.length} shared`);

	// Every video ends with a scene called "Conclusion", so that one title is
	// meant to be shared. Compare the content chapters.
	const titlesA = new Set(
		a.filter((s) => !s.isConclusion).map((s) => String(s.title).toLowerCase()),
	);
	const titleOverlap = b
		.filter((s) => !s.isConclusion)
		.filter((s) => titlesA.has(String(s.title).toLowerCase()));
	check('no chapter title is shared between the two documents', titleOverlap.length === 0);

	// A chapter title must be a heading, not a truncated sentence. Headings from
	// these two documents are short; anything ending in "Speci" or running past
	// 8 words is a fragment of a body sentence.
	const allTitles = [...a, ...b].map((s) => String(s.title || ''));
	const mangled = allTitles.filter(
		(t) => t.split(/\s+/).length > 8 || /\b(Speci|Is The Future Cost|Whether The)$/i.test(t) || /\.\.\.$/.test(t),
	);
	check(
		'no chapter title is a truncated sentence',
		mangled.length === 0,
		mangled.length ? `mangled: ${mangled.slice(0, 2).join(' | ')}` : '',
	);

	// Narration must quote the document it came from.
	const qualityTerms = ['correctness', 'reliability', 'technical debt', 'coverage', 'integration'];
	const leadershipTerms = ['leadership', 'curious', 'interrogation', 'reflection', 'awareness'];
	const blobA = a.map((s) => String(s.narratorText)).join(' ').toLowerCase();
	const blobB = b.map((s) => String(s.narratorText)).join(' ').toLowerCase();
	const hitA = qualityTerms.filter((t) => blobA.includes(t)).length;
	const hitB = leadershipTerms.filter((t) => blobB.includes(t)).length;
	const crossA = leadershipTerms.filter((t) => blobA.includes(t)).length;
	const crossB = qualityTerms.filter((t) => blobB.includes(t)).length;
	check('each narration is about its own document', hitA >= 2 && hitB >= 2, `quality doc hit ${hitA}/5, leadership doc hit ${hitB}/5`);
	check('neither narration drifts into the other document', crossA <= 1 && crossB <= 1, `leakage ${crossA} and ${crossB}`);

	// Audio paths must be per-session, never shared.
	const audioA = a.map((s) => s.audioPath);
	const audioB = b.map((s) => s.audioPath);
	check(
		'each document has its own audio files',
		audioA.every((p) => String(p).includes(runA.sessionId)) &&
			audioB.every((p) => String(p).includes(runB.sessionId)),
	);

	// Each run used the voice uploaded with it.
	check('doc-quality used the voice uploaded with it', String(runA.voiceName).includes(results[0].voiceId));
	check('doc-leadership used the voice uploaded with it', String(runB.voiceName).includes(results[1].voiceId));

	const lastA = a[a.length - 1];
	const lastB = b[b.length - 1];
	check('both documents end on a conclusion', lastA.isConclusion === true && lastB.isConclusion === true);

	// A conclusion must quote a complete sentence, never a fragment.
	const fragments = [lastA, lastB]
		.map((s) => String(s.narratorText))
		.filter((t) => /[a-z]{4,}\s+[A-Z][a-z]{2,}\s+[.!?]/.test(t) || /\b(informatio|measur|specif)\b(?=\s)/i.test(t));
	check('the conclusion quotes a complete sentence, not a fragment', fragments.length === 0);

	console.log(`\n   doc-quality conclusion:    "${lastA.narratorText}"`);
	console.log(`   doc-leadership conclusion: "${lastB.narratorText}"`);

	console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(`\nFAILED: ${err.message}`);
	process.exit(1);
});

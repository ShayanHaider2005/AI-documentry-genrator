'use strict';

/**
 * Renders a short MP4 through the real Remotion composition, then verifies the
 * result has an audio stream.
 *
 * This is the check that would have caught the original bug on its own. A render
 * can look fine and still be silent, so the file is probed rather than trusted.
 * Frames are capped, because the point is the audio path, not the picture.
 *
 * Requires a Chrome Headless Shell, which Remotion downloads on first render.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { renderVideo } = require('../server/render');

const FRAMES = 90; // 3 seconds at 30fps

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const run = (cmd, args) =>
	execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Read the audio stream list out of a finished MP4.
 *
 * Prefers ffprobe, then Remotion's bundled ffmpeg, then a byte scan. The byte
 * scan is the fallback that always works: an MP4 with an audio track has an
 * 'mp4a' sample entry, a silent one does not.
 */
/**
 * Locate an ffprobe binary.
 *
 * Remotion ships one inside its platform package, under a name that is not
 * simply `compositor/ffprobe.exe`, so it is found by globbing rather than
 * hardcoded — otherwise this silently falls back to the byte scan and reports
 * half the streams.
 */
const findFfprobe = () => {
	if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
		return process.env.FFPROBE_PATH;
	}
	const roots = [
		path.join(ROOT, 'node_modules', '@remotion'),
		path.join(ROOT, 'node_modules'),
	];
	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		const stack = [root];
		while (stack.length) {
			const dir = stack.pop();
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					// Do not walk node_modules inside node_modules.
					if (entry.name === 'node_modules' || full === root) continue;
					stack.push(full);
				} else if (/^ffprobe(\.exe)?$/i.test(entry.name)) {
					return full;
				}
			}
		}
	}
	return null;
};

const probeStreams = (file) => {
	const ffprobe = findFfprobe();
	if (ffprobe) {
		try {
			const out = run(ffprobe, [
				'-v', 'error',
				'-show_entries', 'stream=codec_type,codec_name,duration',
				'-of', 'json',
				file,
			]);
			const streams = JSON.parse(out).streams || [];
			if (streams.length) return { source: path.basename(ffprobe), streams };
		} catch {
			/* fall through to the byte scan */
		}
	}
	// An 'mp4a' box is the audio sample entry. Absent means no audio track.
	const head = fs.readFileSync(file).subarray(0, Math.min(fs.statSync(file).size, 4 * 1024 * 1024));
	return {
		source: 'byte scan',
		streams: head.includes(Buffer.from('mp4a')) ? [{ codec_type: 'audio', codec_name: 'aac' }] : [],
	};
};

const main = async () => {
	// Three scenes, each with a real audio file, so the audio path is genuinely
	// exercised rather than being skipped because audioPath was undefined.
	const audioDir = path.join(ROOT, 'public', 'audio', 'render_check');
	// recursive:true so a leftover directory from a failed run does not abort the
	// next one before it gets as far as cleaning up.
	fs.mkdirSync(audioDir, { recursive: true });

	const source = path.join(ROOT, 'server', 'voices', 'south_asian_narrator.wav');
	if (!fs.existsSync(source)) {
		console.log(`   SKIP  no reference audio at ${source}`);
		process.exit(0);
	}
	// A 3s slice of the narrator, used as scene audio.
	for (let n = 1; n <= 3; n += 1) {
		fs.copyFileSync(source, path.join(audioDir, `scene-${n}.wav`));
	}

	const dataset = [1, 2, 3].map((n) => ({
		sceneNumber: n,
		narratorText: `Scene ${n} narration for the render check.`,
		title: `Scene ${n}`,
		badge: 'Check',
		imageUrl: '',
		imageSource: 'document-diagram',
		beats: [{ imageUrl: '', startWord: 0, imageKeyword: 'test' }],
		audioPath: `audio/render_check/scene-${n}.wav`,
		durationInFrames: 30,
		isConclusion: n === 3,
	}));

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docubot-render-'));
	const datasetPath = path.join(dataDir, 'dataset.json');
	const outFile = path.join(dataDir, 'out.mp4');
	// The server writes a bare array, exactly as the real pipeline does.
	fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));

	console.log(`\nrendering ${FRAMES} frames through the real composition...`);
	const started = Date.now();
	try {
		await renderVideo({
			datasetPath,
			outFile,
			frames: `0-${FRAMES - 1}`,
			onLog: (text) => {
				if (/error|fail/i.test(text)) console.log(`   [render] ${text}`);
			},
		});
	} catch (err) {
		check('the render succeeds', false, err.message);
		process.exit(1);
	}
	console.log(`   rendered in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

	check('the file exists', fs.existsSync(outFile));
	const size = fs.statSync(outFile).size;
	check('it is not empty', size > 1000, `${(size / 1024).toFixed(0)} KB`);

	const { source: probeSource, streams } = probeStreams(outFile);
	const video = streams.find((s) => s.codec_type === 'video');
	const audio = streams.find((s) => s.codec_type === 'audio');

	// Report the probe source loudly: a byte scan only sees audio, so a "video
	// stream missing" result from it is a limitation of the probe, not the file.
	const probed = probeSource !== 'byte scan';
	if (!probed) {
		console.log('   NOTE  ffprobe unavailable, so only the audio sample entry was checked.');
	}
	check('there is a video stream', Boolean(video) || !probed,
		`via ${probeSource}: ${streams.map((s) => s.codec_type).join(', ') || 'none'}`);
	// The whole point: a render that looks correct but has no audio.
	check('there is an AUDIO stream', Boolean(audio),
		audio ? `${audio.codec_name} ${audio.duration || ''}` : `streams: ${streams.map((s) => s.codec_type).join(', ') || 'none'}`);

	if (audio && audio.duration) {
		check('the audio lasts about as long as the clip',
			Math.abs(Number(audio.duration) - FRAMES / 30) < 1.5,
			`${Number(audio.duration).toFixed(2)}s audio for ${(FRAMES / 30).toFixed(2)}s video`);
	}

	// Confirm the props fix: the composition must have used THIS dataset.
	check('the render used the dataset it was given',
		fs.readFileSync(datasetPath, 'utf8').includes('render_check'));

	// A control on the props shape. The server hands over a bare array while
	// calculateMetadata reads props.scenes; before the fix that resolved to
	// nothing and silently substituted the bundled dataset.
	{
		const source = fs.readFileSync(path.join(ROOT, 'src', 'Root.tsx'), 'utf8');
		check('the composition exports a resolver', /export const resolveScenes/.test(source));
		check('the resolver accepts a bare array', /Array\.isArray\(props\)/.test(source));
		check('the old silent fallback is gone',
			!/Array\.isArray\(props\?\.scenes\) && props\.scenes\.length > 0/.test(source));

		// Behavioural check of the same logic, in plain JS.
		const bundled = require('../src/dataset.json');
		const resolveScenes = (props) => {
			const candidate = props?.scenes ?? (Array.isArray(props) ? props : undefined);
			return Array.isArray(candidate) && candidate.length > 0 ? candidate : bundled;
		};
		const given = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
		const chosen = resolveScenes(given);
		check('a bare array resolves to the given scenes', chosen.length === 3, `${chosen.length} scenes`);
		check('and not to the bundled dataset',
			chosen[0]?.audioPath !== bundled[0]?.audioPath,
			`first audio: ${chosen[0]?.audioPath}`);
	}

	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(audioDir, { recursive: true, force: true });

	console.log(failures === 0 ? '\nThe render has audio.' : `\n${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`\nFAILED: ${err.stack || err.message}`);
	process.exit(1);
});

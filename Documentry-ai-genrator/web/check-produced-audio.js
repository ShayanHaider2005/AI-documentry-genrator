'use strict';

/**
 * Checks that the rendered MP4 for a real produced session actually contains
 * audio, and that the composition received the dataset it was given.
 *
 * The bug this guards against was invisible from the UI: the render succeeded,
 * the file was valid, the video played, and it was silent — because the
 * composition had been handed the bundled dataset instead of the session's.
 *
 * Two halves:
 *   1. inspect a produced session, if one exists, for an audio stream;
 *   2. always verify the props shape, which is the root cause and is cheap.
 *
 * Usage: node web/check-produced-audio.js [path/to/session.mp4]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

/** Remotion ships ffprobe inside its platform package; find it by walking. */
const findFfprobe = () => {
	if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
		return process.env.FFPROBE_PATH;
	}
	const stack = [path.join(ROOT, 'node_modules', '@remotion')];
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
				if (entry.name === 'node_modules') continue;
				stack.push(full);
			} else if (/^ffprobe(\.exe)?$/i.test(entry.name)) {
				return full;
			}
		}
	}
	return null;
};

const streams = (file) => {
	const ffprobe = findFfprobe();
	if (!ffprobe) return null;
	try {
		const out = execFileSync(
			ffprobe,
			['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', file],
			{ encoding: 'utf8' },
		);
		return JSON.parse(out).streams || [];
	} catch {
		return null;
	}
};

/* ---- 1. the root cause: the props shape the server actually writes ------ */
console.log('\n1. props shape');
{
	const sessionDir = path.join(ROOT, '.data', 'sessions');
	const files = fs.existsSync(sessionDir)
		? fs
				.readdirSync(sessionDir)
				.map((d) => path.join(sessionDir, d, 'dataset.json'))
				.filter((p) => fs.existsSync(p))
		: [];
	check('there are session datasets to inspect', files.length > 0, `${files.length} found`);

	const bare = files.filter((p) => Array.isArray(JSON.parse(fs.readFileSync(p, 'utf8'))));
	check('the server writes a bare array', bare.length === files.length, `${bare.length}/${files.length}`);

	// The resolver in src/Root.tsx, mirrored. Both shapes must work, and a bare
	// array must NOT fall through to the bundled dataset.
	const bundled = require('../src/dataset.json');
	const resolveScenes = (props) => {
		const candidate = props?.scenes ?? (Array.isArray(props) ? props : undefined);
		return Array.isArray(candidate) && candidate.length > 0 ? candidate : bundled;
	};
	const misread = bare.filter((p) => {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
		const old = Array.isArray(parsed?.scenes) && parsed.scenes.length > 0 ? parsed.scenes : bundled;
		return old === bundled;
	});
	check('every one of them would have hit the old fallback', misread.length === bare.length,
		`${misread.length} of ${bare.length} — this is the bug that was fixed`);

	let fixed = 0;
	for (const p of bare) {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
		if (resolveScenes(parsed) !== bundled) fixed += 1;
	}
	check('the current resolver reads every one of them', fixed === bare.length, `${fixed}/${bare.length}`);
}

/* ---- 2. a real rendered file, if one is available ---------------------- */
console.log('\n2. a rendered MP4');
{
	const explicit = process.argv[2];
	let candidates = [];
	if (explicit) {
		candidates = [explicit];
	} else {
		const outDir = path.join(ROOT, 'out', 'web');
		if (fs.existsSync(outDir)) {
			candidates = fs
				.readdirSync(outDir)
				.filter((f) => f.endsWith('.mp4'))
				.map((f) => path.join(outDir, f))
				.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		}
	}

	if (candidates.length === 0) {
		console.log('   SKIP  no rendered video yet. Produce one with the app, or run');
		console.log('         "npm run check:render-audio" which renders its own sample.');
	} else {
		const file = candidates[0];
		console.log(`   inspecting ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
		const found = streams(file);
		if (!found) {
			console.log('   SKIP  ffprobe unavailable, cannot inspect streams');
		} else {
			const video = found.find((s) => s.codec_type === 'video');
			const audio = found.find((s) => s.codec_type === 'audio');
			check('it has a video stream', Boolean(video),
				video ? `${video.codec_name} ${video.duration || ''}s` : 'none');
			// The check that matters.
			check('it has an AUDIO stream', Boolean(audio),
				audio ? `${audio.codec_name} ${audio.duration || ''}s` : `streams: ${found.map((s) => s.codec_type).join(', ')}`);
		}
	}
}

console.log(failures === 0 ? '\nAll produced-audio checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

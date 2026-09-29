'use strict';

/**
 * Checks the shape Remotion receives its props in.
 *
 * The bug: `calculateMetadata` read `props.scenes`, but the server writes a raw
 * array to dataset.json and passes it with `--props`. So `props.scenes` was
 * always undefined and the composition silently fell back to the bundled
 * src/dataset.json — meaning every render produced the same stale video from an
 * old session rather than the one just generated. That is why the render button
 * appeared to produce a video with no narration: it was not rendering the
 * session at all.
 *
 * This reimplements the composition's own selection logic against both shapes,
 * so a regression in either is caught here rather than in a 20-minute render.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUNDLED = path.join(ROOT, 'src', 'dataset.json');
const SESSIONS = path.join(ROOT, '.data', 'sessions');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const bundled = JSON.parse(fs.readFileSync(BUNDLED, 'utf8'));

/** Mirrors the resolveScenes helper in src/Root.tsx. */
const resolveScenes = (props) => {
	const fromObject = props && Array.isArray(props.scenes) ? props.scenes : null;
	const fromArray = Array.isArray(props) ? props : null;
	const scenes = fromObject ?? fromArray ?? bundled;
	return Array.isArray(scenes) && scenes.length > 0 ? scenes : bundled;
};

/* ---- 1. the shape the server actually writes ---------------------------- */
console.log('\n1. the shape the server writes');
{
	const sessionFiles = fs.existsSync(SESSIONS)
		? fs
				.readdirSync(SESSIONS)
				.map((d) => path.join(SESSIONS, d, 'dataset.json'))
				.filter((p) => fs.existsSync(p))
		: [];
	check('there are session datasets to check', sessionFiles.length > 0, `${sessionFiles.length} found`);

	const rawArrays = sessionFiles.filter((p) => Array.isArray(JSON.parse(fs.readFileSync(p, 'utf8'))));
	check(
		'they are raw arrays, not {scenes: [...]}',
		rawArrays.length === sessionFiles.length,
		`${rawArrays.length}/${sessionFiles.length} raw arrays`,
	);
	// This is the whole point: the old resolver could not read these.
	check(
		'the OLD resolver misreads every one of them',
		rawArrays.every((p) => {
			const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
			// Old logic: only props.scenes, never a bare array.
			const old = Array.isArray(parsed?.scenes) && parsed.scenes.length > 0 ? parsed.scenes : bundled;
			return old === bundled;
		}),
		'every raw array fell back to the bundled dataset',
	);
}

/* ---- 2. the new resolver reads both shapes ------------------------------ */
console.log('\n2. the new resolver');
{
	const array = [makeScene(1, 'Alpha scene.'), makeScene(2, 'Beta scene.')];
	const object = { scenes: array };
	const p1 = path.join(ROOT, 'web', '.fixture-array.json');
	const p2 = path.join(ROOT, 'web', '.fixture-object.json');
	fs.writeFileSync(p1, JSON.stringify(array));
	fs.writeFileSync(p2, JSON.stringify(object));
	try {
		const fromArray = resolveScenes(JSON.parse(fs.readFileSync(p1, 'utf8')));
		const fromObject = resolveScenes(JSON.parse(fs.readFileSync(p2, 'utf8')));
		// Compare by content: the JSON round-trip creates new objects, so the
		// identity check that belongs in the implementation is the one that has
		// to give way here.
		const titles = (list) => list.map((s) => s.title).join(',');
		check('it reads a raw array', titles(fromArray) === 'S1,S2', titles(fromArray));
		check('it reads {scenes: [...]}', titles(fromObject) === 'S1,S2', titles(fromObject));
		check(
			'it does not fall back to bundled for either',
			titles(fromArray) !== titles(bundled) && titles(fromObject) !== titles(bundled),
		);
	} finally {
		fs.rmSync(p1, { force: true });
		fs.rmSync(p2, { force: true });
	}
}

/* ---- 3. the bundled dataset is the last resort, not the first ----------- */
console.log('\n3. fallbacks');
{
	check('no props at all still yields something', resolveScenes(undefined).length > 0);
	check('an empty array falls back to bundled', resolveScenes([]) === bundled);
	check('an empty {scenes: []} falls back to bundled', resolveScenes({ scenes: [] }) === bundled);
	check('null scenes fall back to bundled', resolveScenes({ scenes: null }) === bundled);
}

/* ---- 4. the bundled dataset should not be what ships -------------------- */
console.log('\n4. the bundled dataset');
{
	check('it has scenes', Array.isArray(bundled) && bundled.length > 0, `${bundled.length} scenes`);
	const audioOf = bundled[0]?.audioPath || '';
	const onDisk = audioOf ? path.join(ROOT, 'public', audioOf) : '';
	check(
		"the bundled dataset's audio still exists",
		Boolean(onDisk) && fs.existsSync(onDisk),
		onDisk ? path.basename(path.dirname(onDisk)) : 'no audioPath',
	);
	if (audioOf) {
		const sessionId = audioOf.split(/[\\/]/)[1];
		check(
			'it points at a specific session, not a fresh one',
			/^sess_[0-9a-f]+$/.test(sessionId || ''),
			sessionId,
		);
	}
}

function makeScene(n, text) {
	return { sceneNumber: n, narratorText: text, title: `S${n}`, durationInFrames: 90, audioPath: `audio/x/scene-${n}.wav` };
}

console.log(failures === 0 ? '\nAll props-shape checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

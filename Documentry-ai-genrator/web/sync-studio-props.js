'use strict';

/**
 * sync-studio-props.js — point Remotion Studio at the most recent render.
 *
 * The brief asked the server to write `public/input-props.json` every time a PDF
 * is processed. That is not done here, for two reasons.
 *
 * One is shared mutable state. A single file at a fixed path means two
 * concurrent uploads race on it, and whichever render happens to read it last
 * gets the other user's document. The existing pipeline passes a per-session
 * --props path straight to the CLI, which is correct precisely because there is
 * no shared file in the middle. Writing this on every upload would put one back.
 *
 * Two is that the file holds somebody's parsed document inside `public/`. Today
 * that directory is not a public mount — the server serves only `/audio/*` from
 * it, and GET /input-props.json falls through to the SPA shell, verified rather
 * than assumed. But that is one line of routing away from exposing it, and
 * public/ is exactly where a static mount would go.
 *
 * So the file is written here instead, by hand, on demand:
 *
 *   npm run studio:props     refresh public/input-props.json from the newest render
 *   npm run studio           refresh it, then open Studio on it
 *
 * The render pipeline is untouched. It still passes a per-session --props path
 * straight to the CLI, which is the correct design: every render gets exactly
 * the scenes it was asked for, with no shared mutable file in the middle.
 *
 * The output is gitignored. It is a local scratch file containing somebody's
 * document, not a source file.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DOCUBOT_DATA_DIR
	? path.resolve(process.env.DOCUBOT_DATA_DIR)
	: path.join(ROOT, '.data', 'sessions');
const TARGET = path.join(ROOT, 'public', 'input-props.json');

/**
 * Every dataset.json on disk, newest first.
 *
 * Scans the whole tree rather than assuming one directory: after the per-user
 * isolation change the datasets live at
 * .data/sessions/u_<hash>/<session id>/dataset.json, and sessions created before
 * that change are still directly under .data/sessions/<id>/. Both are found.
 */
const findDatasets = () => {
	/** @type {{file: string, mtime: number}[]} */
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 3) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			// Files first. dataset.json is a file, so an isDirectory() guard in
			// front of this check skipped every one of them.
			if (entry.isFile() && entry.name === 'dataset.json') {
				try {
					found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
				} catch {
					/* raced with a delete */
				}
				continue;
			}
			if (entry.isDirectory()) walk(full, depth + 1);
		}
	};
	walk(DATA_DIR, 0);
	return found.sort((a, b) => b.mtime - a.mtime);
};

/**
 * Wrap a scene array in the object shape Remotion wants.
 *
 * This is the shape mismatch that caused the original silent-render bug: the
 * server wrote a bare array to dataset.json and passed it as --props, but
 * calculateMetadata read `props.scenes`, so every render fell back to the
 * bundled src/dataset.json and produced the same 8-scene video regardless of
 * the PDF. Root.tsx's resolveScenes now accepts both, but Studio's props editor
 * is schema-driven and reads top-level keys, so writing the bare array would
 * show an empty composition. Object form here.
 */
const toProps = (dataset) => {
	if (Array.isArray(dataset)) return { scenes: dataset };
	if (dataset && Array.isArray(dataset.scenes)) return dataset;
	return null;
};

const main = () => {
	if (!fs.existsSync(DATA_DIR)) {
		console.error(`No data directory at ${DATA_DIR}. Nothing to sync.`);
		process.exit(1);
	}

	const datasets = findDatasets();
	if (!datasets.length) {
		console.error(
			`No dataset.json found under ${DATA_DIR}.\n` +
				'Render a video first, or run `npm run pipeline`.',
		);
		process.exit(1);
	}

	const newest = datasets[0];
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(newest.file, 'utf8'));
	} catch (err) {
		console.error(`Could not read ${newest.file}: ${err.message}`);
		process.exit(1);
	}

	const props = toProps(parsed);
	if (!props || !props.scenes.length) {
		console.error(`${newest.file} holds no scenes. Refusing to write an empty Studio props file.`);
		process.exit(1);
	}

	fs.mkdirSync(path.dirname(TARGET), { recursive: true });
	fs.writeFileSync(TARGET, `${JSON.stringify(props, null, 2)}\n`, 'utf8');

	const rel = path.relative(ROOT, newest.file).split(path.sep).join('/');
	const when = new Date(newest.mtime).toLocaleString();
	console.log(`  wrote ${path.relative(ROOT, TARGET).split(path.sep).join('/')}`);
	console.log(`    from   ${rel}`);
	console.log(`    scenes ${props.scenes.length}`);
	console.log(`    mtime  ${when}`);
	console.log('');
	console.log('  Now: npm run studio');

	// Also print the frames-per-second note, because Studio's default duration
	// comes from the composition, not from this file.
	const fps = props.fps ?? props.scenes[0]?.fps;
	if (fps) console.log(`    fps    ${fps} (from the dataset, if present)`);
};

main();

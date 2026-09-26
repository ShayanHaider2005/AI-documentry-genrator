'use strict';

/**
 * render.js — Server-side MP4 rendering by driving the Remotion CLI.
 *
 * Keeping this out of web.js means the render step can be triggered from the
 * site, a script, or CI without duplicating the command line.
 *
 * Exports: renderVideo({ datasetPath, outFile, onLog, signal }) → Promise<string>
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'src/index.ts';
const COMPOSITION_ID = 'Documentary';

// Invoke the Remotion CLI's JS entry directly rather than through `npx`.
// Node >= 18.20 refuses to spawn a .cmd without a shell (EINVAL), and going
// straight to the JS avoids shell quoting issues around --props paths.
const REMOTION_CLI = path.join(ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');

/** Pull "Rendered 1234/5366" style counters out of the CLI output. */
const parseProgress = (line) => {
	const match =
		/Rendered\s+(\d+)\s*\/\s*(\d+)/i.exec(line) ||
		/(\d+)\s*\/\s*(\d+)\s+frames?/i.exec(line);
	if (!match) return null;
	const current = Number(match[1]);
	const total = Number(match[2]);
	if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
		return null;
	}
	return { current, total, percent: Math.min(100, (current / total) * 100) };
};

/**
 * Render the Documentary composition to an MP4 file.
 *
 * @param {object}   options
 * @param {string}   options.datasetPath  Path to the JSON dataset (array of scenes).
 * @param {string}   options.outFile      Destination .mp4 path.
 * @param {string}   [options.frames]     Optional frame range, e.g. "0-120" (default: whole video).
 * @param {Function} [options.onLog]      Called with (text, progress|null).
 * @param {AbortSignal} [options.signal]  Abort an in-flight render.
 * @returns {Promise<string>} The resolved output path.
 */
function renderVideo({ datasetPath, outFile, frames, onLog = () => {}, signal }) {
	if (!datasetPath || !fs.existsSync(datasetPath)) {
		return Promise.reject(new Error(`Dataset not found: ${datasetPath}`));
	}

	fs.mkdirSync(path.dirname(outFile), { recursive: true });

	const args = [
		'render',
		ENTRY,
		COMPOSITION_ID,
		outFile,
		`--props=${datasetPath}`,
		...(frames ? [`--frames=${frames}`] : []),
		'--log=info',
		'--concurrency=50%',
	];

	return new Promise((resolve, reject) => {
		if (!fs.existsSync(REMOTION_CLI)) {
			return reject(
				new Error(`Remotion CLI not found at ${REMOTION_CLI} — run npm install.`),
			);
		}

		const child = spawn(process.execPath, [REMOTION_CLI, ...args], {
			cwd: ROOT,
			windowsHide: true,
			env: { ...process.env, FORCE_COLOR: '0' },
		});

		let settled = false;
		let stderrTail = '';

		const onAbort = () => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		};
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
		}

		const handleChunk = (buffer) => {
			const text = buffer.toString();
			for (const rawLine of text.split(/\r?\n|\r/)) {
				const line = rawLine.trim();
				if (!line) continue;
				onLog(line, parseProgress(line));
			}
		};

		child.stdout.on('data', handleChunk);
		child.stderr.on('data', (buffer) => {
			handleChunk(buffer);
			stderrTail = `${stderrTail}${buffer.toString()}`.slice(-4000);
		});

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			reject(new Error(`Failed to launch Remotion CLI: ${err.message}`));
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			if (signal) signal.removeEventListener('abort', onAbort);

			if (code === 0 && fs.existsSync(outFile)) {
				const { size } = fs.statSync(outFile);
				if (size > 0) {
					onLog(`Render complete: ${outFile}`, {
						current: 1,
						total: 1,
						percent: 100,
					});
					return resolve(outFile);
				}
			}
			reject(
				new Error(
					`Render failed (exit code ${code}).${
						stderrTail ? `\n${stderrTail.slice(-800)}` : ''
					}`,
				),
			);
		});
	});
}

module.exports = { renderVideo, parseProgress };

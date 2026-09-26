'use strict';

/**
 * build.js — Bundles the React frontend into web/dist.
 *
 * Uses esbuild (already present as a transitive dependency) so the site needs
 * no extra tooling. Emits bundle.js / bundle.css and copies index.html.
 *
 * Run: node web/build.js   (or: npm run web:build)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = __dirname;
const DIST_DIR = path.join(WEB_DIR, 'dist');
const ENTRY = path.join(WEB_DIR, 'src', 'main.tsx');

async function main() {
	const esbuild = await import('esbuild');

	fs.mkdirSync(DIST_DIR, { recursive: true });
	fs.copyFileSync(path.join(WEB_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));

	const result = await esbuild.build({
		entryPoints: [ENTRY],
		bundle: true,
		outfile: path.join(DIST_DIR, 'bundle.js'),
		platform: 'browser',
		target: ['chrome100', 'firefox100', 'safari15'],
		format: 'iife',
		jsx: 'automatic',
		minify: true,
		sourcemap: false,
		logLevel: 'info',
		loader: {
			'.png': 'file',
			'.jpg': 'file',
			'.svg': 'file',
		},
		define: {
			'process.env.NODE_ENV': '"production"',
		},
		// Remotion and React ship ESM+CJS; let esbuild resolve both.
		mainFields: ['module', 'main'],
		conditions: ['import', 'require', 'default'],
	});

	if (result.errors && result.errors.length > 0) {
		process.exitCode = 1;
		return;
	}

	const bundle = path.join(DIST_DIR, 'bundle.js');
	const size = fs.existsSync(bundle) ? fs.statSync(bundle).size : 0;
	console.log(`[WEB] built ${path.relative(ROOT, bundle)} (${(size / 1024).toFixed(0)} KB)`);

	const css = path.join(DIST_DIR, 'bundle.css');
	console.log(
		fs.existsSync(css)
			? `[WEB] built ${path.relative(ROOT, css)}`
			: '[WEB] note: no bundle.css emitted (styles may be inlined)',
	);
}

main().catch((err) => {
	console.error('[WEB] build failed:', err.message || err);
	process.exitCode = 1;
});

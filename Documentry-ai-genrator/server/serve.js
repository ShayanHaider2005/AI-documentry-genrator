'use strict';

/**
 * serve.js — starts everything the site needs, with one command.
 *
 * Voice cloning runs in a separate Python service. Running `npm run web` alone
 * used to leave that service down, and the site then quietly narrated in the
 * default voice, which looks exactly like "voice cloning does not work".
 *
 * So this is the single entry point:
 *   - starts the OmniVoice service if it is not already running
 *   - starts the web server
 *   - shuts the voice service down again on exit
 *
 * If the voice stack was never installed, it says so with the exact command
 * rather than starting the site with cloning silently unavailable.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const omnivoice = require('./omnivoice');

const ROOT = path.join(__dirname, '..');
const VOICE_DIR = path.join(ROOT, 'server', 'voice');
const VENV_PYTHON = path.join(VOICE_DIR, '.venv', 'Scripts', 'python.exe');
const SERVICE = path.join(VOICE_DIR, 'server.py');
const SETUP = path.join(VOICE_DIR, 'setup.py');

/**
 * The model is ~3.3 GB and loads on CPU, so a cold start is minutes rather
 * than seconds. Wait generously, and say what is happening while waiting.
 */
const BOOT_TIMEOUT_MS = Number(process.env.OMNIVOICE_BOOT_TIMEOUT_MS || 30 * 60 * 1000);

const colour = (code, text) => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => colour(32, t);
const yellow = (t) => colour(33, t);
const red = (t) => colour(31, t);
const bold = (t) => colour(1, t);
const dim = (t) => colour(90, t);

const isWindows = process.platform === 'win32';

/** Ask the voice service whether it is up and has its model loaded. */
async function voiceHealth(timeoutMs = 3000) {
	const result = await omnivoice.serviceHealth(timeoutMs);
	return {
		reachable: result.reachable,
		ready: Boolean(result.body?.ready),
		loading: Boolean(result.body?.loading),
		body: result.body,
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the service to report ready.
 *
 * A cold start loads ~3.3 GB of weights, so this polls patiently and reports
 * progress rather than appearing to hang. "loading" is a normal state, not a
 * failure, so it is not treated as one.
 */
async function waitUntilReady(proc) {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let announced = false;
	let ticks = 0;

	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`the voice service exited with code ${proc.exitCode}`);
		}
		const { reachable, ready, body } = await voiceHealth();
		if (reachable && ready) return body;

		ticks += 1;
		if (!announced && reachable && body?.loading) {
			process.stdout.write(
				dim('  loading the OmniVoice model (~3.3 GB; minutes on CPU)...\n'),
			);
			announced = true;
		}
		// Before the port even opens, the model download is the likely hold-up.
		if (!announced && ticks > 3) {
			process.stdout.write(dim('  starting the voice service...\n'));
			announced = true;
		}
		await sleep(2000);
	}
	throw new Error(
		`the voice service was still loading after ${Math.round(BOOT_TIMEOUT_MS / 60000)} minutes. ` +
			'Check server/voice/service.log — the first run downloads ~3.3 GB.',
	);
}

/** Report what is missing and how to fix it, then run setup if asked to. */
function runSetup() {
	console.log('');
	console.log(red(bold('  Voice cloning has never been set up on this machine.')));
	console.log('');
	console.log('  It needs a one-time install (~4 GB, several minutes):');
	console.log(yellow('    npm run voice:setup'));
	console.log('');

	if (process.stdin.isTTY && process.argv.includes('--setup')) {
		console.log('  Running it now...');
		const result = spawnSync('py', ['-3', SETUP], {
			cwd: ROOT,
			stdio: 'inherit',
			shell: isWindows,
		});
		if (result.status !== 0) {
			console.error(red('  Setup failed. See the output above.'));
			return false;
		}
		return true;
	}
	return false;
}

let voiceProcess = null;

function stopVoice() {
	if (!voiceProcess || voiceProcess.exitCode !== null) return;
	voiceProcess.kill();
	voiceProcess = null;
}

async function startVoiceService() {
	const existing = await voiceHealth();
	if (existing.ready) {
		console.log(`  voice      ${green('already running')} ${dim(omnivoice.SERVICE_URL)}`);
		return true;
	}

	if (!fs.existsSync(VENV_PYTHON)) {
		if (!runSetup()) return false;
		if (!fs.existsSync(VENV_PYTHON)) {
			console.error(red('  Setup did not produce the voice environment.'));
			return false;
		}
	}
	if (!fs.existsSync(SERVICE)) {
		console.error(red(`  Missing ${SERVICE}`));
		return false;
	}

	const env = { ...process.env };

	const logFile = path.join(VOICE_DIR, 'service.log');
	const out = fs.openSync(logFile, 'a');
	console.log('  voice      starting OmniVoice...');

	voiceProcess = spawn(VENV_PYTHON, [SERVICE], {
		cwd: ROOT,
		env,
		stdio: ['ignore', out, out],
		detached: false,
	});
	voiceProcess.on('error', (err) => console.error(red(`  voice service failed to start: ${err.message}`)));
	voiceProcess.on('exit', (code) => {
		if (code !== 0 && code !== null) {
			console.error(red(`  voice service exited with code ${code}; see ${logFile}`));
		}
	});

	try {
		const body = await waitUntilReady(voiceProcess);
		console.log(
			`  voice      ${green('ready')} ${dim(`cloning+speech on ${body.device} (${body.dtype})`)}`,
		);
		return true;
	} catch (err) {
		console.error(red(`  ${err.message}`));
		console.error(dim(`  see ${logFile}`));
		stopVoice();
		return false;
	}
}

async function main() {
	console.log('');
	console.log(`  ${bold('DocuBot')} ${dim('- starting services')}`);
	console.log('');

	const voiceReady = await startVoiceService();
	if (!voiceReady) {
		console.log('');
		console.log(
			red('  The site will still run, but narration will use the built-in neural voice.'),
		);
		console.log(dim('  Start the voice service with: npm run voice:start'));
		console.log('');
	}

	// Run the web server in this same process, so Ctrl+C stops both services.
	const { startWebServer } = require('./web');
	startWebServer();

	const shutdown = () => {
		stopVoice();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	process.on('exit', stopVoice);
}

main().catch((err) => {
	console.error(red(`\n  ${err.message}\n`));
	stopVoice();
	process.exit(1);
});

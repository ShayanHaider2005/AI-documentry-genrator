'use strict';

/**
 * serve.js — starts everything the site needs, with one command.
 *
 * Voice cloning runs in a separate Python service. Running `npm run web` alone
 * used to leave that service down, and the site then quietly narrated in the
 * default voice, which looks exactly like "voice cloning does not work".
 *
 * So this is the single entry point:
 *   - starts the voice service if it is not already running
 *   - starts the web server
 *   - shuts the voice service down again on exit
 *
 * If the voice stack was never installed, it says so with the exact command
 * rather than starting the site with cloning silently unavailable.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VOICE_DIR = path.join(ROOT, 'server', 'voice');
const VENV_PYTHON = path.join(VOICE_DIR, '.venv', 'Scripts', 'python.exe');
const SERVICE = path.join(VOICE_DIR, 'service.py');
const SETUP = path.join(VOICE_DIR, 'setup.py');
const SETUP_LOG = path.join(VOICE_DIR, 'setup.log');

const SERVICE_URL = (process.env.OPENVOICE_URL || 'http://127.0.0.1:5055').replace(/\/+$/, '');
const BOOT_TIMEOUT_MS = 240000;

const colour = (code, text) => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => colour(32, t);
const yellow = (t) => colour(33, t);
const red = (t) => colour(31, t);
const bold = (t) => colour(1, t);
const dim = (t) => colour(90, t);

const isWindows = process.platform === 'win32';

/** Ask the voice service whether it is up and has its model loaded. */
async function voiceHealth(timeoutMs = 3000) {
	try {
		const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		const body = await res.json().catch(() => ({}));
		return { reachable: res.ok, ready: Boolean(body?.ready), body };
	} catch {
		return { reachable: false, ready: false, body: null };
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the service to report ready. Model loading on CPU takes a while, so
 * this polls patiently and says so, rather than appearing to hang.
 */
async function waitUntilReady(proc) {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let announced = false;

	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`the voice service exited with code ${proc.exitCode}`);
		}
		const { reachable, body } = await voiceHealth();
		if (reachable && body?.ready) return body;

		if (!announced) {
			process.stdout.write(dim('  loading the voice model (CPU, first run can take a minute)...\n'));
			announced = true;
		}
		await sleep(2000);
	}
	throw new Error('the voice service did not become ready in time');
}

/** Report what is missing and how to fix it, then run setup if asked to. */
function runSetup() {
	console.log('');
	console.log(red(bold('  Voice cloning has never been set up on this machine.')));
	console.log('');
	console.log('  It needs a one-time install (about 1 GB, a few minutes):');
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
		console.log(`  voice clone  ${green('already running')} ${dim(SERVICE_URL)}`);
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

	// NLTK refuses to fetch through a proxy without this opt-in, and the
	// English grapheme-to-phoneme step needs the corpora.
	const env = {
		...process.env,
		NLTK_ALLOW_PROXIED_URLOPEN: process.env.NLTK_ALLOW_PROXIED_URLOPEN || '1',
		NLTK_DATA: process.env.NLTK_DATA || path.join(VOICE_DIR, 'nltk_data'),
	};

	const logFile = path.join(VOICE_DIR, 'service.log');
	const out = fs.openSync(logFile, 'a');
	console.log('  voice clone  starting...');

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
			`  voice clone  ${green('ready')} ${dim(`cloning+speech on ${body.device}`)}`,
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
		console.log(red('  The site will still run, but narration will use the default voice.'));
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

'use strict';

/**
 * Checks the voice client's HTTP layer, which had a defect that made the
 * configured synthesis timeout meaningless.
 *
 * `fetch` runs on undici, which enforces its own 300-second headers timeout
 * that AbortSignal does not override. OmniVoice replies only once inference
 * finishes, so every request taking more than five minutes died with
 * UND_ERR_HEADERS_TIMEOUT no matter what OMNIVOICE_SYNTH_TIMEOUT_MS said.
 *
 * Note the module reads its env vars at require time, so these tests set the
 * environment BEFORE pulling the client in. Setting it afterwards silently
 * does nothing, which is itself worth being careful about.
 *
 * By default the long test uses a short delay. Pass --long to run a genuine
 * >300 s request, which is the only thing that actually proves undici's cap is
 * gone; that takes five minutes of wall clock.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Somewhere harmless to point outputPath; the fake service writes a stub. */
const OUT = path.join(os.tmpdir(), 'omnivoice-client-check');

/**
 * A stand-in for the voice service.
 * @param {(req, res) => void} handler
 * @param {{delayHeaders?: number}} opts hold the response open before replying.
 */
const startFake = (handler, { delayHeaders = 0 } = {}) =>
	new Promise((resolve) => {
		const server = http.createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			req.bodyText = Buffer.concat(chunks).toString('utf8');
			if (delayHeaders) await sleep(delayHeaders);
			handler(req, res);
		});
		server.listen(0, '127.0.0.1', () => {
			resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
		});
	});

/**
 * Point a freshly loaded client at a fake service.
 * `env` is applied first, because the module reads it at require time.
 */
const useClient = (url, env = {}) => {
	process.env.OMNIVOICE_URL = url;
	for (const [k, v] of Object.entries(env)) {
		if (v === null) delete process.env[k];
		else process.env[k] = String(v);
	}
	delete require.cache[require.resolve('../server/omnivoice')];
	return require('../server/omnivoice');
};

/** A fake that behaves like the real service: writes the file, reports the path. */
const writesFile = (extra = {}) => (req, res) => {
	const out = JSON.parse(req.bodyText).output_path;
	fs.writeFileSync(out, 'not really audio');
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ output_path: out, seconds: 1.5, mode: 'clone', ...extra }));
};

(async () => {
	/* ---- 1. a normal reply ---------------------------------------------- */
	console.log('\n1. a normal reply');
	{
		const { server, url } = await startFake(
			writesFile({ num_step: 12, rtf: 0.5, device: 'cpu' }),
		);
		const client = useClient(url, { OMNIVOICE_SYNTH_TIMEOUT_MS: null });
		const r = await client.generateVoice({ text: 'hello', outputPath: path.join(OUT, 'x.mp3') });
		check('it parses the response', r.seconds === 1.5 && r.mode === 'clone');
		check('it reports the step count', r.numStep === 12);
		check('it reports the device', r.device === 'cpu');
		server.close();
	}

	/* ---- 2. a slow reply is WAITED FOR ----------------------------------- */
	console.log('\n2. a slow reply, inside the configured timeout');
	{
		const SLOW = 8000;
		const { server, url } = await startFake(writesFile(), { delayHeaders: SLOW });
		// The timeout must exceed the delay, or the client is right to give up.
		const client = useClient(url, { OMNIVOICE_SYNTH_TIMEOUT_MS: 60_000 });
		try {
			const t0 = Date.now();
			const r = await client.generateVoice({ text: 'slow', outputPath: path.join(OUT, 'y.mp3') });
			const waited = Date.now() - t0;
			check('it waited rather than giving up', waited >= SLOW, `${waited} ms for a ${SLOW} ms delay`);
			check('the response arrived intact', r.mode === 'clone');
		} catch (err) {
			check('it waited rather than giving up', false, err.message);
		}
		server.close();
	}

	/* ---- 3. the client's own timeout still fires, with a useful message --- */
	console.log('\n3. a reply slower than the configured timeout');
	{
		const { server, url } = await startFake(() => {}, { delayHeaders: 30_000 });
		const client = useClient(url, { OMNIVOICE_SYNTH_TIMEOUT_MS: 3000 });
		const t0 = Date.now();
		try {
			await client.generateVoice({ text: 'forever', outputPath: path.join(OUT, 'z.mp3') });
			check('it gives up', false, 'it returned instead');
		} catch (err) {
			const waited = Date.now() - t0;
			check('it gives up', /timed out/i.test(err.message), `"${err.message.slice(0, 52)}..."`);
			check('it gives up on schedule', waited < 15_000, `${waited} ms for a 3000 ms timeout`);
			check(
				'the message says what to do',
				/OMNIVOICE_NUM_STEP|too long/i.test(err.message),
			);
		}
		server.close();
	}

	/* ---- 4. the real bug: a request past undici's 300 s headers cap ------ */
	console.log('\n4. a request longer than 300 s (undici used to kill these)');
	{
		const LONG = process.argv.includes('--long') ? 320_000 : 8000;
		console.log(
			process.argv.includes('--long')
				? `   running for real: ${LONG / 1000}s, this takes ${LONG / 1000 / 60} minutes`
				: `   quick mode (${LONG / 1000}s). Pass --long for the real 320 s test.`,
		);
		const { server, url } = await startFake(writesFile(), { delayHeaders: LONG });
		// Comfortably longer than the delay, so the only thing that can end the
		// wait early is a cap we failed to remove.
		const client = useClient(url, { OMNIVOICE_SYNTH_TIMEOUT_MS: 900_000 });
		try {
			const t0 = Date.now();
			const r = await client.generateVoice({ text: 'long', outputPath: path.join(OUT, 'l.mp3') });
			const waited = Date.now() - t0;
			check('it survived the full wait', waited >= LONG, `${waited} ms for a ${LONG} ms delay`);
			check('the response arrived intact', r.mode === 'clone');
		} catch (err) {
			check('it survived the full wait', false, `${err.code || err.message}`);
		}
		server.close();
	}

	/* ---- 5. a service error surfaces the reason, not a bare status -------- */
	console.log('\n5. errors from the service');
	{
		const { server, url } = await startFake((req, res) => {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ detail: 'instruct must be one of: male, female' }));
		});
		const client = useClient(url);
		try {
			await client.generateVoice({ text: 'x', outputPath: path.join(OUT, 'e.mp3') });
			check('it throws', false, 'it did not');
		} catch (err) {
			check('it carries the status', /HTTP 400/.test(err.message));
			check("it passes through the service's reason", /instruct must be one of/.test(err.message));
		}
		server.close();
	}

	/* ---- 6. a dead service is reported as such --------------------------- */
	console.log('\n6. a service that is not running');
	{
		const { server, url } = await startFake(() => {});
		const port = new URL(url).port;
		server.close();
		await sleep(300);
		const client = useClient(`http://127.0.0.1:${port}`);
		try {
			await client.generateVoice({ text: 'x', outputPath: path.join(OUT, 'f.mp3') });
			check('it throws', false, 'it did not');
		} catch (err) {
			check('it explains how to start the service', /npm run voice:start|npm run web/.test(err.message));
		}
	}

	/* ---- 7. a service that reports a file it did not write -------------- */
	console.log('\n7. a service that lies about writing the file');
	{
		const { server, url } = await startFake((req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					output_path: path.join(OUT, 'never-written.mp3'),
					seconds: 1,
					mode: 'clone',
				}),
			);
		});
		const client = useClient(url);
		try {
			await client.generateVoice({ text: 'x', outputPath: path.join(OUT, 'g.mp3') });
			check('it throws rather than returning a missing file', false, 'it did not');
		} catch (err) {
			check('it throws rather than returning a missing file', /not on disk/.test(err.message));
		}
		server.close();
	}

	/* ---- 8. validateReference reports unreachability cleanly ------------- */
	console.log('\n8. validateReference against a dead service');
	{
		const client = useClient('http://127.0.0.1:59999');
		const r = await client.validateReference({ refAudioPath: __filename });
		check('it returns ok:false, not an exception', r.ok === false);
		check(
			'it gives an actionable reason',
			typeof r.reason === 'string' && r.reason.length > 10,
			`"${String(r.reason).slice(0, 48)}..."`,
		);
	}

	fs.rmSync(OUT, { recursive: true, force: true });
	console.log(failures === 0 ? '\nAll client checks passed.' : `\n${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})();

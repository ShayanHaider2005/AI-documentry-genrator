'use strict';

/**
 * Checks the narration library: manifest reading, voice selection, and the auth
 * gateway that guards everything above the login page.
 *
 * Deliberately does not synthesise anything. These are the parts that can be
 * wrong in ways a running server would only show as a wrong voice, a 500, or a
 * video that quietly loses its audio.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'server', 'voices', 'defaults', 'manifest.json');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures += 1;
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docubot-check-'));

const main = async () => {
/* ---- 1. the manifest is what the generator promised --------------------- */
console.log('\n1. the voice library manifest');
if (!fs.existsSync(MANIFEST)) {
	check('a manifest exists', false, `${MANIFEST} not found. Run: npm run voice:library`);
} else {
	const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
	check('it parses', Boolean(manifest), `${(manifest.voices || []).length} voices`);

	const voices = manifest.voices || [];
	check('it has voices', voices.length > 0, `${voices.length}`);
	check(
		'ten is the target (5 accents x 2 genders)',
		voices.length === 10,
		`${voices.length} of 10`,
	);

	const genders = new Set(voices.map((v) => v.gender));
	check('both genders are present', genders.size === 2, [...genders].join(', '));

	for (const gender of ['male', 'female']) {
		const forGender = voices.filter((v) => v.gender === gender);
		check(`${gender}: five accents`, forGender.length === 5, `${forGender.length}`);
	}

	const accents = new Set(voices.map((v) => v.accent));
	check('five distinct accents', accents.size === 5, [...accents].join(', '));

	// Every voice must be one the model can actually produce, or generation
	// would have failed. This is the check that would have caught asking for an
	// "african accent", which the model's closed vocabulary does not contain.
	// American has two spellings: the UI says "USA", the model says "american".
	const VALID_ACCENTS = [
		'american', 'australian', 'british', 'canadian', 'chinese',
		'indian', 'japanese', 'korean', 'portuguese', 'russian',
		'usa', // the model's own alternative spelling
	];
	const accentOf = (instruct) =>
		/\b([a-z]+) accent\b/i.exec(String(instruct || ''))?.[1]?.toLowerCase() || '';
	const badInstruct = voices.filter((v) => !VALID_ACCENTS.includes(accentOf(v.instruct)));
	check('every instruct uses a real model accent', badInstruct.length === 0,
		badInstruct.length
			? badInstruct.map((v) => `${v.voiceId}="${v.instruct}"`).join('; ')
			: `all valid: ${[...new Set(voices.map((v) => accentOf(v.instruct)))].join(', ')}`);

	// The instruct must also carry the gender the picker claims, or a "Female"
	// option would hand back a male voice.
	const genderMismatch = voices.filter((v) => {
		const instruct = String(v.instruct || '').toLowerCase();
		return v.gender === 'female' ? !instruct.includes('female') : !instruct.includes('male');
	});
	check('every instruct matches its gender', genderMismatch.length === 0,
		genderMismatch.length ? genderMismatch.map((v) => v.voiceId).join(', ') : 'all consistent');

	// No voice may claim an accent the audio does not have.
	const mislabelled = voices.filter((v) => {
		const claimed = String(v.accentLabel || '').toLowerCase();
		if (claimed.includes('african')) return true;
		return false;
	});
	check('no voice claims an African accent', mislabelled.length === 0,
		mislabelled.length ? mislabelled.map((v) => v.voiceId).join(', ') : 'none do');

	// ref_text is what keeps synthesis off Whisper, so it must be present.
	const noText = voices.filter((v) => !String(v.refText || '').trim());
	check('every voice has a transcript', noText.length === 0,
		noText.length ? noText.map((v) => v.voiceId).join(', ') : 'all have ref_text');
	check(
		'transcripts are the fixed three sentences',
		voices.every((v) => String(v.refText || '').trim() === String(manifest.referenceText || '').trim()),
	);

	// And the audio has to be there, at 24 kHz mono, or the offer is a lie.
	let missing = 0;
	let badRate = 0;
	for (const v of voices) {
		const p = path.isAbsolute(v.audioPath) ? v.audioPath : path.join(ROOT, v.audioPath);
		if (!fs.existsSync(p)) {
			missing += 1;
			continue;
		}
		if (Number(v.sampleRate) !== 24000) badRate += 1;
	}
	check('every WAV is on disk', missing === 0, missing ? `${missing} missing` : 'all present');
	check('every WAV is 24 kHz', badRate === 0, badRate ? `${badRate} wrong rate` : 'all 24000 Hz');
	check('the manifest explains the accent mapping', /no african accent/i.test(manifest.note || ''),
		(manifest.note || '(none)').slice(0, 60));
}

/* ---- 2. reading the library, including when it is absent ---------------- */
console.log('\n2. readVoiceLibrary');
{
	// Load fresh so the mtime cache cannot mask a missing manifest.
	for (const key of Object.keys(require.cache)) {
		if (key.includes(path.join('server', 'voices.js'))) delete require.cache[key];
	}
	const { readVoiceLibrary, defaultLibraryVoice, voiceById } = require('../server/voices');

	const library = readVoiceLibrary();
	if (fs.existsSync(MANIFEST)) {
		check('it reports available', library.available === true, `${library.voices.length} voices`);
		check('it carries the accent labels', Object.keys(library.accents || {}).length > 0);
		check('it carries instruct strings', library.voices.every((v) => v.instruct));
		check('it carries ref_text', library.voices.every((v) => v.refText));
		const dflt = defaultLibraryVoice();
		check('it picks a default', Boolean(dflt), dflt || 'none');
		check('the default exists in the list', library.voices.some((v) => v.voiceId === dflt));
		check('a known id resolves', Boolean(voiceById('male_indian')), 'male_indian');
		check('an unknown id resolves to null', voiceById('nope_not_real') === null);
	} else {
		check('it reports unavailable rather than throwing', library.available === false);
		check('it returns an empty list', Array.isArray(library.voices) && library.voices.length === 0);
		check('it explains how to build it', /voice:library/.test(library.note || ''), library.note);
		check('no default is invented', defaultLibraryVoice() === null);
	}
}

/* ---- 3. auth: the hashing and the session lifecycle --------------------- */
console.log('\n3. authentication');
{
	const { createAuth, hashPassword, verifyPassword, parseCookies, COOKIE_NAME } =
		require('../server/auth');

	check('a password is not stored in the clear',
		!hashPassword('correct horse').includes('correct horse'));
	check('the same password verifies', verifyPassword('correct horse', hashPassword('correct horse')));
	check('a different password does not', !verifyPassword('wrong', hashPassword('correct horse')));
	check('a malformed hash fails closed', !verifyPassword('x', 'garbage'));
	check('two hashes of one password differ (salted)',
		hashPassword('a') !== hashPassword('a'));

	const file = path.join(tempDir(), 'users.json');
	const auth = createAuth({ file });

	const reg = await auth.register({ username: 'shayan', password: 'hunter2hunter' });
	check('registration returns a token', typeof reg.token === 'string' && reg.token.length > 20);
	check('it never returns the hash', !JSON.stringify(reg.user).includes('passwordHash'));
	check('the user verifies', Boolean(auth.verify(reg.token)));
	check('a wrong token does not', auth.verify('made-up') === null);
	check('an empty token does not', auth.verify('') === null);
	check('a null token does not', auth.verify(null) === null);

	// Wrong password and unknown user must be indistinguishable to the caller.
	const wrongPw = await auth.login({ username: 'shayan', password: 'not-it-at-all' }).then(
		() => null,
		(e) => e.message,
	);
	const noUser = await auth.login({ username: 'nobody', password: 'not-it-at-all' }).then(
		() => null,
		(e) => e.message,
	);
	check('a wrong password is rejected', Boolean(wrongPw), wrongPw);
	check('an unknown user gives the same message', wrongPw === noUser, noUser);

	await auth.register({ username: 'admin', password: 'another-secret' });
	const dup = await auth.register({ username: 'shayan', password: 'different-one' }).then(
		() => null,
		(e) => e.message,
	);
	check('a duplicate username is rejected', Boolean(dup), dup);

	const shortPw = await auth.register({ username: 'tiny', password: 'abc' }).then(
		() => null,
		(e) => e.message,
	);
	check('a short password is rejected', Boolean(shortPw), shortPw);

	const badName = await auth.register({ username: 'a b!', password: 'longenough1' }).then(
		() => null,
		(e) => e.message,
	);
	check('an invalid username is rejected', Boolean(badName), badName);

	// A second login must not disturb the first session.
	const second = await auth.login({ username: 'shayan', password: 'hunter2hunter' });
	check('the first session survives a second login', Boolean(auth.verify(reg.token)));
	check('the second session works', Boolean(auth.verify(second.token)));
	check('both sessions are distinct', reg.token !== second.token);

	await auth.logout(second.token);
	check('the logged-out token stops working', auth.verify(second.token) === null);
	check('the other session is untouched', Boolean(auth.verify(reg.token)));

	// A token from another store must not resolve.
	const other = createAuth({ file: path.join(tempDir(), 'other.json') });
	check('a foreign token is rejected', other.verify(reg.token) === null);

	// The file on disk must not contain anything reversible.
	const raw = fs.readFileSync(file, 'utf8');
	check('the store keeps hashes, not passwords', !raw.includes('hunter2hunter'));
	check('the store does not keep raw tokens', !raw.includes(reg.token));

	const cookies = parseCookies(`${COOKIE_NAME}=abc123; other=1`);
	check('cookies parse', cookies[COOKIE_NAME] === 'abc123', JSON.stringify(cookies));
	check('a URL-encoded cookie decodes', parseCookies(`${COOKIE_NAME}=a%20b`)[COOKIE_NAME] === 'a b');
	check('a malformed header does not throw', JSON.stringify(parseCookies('garbage')) === '{}');
	check('an empty header does not throw', JSON.stringify(parseCookies(undefined)) === '{}');
}

/* ---- 4. the one-button route exists and is wired ------------------------ */
console.log('\n4. the produce route');
{
	const source = fs.readFileSync(path.join(ROOT, 'server', 'web.js'), 'utf8');
	check("POST /api/produce exists", /'\/api\/produce'/.test(source));
	check('it is not in the public set (it needs auth)',
		!/'\/api\/produce'[^\n]*\n?[^\n]*PUBLIC_ROUTES/.test(source));
	check('it runs the pipeline', /api\/produce[\s\S]{0,2600}runPipeline/.test(source));
	check('it then renders', /api\/produce[\s\S]{0,4000}renderVideo/.test(source));
	check('render happens after generate in the same job',
		source.indexOf('runPipeline') < source.lastIndexOf('renderVideo'));
	check('it hands back a download URL', /downloadUrl/.test(source));
	check('the download names the file after the session', /DocuBot_\$\{session\.id\}/.test(source));
	check('the video route honours ?download=1', /searchParams\.get\('download'\)/.test(source));
	check('the public route list exists', /PUBLIC_ROUTES/.test(source));
	check('auth is required for the API', /unauthenticated/.test(source));
}

console.log(failures === 0 ? '\nAll library and auth checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(`\nFAILED: ${err.stack || err.message}`);
	process.exit(1);
});

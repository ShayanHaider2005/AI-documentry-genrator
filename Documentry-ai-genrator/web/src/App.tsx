import React from 'react';
import { DocumentaryVideo } from '../../src/DocumentaryVideo';
import { api, UnauthorisedError } from './api';
import type {
	JobStatus,
	LibraryVoice,
	Scene,
	SessionSummary,
	StoredSession,
	VoiceLibrary,
	VoiceSampleConfig,
} from './api';
import {
	Button,
	FilePicker,
	Notice,
	Player,
	VoiceRecorder,
} from './components';
import { CreatorFooter, DocuBotMark } from './Mascot';
import './styles.css';

const POLL_INTERVAL_MS = 1200;

const uid = () => Math.random().toString(36).slice(2, 10);

const formatDate = (iso: string) => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
};

const WELCOME =
	"Hi! I'm DocuBot. I turn a lecture PDF into a narrated documentary video.\n\n" +
	'To start a new video:\n' +
	'1. Press "+ New Video".\n' +
	'2. Drop your PDF below the preview.\n' +
	'3. Optionally record the three sample sentences and upload the MP3 — I will clone your voice and accent.\n' +
	'4. Press Generate, then Render MP4.\n\n' +
	'Your finished videos are listed on the left; select one to replay it instantly. You can also ask me about your document.';

/** Numbered step header used to make the flow obvious at a glance. */
const StepHeader: React.FC<{ step: number; title: string; done: boolean }> = ({
	step,
	title,
	done,
}) => (
	<div className="step-header">
		<span className={`step-badge${done ? ' done' : ''}`}>
			{done ? '✓' : step}
		</span>
		<span className="step-title">{title}</span>
	</div>
);

/**
 * Narrator picker: gender, then accent.
 *
 * Gender first because it is the coarser choice, and it keeps the accent list
 * short. The labels come from the server rather than being composed here, since
 * the model's accent vocabulary is closed and a label written in the browser
 * could claim an accent the audio does not have.
 */
const VoicePicker: React.FC<{
	library: VoiceLibrary | null;
	value: string | null;
	onChange: (voiceId: string | null) => void;
	disabled: boolean;
	fallbackLabel: string;
}> = ({ library, value, onChange, disabled, fallbackLabel }) => {
	const [gender, setGender] = React.useState<'male' | 'female'>('male');

	if (!library?.available) {
		return (
			<Notice kind="info">
				{/* Honest about the cause rather than implying a choice exists. */}
				{library?.note || 'No narrator library has been generated yet.'}
				{library && !library.note ? null : ' Run "npm run voice:library" to build it.'}
				{fallbackLabel ? ` Until then, narration uses ${fallbackLabel}.` : ''}
			</Notice>
		);
	}

	const forGender = library.voices.filter((voice) => voice.gender === gender);
	const selected = library.voices.find((voice) => voice.voiceId === value) || null;

	// A voice chosen under the other gender must not silently stay selected while
	// the accent list shows something else.
	const effective = selected && selected.gender === gender ? selected : null;

	return (
		<div className="voice-picker">
			<div className="seg" role="group" aria-label="Narrator gender">
				{(['male', 'female'] as const).map((option) => (
					<button
						type="button"
						key={option}
						className={`seg-btn${gender === option ? ' on' : ''}`}
						aria-pressed={gender === option}
						disabled={disabled}
						onClick={() => setGender(option)}
					>
						{option === 'male' ? 'Male' : 'Female'}
					</button>
				))}
			</div>

			<label className="field">
				<span>Accent</span>
				<select
					value={effective?.voiceId ?? ''}
					disabled={disabled}
					onChange={(event) => onChange(event.target.value || null)}
				>
					<option value="">Select an accent…</option>
					{forGender.map((voice) => (
						<option key={voice.voiceId} value={voice.voiceId}>
							{voice.accentLabel} — {voice.name}
						</option>
					))}
				</select>
			</label>

			{effective ? (
				<Notice kind="ok">
					Narrating with {effective.name} ({effective.accentLabel}). Synthesised locally
					with OmniVoice.
				</Notice>
			) : null}

			{library.note ? <p className="hint">{library.note}</p> : null}
		</div>
	);
};

export const App: React.FC<{ onSignOut?: () => void; username?: string }> = ({
	onSignOut,
	username,
}) => {
	const [config, setConfig] = React.useState<VoiceSampleConfig | null>(null);
	const [sessionId, setSessionId] = React.useState<string | null>(null);

	/* history */
	const [history, setHistory] = React.useState<SessionSummary[]>([]);
	const [active, setActive] = React.useState<StoredSession | null>(null);
	const [loadingSession, setLoadingSession] = React.useState<string | null>(null);

	const [pdfName, setPdfName] = React.useState<string | null>(null);
	const [pdfChars, setPdfChars] = React.useState<number | null>(null);
	const [voiceName, setVoiceName] = React.useState<string | null>(null);
	const [voiceInfo, setVoiceInfo] = React.useState<string | null>(null);
	const [voiceError, setVoiceError] = React.useState<string | null>(null);

	/* which generated narrator to use when nothing was uploaded */
	const [voiceId, setVoiceId] = React.useState<string | null>(null);
	/* The recorder is behind a toggle: most people will pick a narrator, and
	    three sample sentences plus a record button is a lot of surface to show
	    by default. */
	const [showRecorder, setShowRecorder] = React.useState(false);

	/** Hidden input used by the one-button flow when no PDF is chosen yet. */
	const coldStartInput = React.useRef<HTMLInputElement | null>(null);

	const [videoUrl, setVideoUrl] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState<string | null>(null);

	/* the single produce job: script, audio, visuals, then the merged MP4 */
	const [produceJob, setProduceJob] = React.useState<JobStatus | null>(null);
	const [narratorUsed, setNarratorUsed] = React.useState<string | null>(null);
	const [downloaded, setDownloaded] = React.useState(false);

	/** Send a 401 to the shell so the user lands on the sign-in screen. */
	const handleAuthLoss = React.useCallback((err: unknown) => {
		if (err instanceof UnauthorisedError) {
			window.dispatchEvent(new CustomEvent('docubot:unauthorised'));
		}
	}, []);

	const refreshHistory = React.useCallback(async () => {
		try {
			const { sessions } = await api.listSessions();
			setHistory(sessions);
		} catch {
			/* the sidebar is non-critical */
		}
	}, []);

	/* ---------------------------------------------------------- bootstrap */
	React.useEffect(() => {
		api
			.config()
			.then(setConfig)
			.catch(() => setError('Could not reach the server. Is it running?'));

		refreshHistory();

		// A finished video can be opened directly via ?session=<id>.
		const existing = new URLSearchParams(window.location.search).get('session');

		const startFresh = () => {
			api
				.createSession()
				.then(({ sessionId: id }) => {
					setSessionId(id);
					window.history.replaceState(
						null,
						'',
						`${window.location.pathname}?session=${id}`,
					);
				})
				.catch(() => setError('Could not start a session.'));
		};

		if (existing) {
			api
				.storedSession(existing)
				.then((record) => {
					setActive(record);
					setSessionId(record.id);
				})
				.catch(startFresh);
		} else {
			startFresh();
		}
	}, [refreshHistory]);

	/* ------------------------------------------------------------- polling */
	const pollJob = React.useCallback(
		async (jobId: string, onUpdate: (job: JobStatus) => void) => {
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const job = await api.job(jobId);
				onUpdate(job);
				if (job.status !== 'running') return job;
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}
		},
		[],
	);

	/* --------------------------------------------------------- new video */
	const handleNewVideo = () => {
		setActive(null);
		setVideoUrl(null);
		setPdfName(null);
		setPdfChars(null);
		setVoiceName(null);
		setVoiceInfo(null);
		setVoiceError(null);
		setProduceJob(null);
		setNarratorUsed(null);
		setDownloaded(false);
		setError(null);

		api
			.createSession()
			.then(({ sessionId: id }) => {
				setSessionId(id);
				window.history.replaceState(
					null,
					'',
					`${window.location.pathname}?session=${id}`,
				);
			})
			.catch(() => setError('Could not start a session.'));
	};

	/* ------------------------------------------------- sidebar selection */
	const handleSelectSession = async (id: string) => {
		if (id === active?.id) return;
		setError(null);
		setVideoUrl(null);
		setLoadingSession(id);
		try {
			// One small JSON request, then the player switches locally.
			const record = await api.storedSession(id);
			setActive(record);
			setSessionId(record.id);
			window.history.replaceState(
				null,
				'',
				`${window.location.pathname}?session=${record.id}`,
			);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setLoadingSession(null);
		}
	};

	const handleDeleteSession = async (
		event: React.MouseEvent,
		id: string,
	) => {
		event.stopPropagation();
		try {
			await api.deleteSession(id);
			if (active?.id === id) handleNewVideo();
			refreshHistory();
		} catch (err) {
			setError((err as Error).message);
		}
	};

	/* ------------------------------------------------------------- actions */
	const handlePdf = async (file: File) => {
		if (!sessionId) return;
		setError(null);
		setBusy('Reading your PDF…');
		try {
			const result = await api.uploadPdf(sessionId, file);
			setPdfName(result.fileName);
			setPdfChars(result.characters);
			setActive(null);
			setVideoUrl(null);
			setDownloaded(false);
		} catch (err) {
			handleAuthLoss(err);
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};

	const handleVoice = async (file: File) => {
		if (!sessionId) return;
		setError(null);
		setVoiceName(null);
		setVoiceInfo(null);
		setBusy('Cloning your voice…');
		try {
			const result = await api.uploadVoice(sessionId, file);
			setVoiceName(result.fileName);
			setVoiceInfo(`Cloned your voice (${result.voiceName}).`);
		} catch (err) {
			// Voice cloning failing is common (plan limits, disabled free tier), so
			// it gets its own persistent banner with the provider's reason.
			const apiErr = err as Error & { detail?: string };
			setVoiceName(file.name);
			setVoiceInfo(null);
			setVoiceError(apiErr.detail || apiErr.message);
			handleAuthLoss(err);
		} finally {
			setBusy(null);
		}
	};

	/**
	 * The single button: produce the whole thing and download it.
	 *
	 * One request, one job, one file. This replaced a two-step flow (Generate,
	 * then Download MP4) where the audio was lost between the steps — the render
	 * was handed a bare array of scenes, the composition fell back to the
	 * bundled dataset, and the video came out with no narration. A single job
	 * cannot drift out of step like that, and the finished MP4 is handed straight
	 * to the browser.
	 */
	const handleProduce = async (file?: File) => {
		if (!sessionId) return;
		setError(null);
		setVideoUrl(null);
		setDownloaded(false);
		setNarratorUsed(null);
		// A file passed straight to the button is uploaded in the same request,
		// so remember its name for the panel heading afterwards.
		const bodyFileName = file?.name ?? null;
		if (bodyFileName) setPdfName(bodyFileName);
		try {
			const { jobId } = await api.produce({
				sessionId,
				file: file ?? null,
				voiceId: voiceName ? null : voiceId,
			});
			setProduceJob({
				id: jobId,
				type: 'produce',
				status: 'running',
				progress: 0,
				logs: [],
				result: null,
				error: null,
			});

			const finished = await pollJob(jobId, setProduceJob);
			if (finished.status === 'error') {
				setError(finished.error ?? 'Production failed');
				return;
			}

			setNarratorUsed(finished.result?.narrator ?? null);
			setVideoUrl(finished.result?.videoUrl ?? null);

			// The finished record, so the player and the sidebar agree.
			const record = await api.storedSession(finished.result?.sessionId ?? sessionId);
			setActive(record);
			// The uploaded file may have arrived in the produce request itself, so
			// the name can be new here even when no earlier upload step ran.
			if (!pdfName && bodyFileName) setPdfName(bodyFileName);
			refreshHistory();

			// Hand the file to the browser as soon as it is ready. A programmatic
			// click on a real anchor is what triggers a save; setting location
			// or window.open would only open a player.
			const downloadUrl = finished.result?.downloadUrl;
			if (downloadUrl) {
				const anchor = document.createElement('a');
				anchor.href = downloadUrl;
				anchor.download = finished.result?.fileName ?? 'DocuBot.mp4';
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				setDownloaded(true);
			}
		} catch (err) {
			handleAuthLoss(err);
			setError((err as Error).message);
		}
	};

	const handleSignOut = async () => {
		try {
			await api.logout();
		} catch {
			/* signing out locally is what matters */
		}
		onSignOut?.();
	};

	/* --------------------------------------------------------------- view */
	const scenes: Scene[] = active?.scenes ?? [];
	const totalSeconds = (
		scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0) / 30
	).toFixed(0);

	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					<DocuBotMark size={34} float={false} />
					<div>
						<div>DocuBot</div>
						<div className="brand-sub">AI Documentary Generator</div>
					</div>
				</div>
				<span className="spacer" />
				<span className={`pill ${config?.chatEnabled ? 'on' : 'off'}`}>
					{config?.chatEnabled ? `AI: ${config.llmProvider}` : 'AI chat off'}
				</span>
				<span className={`pill ${config?.voiceCloningAvailable ? 'on' : 'off'}`}>
					{config?.voiceCloningAvailable
						? 'Voice cloning on'
						: config?.voiceLoading
							? 'Voice loading...'
							: 'Library voices'}
				</span>
				{username ? <span className="pill user">{username}</span> : null}
				{onSignOut ? (
					<button type="button" className="link" onClick={handleSignOut}>
						Sign out
					</button>
				) : null}
			</header>

			<div className="shell">
				{/* Voice cloning depends on a local service. If it is not up, say so
				    loudly here rather than letting the failure surface much later as
				    an unexplained "your voice was not used" message. */}
				{config && !config.voiceCloningAvailable ? (
					<div className={config.voiceLoading ? 'banner' : 'banner banner-err'}>
						{config.voiceLoading ? (
							<>
								<strong>Voice cloning is still starting up.</strong> OmniVoice loads
								about 3.3 GB of weights, which takes a few minutes. Wait for the
								startup window to say <code>voice ready</code>, then reload this
								page.
							</>
						) : (
							<>
								<strong>Voice cloning is not running, so your voice will not be used.</strong>{' '}
								Narration will use {config.fallbackVoice}.
								{config.voiceError ? <> {config.voiceError}</> : null}
								<span className="hint">
									Start the voice service with <code>npm run voice:start</code>. First
									time on a new machine? Run <code>npm run voice:setup</code> once
									first. <code>npm run web</code> starts both for you.
								</span>
							</>
						)}
					</div>
				) : null}

				{/* ------------------------------------------------ sidebar */}
				<aside className="sidebar">
					<Button variant="primary" block onClick={handleNewVideo}>
						+ New Video
					</Button>

					<div className="section-title sidebar-title">
						Videos{history.length > 0 ? ` (${history.length})` : ''}
					</div>

					<div className="session-list">
						{history.length === 0 ? (
							<p className="hint sidebar-empty">
								No videos yet. Add a PDF and press Generate.
							</p>
						) : null}

						{history.map((item) => (
							<button
								type="button"
								key={item.id}
								className={`session-item${
									active?.id === item.id ? ' selected' : ''
								}`}
								onClick={() => handleSelectSession(item.id)}
								disabled={loadingSession === item.id}
							>
								<span className="session-item-title">
									{item.title}
								</span>
								<span className="session-item-meta">
									{formatDate(item.createdAt)} · {item.sceneCount} scenes ·{' '}
									{Math.round(item.totalFrames / 30)}s
								</span>
								<span
									className="session-item-delete"
									role="button"
									tabIndex={-1}
									aria-label="Delete video"
									onClick={(event) => handleDeleteSession(event, item.id)}
								>
									×
								</span>
							</button>
						))}
					</div>
				</aside>

				{/* ------------------------------------------------ main */}
				<main className="main">
					<div className="main-inner">
						{error ? <Notice kind="err">{error}</Notice> : null}

						{/* the video, when one is selected */}
						{scenes.length > 0 ? (
							<div className="panel">
								<div className="panel-head">
									<h2>{active?.title}</h2>
									<span className="spacer" />
									<span className="hint">
										{scenes.length} parts · {totalSeconds}s
									</span>
								</div>
								<Player component={DocumentaryVideo} scenes={scenes} />
							</div>
						) : null}

						{/* three simple steps */}
						<div className="panel">
							<StepHeader
								step={1}
								title="Add your PDF"
								done={Boolean(pdfName)}
							/>

							<FilePicker
								id="pdf-input"
								label=""
								hint="A PDF with selectable text works best"
								accept="application/pdf,.pdf"
								fileName={pdfName}
								disabled={!sessionId || Boolean(busy)}
								onFile={handlePdf}
							/>
							{pdfChars !== null ? (
								<Notice kind="ok">
									{pdfChars.toLocaleString()} characters read from your PDF.
								</Notice>
							) : null}
							{/* Cold start: nothing has been uploaded, so the button accepts
							    the PDF directly. Cheaper to explain here than to make
							    the user wonder why the button is disabled. */}
							{!pdfName ? (
								<p className="hint">
									You can also skip this step — the button below will take your PDF
									and start from scratch.
								</p>
							) : null}

							<StepHeader
								step={2}
								title="Choose a narrator"
								done={Boolean(voiceName) || Boolean(voiceId)}
							/>

							{/* An uploaded sample always wins. The picker is replaced rather than
							    shown beside it, so the two are never treated as equal options. */}
							{voiceName ? (
								<Notice kind="ok">
								Using your uploaded voice ({voiceName}).
								<button
									type="button"
									className="link"
									onClick={() => {
										setVoiceName(null);
										setVoiceInfo(null);
										setVoiceError(null);
									}}
									>
										Use a narrator instead
									</button>
								</Notice>
							) : (
								<VoicePicker
									library={config?.voiceLibrary ?? null}
									value={voiceId}
									onChange={setVoiceId}
									disabled={produceJob?.status === 'running'}
									fallbackLabel={config?.defaultVoiceLabel ?? 'Default narrator'}
								/>
							)}

							<button
								type="button"
								className="link voice-advanced"
								onClick={() => setShowRecorder((was) => !was)}
							>
								{showRecorder ? 'Hide voice recording' : 'Record my own voice instead'}
							</button>

							{showRecorder ? (
								<>
									<p className="hint">
										Read these three lines out loud in English, then record them. Your
										voice and accent become the narration.
									</p>
									<ol className="sentences">
										{(config?.voiceSampleSentences ?? []).map((sentence) => (
											<li key={sentence}>{sentence}</li>
										))}
									</ol>
									<VoiceRecorder
										disabled={!sessionId || Boolean(busy)}
										onUse={handleVoice}
										onError={setError}
									/>
									<FilePicker
										id="voice-input"
										label="or upload a file"
										hint="MP3 preferred, about 30 seconds or less"
										accept="audio/mpeg,audio/wav,.mp3,.wav,.m4a,.webm,.ogg"
										fileName={voiceName}
										disabled={!sessionId || Boolean(busy)}
										onFile={handleVoice}
									/>
								</>
							) : null}

							{voiceInfo ? <Notice kind="ok">{voiceInfo}</Notice> : null}
							{voiceError ? (
								<Notice kind="err">
									<strong>Voice cloning failed, your recording is NOT being used.</strong>
									<br />
									{voiceError}
									<br />
									<span className="hint">
										Pick one of the narrators above instead. Cloning runs locally with
										OmniVoice, so there is no account or API key. If the reason mentions
										an undecodable or webm file, install ffmpeg or upload an MP3.
									</span>
								</Notice>
							) : null}

							<StepHeader step={3} title="Make the video" done={scenes.length > 0} />

							<div className="btn-row">
								<Button
									variant="primary"
									onClick={() => {
										// Cold start: no PDF chosen yet, so ask for one and hand it
										// straight to the produce call rather than making the user
										// come back and press the button again.
										if (!pdfName) {
											coldStartInput.current?.click();
											return;
										}
										void handleProduce();
									}}
									disabled={produceJob?.status === 'running'}
								>
									{produceJob?.status === 'running'
										? 'Producing...'
										: 'Generate & Download Documentary'}
								</Button>
							</div>
							<p className="hint">
								One step: script, visuals, narration, and a single MP4 with the audio
								already merged in. On a CPU-only machine this takes a few minutes.
							</p>

							{/* Used when the button is pressed with no PDF chosen: the file goes
							    straight into the produce request, so the one-button flow works
							    from a cold start. Reset after reading so picking the same file
							    twice still fires a change event. */}
							<input
								ref={coldStartInput}
								type="file"
								accept="application/pdf,.pdf"
								hidden
								onChange={(event) => {
									const file = event.target.files?.[0];
									event.target.value = '';
									if (file) void handleProduce(file);
								}}
							/>

							{produceJob?.status === 'running' || produceJob?.logs.length ? (
								<>
									{produceJob?.status === 'running' ? (
										<div className="progress">
											<div style={{ width: `${Math.round(produceJob.progress)}%` }} />
										</div>
									) : null}
									{produceJob?.logs.length ? (
										<div className="logbox">{produceJob.logs.join('\n')}</div>
									) : null}
								</>
							) : null}

							{videoUrl ? (
								<>
									<video src={videoUrl} controls />
									<a className="btn full" href={`${videoUrl}?download=1`} download>
										Download again
									</a>
									{downloaded ? (
										<Notice kind="ok">
											Saved to your downloads.
											{narratorUsed ? ` Narrated by ${narratorUsed}.` : ''}
										</Notice>
									) : null}
								</>
							) : null}
						</div>

					<CreatorFooter compact />
					</div>
				</main>
			</div>
		</div>
	);
};

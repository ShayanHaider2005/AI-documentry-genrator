import React from 'react';
import { DocumentaryVideo } from '../../src/DocumentaryVideo';
import { api } from './api';
import type {
	JobStatus,
	Scene,
	SessionSummary,
	StoredSession,
	VoiceSampleConfig,
} from './api';
import {
	Button,
	ChatPanel,
	FilePicker,
	JobPanel,
	Notice,
	Player,
	type ChatMessage,
} from './components';
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

export const App: React.FC = () => {
	const [config, setConfig] = React.useState<VoiceSampleConfig | null>(null);
	const [sessionId, setSessionId] = React.useState<string | null>(null);

	/* history */
	const [history, setHistory] = React.useState<SessionSummary[]>([]);
	const [active, setActive] = React.useState<StoredSession | null>(null);
	const [loadingSession, setLoadingSession] = React.useState<string | null>(null);

	const [messages, setMessages] = React.useState<ChatMessage[]>([
		{ id: uid(), role: 'bot', text: WELCOME },
	]);
	const [draft, setDraft] = React.useState('');
	const [chatBusy, setChatBusy] = React.useState(false);

	const [pdfName, setPdfName] = React.useState<string | null>(null);
	const [pdfChars, setPdfChars] = React.useState<number | null>(null);
	const [voiceName, setVoiceName] = React.useState<string | null>(null);
	const [voiceInfo, setVoiceInfo] = React.useState<string | null>(null);

	const [videoUrl, setVideoUrl] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState<string | null>(null);

	const [generateJob, setGenerateJob] = React.useState<JobStatus | null>(null);
	const [renderJob, setRenderJob] = React.useState<JobStatus | null>(null);

	const pushMessage = (role: ChatMessage['role'], text: string) =>
		setMessages((current) => [...current, { id: uid(), role, text }]);

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
		setGenerateJob(null);
		setRenderJob(null);
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
			pushMessage(
				'bot',
				`Extracted ${result.characters.toLocaleString()} characters from ${result.fileName}. Press Generate to build the video.`,
			);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};

	const handleVoice = async (file: File) => {
		if (!sessionId) return;
		setError(null);
		setBusy('Cloning your voice…');
		try {
			const result = await api.uploadVoice(sessionId, file);
			setVoiceName(result.fileName);
			const fallback = config?.fallbackVoice ?? 'the default neural voice';
			setVoiceInfo(
				result.voiceId
					? `Cloned your voice (${result.voiceName}).`
					: `Sample accepted. No ElevenLabs key on the server, so narration uses ${fallback}.`,
			);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};

	const handleSend = async () => {
		if (!sessionId || !draft.trim()) return;
		const message = draft.trim();
		setDraft('');
		pushMessage('user', message);
		setChatBusy(true);
		try {
			const result = await api.chat(sessionId, message);
			pushMessage('bot', result.reply);
		} catch (err) {
			pushMessage('bot', `Sorry — ${(err as Error).message}`);
		} finally {
			setChatBusy(false);
		}
	};

	const handleGenerate = async () => {
		if (!sessionId) return;
		setError(null);
		setVideoUrl(null);
		try {
			const { jobId } = await api.generate(sessionId);
			setGenerateJob({
				id: jobId,
				type: 'generate',
				status: 'running',
				progress: 0,
				logs: [],
				result: null,
				error: null,
			});

			const finished = await pollJob(jobId, setGenerateJob);
			if (finished.status === 'error') {
				setError(finished.error ?? 'Generation failed');
				return;
			}

			// Load the finished record so the player and the sidebar agree.
			const record = await api.storedSession(finished.result?.sessionId ?? sessionId);
			setActive(record);
			refreshHistory();
			pushMessage(
				'bot',
				`Done: "${record.title}" with ${record.scenes.length} scenes. Preview it above, then press Render MP4.`,
			);
		} catch (err) {
			setError((err as Error).message);
		}
	};

	const handleRender = async () => {
		if (!sessionId) return;
		setError(null);
		try {
			const { jobId } = await api.render(sessionId);
			setRenderJob({
				id: jobId,
				type: 'render',
				status: 'running',
				progress: 0,
				logs: [],
				result: null,
				error: null,
			});

			const finished = await pollJob(jobId, setRenderJob);
			if (finished.status === 'error') {
				setError(finished.error ?? 'Render failed');
				return;
			}
			setVideoUrl(finished.result?.videoUrl ?? null);
		} catch (err) {
			setError((err as Error).message);
		}
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
					<div className="brand-mark">D</div>
					<div>
						<div>DocuBot</div>
						<div className="brand-sub">AI Documentary &amp; Lecture Generator</div>
					</div>
				</div>
				<span className="spacer" />
				<span className={`pill ${config?.chatEnabled ? 'on' : 'off'}`}>
					{config?.chatEnabled ? `AI: ${config.llmProvider}` : 'AI chat off'}
				</span>
				<span className={`pill ${config?.voiceCloningAvailable ? 'on' : 'off'}`}>
					{config?.voiceCloningAvailable ? 'Voice cloning on' : 'Default voice'}
				</span>
			</header>

			<div className="shell">
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

						{scenes.length > 0 ? (
							<>
								<div className="panel-head">
									<h2>{active?.title}</h2>
									<span className="spacer" />
									<span className="hint">
										{scenes.length} scenes · {totalSeconds}s
									</span>
								</div>
								<Player component={DocumentaryVideo} scenes={scenes} />
							</>
						) : (
							<div className="stage empty">
								<div className="empty-inner">
									<div className="empty-title">
										{loadingSession
											? 'Loading…'
											: 'No video selected'}
									</div>
									<div className="hint">
										Pick a video from the left, or press “+ New Video”
										and add a PDF below.
									</div>
								</div>
							</div>
						)}

						{/* controls: PDF input sits directly under the player */}
						<div className="controls">
							<FilePicker
								id="pdf-input"
								label="Source document"
								hint="PDF with selectable text"
								accept="application/pdf,.pdf"
								fileName={pdfName}
								disabled={!sessionId || Boolean(busy)}
								onFile={handlePdf}
							/>
							{pdfChars !== null ? (
								<Notice kind="ok">
									{pdfChars.toLocaleString()} characters extracted.
								</Notice>
							) : null}

							<details className="voice-details">
								<summary>Use my own voice (optional)</summary>
								<div className="voice-body">
									<p className="hint">
										Read these three sentences aloud in English, record them as
										one MP3, then upload it. Your voice and accent get cloned
										for the narration.
									</p>
									<ol className="sentences">
										{(config?.voiceSampleSentences ?? []).map((sentence) => (
											<li key={sentence}>{sentence}</li>
										))}
									</ol>
									<FilePicker
										id="voice-input"
										label="Voice sample"
										hint="MP3 · about 30 seconds or less"
										accept="audio/mpeg,audio/wav,.mp3,.wav,.m4a"
										fileName={voiceName}
										disabled={!sessionId || Boolean(busy)}
										onFile={handleVoice}
									/>
									{voiceInfo ? <Notice kind="ok">{voiceInfo}</Notice> : null}
								</div>
							</details>

							<div className="btn-row">
								<Button
									variant="primary"
									onClick={handleGenerate}
									disabled={!pdfName || generateJob?.status === 'running'}
								>
									{busy ?? (generateJob?.status === 'running' ? 'Generating…' : 'Generate')}
								</Button>
								<Button
									onClick={handleRender}
									disabled={
										scenes.length === 0 || renderJob?.status === 'running'
									}
								>
									{renderJob?.status === 'running' ? 'Rendering…' : 'Render MP4'}
								</Button>
							</div>

							{generateJob?.logs.length ? (
								<div className="logbox">{generateJob.logs.join('\n')}</div>
							) : null}
							{renderJob?.status === 'running' ? (
								<div className="progress">
									<div style={{ width: `${Math.round(renderJob.progress)}%` }} />
								</div>
							) : null}

							{videoUrl ? (
								<>
									<video src={videoUrl} controls />
									<a className="btn full" href={videoUrl} download>
										Download MP4
									</a>
								</>
							) : null}
						</div>

						<ChatPanel
							messages={messages}
							draft={draft}
							busy={chatBusy}
							chatEnabled={Boolean(config?.chatEnabled)}
							onDraft={setDraft}
							onSend={handleSend}
						/>
					</div>
				</main>
			</div>
		</div>
	);
};

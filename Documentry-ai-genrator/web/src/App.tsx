import React from 'react';
import { DocumentaryVideo } from '../../src/DocumentaryVideo';
import { api } from './api';
import type { JobStatus, Scene, VoiceSampleConfig } from './api';
import {
	Button,
	ChatPanel,
	FilePicker,
	JobPanel,
	Notice,
	Player,
	SceneList,
	type ChatMessage,
} from './components';
import './styles.css';

const POLL_INTERVAL_MS = 1200;

const uid = () => Math.random().toString(36).slice(2, 10);

const WELCOME =
	"Hi! I'm DocuBot. Turn any lecture PDF into a narrated documentary video.\n\n" +
	'To get started:\n' +
	'1. Upload your PDF on the right.\n' +
	'2. Optionally record the three sample sentences and upload the MP3 — I will clone your voice and accent.\n' +
	'3. Press Generate, preview it here, then render the MP4.\n\n' +
	"You can also just ask me something about your document.";

export const App: React.FC = () => {
	const [config, setConfig] = React.useState<VoiceSampleConfig | null>(null);
	const [sessionId, setSessionId] = React.useState<string | null>(null);

	const [messages, setMessages] = React.useState<ChatMessage[]>([
		{ id: uid(), role: 'bot', text: WELCOME },
	]);
	const [draft, setDraft] = React.useState('');
	const [chatBusy, setChatBusy] = React.useState(false);

	const [pdfName, setPdfName] = React.useState<string | null>(null);
	const [pdfChars, setPdfChars] = React.useState<number | null>(null);
	const [voiceName, setVoiceName] = React.useState<string | null>(null);
	const [voiceInfo, setVoiceInfo] = React.useState<string | null>(null);

	const [scenes, setScenes] = React.useState<Scene[] | null>(null);
	const [videoUrl, setVideoUrl] = React.useState<string | null>(null);

	const [error, setError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState<string | null>(null);

	const [generateJob, setGenerateJob] = React.useState<JobStatus | null>(null);
	const [renderJob, setRenderJob] = React.useState<JobStatus | null>(null);

	/* ---------------------------------------------------------- bootstrap */
	React.useEffect(() => {
		api
			.config()
			.then(setConfig)
			.catch(() => setError('Could not reach the server. Is it running?'));

		// A session can be resumed (and shared) via ?session=<id> in the URL.
		const existing = new URLSearchParams(window.location.search).get('session');

		const startFresh = () => {
			api
				.createSession()
				.then(({ sessionId }) => {
					setSessionId(sessionId);
					window.history.replaceState(
						null,
						'',
						`${window.location.pathname}?session=${sessionId}`,
					);
				})
				.catch(() => setError('Could not start a session.'));
		};

		if (existing) {
			api
				.session(existing)
				.then((snapshot) => {
					setSessionId(snapshot.sessionId);
					setPdfName(snapshot.pdf?.fileName ?? null);
					setPdfChars(snapshot.pdf?.characters ?? null);
					setVoiceName(snapshot.voice?.fileName ?? null);
					setScenes(snapshot.dataset);
					if (snapshot.renderPath) setVideoUrl(`/video/${snapshot.sessionId}`);
				})
				.catch(() => {
					// Unknown or expired session — fall back to a clean one.
					startFresh();
				});
		} else {
			startFresh();
		}
	}, []);

	const pushMessage = (role: ChatMessage['role'], text: string) =>
		setMessages((current) => [...current, { id: uid(), role, text }]);

	/* ------------------------------------------------------------- polling */
	const pollJob = React.useCallback(
		async (
			jobId: string,
			onUpdate: (job: JobStatus) => void,
			onDone: (job: JobStatus) => void,
		) => {
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const job = await api.job(jobId);
				onUpdate(job);
				if (job.status !== 'running') {
					onDone(job);
					return job;
				}
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}
		},
		[],
	);

	/* ------------------------------------------------------------- actions */
	const handlePdf = async (file: File) => {
		if (!sessionId) return;
		setError(null);
		setBusy('Reading your PDF…');
		try {
			const result = await api.uploadPdf(sessionId, file);
			setPdfName(result.fileName);
			setPdfChars(result.characters);
			setScenes(null);
			setVideoUrl(null);
			pushMessage(
				'bot',
				`Got it — I extracted ${result.characters.toLocaleString()} characters from ${result.fileName}. Ask me anything about it, or press Generate to build the video.`,
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
			setVoiceInfo(
				result.voiceId
					? `Cloned your voice (${result.voiceName}).`
					: `Voice sample accepted. No ElevenLabs key on the server, so narration will use ${config?.fallbackVoice ?? 'the default neural voice'}.`,
			);
			pushMessage(
				'bot',
				result.voiceId
					? `Your voice is cloned — the narration will sound like you.`
					: `Thanks, I saved your sample. The server has no ElevenLabs key configured, so I will narrate with ${config?.fallbackVoice ?? 'a neural teacher voice'} instead.`,
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

			const finished = await pollJob(
				jobId,
				setGenerateJob,
				() => undefined,
			);

			if (finished.status === 'error') {
				setError(finished.error ?? 'Generation failed');
				return;
			}

			const snapshot = await api.session(sessionId);
			setScenes(snapshot.dataset);
			const seconds = ((finished.result?.totalFrames ?? 0) / 30).toFixed(0);
			pushMessage(
				'bot',
				`Your documentary is ready: ${finished.result?.sceneCount ?? 0} scenes, about ${seconds} seconds. Preview it on the right, then press Render MP4 to export.`,
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

			const finished = await pollJob(jobId, setRenderJob, () => undefined);
			if (finished.status === 'error') {
				setError(finished.error ?? 'Render failed');
				return;
			}
			setVideoUrl(finished.result?.videoUrl ?? null);
			pushMessage('bot', 'Your MP4 has been rendered. You can play or download it below.');
		} catch (err) {
			setError((err as Error).message);
		}
	};

	/* --------------------------------------------------------------- view */
	const totalSeconds = scenes
		? (scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0) / 30).toFixed(0)
		: '0';

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

			<div className="layout">
				<ChatPanel
					messages={messages}
					draft={draft}
					busy={chatBusy}
					chatEnabled={Boolean(config?.chatEnabled)}
					onDraft={setDraft}
					onSend={handleSend}
				/>

				<section className="card">
					<header className="card-head">
						<span className="card-title">Studio</span>
						<span className="spacer" />
						{busy ? <span className="pill">{busy}</span> : null}
					</header>

					<div className="card-body">
						{error ? <Notice kind="err">{error}</Notice> : null}

						<FilePicker
							id="pdf-input"
							label="1 · Source document"
							hint="PDF with selectable text"
							accept="application/pdf,.pdf"
							fileName={pdfName}
							disabled={!sessionId || Boolean(busy)}
							onFile={handlePdf}
						/>
						{pdfChars !== null ? (
							<Notice kind="ok">{pdfChars.toLocaleString()} characters extracted.</Notice>
						) : null}

						<div className="field">
							<span className="label">2 · Your voice (optional)</span>
							<div className="hint">
								Read these three sentences aloud in English, record them as one MP3, then
								upload it. Your voice and accent get cloned for the narration.
							</div>
							<ol className="sentences">
								{(config?.voiceSampleSentences ?? []).map((sentence) => (
									<li key={sentence}>{sentence}</li>
								))}
							</ol>
						</div>

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

						<JobPanel
							job={generateJob}
							title="3 · Generate"
							actionLabel="Generate documentary"
							onAction={handleGenerate}
							canRun={Boolean(pdfName) && generateJob?.status !== 'running'}
							running={generateJob?.status === 'running'}
						/>

						{scenes ? (
							<>
								<div className="section-title">Preview</div>
								<Player component={DocumentaryVideo} scenes={scenes} />
								<div className="meta">
									<span>
										<strong>{scenes.length}</strong> scenes
									</span>
									<span>
										<strong>{totalSeconds}s</strong> runtime
									</span>
									<span>
										<strong>1920×1080</strong> @ 30fps
									</span>
								</div>
								<SceneList scenes={scenes} />
							</>
						) : null}

						{scenes ? (
							<JobPanel
								job={renderJob}
								title="4 · Export"
								actionLabel="Render MP4"
								onAction={handleRender}
								canRun={renderJob?.status !== 'running'}
								running={renderJob?.status === 'running'}
							/>
						) : null}

						{videoUrl ? (
							<>
								<div className="section-title">Your video</div>
								<video src={videoUrl} controls />
								<a className="btn full" href={videoUrl} download>
									Download MP4
								</a>
							</>
						) : null}
					</div>
				</section>
			</div>
		</div>
	);
};

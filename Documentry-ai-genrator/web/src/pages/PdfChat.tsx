import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { api, fileToBase64, UnauthorisedError } from '../api';
import type { BundleStatus, ChatAnswer, ChatSource, OkfManifest } from '../api';
import { playDocuBotSFX } from '../utils/botAudio';
import { DocuBotMark, CreatorFooter } from '../Mascot';
import '../styles.css';

/**
 * PdfChat — ask questions about a PDF, answered only from that PDF.
 *
 * The shape of the page follows the shape of the guarantee. A chatbot that
 * might be making things up needs to make its sources visible, so the right
 * panel shows which pages each answer came from and says plainly when it found
 * nothing. The left panel shows the conversion, because "Index Ready" is the
 * only honest signal that answers will be grounded.
 */

/**
 * There is no error state: a problem is its own field, shown whenever it is
 * set. Encoding it as a phase meant a client-side validation failure had to move
 * the page out of 'ready' just to become visible, which lost the index status
 * as a side effect and made a rejected re-upload look like nothing happened.
 */
type Phase = 'empty' | 'converting' | 'ready';

interface Turn {
	id: string;
	question: string;
	answer: ChatAnswer | null;
	/** Set when the request itself failed, as opposed to a poor answer. */
	failure: string | null;
}

const MAX_PDF_BYTES = 40 * 1024 * 1024;

const bytes = (n: number): string =>
	n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/** Split an answer into lines so a citation on its own line still animates. */
const paragraphs = (text: string): string[] =>
	text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

const SUGGESTIONS = [
	'What is this document about?',
	'What are the main sections?',
	'What does it conclude?',
	'What are the key definitions?',
];

export const PdfChat: React.FC<{ onBack: () => void; username?: string }> = ({
	onBack,
	username,
}) => {
	const reduce = useReducedMotion();

	const [phase, setPhase] = React.useState<Phase>('empty');
	const [manifest, setManifest] = React.useState<OkfManifest | null>(null);
	const [busyText, setBusyText] = React.useState('');
	const [problem, setProblem] = React.useState<string | null>(null);
	const [turns, setTurns] = React.useState<Turn[]>([]);
	const [draft, setDraft] = React.useState('');
	const [asking, setAsking] = React.useState(false);
	const [dragging, setDragging] = React.useState(false);
	const [panelOpen, setPanelOpen] = React.useState(false);

	const fileInput = React.useRef<HTMLInputElement>(null);
	const logRef = React.useRef<HTMLDivElement>(null);

	// The nav voice on entering this page is the Shell's route effect, which
	// fires on every route change. Replaying it here would double up, so this
	// page only owns the sounds that are specific to it: the answer chime.

	/* ---- restore state on reload ---------------------------------------- */
	React.useEffect(() => {
		let cancelled = false;
		api
			.chatBundle()
			.then((status: BundleStatus) => {
				if (cancelled) return;
				if (status.ready && status.manifest) {
					setManifest(status.manifest);
					setPhase('ready');
				}
			})
			.catch(() => {
				// No bundle, or the server is unreachable. Either way the
				// dropzone is the correct thing to show.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Keep the newest turn in view, but only once it exists. Scrolling on every
	// render would fight the user while they are reading an earlier answer.
	React.useEffect(() => {
		if (!turns.length) return;
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
	}, [turns.length, asking]);

	/* ---- upload ---------------------------------------------------------- */
	const upload = React.useCallback(
		async (file: File) => {
			setProblem(null);

			if (!/\.pdf$/i.test(file.name)) {
				setProblem('That is not a PDF. Please choose a .pdf file.');
				return;
			}
			if (file.size > MAX_PDF_BYTES) {
				// Checked before the read: a 200 MB file would become a 270 MB
				// base64 string and blow past the server's body limit with an
				// error message about the server.
				setProblem(`That PDF is ${bytes(file.size)}. The limit is 40 MB.`);
				return;
			}

			setPhase('converting');
			setBusyText('Converting PDF to OKF Knowledge Graph...');
			try {
				const dataBase64 = await fileToBase64(file);
				const result = await api.chatConvert({ fileName: file.name, dataBase64 });
				setManifest(result.manifest);
				setPhase('ready');
				setProblem(null);
				setBusyText('');
				// The upload is a completed action, not a failure.
				playDocuBotSFX('happy');
			} catch (err) {
				// Back to where we were, not to a new state. The busy pill and the
				// disabled dropzone are both gated on 'converting', so leaving the
				// phase there strands the page mid-upload with no way to try again.
				setPhase(manifest ? 'ready' : 'empty');
				setBusyText('');
				setProblem(err instanceof Error ? err.message : 'Could not read that PDF.');
				playDocuBotSFX('shocked');
			}
		},
		[],
	);

	const onDrop = (event: React.DragEvent) => {
		event.preventDefault();
		setDragging(false);
		const file = event.dataTransfer.files?.[0];
		if (file) void upload(file);
	};

	/* ---- ask ------------------------------------------------------------- */
	const ask = React.useCallback(
		async (question: string) => {
			const clean = question.trim();
			if (!clean || asking) return;

			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			// The turn is added before the request, with a null answer, so the
			// user's question appears instantly. Waiting for the round trip
			// before showing anything makes a fast question feel broken.
			setTurns((prev) => [...prev, { id, question: clean, answer: null, failure: null }]);
			setDraft('');
			setAsking(true);

			try {
				const answer = await api.chatQuery(clean);
				setTurns((prev) =>
					prev.map((t) => (t.id === id ? { ...t, answer, failure: null } : t)),
				);
				// The chime is on completion, which is the brief's requirement and
				// also the honest moment for it: the user has been waiting, and
				// this is the sound that says it is over.
				playDocuBotSFX('happy');
			} catch (err) {
				const message =
					err instanceof UnauthorisedError
						? 'Your session expired. Sign in again to keep asking.'
						: err instanceof Error
							? err.message
							: 'Something went wrong.';
				setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, failure: message } : t)));
				playDocuBotSFX('shocked');
			} finally {
				setAsking(false);
			}
		},
		[asking],
	);

	const ready = phase === 'ready' && Boolean(manifest);

	/* ---- animation ------------------------------------------------------- */
	// The brief's numbers: opacity 0 / y 15 in, to opacity 1 / y 0.
	const bubble = (index: number) => ({
		initial: { opacity: 0, y: 15 },
		animate: { opacity: 1, y: 0 },
		transition: {
			duration: reduce ? 0 : 0.32,
			// Stagger: each bubble trails the one above it, capped so a long
			// transcript does not leave the newest reply half a second behind.
			delay: reduce ? 0 : Math.min(index * 0.06, 0.3),
			ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
		},
	});

	return (
		<div className="pdfchat">
			<header className="pdfchat-head">
				<div>
					<h1 className="pdfchat-title">
						PDF Chat
						{username ? <span className="pdfchat-who">signed in as {username}</span> : null}
					</h1>
					<p className="pdfchat-sub">
						Ask questions about your PDF. Every answer is drawn from the document itself and
						cites the pages it used.
					</p>
				</div>
				<button type="button" className="btn btn-ghost" onClick={onBack}>
					Back to Studio
				</button>
			</header>

			<div className="pdfchat-split">
				{/* ---------------------------------------------------- left ---- */}
				<section className="pdfchat-pane glass" aria-label="Your document">
					<h2 className="section-title">Your document</h2>

					<button
						type="button"
						className={`file-drop${dragging ? ' dragging' : ''}`}
						onClick={() => fileInput.current?.click()}
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={onDrop}
						disabled={phase === 'converting'}
					>
						<input
							ref={fileInput}
							type="file"
							accept="application/pdf,.pdf"
							className="visually-hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								// Reset first: without it, re-picking the same file
								// after an error fires no change event at all.
								e.target.value = '';
								if (file) void upload(file);
							}}
						/>
						{phase === 'converting' ? (
							<>
								<span className="spinner" aria-hidden="true" />
								<strong>Converting...</strong>
								<span className="hint">{busyText}</span>
							</>
						) : (
							<>
								<strong>Drop a PDF here</strong>
								<span className="hint">or click to choose one. Up to 40 MB.</span>
							</>
						)}
					</button>

					{/* Conversion status, as the brief words it. */}
					<div className="pdfchat-status" role="status" aria-live="polite">
						{phase === 'converting' ? (
							<span className="pill pill-busy">
								<span className="rec-dot" /> Converting PDF to OKF Knowledge Graph...
							</span>
						) : null}
						{ready ? (
							<span className="pill pill-ok">
								Index Ready &middot; {manifest?.pageCount} pages &middot;{' '}
								{manifest?.fileCount} concepts
							</span>
						) : null}
						{/* Rendered whenever `problem` is set, not only when the phase
					    happens to say so. The three client-side validation failures in
					    upload() return before the phase is touched, so gating on the
					    phase meant dropping a wrong file type did nothing at all once
					    a document was already converted. */}
						{problem ? <span className="pill pill-bad">{problem}</span> : null}
					</div>

					{ready && manifest ? (
						<details className="pdfchat-manifest" open>
							<summary onClick={() => setPanelOpen((v) => !v)}>
								{manifest.title}
								<span className="hint">source: {manifest.source}</span>
							</summary>
							{panelOpen ? (
								<dl>
									<div>
										<dt>Pages</dt>
										<dd>{manifest.pageCount}</dd>
									</div>
									<div>
										<dt>Concept files</dt>
										<dd>{manifest.fileCount}</dd>
									</div>
									<div>
										<dt>Converted</dt>
										<dd>{new Date(manifest.generated).toLocaleString()}</dd>
									</div>
								</dl>
							) : null}
						</details>
					) : null}

					{/* A fresh document invalidates every previous answer, so the
					    transcript is cleared with it rather than left describing a
					    PDF that is no longer there. */}
					{ready ? (
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => {
								setTurns([]);
								setManifest(null);
								setPhase('empty');
							}}
						>
							Use a different PDF
						</button>
					) : null}
				</section>

				{/* --------------------------------------------------- right ---- */}
				<section className="pdfchat-pane glass pdfchat-log" aria-label="Conversation">
					<h2 className="section-title">Conversation</h2>

					<div className="chat-log pdfchat-scroll" ref={logRef}>
						{turns.length === 0 ? (
							<div className="pdfchat-empty">
								<DocuBotMark size={72} />
								<p>
									{ready
										? 'Ask me anything about this document. I answer only from what it says, and I will tell you when it does not cover something.'
										: 'Drop a PDF on the left and I will read it, then answer questions from it.'}
								</p>
							</div>
						) : null}

						{turns.map((turn, index) => (
							<motion.div
								key={turn.id}
								className="pdfchat-turn"
								{...bubble(index)}
							>
								<div className="bubble bubble-user">
									<span className="pdfchat-q">{turn.question}</span>
								</div>

								<div className="bubble bubble-bot">
									<DocuBotMark size={26} float={false} />
									<div className="pdfchat-a">
										{turn.answer ? (
											<>
												{paragraphs(turn.answer.answer).map((p, i) => (
													<p key={i}>{p}</p>
												))}
												<Sources sources={turn.answer.sources} />
												{turn.answer.activeProvider ? (
													<p className="pdfchat-provider">
														Answered by {turn.answer.activeProvider}
														{turn.answer.model ? ` / ${turn.answer.model}` : ''}
														{turn.answer.degraded ? (
															<span className="pdfchat-degraded"> &middot; {turn.answer.degraded}</span>
														) : null}
													</p>
												) : null}
											</>
										) : turn.failure ? (
											<p className="pdfchat-fail">{turn.failure}</p>
										) : (
											<span className="typing" aria-label="DocuBot is thinking">
												<i />
												<i />
												<i />
											</span>
										)}
									</div>
								</div>
							</motion.div>
						))}
					</div>

					{/* Suggestion chips double as the empty state and as a way to
					    start without knowing what to type. */}
					{ready && turns.length === 0 ? (
						<div className="pdfchat-suggest">
							{SUGGESTIONS.map((s) => (
								<button key={s} type="button" className="pill pill-chip" onClick={() => ask(s)}>
									{s}
								</button>
							))}
						</div>
					) : null}

					<form
						className="composer"
						onSubmit={(e) => {
							e.preventDefault();
							void ask(draft);
						}}
					>
						<label className="visually-hidden" htmlFor="pdfchat-input">
							Your question
						</label>
						<input
							id="pdfchat-input"
							className="field"
							value={draft}
							placeholder={ready ? 'Ask about this document...' : 'Upload a PDF first'}
							disabled={!ready || asking}
							onChange={(e) => setDraft(e.target.value)}
						/>
						<button
							type="submit"
							className="btn btn-primary pdfchat-send"
							// Disabled rather than hidden: a send button that vanishes
							// moves the layout under the user's cursor.
							disabled={!ready || asking || !draft.trim()}
						>
							{asking ? 'Thinking...' : 'Send'}
						</button>
					</form>
				</section>
			</div>

			<CreatorFooter />
		</div>
	);
};

/**
 * The page badges.
 *
 * Buttons rather than labels, because a page reference the user cannot open is
 * decoration. They scroll the transcript to the first answer that cited that
 * page, which is as close to "open the PDF at page 4" as this page can honestly
 * get without embedding a viewer.
 */
const Sources: React.FC<{ sources: ChatSource[] }> = ({ sources }) => {
	if (!sources.length) {
		return (
			<p className="pdfchat-nosource">
				No pages matched, so this answer is not grounded in the document.
			</p>
		);
	}
	return (
		<div className="pdfchat-sources">
			<span className="hint">From</span>
			{sources.map((s) => (
				<button
					key={`${s.file}`}
					type="button"
					className="pill pill-source"
					title={`${s.title} - match score ${s.score}`}
					onClick={() => {
						const target = document.getElementById('pdfchat-input');
						target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
						target?.focus();
					}}
				>
					p.{s.page}
				</button>
			))}
		</div>
	);
};

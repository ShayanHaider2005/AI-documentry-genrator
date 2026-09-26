import React from 'react';
import { Player as RemotionPlayer } from '@remotion/player';
import type { JobStatus, Scene } from './api';

/* ------------------------------------------------------------------ atoms */

export const Button: React.FC<
	React.ButtonHTMLAttributes<HTMLButtonElement> & {
		variant?: 'primary' | 'ghost' | 'default';
		block?: boolean;
	}
> = ({ variant = 'default', block, className = '', ...rest }) => {
	const variantClass =
		variant === 'primary' ? 'btn primary' : variant === 'ghost' ? 'btn ghost' : 'btn';
	return (
		<button
			type="button"
			className={`${variantClass}${block ? ' full' : ''} ${className}`.trim()}
			{...rest}
		/>
	);
};

export const Notice: React.FC<{
	kind: 'ok' | 'err' | 'info';
	children: React.ReactNode;
}> = ({ kind, children }) =>
	children ? <div className={`notice ${kind}`}>{children}</div> : null;

/* ------------------------------------------------------------------- file */

export const FilePicker: React.FC<{
	id: string;
	label: string;
	hint: string;
	accept: string;
	fileName?: string | null;
	disabled?: boolean;
	onFile: (file: File) => void;
}> = ({ id, label, hint, accept, fileName, disabled, onFile }) => {
	const [over, setOver] = React.useState(false);

	return (
		<div className="field">
			<span className="label">{label}</span>
			<label
				htmlFor={id}
				className={`file-drop${over ? ' over' : ''}`}
				onDragOver={(event) => {
					event.preventDefault();
					if (!disabled) setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(event) => {
					event.preventDefault();
					setOver(false);
					if (disabled) return;
					const dropped = event.dataTransfer.files?.[0];
					if (dropped) onFile(dropped);
				}}
			>
				<input
					id={id}
					type="file"
					accept={accept}
					disabled={disabled}
					onChange={(event) => {
						const picked = event.target.files?.[0];
						if (picked) onFile(picked);
						event.target.value = '';
					}}
				/>
				<div className="hint">
					{fileName ? 'Selected' : 'Click to browse or drop a file here'}
					<div style={{ marginTop: 4, fontSize: 11, opacity: 0.75 }}>{hint}</div>
				</div>
				{fileName ? <div className="file-name">{fileName}</div> : null}
			</label>
		</div>
	);
};

/* ------------------------------------------------------------------- chat */

export interface ChatMessage {
	id: string;
	role: 'bot' | 'user';
	text: string;
}

export const ChatPanel: React.FC<{
	messages: ChatMessage[];
	draft: string;
	busy: boolean;
	chatEnabled: boolean;
	onDraft: (value: string) => void;
	onSend: () => void;
}> = ({ messages, draft, busy, chatEnabled, onDraft, onSend }) => {
	const logRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [messages]);

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!busy && draft.trim()) onSend();
	};

	return (
		<section className="card">
			<header className="card-head">
				<span className="card-title">DocuBot</span>
				<span className="spacer" />
				<span className={`pill ${chatEnabled ? 'on' : 'off'}`}>
					{chatEnabled ? 'AI online' : 'Guided mode'}
				</span>
			</header>

			<div className="card-body" ref={logRef}>
				<div className="chat-log">
					{messages.map((message) => (
						<div key={message.id} className={`msg ${message.role}`}>
							<div className="avatar">{message.role === 'bot' ? 'DB' : 'You'}</div>
							<div className="bubble">{message.text}</div>
						</div>
					))}
				</div>
			</div>

			<form className="composer" onSubmit={submit}>
				<input
					value={draft}
					placeholder={
						chatEnabled
							? 'Ask about your document…'
							: 'Guided mode — ask a question once an LLM key is configured'
					}
					onChange={(event) => onDraft(event.target.value)}
					disabled={busy}
				/>
				<Button variant="primary" type="submit" disabled={busy || !draft.trim()}>
					Send
				</Button>
			</form>
		</section>
	);
};

/* ------------------------------------------------------------------ job */

export const JobPanel: React.FC<{
	job: JobStatus | null;
	title: string;
	actionLabel: string;
	onAction: () => void;
	canRun: boolean;
	running: boolean;
}> = ({ job, title, actionLabel, onAction, canRun, running }) => (
	<div className="field">
		<span className="label">{title}</span>
		<Button variant="primary" block onClick={onAction} disabled={!canRun || running}>
			{actionLabel}
		</Button>
		{running && job ? (
			<>
				<div className="progress">
					<div style={{ width: `${Math.round(job.progress)}%` }} />
				</div>
				<div className="hint">{job.status === 'running' ? 'Working…' : ''}</div>
			</>
		) : null}
		{job && job.logs.length > 0 ? <div className="logbox">{job.logs.join('\n')}</div> : null}
	</div>
);

/* --------------------------------------------------------------- preview */

export const Player: React.FC<{
	component: React.ComponentType<{ scenes?: Scene[] }>;
	scenes: Scene[];
}> = ({ component, scenes }) => {
	const total = scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0);

	return (
		<div className="stage">
			<RemotionPlayer
				component={component}
				inputProps={{ scenes }}
				durationInFrames={Math.max(30, total)}
				compositionWidth={1920}
				compositionHeight={1080}
				fps={30}
				style={{ width: '100%', height: '100%' }}
				controls
				acknowledgeRemotionLicense
			/>
		</div>
	);
};

export const SceneList: React.FC<{ scenes: Scene[] }> = ({ scenes }) => (
	<div className="scene-list">
		{scenes.map((scene) => (
			<div className="scene-row" key={scene.sceneNumber}>
				<span className="scene-num">{scene.sceneNumber}</span>
				<span className="scene-title">{scene.title || scene.narratorText}</span>
				<span className="scene-dur">{(scene.durationInFrames / 30).toFixed(1)}s</span>
			</div>
		))}
	</div>
);

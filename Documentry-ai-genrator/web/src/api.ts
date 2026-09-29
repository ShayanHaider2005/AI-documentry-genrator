/** Typed fetch helpers for the DocuBot API. */

// Re-use the composition's types so the browser and the renderer can never
// drift apart.
import type { Scene, WordTiming } from '../../src/types';
import { normalizeVoiceSample } from './audio';
export type { Scene, WordTiming };

/** One generated narrator, offered when the user uploads no sample of their own. */
export interface LibraryVoice {
	voiceId: string;
	name: string;
	gender: 'male' | 'female';
	accent: string;
	/**
	 * Shown in the picker. Read this from the server rather than composing a
	 * label here: the model's accent vocabulary is closed, so the label has to
	 * match the audio the user is actually choosing.
	 */
	accentLabel: string;
	audioPath: string;
	refText: string;
	instruct: string;
	seconds: number;
}

export interface VoiceLibrary {
	available: boolean;
	voices: LibraryVoice[];
	accents: Record<string, string>;
	/** Why the library may be missing, or a caveat about the accent mapping. */
	note: string;
}

export interface VoiceSampleConfig {
	voiceSampleSentences: string[];
	voiceSampleScript: string;
	fallbackVoice: string;
	voiceCloningAvailable: boolean;
	voiceEngine: string;
	/** True while OmniVoice is still loading its ~3.3 GB of weights. */
	voiceLoading: boolean;
	/** Why cloning is unavailable, when it is. Null when it is available. */
	voiceError: string | null;
	/** Whether the bundled default narrator has been generated. */
	defaultVoiceAvailable: boolean;
	defaultVoiceLabel: string;
	voiceLibrary: VoiceLibrary;
	chatEnabled: boolean;
	llmProvider: string | null;
}

export interface SessionSnapshot {
	sessionId: string;
	pdf: { fileName: string; bytes: number; characters: number } | null;
	voice: {
		status: string;
		voiceName: string;
		/**
		 * Always null. OmniVoice clones per synthesis and needs the reference
		 * path each time, so there is no reusable voice id. The field is kept so
		 * older stored sessions still deserialise.
		 */
		voiceId: string | null;
		fileName: string;
		bytes: number;
	} | null;
	hasDataset: boolean;
	dataset: Scene[] | null;
	renderPath: string | null;
}

export interface SessionSummary {
	id: string;
	title: string;
	createdAt: string;
	sceneCount: number;
	totalFrames: number;
}

export interface StoredSession {
	id: string;
	title: string;
	createdAt: string;
	scenes: Scene[];
}

export interface JobStatus {
	id: string;
	type: 'generate' | 'render' | 'produce';
	status: 'running' | 'done' | 'error';
	progress: number;
	logs: string[];
	result: {
		sessionId?: string;
		title?: string;
		sceneCount?: number;
		totalFrames?: number;
		videoUrl?: string;
		/** Set by the one-button flow; fetches the MP4 as a download. */
		downloadUrl?: string;
		fileName?: string;
		narrator?: string | null;
	} | null;
	error: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
	});

	const text = await response.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = { error: text };
	}

	if (response.status === 401) {
		// Distinct type so the app can send the user to the login screen instead
		// of showing a failed action they cannot act on.
		throw new UnauthorisedError(
			(body as { error?: string })?.error || 'Sign in to continue.',
		);
	}
	if (!response.ok) {
		const message =
			(body as { error?: string })?.error || `Request failed (${response.status})`;
		throw new Error(message);
	}
	return body as T;
}

/** Read a File into base64 (without the data-URL prefix). */
export const fileToBase64 = (file: File): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
		reader.onload = () => {
			const result = String(reader.result || '');
			resolve(result.slice(result.indexOf(',') + 1));
		};
		reader.readAsDataURL(file);
	});

const postJson = <T>(path: string, payload: unknown) =>
	request<T>(path, { method: 'POST', body: JSON.stringify(payload) });

/** Thrown when the server refuses because there is no session. */
export class UnauthorisedError extends Error {
	constructor(message = 'Sign in to continue.') {
		super(message);
		this.name = 'UnauthorisedError';
	}
}

export const api = {
	config: () => request<VoiceSampleConfig>('/api/config'),

	// ── Auth ───────────────────────────────────────────────────────────────
	// The cookie is set by the server as httpOnly, so nothing here holds the
	// token: a reload either has a session or does not.
	register: (username: string, password: string) =>
		postJson<{ user: { id: string; username: string } }>('/api/auth/register', {
			username,
			password,
		}),

	login: (username: string, password: string) =>
		postJson<{ user: { id: string; username: string } }>('/api/auth/login', {
			username,
			password,
		}),

	logout: () => postJson<{ ok: boolean }>('/api/auth/logout', {}),

	/** The signed-in user, or null. A 401 here is a normal answer, not an error. */
	me: () =>
		request<{ user: { id: string; username: string } | null }>('/api/auth/me'),

	createSession: () => postJson<{ sessionId: string }>('/api/session', {}),

	session: (sessionId: string) => request<SessionSnapshot>(`/api/session/${sessionId}`),

	uploadPdf: async (sessionId: string, file: File) =>
		postJson<{ fileName: string; characters: number; preview: string }>(
			'/api/upload/pdf',
			{
				sessionId,
				fileName: file.name,
				dataBase64: await fileToBase64(file),
			},
		),

	/**
	 * Upload a voice sample, normalising it first.
	 *
	 * MediaRecorder produces webm/opus (Chrome, Edge) or mp4/aac (Safari), and
	 * the local voice service cannot decode those without ffmpeg. The browser
	 * that produced the clip can, so convert to mono 16 kHz WAV here.
	 */
	uploadVoice: async (sessionId: string, file: File) => {
		const normalized = await normalizeVoiceSample(file);
		return postJson<NonNullable<SessionSnapshot['voice']>>('/api/upload/voice', {
			sessionId,
			fileName: normalized.name,
			dataBase64: await fileToBase64(normalized),
		});
	},

	chat: (sessionId: string, message: string) =>
		postJson<{ reply: string; provider: string | null }>('/api/chat', {
			sessionId,
			message,
		}),

	/** History: lightweight summaries for the sidebar. */
	listSessions: () => request<{ sessions: SessionSummary[] }>('/api/sessions'),

	/** History: full scenes for the player, fetched once per selection. */
	storedSession: (id: string) => request<StoredSession>(`/api/sessions/${id}`),

	deleteSession: (id: string) =>
		request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

	generate: (sessionId: string, voiceId?: string | null) =>
		postJson<{ jobId: string }>('/api/generate', { sessionId, voiceId }),

	render: (sessionId: string) =>
		postJson<{ jobId: string }>('/api/render', { sessionId }),

	/**
	 * The one button: script, visuals, narration, and the merged MP4 in a
	 * single job, so the audio cannot be lost between two separate calls.
	 *
	 * Accepts a File for a cold start, in which case it is uploaded in the same
	 * request rather than requiring a separate upload step first.
	 */
	produce: async (params: {
		sessionId: string;
		file?: File | null;
		voiceId?: string | null;
	}) => {
		const payload: Record<string, unknown> = {
			sessionId: params.sessionId,
			voiceId: params.voiceId ?? null,
		};
		if (params.file) {
			payload.fileName = params.file.name;
			payload.dataBase64 = await fileToBase64(params.file);
		}
		return postJson<{ jobId: string }>('/api/produce', payload);
	},

	job: (jobId: string) => request<JobStatus>(`/api/job/${jobId}`),
};

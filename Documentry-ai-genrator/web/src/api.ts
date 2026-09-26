/** Typed fetch helpers for the DocuBot API. */

// Re-use the composition's types so the browser and the renderer can never
// drift apart.
import type { Scene, WordTiming } from '../../src/types';
export type { Scene, WordTiming };

export interface VoiceSampleConfig {
	voiceSampleSentences: string[];
	voiceSampleScript: string;
	fallbackVoice: string;
	voiceCloningAvailable: boolean;
	chatEnabled: boolean;
	llmProvider: string | null;
}

export interface SessionSnapshot {
	sessionId: string;
	pdf: { fileName: string; bytes: number; characters: number } | null;
	voice: {
		status: string;
		voiceName: string;
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
	type: 'generate' | 'render';
	status: 'running' | 'done' | 'error';
	progress: number;
	logs: string[];
	result: {
		sessionId?: string;
		title?: string;
		sceneCount?: number;
		totalFrames?: number;
		videoUrl?: string;
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

export const api = {
	config: () => request<VoiceSampleConfig>('/api/config'),

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

	uploadVoice: async (sessionId: string, file: File) =>
		postJson<NonNullable<SessionSnapshot['voice']>>('/api/upload/voice', {
			sessionId,
			fileName: file.name,
			dataBase64: await fileToBase64(file),
		}),

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

	generate: (sessionId: string) =>
		postJson<{ jobId: string }>('/api/generate', { sessionId }),

	render: (sessionId: string) =>
		postJson<{ jobId: string }>('/api/render', { sessionId }),

	job: (jobId: string) => request<JobStatus>(`/api/job/${jobId}`),
};

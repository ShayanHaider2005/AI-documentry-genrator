export interface WordTiming {
	word: string;
	startFrame: number;
	endFrame: number;
}

export interface Scene {
	id: string;
	sceneNumber?: number;
	title?: string;
	narrationText: string;
	summaryBulletPoints?: string[];
	audioUrl: string;
	durationInFrames: number;
	wordTimings?: WordTiming[];
	bRollPrompt?: string;
	bRollImageUrl?: string;
}

export interface VideoScript extends Record<string, unknown> {
	title: string;
	clientAvatarUrl?: string;
	teacherName?: string;
	talkingHeadVideoUrl?: string;
	totalDurationInFrames: number;
	scenes: Scene[];
}

export type DocumentaryProps = VideoScript;


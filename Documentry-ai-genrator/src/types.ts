export interface Scene {
	id: string;
	narrationText: string;
	audioUrl: string;
	durationInFrames: number;
	bRollPrompt: string;
	bRollImageUrl: string;
}

export interface VideoScript extends Record<string, unknown> {
	title: string;
	clientAvatarUrl: string;
	talkingHeadVideoUrl?: string;
	totalDurationInFrames: number;
	scenes: Scene[];
}

export type DocumentaryProps = VideoScript;

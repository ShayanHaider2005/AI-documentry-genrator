export interface Scene {
	sceneNumber: number;
	narratorText: string;
	visualPrompt: string;
	imageKeyword: string;
	imageUrl: string;
	audioPath: string;
	durationInFrames: number;
	id?: string;
}

export interface DocumentaryProps {
	scenes?: Scene[];
}

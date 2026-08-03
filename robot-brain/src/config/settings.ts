export interface PipelineSettings {
    debugMode: boolean;
    logLevel: 'silent' | 'info' | 'verbose';
    enableLearning: boolean;
    enableAvatar: boolean;
    enableWebSocket: boolean;
    websocketPort: number;
}

export const DEFAULT_SETTINGS: PipelineSettings = {
    debugMode: false,
    logLevel: 'info',
    enableLearning: true,
    enableAvatar: true,
    enableWebSocket: true,
    websocketPort: 8055,
};

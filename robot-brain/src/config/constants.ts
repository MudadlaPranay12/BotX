export const PIPELINE = {
    SENSOR_QUEUE_CAPACITY: 100,
    PERCEPTION_BATCH_WINDOW_MS: 200,
    CONTEXT_CONFIDENCE_THRESHOLD: 0.3,
    DECISION_COOLDOWN_MS: 120000,
    MOTION_COOLDOWN_MS: 2000,
    IGNORE_TIMEOUT_MS: 45000,
    WEBSOCKET_PORT: 8055,
} as const;

export const LEARNING = {
    UPDATE_INC: 2,
    UPDATE_DEC: 1,
    MAX_SCORE: 100,
    DEFAULT_USER_ID: 'default',
} as const;

export const PIPELINE_STAGES = [
    'sensor',
    'filter',
    'perception',
    'context',
    'decision',
    'behaviour',
    'explanation',
    'motion',
    'actuator',
] as const;

export type AvatarExpression =
    | 'happy'
    | 'sad'
    | 'confused'
    | 'thinking'
    | 'neutral'
    | 'idle'
    | 'worried'
    | 'shocked'
    | 'sleeping';

export type AvatarAction = 'JUMP' | 'SHAKE' | 'ALERT_RED' | 'NOD' | 'POINT_LEFT' | 'NONE';

export type AvatarAnimation = 'nod' | 'shake' | 'raise-hand' | 'point' | 'gesture';

export interface RobotCommand {
    type: 'ROBOT_STATE';
    expression: AvatarExpression;
    action: AvatarAction;
    speechBubble?: string;
    duration?: number;
    targetX?: number;
    targetY?: number;
    alignment?: 'left-editor' | 'right-editor' | 'bottom-panel' | 'floating';
}

export interface WindowAnchorPayload {
    type: 'WINDOW_ANCHOR';
    targetX: number;
    targetY: number;
    alignment: 'left-editor' | 'right-editor' | 'bottom-panel' | 'floating';
}

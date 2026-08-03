import type { AvatarExpression, AvatarAnimation } from '../core/types';

export type { AvatarExpression, AvatarAnimation };

export interface AvatarState {
    expression: AvatarExpression;
    animation: AvatarAnimation | null;
    text: string | null;
    visible: boolean;
}

export const DEFAULT_AVATAR_STATE: AvatarState = {
    expression: 'neutral',
    animation: null,
    text: null,
    visible: true,
};

import { BehaviourAction } from "../behaviour/behaviourAction";

export enum ExplanationType {
    WHY_SUGGESTION = "WHY_SUGGESTION",
    WHY_ERROR_HELP = "WHY_ERROR_HELP",
    WHY_DEBUGGING = "WHY_DEBUGGING",
    WHY_GIT_ACTION = "WHY_GIT_ACTION",
    WHY_EXTENSION = "WHY_EXTENSION",
    WHY_CELEBRATE = "WHY_CELEBRATE",
    WHY_NONE = "WHY_NONE"
}

export interface Explanation {
    id: string;
    type: ExplanationType;
    action: BehaviourAction;
    shortText: string;
    longText: string;
    confidence: number;
    timestamp: number;
}

import { BehaviourAction } from "../behaviour/behaviourAction";
import type { ExpressionType } from "../ai/gemini";

export enum ExplanationType {
    WHY_SUGGESTION = "WHY_SUGGESTION",
    WHY_ERROR_HELP = "WHY_ERROR_HELP",
    WHY_DEBUGGING = "WHY_DEBUGGING",
    WHY_GIT_ACTION = "WHY_GIT_ACTION",
    WHY_EXTENSION = "WHY_EXTENSION",
    WHY_CELEBRATE = "WHY_CELEBRATE",
    WHY_LOGIC_REVIEW = "WHY_LOGIC_REVIEW",
    WHY_NONE = "WHY_NONE"
}

export interface DiagnosticFix {
    line: number;
    description: string;
    suggestedCode: string;
}

export interface DiagnosticError {
    line: number;
    column: number;
    message: string;
    severity: string;
    code?: string;
}

export interface DiagnosticAnalysisRequest {
    file: string;
    fileName: string;
    language: string;
    fileContent: string;
    surroundingCode: Record<number, string>;
    errors: DiagnosticError[];
    warnings: DiagnosticError[];
    errorCount: number;
    warningCount: number;
    resolvedDependencies?: string;
}

export interface LogicReviewRequest {
    file: string;
    fileName: string;
    language: string;
    functionName: string;
    startLine: number;
    fileContent: string;
    functionCode: string;
}

export interface Explanation {
    id: string;
    type: ExplanationType;
    action: BehaviourAction;
    shortText: string;
    longText: string;
    confidence: number;
    timestamp: number;
    expression?: ExpressionType;
    fixes?: DiagnosticFix[];
    fixCount?: number;
}

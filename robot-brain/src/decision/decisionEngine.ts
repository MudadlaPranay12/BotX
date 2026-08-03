import { ContextType } from "../context/contextType";
import type { Context } from "../context/context";
import { DecisionType } from "./decisionType";
import { Decision } from "./decision";
import { DecisionState } from "./decisionState";
import { DecisionPublisher } from "./decisionPublisher";
import { Logger } from "../utils/logger";

interface DecisionRule {
    decisionType: DecisionType;
    confidence: number;
    reason: string;
}

export class DecisionEngine {
    private state: DecisionState;
    private publisher: DecisionPublisher;

    constructor() {
        this.state = new DecisionState();
        this.publisher = new DecisionPublisher();
    }

    process(context: Context): void {
        const rule = this.resolveRule(context);

        if (rule.decisionType === DecisionType.DO_NOTHING) {
            this.state.lastContext = context.type;
            return;
        }

        if (this.state.isOnCooldown(rule.decisionType)) {
            return;
        }

        const decision = this.buildDecision(context, rule);

        this.state.setCooldown(rule.decisionType);
        this.state.lastHint = rule.reason;
        this.state.lastContext = context.type;

        this.publisher.publish(decision);

        Logger.info("DECISION", {
            "Decision": decision.type,
            "Reason": decision.reason,
            "Confidence": String(decision.confidence),
            "Timestamp": new Date(decision.timestamp).toISOString()
        });
    }

    forceCooldown(type: DecisionType, durationMs: number): void {
        this.state.setCustomCooldown(type, durationMs);
        Logger.info("DECISION", {
            "Decision": type,
            "Event": "Forced cooldown",
            "Duration": `${durationMs}ms`
        });
    }

    getState(): DecisionState {
        return this.state;
    }

    getPublisher(): DecisionPublisher {
        return this.publisher;
    }

    private resolveRule(context: Context): DecisionRule {

        if (context.type === ContextType.USER_STUCK_ON_ERROR) {
            const language = String(context.data["language"] ?? context.data["Language"] ?? "code");
            return {
                decisionType: DecisionType.SHOW_ERROR_HELP,
                confidence: 0.98,
                reason: `User is stuck on a syntax error in ${String(context.data["file"] ?? "unknown")}`
            };
        }

        if (context.type === ContextType.DIAGNOSTIC_ANALYSIS) {
            return {
                decisionType: DecisionType.DO_NOTHING,
                confidence: 1.0,
                reason: "Diagnostic analysis handled by the dedicated explanation agent"
            };
        }

        switch (context.type) {

            case ContextType.EDITING_JAVA:
            case ContextType.EDITING_TYPESCRIPT:
            case ContextType.EDITING_PYTHON:
            case ContextType.EDITING_CPP:
                return {
                    decisionType: DecisionType.WAIT,
                    confidence: 0.60,
                    reason: "Active editing session in progress"
                };

            case ContextType.READING_CODE:
            case ContextType.WRITING_CODE:
            case ContextType.SWITCHING_FILES:
                return {
                    decisionType: DecisionType.DO_NOTHING,
                    confidence: 1.0,
                    reason: ""
                };

            case ContextType.FIXING_COMPILER_ERROR:
                return {
                    decisionType: DecisionType.SHOW_ERROR_HELP,
                    confidence: 0.98,
                    reason: "Compiler error detected"
                };

            case ContextType.DEBUGGING:
                return {
                    decisionType: DecisionType.SUGGEST_DEBUGGING,
                    confidence: 0.90,
                    reason: "Debug session is active"
                };

            case ContextType.USING_TERMINAL:
                return {
                    decisionType: DecisionType.WAIT,
                    confidence: 0.70,
                    reason: "User is working in terminal"
                };

            case ContextType.WORKING_WITH_GIT:
                return {
                    decisionType: DecisionType.SUGGEST_GIT_ACTION,
                    confidence: 0.85,
                    reason: "Git repository activity detected"
                };

            case ContextType.MANAGING_EXTENSIONS:
                return {
                    decisionType: DecisionType.SUGGEST_EXTENSION,
                    confidence: 0.80,
                    reason: "Extension changes detected"
                };

            case ContextType.IDLE:
                return {
                    decisionType: DecisionType.DO_NOTHING,
                    confidence: 1.0,
                    reason: ""
                };

            default:
                return {
                    decisionType: DecisionType.WAIT,
                    confidence: 0.50,
                    reason: "Uncertain context"
                };
        }
    }

    private buildDecision(context: Context, rule: DecisionRule): Decision {
        const data: Record<string, unknown> = { ...context.data };

        if (context.type === ContextType.USER_STUCK_ON_ERROR) {
            data["actionProfile"] = {
                expression: "confused",
                animation: "shake",
                speechPrompt: "Explain the syntax error friendly and simply"
            };
        }

        return {
            id: `dec-${context.id}`,
            type: rule.decisionType,
            confidence: rule.confidence,
            timestamp: Date.now(),
            reason: rule.reason,
            sourceContext: context,
            data
        };
    }
}

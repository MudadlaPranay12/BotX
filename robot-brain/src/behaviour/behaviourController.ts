import * as vscode from 'vscode';
import { DecisionType } from "../decision/decisionType";
import type { Decision } from "../decision/decision";
import { BehaviourAction } from "./behaviourAction";
import { RobotBehaviourState, BehaviourState } from "./behaviourState";
import { BehaviourPublisher, BehaviourEvent } from "./behaviourPublisher";
import { FSM } from "./fsm";
import { Logger } from "../utils/logger";
import { sendToRobot } from "../utils/websocketServer";
import type { AvatarExpression, AvatarAction, RobotCommand, RobotStateUpdatePayload } from "../core/types";
import type { SkillLevel } from "../learning/skillProfile";
import { MotionPlanner } from "../motion/motionPlanner";

export class BehaviourController {
    private state: BehaviourState;
    private publisher: BehaviourPublisher;
    private fsm: FSM;
    private motionPlanner?: MotionPlanner;
    private stateMachineRunning: boolean = false;

    constructor(motionPlanner?: MotionPlanner) {
        this.state = new BehaviourState();
        this.publisher = new BehaviourPublisher();
        this.fsm = new FSM();
        this.motionPlanner = motionPlanner;
    }

    process(decision: Decision): void {
        if (!this.state.robotEnabled) {
            return;
        }

        const action = this.resolveAction(decision.type);

        if (action === BehaviourAction.NONE) {
            return;
        }

        if (this.state.isBusy || this.stateMachineRunning) {
            this.fsm.transition(RobotBehaviourState.COOLDOWN);
            this.state.currentState = RobotBehaviourState.COOLDOWN;
            Logger.info("BEHAVIOUR", {
                "State": "COOLDOWN",
                "Action": action,
                "Reason": "Behaviour busy, rejecting new action"
            });
            return;
        }

        const isIdleTransition = action === BehaviourAction.CELEBRATE ||
                                 action === BehaviourAction.ASK_USER ||
                                 action === BehaviourAction.SHOW_HINT ||
                                 action === BehaviourAction.SHOW_DOCUMENTATION ||
                                 action === BehaviourAction.SHOW_EXTENSION_HELP ||
                                 action === BehaviourAction.SHOW_GIT_HELP;

        if (isIdleTransition) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const diags = vscode.languages.getDiagnostics(editor.document.uri);
                const hasActiveErrors = diags.some(d =>
                    d.severity === vscode.DiagnosticSeverity.Error
                );
                if (hasActiveErrors) {
                    Logger.info("BEHAVIOUR", {
                        "State": "LOCKED",
                        "Action": action,
                        "Reason": "Active diagnostics prevent idle transition"
                    });
                    return;
                }
            }
        }

        this.state.lastAction = action;
        this.state.lastActionTime = Date.now();

        // Fast-track: immediately notify WebSocket clients on error help
        if (action === BehaviourAction.SHOW_ERROR_HELP || action === BehaviourAction.SHOW_WARNING) {
            sendToRobot({ type: "ACTION", animation: "thinking" });
        }

        const event: BehaviourEvent = {
            action,
            state: RobotBehaviourState.SPEAKING,
            timestamp: Date.now(),
            data: decision.data ? { ...decision.data } : undefined
        };

        this.publisher.publish(event);

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.SPEAKING,
            "Action": action,
            "Timestamp": new Date(event.timestamp).toISOString()
        });

        this.runTimedStateMachine(action);
    }

    private async runTimedStateMachine(action: BehaviourAction): Promise<void> {
        this.stateMachineRunning = true;
        try {
            const OBSERVE_MS = 50;
            const THINK_MS = 100;
            const WAIT_MS = 500;

            const actionDuration = this.resolveActionDuration(action);

            this.fsm.transition(RobotBehaviourState.OBSERVING);
            this.state.currentState = RobotBehaviourState.OBSERVING;
            Logger.info("BEHAVIOUR", { "State": RobotBehaviourState.OBSERVING, "Action": action });

            await this.delay(OBSERVE_MS);

            this.fsm.transition(RobotBehaviourState.THINKING);
            this.state.currentState = RobotBehaviourState.THINKING;
            Logger.info("BEHAVIOUR", { "State": RobotBehaviourState.THINKING, "Action": action });

            await this.delay(THINK_MS);

            this.fsm.transition(RobotBehaviourState.SPEAKING);
            this.state.currentState = RobotBehaviourState.SPEAKING;
            Logger.info("BEHAVIOUR", { "State": RobotBehaviourState.SPEAKING, "Action": action });

            this.fsm.transition(RobotBehaviourState.WAITING);
            this.state.currentState = RobotBehaviourState.WAITING;
            Logger.info("BEHAVIOUR", { "State": RobotBehaviourState.WAITING, "Action": action });

            await this.delay(actionDuration + WAIT_MS);

            this.fsm.transition(RobotBehaviourState.IDLE);
            this.state.currentState = RobotBehaviourState.IDLE;
            Logger.info("BEHAVIOUR", { "State": RobotBehaviourState.IDLE, "Action": action });
            sendToRobot({ type: "ACTION", animation: "neutral" });
        } catch (err) {
            Logger.info("BEHAVIOUR", {
                "State": "ERROR",
                "Action": action,
                "Reason": `State machine error: ${String(err)}`
            });
        } finally {
            this.stateMachineRunning = false;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private resolveActionDuration(action: BehaviourAction): number {
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return 5000;
            case BehaviourAction.SHOW_DEBUG_HELP:
                return 4000;
            case BehaviourAction.SHOW_GIT_HELP:
            case BehaviourAction.SHOW_EXTENSION_HELP:
                return 3000;
            case BehaviourAction.SHOW_HINT:
            case BehaviourAction.SHOW_WARNING:
            case BehaviourAction.SHOW_DOCUMENTATION:
                return 2500;
            case BehaviourAction.CELEBRATE:
                return 3000;
            default:
                return 2000;
        }
    }

    getState(): BehaviourState {
        return this.state;
    }

    /**
     * Receives the expression output from the explanation agent (Gemini) and
     * broadcasts a structured ROBOT_STATE_UPDATE message to robot-body.
     */
    broadcastRobotStateUpdate(expression: string, speechBubble: string, fixCount: number): void {
        const payload: RobotStateUpdatePayload = {
            type: "ROBOT_STATE_UPDATE",
            payload: {
                expression,
                speechBubble,
                fixCount,
                timestamp: Date.now()
            }
        };

        sendToRobot(payload);

        Logger.info("ROBOT", {
            "Event": "ROBOT_STATE_UPDATE broadcast",
            "Expression": expression,
            "Speech": speechBubble.slice(0, 80),
            "FixCount": String(fixCount)
        });
    }

    getPublisher(): BehaviourPublisher {
        return this.publisher;
    }

    enable(): void {
        this.state.robotEnabled = true;
        this.fsm.reset();
        this.state.currentState = RobotBehaviourState.IDLE;
    }

    disable(): void {
        this.state.robotEnabled = false;
        this.fsm.transition(RobotBehaviourState.DISABLED);
        this.state.currentState = RobotBehaviourState.DISABLED;
    }

    triggerState(event: string, skillLevel?: SkillLevel, contextData?: Record<string, unknown>): void {
        const mapping = this.resolveStateMapping(event, skillLevel);
        if (!mapping) {
            return;
        }

        let targetX: number | undefined;
        let targetY: number | undefined;
        let alignment: 'left-editor' | 'right-editor' | 'bottom-panel' | 'floating' | undefined;

        if (contextData?.editor && typeof contextData.line === 'number' && this.motionPlanner) {
            const anchor = this.motionPlanner.calculateEditorAnchor(
                contextData.editor as import('vscode').TextEditor,
                contextData.line as number,
            );
            targetX = anchor.targetX;
            targetY = anchor.targetY;
            alignment = anchor.alignment;
        } else if (!contextData && (event === 'COMPILING_SUCCESS' || event === 'GIT_COMMIT_SUCCESS')) {
            targetX = 400;
            targetY = 300;
            alignment = 'floating';
        }

        if (event === 'USER_STUCK_ON_ERROR' && contextData?.editor) {
            mapping.action = 'POINT_LEFT';
        }

        const command: RobotCommand = {
            type: 'ROBOT_STATE',
            expression: mapping.expression,
            action: mapping.action,
            speechBubble: mapping.speechBubble,
            duration: mapping.duration,
        };

        if (targetX !== undefined) {
            command.targetX = targetX;
            command.targetY = targetY;
            command.alignment = alignment;
            console.log(`[ACTUATOR] Synchronizing state ${mapping.expression} with target coordinates (X: ${targetX}, Y: ${targetY})`);
        }

        sendToRobot(command);

        const targetStr = targetX !== undefined ? `(X: ${targetX}, Y: ${targetY})` : '(floating)';
        Logger.pipelineTrace({
            actuator: `Target ${targetStr}`,
            actuatorTarget: mapping.action,
            express: mapping.expression,
            expressSpeech: mapping.speechBubble,
        });
    }

    private resolveStateMapping(event: string, skillLevel?: SkillLevel): { expression: AvatarExpression; action: AvatarAction; speechBubble: string; duration: number } | null {
        switch (event) {
            case 'GIT_COMMIT_SUCCESS':
                return { expression: 'happy', action: 'JUMP', speechBubble: 'Push successful! You rock!', duration: 4000 };
            case 'GIT_MERGE_CONFLICT':
                return { expression: 'shocked', action: 'ALERT_RED', speechBubble: 'Oh no! Merge conflict detected!', duration: 5000 };
            case 'DIAGNOSTIC_ERROR_FOUND':
                return { expression: 'thinking', action: 'NOD', speechBubble: 'Diagnostic error detected at cursor. Inspecting.', duration: 4000 };
            case 'COMPILING_SUCCESS':
                return { expression: 'thinking', action: 'NOD', speechBubble: 'Build passed cleanly! Nice code.', duration: 4000 };
            case 'USER_STUCK_ON_ERROR':
                return { expression: 'thinking', action: 'NOD', speechBubble: 'Diagnosing error at cursor. Analyzing diagnostic data.', duration: 4000 };
            default:
                return null;
        }
    }

    private resolveAction(decisionType: DecisionType): BehaviourAction {
        switch (decisionType) {
            case DecisionType.SHOW_ERROR_HELP:
                return BehaviourAction.SHOW_ERROR_HELP;

            case DecisionType.SHOW_WARNING:
                return BehaviourAction.SHOW_WARNING;

            case DecisionType.SHOW_HINT:
                return BehaviourAction.SHOW_HINT;

            case DecisionType.SUGGEST_DOCUMENTATION:
                return BehaviourAction.SHOW_DOCUMENTATION;

            case DecisionType.SUGGEST_DEBUGGING:
                return BehaviourAction.SHOW_DEBUG_HELP;

            case DecisionType.SUGGEST_GIT_ACTION:
                return BehaviourAction.SHOW_GIT_HELP;

            case DecisionType.SUGGEST_EXTENSION:
                return BehaviourAction.SHOW_EXTENSION_HELP;

            case DecisionType.CONGRATULATE:
                return BehaviourAction.CELEBRATE;

            case DecisionType.ASK_USER:
                return BehaviourAction.ASK_USER;

            case DecisionType.WAIT:
            case DecisionType.DO_NOTHING:
            case DecisionType.UNKNOWN:
            default:
                return BehaviourAction.NONE;
        }
    }
}

import * as vscode from 'vscode';
import { RobotBehaviourState } from "../behaviour/behaviourState";
import { BehaviourController } from "../behaviour/behaviourController";
import type { BehaviourEvent } from "../behaviour/behaviourPublisher";
import { BehaviourAction } from "../behaviour/behaviourAction";

const STATE_ICONS: Record<string, string> = {
    [RobotBehaviourState.IDLE]: "$(robot)",
    [RobotBehaviourState.OBSERVING]: "$(eye)",
    [RobotBehaviourState.THINKING]: "$(sync~spin)",
    [RobotBehaviourState.SPEAKING]: "$(comment)",
    [RobotBehaviourState.WAITING]: "$(ellipsis)",
    [RobotBehaviourState.COOLDOWN]: "$(watch)",
    [RobotBehaviourState.DISABLED]: "$(circle-slash)",
};

const STATE_LABELS: Record<string, string> = {
    [RobotBehaviourState.IDLE]: "Idle",
    [RobotBehaviourState.OBSERVING]: "Observing...",
    [RobotBehaviourState.THINKING]: "Thinking...",
    [RobotBehaviourState.SPEAKING]: "Speaking",
    [RobotBehaviourState.WAITING]: "Waiting",
    [RobotBehaviourState.COOLDOWN]: "Cooldown",
    [RobotBehaviourState.DISABLED]: "Disabled",
};

export class BotXStatusBar {
    private item: vscode.StatusBarItem;
    private currentState: RobotBehaviourState = RobotBehaviourState.IDLE;
    private currentAction: BehaviourAction = BehaviourAction.NONE;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = "botx.showRobot";
        this.updateText();
        this.item.show();
    }

    wireToBehaviour(behaviour: BehaviourController): void {
        behaviour.getPublisher().subscribe((event: BehaviourEvent) => {
            this.currentAction = event.action;
            this.updateText();
        });
    }

    onStateChange(state: RobotBehaviourState): void {
        this.currentState = state;
        this.updateText();
    }

    getStatusBarItem(): vscode.StatusBarItem {
        return this.item;
    }

    dispose(): void {
        this.item.dispose();
    }

    private updateText(): void {
        const icon = STATE_ICONS[this.currentState] ?? "$(question)";
        const label = STATE_LABELS[this.currentState] ?? this.currentState;
        this.item.text = `${icon} BotX: ${label}`;
        this.item.tooltip = this.buildTooltip();
    }

    private buildTooltip(): string {
        const stateLabel = STATE_LABELS[this.currentState] ?? this.currentState;
        const actionLabel = this.currentAction !== BehaviourAction.NONE ? `Last action: ${this.currentAction}` : "";
        return `BotX Status: ${stateLabel}\n${actionLabel}\nClick to open command menu`;
    }
}

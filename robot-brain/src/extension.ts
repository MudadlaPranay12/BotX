import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { startRobotServer, stopRobotServer, sendToRobot, onRobotMessage } from './utils/websocketServer';
import { loadEnvFile } from './utils/env';

import { EventFilter } from './eventFilter/eventFilter';
import { EventType } from './eventFilter/eventTypes';

import { EditorSensor } from './sensors/editorSensor';
import { DiagnosticsSensor } from './sensors/diagnosticsSensor';
import { CursorSensor } from './sensors/cursorSensor';
import { FileSensor } from './sensors/fileSensor';
import { TerminalSensor } from './sensors/terminalSensor';
import { DebuggerSensor } from './sensors/debuggerSensor';
import { GitSensor } from './sensors/gitSensor';
import { ExtensionSensor } from './sensors/extensionSensor';

import { PerceptionEngine } from './perception';
import { ContextEngine } from './context/contextEngine';
import { DecisionEngine } from './decision';
import { DecisionType } from './decision/decisionType';
import { BehaviourController } from './behaviour';
import { LearningAgent, LearningPublisher } from './learning';
import type { AvatarExpression } from './core/types';
import { AIExplanationEngine } from './explanation';
import { BotXStatusBar } from './ui/statusBar';
import { BotXCodeActionProvider } from './ui/codeActionProvider';
import { BotXHoverProvider } from './ui/hoverProvider';
import { MotionPlanner } from './motion';
import { MotionController } from './motionController';

const IGNORE_TIMEOUT_MS = 45000;
const DISMISS_COOLDOWN_MS = 120000;

const VALID_EXPRESSIONS: readonly AvatarExpression[] = [
    'happy', 'sad', 'confused', 'thinking', 'neutral',
    'idle', 'worried', 'shocked', 'sleeping'
];

function toAvatarExpression(value: unknown, fallback: AvatarExpression = 'neutral'): AvatarExpression {
    if (typeof value === 'string' && (VALID_EXPRESSIONS as readonly string[]).includes(value)) {
        return value as AvatarExpression;
    }
    return fallback;
}

interface StuckErrorWatch {
    file: string;
    line: number;
    message: string;
    startedAt: number;
    ignoreTimer: ReturnType<typeof setTimeout> | null;
    resolved: boolean;
}

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize();

    loadEnvFile(context.extensionPath);

    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) {
        console.log("[AI] Gemini API key missing — set GEMINI_API_KEY in .env");
    } else {
        console.log("[AI] Gemini API configured");
    }

    const eventFilter = new EventFilter();

    const perception = new PerceptionEngine();
    const contextEngine = new ContextEngine();
    const decisionEngine = new DecisionEngine();
    const planner = new MotionPlanner();
    const behaviour = new BehaviourController(planner);
    const learner = new LearningAgent(context);
    const explainer = new AIExplanationEngine();
    const motionController = new MotionController();

    explainer.setPromptContext({ skillProfile: learner.getProfile() });
    learner.getPublisher().subscribe(() => {
        explainer.setPromptContext({ skillProfile: learner.getProfile() });
    });

    explainer.setApiKeyRetriever(() => Promise.resolve(context.secrets.get("GEMINI_API_KEY")));

    new EditorSensor(eventFilter).start(context);
    new DiagnosticsSensor(eventFilter).start(context);
    new CursorSensor(eventFilter).start(context);
    new FileSensor(eventFilter).start(context);
    new TerminalSensor(eventFilter).start(context);
    new DebuggerSensor(eventFilter).start(context);
    new GitSensor(eventFilter, behaviour).start(context);
    new ExtensionSensor(eventFilter).start(context);

    vscode.window.showInformationMessage('Aether Sensors Initialized');

    // -------- Start WebSocket Server --------
    startRobotServer(8055);

    sendToRobot({ type: "ACTION", animation: "happy", speech: "Hi, ready to code!" });

    // -------- Track VS Code window focus --------
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
            sendToRobot({ type: "WINDOW_VISIBILITY", visible: e.focused });
        })
    );

    // -------- Feedback Loop State --------
    let currentErrorWatch: StuckErrorWatch | null = null;

    function clearErrorWatch(): void {
        if (currentErrorWatch) {
            if (currentErrorWatch.ignoreTimer) {
                clearTimeout(currentErrorWatch.ignoreTimer);
            }
            currentErrorWatch = null;
        }
    }

    function onErrorAccepted(file: string, line: number, message: string): void {
        clearErrorWatch();
        learner.updateSkill(true);
        sendToRobot({ type: "ACTION", animation: "happy", speech: "Issue resolved" });
        Logger.info("FEEDBACK", {
            "Outcome": "accepted",
            "File": file,
            "Line": String(line)
        });
    }

    function onErrorIgnored(file: string, line: number, message: string): void {
        clearErrorWatch();
        learner.updateSkill(false);
        sendToRobot({ type: "ACTION", animation: "happy", speech: "Issue resolved" });
        Logger.info("FEEDBACK", {
            "Outcome": "ignored (timeout)",
            "File": file,
            "Line": String(line)
        });
    }

    // -------- Wire Sensor Events → Perception --------
    eventFilter.subscribe((event) => perception.process(event));

    // -------- Notify companion on editor changes --------
    eventFilter.subscribe((event) => {
        if (event.type === EventType.EDITOR_ACTIVE || event.type === EventType.EDITOR_SWITCHED) {
            sendToRobot({ type: "EDITOR_CHANGED" });
        }
    });

    // -------- Push diagnostics to companion --------
    eventFilter.subscribe((event) => {
        if (event.type === EventType.DIAGNOSTICS_UPDATED) {
            const payload = event.payload as Record<string, unknown> | undefined;
            if (payload && Number(payload["Errors"] ?? 0) > 0) {
                sendToRobot({ type: "ACTION", animation: "sad", speech: String(payload["Message"] ?? "Error detected") });
            } else {
                sendToRobot({ type: "ACTION", animation: "happy", speech: "All clear" });
            }
        }
    });

    // -------- Monitor Diagnostics for Error Resolution --------
    const activeErrors: Map<string, { file: string; line: number; message: string; startedAt: number }> = new Map();

    eventFilter.subscribe((event) => {
        if (event.type !== EventType.DIAGNOSTICS_UPDATED) { return; }

        const changedUris = new Set<string>();
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload) {
            const f = String(payload["File"] ?? "");
            if (f) { changedUris.add(f); }
        }

        const watch = currentErrorWatch;
        if (watch && !watch.resolved) {
            const watchUri = vscode.Uri.file(watch.file);
            const allDiags = vscode.languages.getDiagnostics(watchUri);
            const stillHasError = allDiags.some(
                d => d.range.start.line + 1 === watch.line &&
                     d.severity === vscode.DiagnosticSeverity.Error
            );

            if (!stillHasError) {
                watch.resolved = true;
                onErrorAccepted(watch.file, watch.line, watch.message);
            }

            const key = `${watch.file}:${watch.line}`;
            if (stillHasError) {
                activeErrors.set(key, {
                    file: watch.file,
                    line: watch.line,
                    message: watch.message,
                    startedAt: watch.startedAt
                });
            } else {
                activeErrors.delete(key);
            }
        }

        for (const uriStr of changedUris) {
            const uri = vscode.Uri.file(uriStr);
            const allDiags = vscode.languages.getDiagnostics(uri);
            const errorsOnLines = new Set(
                allDiags
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
                    .map(d => d.range.start.line + 1)
            );

            for (const [key, err] of activeErrors) {
                if (err.file === uriStr) {
                    if (!errorsOnLines.has(err.line)) {
                        activeErrors.delete(key);
                    }
                }
            }
        }
    });

    // -------- Wire the Cognitive Pipeline --------
    perception.getPublisher().subscribe((obs) => {
        Logger.pipelineTrace({
            sensor: obs.source,
            filter: 'Passed (Queue cleared)',
            perceive: obs.type,
        });
        contextEngine.process(obs);
    });

    contextEngine.getPublisher().subscribe((ctx) => {
        Logger.pipelineTrace({
            context: ctx.type,
            contextConfidence: String(Math.round(ctx.confidence * 100)),
        });

        if (ctx.type === 'USER_STUCK_ON_ERROR') {
            const file = String(ctx.data["file"] ?? "");
            const line = Number(ctx.data["line"] ?? 0);
            const message = String(ctx.data["message"] ?? "");

            if (file && line && message) {
                clearErrorWatch();
                currentErrorWatch = {
                    file,
                    line,
                    message,
                    startedAt: Date.now(),
                    ignoreTimer: setTimeout(() => {
                        if (currentErrorWatch && !currentErrorWatch.resolved) {
                            onErrorIgnored(file, line, message);
                        }
                    }, IGNORE_TIMEOUT_MS),
                    resolved: false
                };
                sendToRobot({ type: "ACTION", animation: "sad", speech: message });
            }
        }
        decisionEngine.process(ctx);
    });

    decisionEngine.getPublisher().subscribe((dec) => {
        Logger.pipelineTrace({
            decision: dec.type,
            learner: learner.getSkillLevel(),
            learnerScore: String(learner.getProfile().skillScore),
        });
        behaviour.process(dec);
    });

    behaviour.getPublisher().subscribe((event) => {
        Logger.info("AI", { "Event": "Behaviour event received", "Action": event.action });
        explainer.process(event);
    });

    explainer.getPublisher().subscribe((exp) => {
        Logger.info("MOTION", { "Event": "Explanation ready", "Text": exp.shortText.slice(0, 80) });
        planner.processFromExplanation(exp);
    });

    const MOTION_EXPRESSION_TTL = 60000;
    const motionExpressionMap = new Map<string, { expression: string; addedAt: number }>();

    function evictStaleMotionExpressionMap(): void {
        const now = Date.now();
        for (const [key, entry] of motionExpressionMap) {
            if (now - entry.addedAt > MOTION_EXPRESSION_TTL) {
                motionExpressionMap.delete(key);
            }
        }
    }

    planner.getPublisher().subscribe((plan) => {
        const motionNames = plan.motions.map(m => m.type).join(", ");
        Logger.info("MOTION", { "Plan ID": plan.id, "Motions": motionNames, "Priority": String(plan.priority) });

        for (const motion of plan.motions) {
            if (motion.type === 'CHANGE_EXPRESSION') {
                motionExpressionMap.set(motion.id, { expression: String(motion.parameters['expression'] || 'neutral'), addedAt: Date.now() });
            }
        }

        motionController.executePlan(plan).catch((err) => {
            Logger.info("MOTION", { "Event": "executePlan failed", "Error": String(err) });
        });
    });

    motionController.getPublisher().subscribe((result) => {
        Logger.pipelineTrace({
            actuator: `Motion ID: ${result.motionId}`,
            actuatorTarget: `Status: ${result.status}`,
        });

        evictStaleMotionExpressionMap();

        const exprMap: Record<string, string> = {
            COMPLETED: 'happy',
            FAILED: 'sad',
            SKIPPED: 'neutral',
            INTERRUPTED: 'confused'
        };

        const entry = motionExpressionMap.get(result.motionId);
        const expression = toAvatarExpression(entry ? entry.expression : exprMap[result.status]);
        if (entry) {
            motionExpressionMap.delete(result.motionId);
        }

        Logger.info("ROBOT", {
            "Status": result.status,
            "Expression": expression,
            "Motion ID": result.motionId
        });

        planner.publishNext();
    });

    learner.getPublisher().subscribe((event) => {
        Logger.pipelineTrace({
            learner: event.type,
            learnerScore: `${event.value} (${event.detail})`,
        });
    });

    // -------- Handle Incoming WebSocket Messages --------
    onRobotMessage((data) => {
        const msgType = String(data["type"] ?? "");
        if (msgType === "USER_DISMISS") {
            Logger.info("FEEDBACK", { "Event": "User dismissed suggestion" });

            if (currentErrorWatch && !currentErrorWatch.resolved) {
                currentErrorWatch.resolved = true;
                learner.updateSkill(false);
                clearErrorWatch();
            }

            decisionEngine.forceCooldown(DecisionType.SHOW_ERROR_HELP, DISMISS_COOLDOWN_MS);
            sendToRobot({ type: "ACTION", animation: "neutral" });
        }
    });

    // -------- Register Commands --------
    context.subscriptions.push(
        vscode.commands.registerCommand("botx.explainError", () => {
            vscode.window.showInformationMessage("BotX: Analyzing error...");
        }),
        vscode.commands.registerCommand("botx.showRobot", () => {
            sendToRobot({ type: "WINDOW_VISIBILITY", visible: true });
        }),
        vscode.commands.registerCommand("botx.hideRobot", () => {
            sendToRobot({ type: "WINDOW_VISIBILITY", visible: false });
        }),
        vscode.commands.registerCommand("botx.setApiKey", async () => {
            const key = await vscode.window.showInputBox({
                prompt: "Enter your Gemini API Key",
                password: true,
                placeHolder: "GEMINI_API_KEY"
            });
            if (key) {
                await context.secrets.store("GEMINI_API_KEY", key);
                vscode.window.showInformationMessage("BotX: API key saved securely.");
            }
        })
    );

    // -------- Register Language Providers --------
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: "**/*" },
            new BotXCodeActionProvider()
        ),
        vscode.languages.registerHoverProvider(
            { pattern: "**/*" },
            new BotXHoverProvider()
        )
    );

    // -------- Wire Status Bar --------
    const statusBar = new BotXStatusBar();
    statusBar.wireToBehaviour(behaviour);
    context.subscriptions.push(statusBar);

    Logger.info("AETHER", {
        "Event": "Fully activated"
    });
}

export function deactivate() {
    stopRobotServer();
    Logger.info("AETHER", {
        "Event": "Deactivated"
    });
}

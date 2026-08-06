import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { startRobotServer, stopRobotServer, sendToRobot, onRobotMessage } from './utils/websocketServer';
import { loadEnvFile } from './utils/env';

import { EventFilter } from './eventFilter/eventFilter';
import { EventType } from './eventFilter/eventTypes';
import { Debounce } from './eventFilter/debounce';

import { EditorSensor } from './sensors/editorSensor';
import { DiagnosticsSensor } from './sensors/diagnosticsSensor';
import { CursorSensor } from './sensors/cursorSensor';
import { FileSensor } from './sensors/fileSensor';
import { TerminalSensor } from './sensors/terminalSensor';
import { DebuggerSensor } from './sensors/debuggerSensor';
import { GitSensor } from './sensors/gitSensor';
import { ExtensionSensor } from './sensors/extensionSensor';
import { RapidSaveSensor } from './sensors/rapidSaveSensor';
import { IdleCodeFocusSensor } from './sensors/idleCodeFocusSensor';
import { EnvironmentSensor } from './sensors/environmentSensor';
import type { EnvironmentStatus } from './sensors/environmentSensor';
import { GitConflictSensor, parseGitConflictBlocks } from './sensors/gitConflictSensor';
import type { GitConflictBlock } from './sensors/gitConflictSensor';
import { ImportInspector } from './sensors/importInspector';
import type { DeprecatedApiUsage } from './sensors/importInspector';

import { PerceptionEngine } from './perception';
import { ObservationType } from './perception/observationType';
import type { Observation, DiagnosticObservation } from './perception';
import { ContextEngine } from './context/contextEngine';
import { DecisionEngine } from './decision';
import { DecisionType } from './decision/decisionType';
import { BehaviourController } from './behaviour';
import { LearningAgent, LearningPublisher } from './learning';
import type { AvatarExpression } from './core/types';
import { AIExplanationEngine } from './explanation';
import { GitConflictEngine } from './explanation/gitConflictEngine';
import { ApiMigrationEngine } from './explanation/apiMigrationEngine';
import type { DiagnosticAnalysisRequest, LogicReviewRequest } from './explanation/explanationTypes';
import { BotXStatusBar } from './ui/statusBar';
import { BotXCodeActionProvider, CodeFixRegistry } from './ui/botxCodeActionProvider';
import { BotXHoverProvider } from './ui/hoverProvider';
import { EnvSetupCodeActionProvider } from './ui/envSetupCodeActionProvider';
import { GitConflictCodeActionProvider } from './ui/gitConflictCodeActionProvider';
import { setupWorkspaceEnv } from './utils/envSetup';
import { MotionPlanner } from './motion';
import { MotionController } from './motionController';

const IGNORE_TIMEOUT_MS = 45000;
const DISMISS_COOLDOWN_MS = 120000;

// Module-level so `deactivate()` can clear pending timer handles on shutdown.
const diagnosticDebouncer = new Debounce();
const apiMigrationDebouncer = new Debounce();

const DEPRECATED_API_SPEECH_DEBOUNCE_MS = 1200;

// Module-level so `deactivate()` can dispose the EnvironmentSensor file watchers.
let environmentSensor: EnvironmentSensor | null = null;

const DIAGNOSTIC_ANALYSIS_DEBOUNCE_MS = 1500;

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

function diagnosticSeverityToString(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return "Error";
        case vscode.DiagnosticSeverity.Warning:
            return "Warning";
        case vscode.DiagnosticSeverity.Information:
            return "Information";
        case vscode.DiagnosticSeverity.Hint:
            return "Hint";
        default:
            return "Unknown";
    }
}

function diagnosticSeverityToObservationType(severity: vscode.DiagnosticSeverity): DiagnosticObservation["type"] {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return "SYNTAX_ERROR";
        case vscode.DiagnosticSeverity.Warning:
            return "WARNING";
        default:
            return "INFO";
    }
}

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "throw"]);

function extractFunctionName(lines: string[], blockStart: number): string {
    const maxScan = Math.max(0, blockStart - 20);
    for (let i = blockStart; i >= maxScan; i--) {
        const text = lines[i].trim();

        const fn = text.match(/\bfunction\s+([A-Za-z_$][\w$]*)/);
        if (fn) {
            return fn[1];
        }

        const method = text.match(/([A-Za-z_$][\w$]*)\s*\([^)]*\)/);
        if (method && !CONTROL_KEYWORDS.has(method[1]) && (text.includes("{") || text.includes("=>"))) {
            return method[1];
        }
    }
    return `block-${blockStart + 1}`;
}

function extractFunctionSnippet(document: vscode.TextDocument, cursorLine: number): { name: string; startLine: number; snippet: string } {
    const lines = document.getText().split(/\r?\n/);
    const idx = Math.max(0, Math.min(lines.length - 1, cursorLine - 1));

    let blockStart = idx;
    let balance = 0;
    for (let i = idx; i >= 0; i--) {
        balance += (lines[i].match(/{/g) ?? []).length;
        balance -= (lines[i].match(/}/g) ?? []).length;
        if (balance > 0) {
            blockStart = i;
            break;
        }
    }

    let openCount = 0;
    let closeIdx = blockStart;
    for (let i = blockStart; i < lines.length; i++) {
        openCount += (lines[i].match(/{/g) ?? []).length;
        openCount -= (lines[i].match(/}/g) ?? []).length;
        if (openCount <= 0) {
            closeIdx = i;
            break;
        }
    }

    const MAX_LINES = 120;
    const start = Math.max(0, blockStart - 1);
    const end = Math.min(lines.length - 1, closeIdx + 1);
    const snippetLines = lines.slice(start, end + 1);
    const snippet = snippetLines.length > MAX_LINES
        ? snippetLines.slice(0, MAX_LINES).join("\n") + "\n// ... (truncated)"
        : snippetLines.join("\n");

    return {
        name: extractFunctionName(lines, blockStart),
        startLine: blockStart + 1,
        snippet
    };
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
    const fixRegistry = new CodeFixRegistry();

    explainer.setPromptContext({ skillProfile: learner.getProfile() });
    learner.getPublisher().subscribe(() => {
        explainer.setPromptContext({ skillProfile: learner.getProfile() });
    });

    explainer.setApiKeyRetriever(() => Promise.resolve(context.secrets.get("GEMINI_API_KEY")));

    const gitConflictEngine = new GitConflictEngine();
    gitConflictEngine.setApiKeyRetriever(() => Promise.resolve(context.secrets.get("GEMINI_API_KEY")));

    const apiMigrationEngine = new ApiMigrationEngine();
    apiMigrationEngine.setApiKeyRetriever(() => Promise.resolve(context.secrets.get("GEMINI_API_KEY")));

    new EditorSensor(eventFilter).start(context);
    new DiagnosticsSensor(eventFilter).start(context);
    new CursorSensor(eventFilter).start(context);
    new FileSensor(eventFilter).start(context);
    new TerminalSensor(eventFilter).start(context);
    new DebuggerSensor(eventFilter).start(context);
    new GitSensor(eventFilter, behaviour).start(context);
    new ExtensionSensor(eventFilter).start(context);
    new RapidSaveSensor(eventFilter).start(context);
    new IdleCodeFocusSensor(eventFilter).start(context);

    // -------- Workspace Environment & Setup Guardian --------
    // Subscribe before starting the sensor so the activation-time check (which
    // publishes synchronously) reaches the behaviour layer.
    eventFilter.subscribe((event) => {
        if (event.type !== EventType.ENVIRONMENT_CHECK) {
            return;
        }
        const status = event.payload as EnvironmentStatus;
        behaviour.onEnvironmentStatus(status);
    });

    environmentSensor = new EnvironmentSensor(eventFilter);
    environmentSensor.start(context);

    // -------- Intent-Aware Git Merge Conflict Resolver --------
    // Detect `<<<<<<<` / `=======` / `>>>>>>>` markers in open documents and
    // drive the behaviour layer (Phase 1 silent ALERT, Phase 2 speech bubble).
    const gitConflictSensor = new GitConflictSensor(eventFilter);
    gitConflictSensor.start(context);

    eventFilter.subscribe((event) => {
        if (event.type !== EventType.GIT_CONFLICT_DETECTED &&
            event.type !== EventType.GIT_CONFLICT_RESOLVED) {
            return;
        }
        const payload = event.payload as Record<string, unknown> | undefined;
        const fileName = String(
            payload?.["FileName"] ?? payload?.["File"] ?? payload?.["Repository"] ?? "this file"
        );
        if (event.type === EventType.GIT_CONFLICT_DETECTED) {
            const count = Number(payload?.["ConflictCount"] ?? payload?.["Conflict Count"] ?? 0) || 0;
            behaviour.onGitConflictDetected(count, fileName);
        } else {
            behaviour.onGitConflictResolved(fileName);
        }
    });

    // -------- Library Deprecation & API Shield --------
    // ImportInspector scans the active document for deprecated imports/APIs.
    // Phase 1 sets the state silently; Phase 2 dispatches a non-intrusive
    // speech bubble after the typing/save debounce so background workers wait
    // for a pause. Clean documents fall back to a quiet IDLE.
    const importInspector = new ImportInspector(eventFilter);
    importInspector.start(context);

    eventFilter.subscribe((event) => {
        if (event.type !== EventType.DEPRECATED_API_DETECTED) {
            return;
        }
        const payload = event.payload as Record<string, unknown> | undefined;
        const deprecations = Array.isArray(payload?.["Deprecations"])
            ? payload["Deprecations"] as DeprecatedApiUsage[]
            : [];
        const count = deprecations.length;

        if (count === 0) {
            apiMigrationDebouncer.clear('deprecated-api');
            behaviour.forceIdle();
            return;
        }

        // Phase 1 — silent THINKING state.
        behaviour.onDeprecatedApiDetected(deprecations);

        // Phase 2 — post-debounce speech bubble to robot-body.
        const primary = deprecations[0];
        apiMigrationDebouncer.debounce('deprecated-api', () => {
            behaviour.broadcastRobotStateUpdate(
                "worried",
                `Deprecated SDK API on Line ${primary.line}: ${primary.description}`,
                count
            );
        }, DEPRECATED_API_SPEECH_DEBOUNCE_MS);
    });

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

    // -------- Progressive Intervention — Phase 1 (Developer Tries First) --------
    // On a squiggly error, transition the FSM silently to THINKING with no
    // popup and no edits. On clean files (blank or zero diagnostics) we force a
    // quiet IDLE, suppressing background noise instead of firing "All clear".
    eventFilter.subscribe((event) => {
        if (event.type !== EventType.DIAGNOSTICS_UPDATED) {
            return;
        }
        const payload = event.payload as Record<string, unknown> | undefined;
        const severity = String(payload?.["Severity"] ?? "");
        if (severity === "Error") {
            behaviour.enterThinkingSilently();
            planner.processSilentThinking();
        } else {
            behaviour.forceIdle();
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

    // -------- Proactive Stuck-State Detector --------
    // A STUCK_* observation (rapid saves or idle code focus) transitions the
    // FSM to PROACTIVE_ASSIST and asks Gemini to review the active function's
    // logic (off-by-one, edge cases) rather than its syntax.
    perception.getPublisher().subscribe((obs) => {
        if (obs.type !== ObservationType.STUCK_RAPID_SAVE &&
            obs.type !== ObservationType.STUCK_IDLE_FOCUS) {
            return;
        }

        behaviour.onStuckObservation(obs);
        void handleStuckLogicReview(obs);
    });

    async function handleStuckLogicReview(obs: Observation): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "file") {
            return;
        }

        const document = editor.document;
        const data = obs.data as Record<string, unknown> | undefined;
        const file = String(data?.["File"] ?? document.fileName);
        const line = Number(data?.["Line"] ?? editor.selection.active.line + 1);
        const fileContent = document.getText();
        const fnContext = extractFunctionSnippet(document, line);

        const request: LogicReviewRequest = {
            file,
            fileName: file.split(/[\\/]/).pop() || file,
            language: document.languageId,
            functionName: String(data?.["Function"] ?? fnContext.name),
            startLine: Number(data?.["Line"] ?? fnContext.startLine),
            fileContent,
            functionCode: String(data?.["FunctionCode"] ?? fnContext.snippet)
        };

        const explanation = await explainer.proactiveLogicReview(request);
        behaviour.broadcastRobotStateUpdate(
            explanation.expression ?? "ALERT",
            explanation.shortText,
            explanation.fixCount ?? 0
        );
    }

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

    // -------- 4-Agent Diagnostic Pipeline --------
    // Progressive Intervention — Phase 2 (Proactive Guidance). Perception →
    // Context → Explanation (Gemini) → Behaviour & Motion, triggered only after
    // the 1.5s typing/save debounce so background workers wait for a pause.

    let diagnosticAnalysisInFlight = false;

    async function runDiagnosticAnalysis(obs: Observation): Promise<void> {
        if (diagnosticAnalysisInFlight) {
            return;
        }

        const data = obs.data;
        const file = String(data["File"] ?? "");
        const fileName = file.split(/[\\/]/).pop() || file;
        const errors = (Array.isArray(data["errors"]) ? data["errors"] : []) as Record<string, unknown>[];
        const errorCount = errors.length;

        if (errorCount === 0) {
            // Suppress background "Code looks clean!" noise — clean IDLE only.
            behaviour.forceIdle();
            fixRegistry.clear();
            return;
        }

        diagnosticAnalysisInFlight = true;
        try {
            // Intermediate state dispatched while Gemini is processing.
            behaviour.broadcastRobotStateUpdate(
                "THINKING",
                `Analyzing ${errorCount} error${errorCount === 1 ? "" : "s"} in ${fileName}...`,
                errorCount
            );

            // 2. CONTEXT agent — full file contents, code blocks, language metadata.
            const ctx = await contextEngine.buildDiagnosticContext(obs);

            // 3. EXPLANATION agent — Gemini analyzes the entire array in one prompt.
            const request: DiagnosticAnalysisRequest = {
                file: String(ctx.data["file"] ?? ""),
                fileName: String(ctx.data["fileName"] ?? ""),
                language: String(ctx.data["language"] ?? ""),
                fileContent: String(ctx.data["fileContent"] ?? ""),
                surroundingCode: (ctx.data["surroundingCode"] as Record<number, string>) ?? {},
                errors: (ctx.data["errors"] as DiagnosticAnalysisRequest["errors"]) ?? [],
                warnings: (ctx.data["warnings"] as DiagnosticAnalysisRequest["warnings"]) ?? [],
                errorCount: Number(ctx.data["errorCount"] ?? 0),
                warningCount: Number(ctx.data["warningCount"] ?? 0),
                resolvedDependencies: String(ctx.data["resolvedDependenciesText"] ?? "")
            };
            const explanation = await explainer.analyzeDiagnostics(request);

            // Surface Gemini's fixes to the CodeAction lightbulb for this file.
            fixRegistry.setFixes(file, explanation.fixes ?? []);

            // 4. BEHAVIOUR & MOTION agent — broadcast high-level explanation to
            // robot-body (port 8055). User code is never modified here; fixes are
            // only offered via the QuickFix in Phase 3.
            behaviour.broadcastRobotStateUpdate(
                explanation.expression ?? "CONFUSED",
                explanation.shortText,
                explanation.fixCount ?? explanation.fixes?.length ?? 0
            );
        } catch (err) {
            Logger.info("PIPELINE", {
                "Event": "Diagnostic analysis failed",
                "Error": String(err)
            });
            // Fall back to CONFUSED on Gemini failure / rate limit.
            behaviour.broadcastRobotStateUpdate("CONFUSED", "I got confused analyzing that — let me try again.", errorCount);
        } finally {
            diagnosticAnalysisInFlight = false;
        }
    }

    async function triggerDiagnosticAnalysis(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "file") {
            return;
        }

        const document = editor.document;
        const uri = document.uri;
        const file = document.fileName;
        const language = document.languageId;
        const diagnostics = vscode.languages.getDiagnostics(uri);

        // -------- Guard Clause (Blank File & Zero Diagnostics) --------
        // Do NOT invoke Gemini or dispatch speech bubbles for empty/whitespace
        // files or when there are zero compiler diagnostics. Force a clean IDLE
        // without firing "Code looks clean!" or intermediate alerts.
        if (!perception.shouldAnalyzeDocument(document, diagnostics)) {
            behaviour.forceIdle();
            fixRegistry.clear();
            return;
        }

        const errorCount = diagnostics.filter(
            (d) => d.severity === vscode.DiagnosticSeverity.Error
        ).length;

        // Warnings-only (no errors): suppress the "Code looks clean!" broadcast —
        // quiet IDLE keeps background noise off clean files.
        if (errorCount === 0) {
            behaviour.forceIdle();
            fixRegistry.clear();
            return;
        }

        // 1. PERCEPTION agent — capture ALL errors & warnings in the document
        //    into a single batched context payload before querying Gemini.
        const obs = perception.processDiagnosticBatch(
            diagnostics.map((d) => ({
                type: diagnosticSeverityToObservationType(d.severity),
                details: d.message,
                line: d.range.start.line + 1,
                column: d.range.start.character + 1,
                file,
                language,
                severity: diagnosticSeverityToString(d.severity),
                code: d.code ? String(d.code) : undefined
            })),
            { file, language }
        );

        if (!obs) {
            return;
        }

        await runDiagnosticAnalysis(obs);
    }

    /**
     * Progressive Intervention wiring. Phase 1 (silent THINKING) runs
     * immediately on a real error; Phase 2 (Gemini explanation speech bubble)
     * only fires after the developer pauses for the 1.5s debounce. Typing,
     * saving, diagnostics, and active-editor changes all coalesce into a single
     * trailing-edge debounce so we batch diagnostics instead of hammering the
     * API on every keystroke.
     */
    function scheduleDiagnosticAnalysis(): void {
        diagnosticDebouncer.debounce(
            'diagnostics',
            () => { void triggerDiagnosticAnalysis(); },
            DIAGNOSTIC_ANALYSIS_DEBOUNCE_MS
        );
    }

    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(() => {
            behaviour.enterThinkingSilently();
            scheduleDiagnosticAnalysis();
        }),
        vscode.window.onDidChangeActiveTextEditor(() => {
            if (!vscode.window.activeTextEditor) {
                // Tab closed — cancel any pending analysis and clean up.
                diagnosticDebouncer.clear('diagnostics');
                behaviour.forceIdle();
                return;
            }
            scheduleDiagnosticAnalysis();
        }),
        vscode.workspace.onDidChangeTextDocument(() => {
            scheduleDiagnosticAnalysis();
        }),
        vscode.workspace.onDidSaveTextDocument(() => {
            scheduleDiagnosticAnalysis();
        }),
        vscode.workspace.onDidCloseTextDocument(() => {
            diagnosticDebouncer.clear('diagnostics');
        })
    );

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
        }),
        vscode.commands.registerCommand("botx.setupWorkspaceEnv", () => {
            void setupWorkspaceEnv();
        }),
        vscode.commands.registerCommand(
            "botx.resolveGitConflict",
            async (uri: vscode.Uri, blockStartLine: number) => {
                await resolveGitConflict(uri, blockStartLine);
            }
        ),
        vscode.commands.registerCommand(
            "botx.migrateApiCall",
            async (uri: vscode.Uri, line: number) => {
                await migrateApiCall(uri, line);
            }
        )
    );

    // -------- Resolve Git Merge Conflict (Aether Engine) --------
    // Analyzes the intent behind both branches via Gemini, then applies the
    // synthesized merged block with a `vscode.WorkspaceEdit` so the developer
    // can review or undo it (Ctrl + Z). Conflict markers are removed cleanly.
    async function resolveGitConflict(uri: vscode.Uri, blockStartLine: number): Promise<void> {
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
            Logger.info("CONFLICT", { "Event": "Failed to open document", "Error": String(err) });
            vscode.window.showErrorMessage("BotX: Could not open the file to resolve the conflict.");
            return;
        }

        const blocks = parseGitConflictBlocks(document);
        const block: GitConflictBlock | undefined = blocks.find((b) => b.startLine === blockStartLine)
            ?? blocks.find((b) => blockStartLine >= b.startLine && blockStartLine <= b.endLine);
        if (!block) {
            vscode.window.showWarningMessage("BotX: No merge conflict found at that location.");
            return;
        }

        behaviour.broadcastRobotStateUpdate(
            "THINKING",
            "Analyzing both branches to merge them safely...",
            0
        );

        const resolution = await gitConflictEngine.resolveConflict({
            fileName: document.fileName,
            language: document.languageId,
            fileContent: document.getText(),
            startLine: block.startLine,
            endLine: block.endLine,
            currentBranchLabel: block.currentBranchLabel,
            incomingBranchLabel: block.incomingBranchLabel,
            currentCode: block.currentCode,
            incomingCode: block.incomingCode
        });

        const mergedCode = resolution.mergedCode.endsWith("\n") || block.endLine >= document.lineCount
            ? resolution.mergedCode
            : `${resolution.mergedCode}\n`;

        const start = new vscode.Position(block.startLine - 1, 0);
        const end = new vscode.Position(block.endLine, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(start, end), mergedCode);

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showWarningMessage("BotX: The merged conflict could not be applied.");
            behaviour.broadcastRobotStateUpdate("CONFUSED", "Conflict could not be applied.", 0);
            return;
        }

        Logger.info("CONFLICT", {
            "Event": "Conflict resolved via Aether Engine",
            "File": document.fileName,
            "Lines": `${block.startLine}-${block.endLine}`,
            "Summary": resolution.summary.slice(0, 80)
        });

        vscode.window.showInformationMessage("🤖 BotX: Conflict resolved successfully!");
        behaviour.broadcastRobotStateUpdate("HAPPY", "Conflict resolved — both branches merged!", 0);
    }

    // -------- Migrate Deprecated API (Aether Engine) --------
    // Analyzes the deprecated call with Gemini and replaces the line via a
    // `vscode.WorkspaceEdit` so the developer can review or undo (Ctrl + Z).
    async function migrateApiCall(uri: vscode.Uri, line: number): Promise<void> {
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
            Logger.info("MIGRATION", { "Event": "Failed to open document", "Error": String(err) });
            vscode.window.showErrorMessage("BotX: Could not open the file to migrate the API call.");
            return;
        }

        const deprecations = importInspector.getDeprecations(uri);
        const deprecation = deprecations.find((d) => d.line === line);
        if (!deprecation) {
            vscode.window.showWarningMessage("BotX: No deprecated API call found at that line.");
            return;
        }

        const lineIndex = Math.max(0, Math.min(document.lineCount - 1, line - 1));
        const deprecatedLine = document.lineAt(lineIndex).text;
        const surroundingCode = buildSurroundingWindow(document, lineIndex);

        behaviour.broadcastRobotStateUpdate(
            "THINKING",
            "Migrating deprecated API to modern syntax...",
            0
        );

        const migration = await apiMigrationEngine.migrateApiCall({
            fileName: document.fileName,
            language: document.languageId,
            line,
            deprecatedLine,
            methodSignature: deprecation.symbol,
            packageName: deprecation.packageName,
            installedVersion: deprecation.installedVersion,
            targetVersion: deprecation.targetVersion,
            fileContent: document.getText(),
            surroundingCode
        });

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, document.lineAt(lineIndex).range, migration.migratedCode);

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showWarningMessage("BotX: The API migration could not be applied.");
            behaviour.broadcastRobotStateUpdate("CONFUSED", "API migration could not be applied.", 0);
            return;
        }

        Logger.info("MIGRATION", {
            "Event": "API migrated via Aether Engine",
            "File": document.fileName,
            "Line": String(line),
            "Symbol": deprecation.symbol,
            "Summary": migration.summary.slice(0, 80)
        });

        vscode.window.showInformationMessage("🤖 BotX: API migrated successfully!");
        behaviour.broadcastRobotStateUpdate("HAPPY", "API migrated to modern syntax!", 0);
    }

    function buildSurroundingWindow(document: vscode.TextDocument, lineIndex: number): string {
        const start = Math.max(0, lineIndex - 5);
        const end = Math.min(document.lineCount - 1, lineIndex + 5);
        const parts: string[] = [];
        for (let i = start; i <= end; i++) {
            parts.push(`${String(i + 1).padStart(4)}: ${document.lineAt(i).text}`);
        }
        return parts.join("\n");
    }

    // -------- Apply Gemini Fix (Phase 3 — Explicit User Approval) --------
    // Runs `vscode.WorkspaceEdit` so the developer can review or undo the
    // change (Ctrl + Z). On success we signal the motion planner to celebrate.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "botx.applyAiFix",
            async (
                uri: vscode.Uri,
                line: number,
                suggestedCode: string,
                description: string
            ) => {
                await applyBotXFix(uri, line, suggestedCode, description);
            }
        )
    );

    async function applyBotXFix(
        uri: vscode.Uri,
        line: number,
        suggestedCode: string,
        description: string
    ): Promise<void> {
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
            Logger.info("FIX", { "Event": "Failed to open document", "Error": String(err) });
            vscode.window.showErrorMessage("BotX: Could not open the file to apply the fix.");
            return;
        }

        const lineIndex = Math.max(0, Math.min(document.lineCount - 1, line - 1));
        const targetRange = document.lineAt(lineIndex).range;

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, targetRange, suggestedCode);

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showWarningMessage("BotX: The suggested fix could not be applied.");
            behaviour.broadcastRobotStateUpdate("CONFUSED", "Fix could not be applied.", 1);
            return;
        }

        learner.updateSkill(true);
        Logger.info("FEEDBACK", {
            "Event": "CodeAction applied",
            "File": document.fileName,
            "Line": String(line),
            "Description": description
        });

        // -------- Feedback Loop to Motion Controller --------
        vscode.window.showInformationMessage("🤖 BotX: Fix applied successfully!");
        behaviour.broadcastRobotStateUpdate("HAPPY", "Fix applied successfully!", 1);
    }

    // -------- Register Language Providers --------
    // BotX QuickFix provider is registered for ALL document schemes (`*`) so it
    // participates in the `Ctrl + .` lightbulb on every active diagnostic line.
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: '*' },
            new BotXCodeActionProvider(fixRegistry, importInspector),
            { providedCodeActionKinds: BotXCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', pattern: '**/.env*' },
            new EnvSetupCodeActionProvider(),
            { providedCodeActionKinds: EnvSetupCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', pattern: '**/*' },
            new GitConflictCodeActionProvider(gitConflictSensor),
            { providedCodeActionKinds: GitConflictCodeActionProvider.providedCodeActionKinds }
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
    if (environmentSensor) {
        environmentSensor.dispose();
        environmentSensor = null;
    }
    diagnosticDebouncer.clear();
    apiMigrationDebouncer.clear();
    stopRobotServer();
    Logger.info("AETHER", {
        "Event": "Deactivated"
    });
}

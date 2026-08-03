import { EventType } from "../eventFilter/eventTypes";
import { AetherEvent } from "../eventFilter/event";
import { ObservationType } from "./observationType";
import { Observation } from "./observation";
import { WorkspaceState } from "./workspaceState";
import { ObservationPublisher } from "./observationPublisher";
import { Logger } from "../utils/logger";

interface EventMapping {
    observationType: ObservationType;
    confidence: number;
}

interface DiagnosticObservation {
    type: "SYNTAX_ERROR" | "SEMANTIC_ERROR" | "WARNING" | "INFO";
    details: string;
    line: number;
    column: number;
    file: string;
    language: string;
    severity: string;
    code?: string;
}

const SYNTAX_ERROR_TTL_MS = 30000;

export class PerceptionEngine {
    private workspaceState: WorkspaceState;
    private publisher: ObservationPublisher;
    private lastSyntaxError: Map<string, { timestamp: number; line: number; message: string; count: number }> = new Map();
    private lastSyntaxEviction: number = Date.now();

    constructor() {
        this.workspaceState = new WorkspaceState();
        this.publisher = new ObservationPublisher();
    }

    process(event: AetherEvent): void {
        this.evictStaleSyntaxErrors();
        this.workspaceState.lastEventTime = event.timestamp;

        const mapping = this.resolveMapping(event);

        if (mapping === undefined) {
            return;
        }

        const observation = this.buildObservation(event, mapping);

        this.updateWorkspaceState(event, observation);

        this.publisher.publish(observation);

        Logger.info("PERCEPTION", {
            "Observation": observation.type,
            "Source": observation.source,
            "Confidence": String(observation.confidence)
        });
    }

    processRawDiagnostic(diagnostic: DiagnosticObservation): void {
        const event: AetherEvent = {
            id: `diag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.DIAGNOSTICS_UPDATED,
            timestamp: Date.now(),
            source: "DiagnosticsSensor",
            payload: {
                File: diagnostic.file,
                Language: diagnostic.language,
                Severity: diagnostic.severity,
                Line: diagnostic.line,
                Column: diagnostic.column,
                Message: diagnostic.details,
                Code: diagnostic.code
            }
        };

        this.process(event);
    }

    processRawCursor(cursorEvent: { file: string; line: number; column: number; language: string }): void {
        const event: AetherEvent = {
            id: `cursor-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.CURSOR_MOVED,
            timestamp: Date.now(),
            source: "CursorSensor",
            payload: {
                File: cursorEvent.file,
                Language: cursorEvent.language,
                Line: cursorEvent.line,
                Column: cursorEvent.column
            }
        };

        this.process(event);
    }

    getWorkspaceState(): WorkspaceState {
        return this.workspaceState;
    }

    getPublisher(): ObservationPublisher {
        return this.publisher;
    }

    private resolveMapping(event: AetherEvent): EventMapping | undefined {
        switch (event.type) {
            case EventType.EDITOR_ACTIVE:
            case EventType.EDITOR_SWITCHED:
                return { observationType: ObservationType.EDITOR_CHANGED, confidence: 1.0 };

            case EventType.EDITOR_OPENED:
                return { observationType: ObservationType.FILE_OPENED, confidence: 1.0 };

            case EventType.CURSOR_MOVED:
                return { observationType: ObservationType.CURSOR_MOVED, confidence: 1.0 };

            case EventType.FILE_CREATED:
                return { observationType: ObservationType.FILE_CREATED, confidence: 1.0 };

            case EventType.FILE_DELETED:
                return { observationType: ObservationType.FILE_DELETED, confidence: 1.0 };

            case EventType.FILE_SAVED:
                return { observationType: ObservationType.FILE_SAVED, confidence: 1.0 };

            case EventType.DIAGNOSTICS_UPDATED:
                return this.resolveDiagnosticMapping(event);

            case EventType.TERMINAL_OPENED:
                return { observationType: ObservationType.TERMINAL_OPENED, confidence: 1.0 };

            case EventType.TERMINAL_CLOSED:
                return { observationType: ObservationType.TERMINAL_CLOSED, confidence: 1.0 };

            case EventType.TERMINAL_COMMAND_FAILED:
                return { observationType: ObservationType.RUNTIME_CRASH, confidence: 0.95 };

            case EventType.DEBUG_STARTED:
                return { observationType: ObservationType.DEBUG_STARTED, confidence: 1.0 };

            case EventType.DEBUG_STOPPED:
                return { observationType: ObservationType.DEBUG_STOPPED, confidence: 1.0 };

            case EventType.DEBUG_BREAKPOINT_HIT:
                return { observationType: ObservationType.DEBUG_INTERRUPTION, confidence: 0.90 };

            case EventType.GIT_BRANCH_CHANGED:
                return { observationType: ObservationType.GIT_BRANCH_CHANGED, confidence: 1.0 };

            case EventType.GIT_COMMIT_SUCCESS:
                return { observationType: ObservationType.SUCCESSFUL_CHECKPOINT, confidence: 0.99 };

            case EventType.GIT_CONFLICT_DETECTED:
                return { observationType: ObservationType.GIT_CONFLICT_DETECTED, confidence: 0.95 };

            case EventType.EXTENSION_INSTALLED:
                return { observationType: ObservationType.EXTENSION_INSTALLED, confidence: 1.0 };

            case EventType.EXTENSION_UNINSTALLED:
                return { observationType: ObservationType.EXTENSION_REMOVED, confidence: 1.0 };

            default:
                return undefined;
        }
    }

    private resolveDiagnosticMapping(event: AetherEvent): EventMapping | undefined {
        const payload = event.payload as Record<string, unknown> | undefined;

        if (!payload || typeof payload !== "object") {
            return { observationType: ObservationType.UNKNOWN, confidence: 0.5 };
        }

        const severity = String(payload["Severity"] || "");
        const message = String(payload["Message"] || "").toLowerCase();
        const line = Number(payload["Line"] || 0);
        const file = String(payload["File"] || "");
        const language = String(payload["Language"] || "").toLowerCase();

        if (severity === "Error" && this.isSyntaxError(message)) {
            const key = `${file}:${line}`;
            const now = Date.now();
            const last = this.lastSyntaxError.get(key);

            if (last && last.message === message && now - last.timestamp < 3000) {
                this.lastSyntaxError.set(key, { timestamp: now, line, message, count: last.count + 1 });
                return { observationType: ObservationType.SYNTAX_ERROR, confidence: 0.99 };
            }

            this.lastSyntaxError.set(key, { timestamp: now, line, message, count: 1 });
            return { observationType: ObservationType.SYNTAX_ERROR, confidence: 0.98 };
        }

        switch (severity) {
            case "Error":
                return { observationType: ObservationType.ERROR_DETECTED, confidence: 0.95 };
            case "Warning":
                return { observationType: ObservationType.WARNING_DETECTED, confidence: 0.85 };
            default:
                return undefined;
        }
    }

    private evictStaleSyntaxErrors(): void {
        const now = Date.now();
        if (now - this.lastSyntaxEviction < SYNTAX_ERROR_TTL_MS) {
            return;
        }
        this.lastSyntaxEviction = now;
        for (const [key, entry] of this.lastSyntaxError) {
            if (now - entry.timestamp > SYNTAX_ERROR_TTL_MS) {
                this.lastSyntaxError.delete(key);
            }
        }
    }

    private isSyntaxError(message: string): boolean {
        const syntaxKeywords = [
            "syntax error", "missing", "expected", "unexpected token",
            "';' expected", "',' expected", "')' expected",
            "illegal start", "not a statement", "unclosed",
            "bracket", "parenthesis", "insert", "semicolon",
            "class", "interface", "enum", "brace"
        ];
        return syntaxKeywords.some((keyword) => message.includes(keyword));
    }

    private buildObservation(event: AetherEvent, mapping: EventMapping): Observation {
        const payload = event.payload as Record<string, unknown> | undefined;

        const baseData: Record<string, unknown> = payload && typeof payload === "object"
            ? { ...payload }
            : {};

        const data = this.normalizeObservationData(event.type, baseData);

        return {
            id: `obs-${event.id}`,
            type: mapping.observationType,
            timestamp: event.timestamp,
            confidence: mapping.confidence,
            source: event.source,
            data
        };
    }

    private normalizeObservationData(eventType: EventType, payload: Record<string, unknown>): Record<string, unknown> {
        const data: Record<string, unknown> = { ...payload };

        if (eventType === EventType.DIAGNOSTICS_UPDATED) {
            data["details"] = payload["Message"] || "";
            data["syntaxError"] = this.isSyntaxError(String(payload["Message"] || "").toLowerCase());
            return data;
        }

        if (eventType === EventType.CURSOR_MOVED) {
            data["cursorLine"] = payload["Line"];
            data["cursorColumn"] = payload["Column"];
            return data;
        }

        if (eventType === EventType.TERMINAL_COMMAND_FAILED) {
            data["errorSnippet"] = payload["Error Snippet"] ?? "";
            data["terminalName"] = payload["Terminal Name"] ?? "";
            data["crash"] = true;
            return data;
        }

        if (eventType === EventType.DEBUG_BREAKPOINT_HIT) {
            data["reason"] = payload["Exception"] ?? payload["Reason"] ?? "";
            data["breakLine"] = payload["Line"] ?? 0;
            data["crashFile"] = payload["File"] ?? "";
            return data;
        }

        if (eventType === EventType.GIT_COMMIT_SUCCESS) {
            data["checkpoint"] = true;
            data["summary"] = payload["Message"] ?? "";
            return data;
        }

        if (eventType === EventType.GIT_CONFLICT_DETECTED) {
            data["conflict"] = true;
            data["conflictMessage"] = payload["Message"] ?? "";
            return data;
        }

        return data;
    }

    private updateWorkspaceState(event: AetherEvent, observation: Observation): void {
        const payload = event.payload as Record<string, unknown> | undefined;

        if (!payload || typeof payload !== "object") {
            return;
        }

        switch (observation.type) {
            case ObservationType.FILE_OPENED:
            case ObservationType.EDITOR_CHANGED: {
                const file = String(payload["File"] || "");
                const language = String(payload["Language"] || "");

                if (file) {
                    this.workspaceState.currentFile = file;
                    this.workspaceState.addOpenedFile(file);
                }
                if (language) {
                    this.workspaceState.currentLanguage = language;
                }
                break;
            }

            case ObservationType.CURSOR_MOVED: {
                const line = Number(payload["Line"] || 0);
                const column = Number(payload["Column"] || 0);

                this.workspaceState.currentCursorLine = line;
                this.workspaceState.currentCursorColumn = column;
                break;
            }

            case ObservationType.FILE_CREATED: {
                const file = String(payload["File"] || "");
                if (file) {
                    this.workspaceState.addOpenedFile(file);
                }
                break;
            }

            case ObservationType.FILE_DELETED: {
                const file = String(payload["File"] || "");
                if (file) {
                    this.workspaceState.removeOpenedFile(file);
                }
                break;
            }

            case ObservationType.ERROR_DETECTED:
            case ObservationType.WARNING_DETECTED:
            case ObservationType.SYNTAX_ERROR: {
                this.workspaceState.diagnosticCount += 1;
                break;
            }

            case ObservationType.TERMINAL_OPENED: {
                const name = String(payload["Terminal Name"] || "");
                if (name) {
                    this.workspaceState.activeTerminal = name;
                }
                break;
            }

            case ObservationType.TERMINAL_CLOSED: {
                this.workspaceState.activeTerminal = "";
                break;
            }

            case ObservationType.GIT_BRANCH_CHANGED: {
                const branch = String(payload["Branch"] || "");
                if (branch) {
                    this.workspaceState.gitBranch = branch;
                }
                break;
            }

            case ObservationType.RUNTIME_CRASH: {
                this.workspaceState.lastCrash = String(payload["Error Snippet"] ?? payload["errorSnippet"] ?? "");
                break;
            }

            case ObservationType.DEBUG_INTERRUPTION: {
                this.workspaceState.lastDebugBreak = String(payload["Exception"] ?? payload["Reason"] ?? "");
                break;
            }

            case ObservationType.SUCCESSFUL_CHECKPOINT: {
                this.workspaceState.lastCheckpoint = String(payload["Message"] ?? payload["summary"] ?? "");
                break;
            }

            case ObservationType.GIT_CONFLICT_DETECTED: {
                this.workspaceState.lastConflict = String(payload["Message"] ?? payload["conflictMessage"] ?? "");
                break;
            }

            default:
                break;
        }
    }
}

export { DiagnosticObservation };

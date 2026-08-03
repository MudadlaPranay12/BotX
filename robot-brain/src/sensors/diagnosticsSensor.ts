import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const DUPLICATE_WINDOW_MS = 500;

const DIAG_EVICTION_INTERVAL_MS = 30000;

export class DiagnosticsSensor {

    private recentEntries: Map<string, number> = new Map();
    private lastDiagEviction: number = Date.now();
    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {

        Logger.info("DIAGNOSTICS SENSOR", {
            "Event": "Started"
        });

        const diagnosticsListener = vscode.languages.onDidChangeDiagnostics((event) => {

            for (const uri of event.uris) {
                const diagnostics = vscode.languages.getDiagnostics(uri);
                const fileName = uri.fsPath;
                const language = this.getLanguage(uri);

                for (const diagnostic of diagnostics) {
                    const severity = this.severityToString(diagnostic.severity);
                    const line = diagnostic.range.start.line + 1;

                    if (this.isDuplicate(uri.fsPath, diagnostic.message, line, severity)) {
                        continue;
                    }

                    this.publishDiagnosticEvent(fileName, language, diagnostic, severity, line);
                }
            }
        });

        context.subscriptions.push(diagnosticsListener);
    }

    private publishDiagnosticEvent(
        filePath: string,
        language: string,
        diagnostic: vscode.Diagnostic,
        severity: string,
        line: number
    ): void {
        const event: AetherEvent = {
            id: `diag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.DIAGNOSTICS_UPDATED,
            timestamp: Date.now(),
            source: "DiagnosticsSensor",
            payload: {
                File: filePath,
                Language: language,
                Severity: severity,
                Line: line,
                Column: diagnostic.range.start.character + 1,
                Message: diagnostic.message,
                Code: diagnostic.code ? String(diagnostic.code) : undefined
            }
        };

        this.eventFilter.publish(event);

        const triggerLabel = severity === "Error" ? "TRIGGER_ROBOT" : "IGNORED";
        Logger.info("DIAGNOSTICS SENSOR", {
            "Event": "Diagnostics Updated",
            "File": filePath.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": language,
            "Severity": severity,
            "Line": String(line),
            "Column": String(diagnostic.range.start.character + 1),
            "Message": diagnostic.message,
            "Action": triggerLabel,
            "Timestamp": new Date().toISOString()
        });
    }

    private evictStaleEntries(): void {
        const now = Date.now();
        if (now - this.lastDiagEviction < DIAG_EVICTION_INTERVAL_MS) {
            return;
        }
        this.lastDiagEviction = now;
        const cutoff = now - DUPLICATE_WINDOW_MS;
        for (const [key, time] of this.recentEntries) {
            if (time < cutoff) {
                this.recentEntries.delete(key);
            }
        }
    }

    private isDuplicate(filePath: string, message: string, line: number, severity: string): boolean {
        this.evictStaleEntries();

        const key = `${filePath}|${message}|${line}|${severity}`;
        const now = Date.now();
        const lastSeen = this.recentEntries.get(key);

        if (lastSeen !== undefined && (now - lastSeen) < DUPLICATE_WINDOW_MS) {
            return true;
        }

        this.recentEntries.set(key, now);
        return false;
    }

    private getLanguage(uri: vscode.Uri): string {
        const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === uri.toString()
        );

        if (document) {
            return document.languageId;
        }

        return uri.fsPath.split(".").pop() || "unknown";
    }

    private severityToString(severity: vscode.DiagnosticSeverity): string {
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
}

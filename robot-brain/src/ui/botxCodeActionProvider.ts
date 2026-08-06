import * as vscode from 'vscode';
import type { DeprecatedApiUsage } from '../sensors/importInspector';

/**
 * A single, line-targeted fix suggestion produced by Gemini (via
 * `AIExplanationEngine.analyzeDiagnostics`). `line` is 1-based.
 */
export interface FixSuggestion {
    line: number;
    description: string;
    suggestedCode: string;
}

/**
 * Minimal read-only surface consumed by the CodeAction provider. The
 * extension populates this from `Explanation.fixes` emitted by the
 * `aiExplanationEngine` so that only diagnostics actually analyzed by Gemini
 * receive a lightbulb action.
 */
export interface FixSuggestionSource {
    getFixes(uri: vscode.Uri): FixSuggestion[];
}

/**
 * Read-only source of deprecated API usages detected by the ImportInspector,
 * consumed by the CodeAction provider to surface the modernization lightbulb.
 */
export interface DeprecationSource {
    getDeprecations(uri: vscode.Uri): DeprecatedApiUsage[];
}

/** Languages the BotX fix flow supports ("motting active diagnostics"). */
export const SUPPORTED_LANGUAGES: readonly string[] = [
    'typescript',
    'javascript',
    'python',
    'java',
    'c',
    'cpp',
    'csharp',
    'go',
    'ruby',
    'php',
    'shellscript',
    'json',
    'css',
    'html'
];

export const SUPPORTED_LANGUAGES_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

/**
 * Keeps the latest Gemini fixes keyed by file so the CodeAction provider can
 * expose `🤖 Fix with BotX (Aether Engine)` for every analyzed diagnostic line.
 * This is the shared link between `aiExplanationEngine` output and the lightbulb UI.
 */
export class CodeFixRegistry implements FixSuggestionSource {
    private fixesByFile: Map<string, FixSuggestion[]> = new Map();

    setFixes(file: string, fixes: FixSuggestion[]): void {
        const normalized = fixes.filter(
            (f) => f.line > 0 && (f.description || f.suggestedCode)
        );
        if (normalized.length === 0) {
            this.fixesByFile.delete(file);
        } else {
            this.fixesByFile.set(file, normalized);
        }
    }

    getFixes(uri: vscode.Uri): FixSuggestion[] {
        return this.fixesByFile.get(uri.fsPath) ?? [];
    }

    clear(): void {
        this.fixesByFile.clear();
    }
}

/**
 * Progressive Intervention — Phase 3 (Explicit User Approval).
 *
 * A high-priority QuickFix provider that surfaces `🤖 Fix with BotX (Aether
 * Engine)` on every active diagnostic line the Aether Engine has analyzed.
 * `isPreferred` is set so VS Code places BotX at the top of the `Ctrl + .`
 * lightbulb menu, ahead of third-party extensions (Blackbox, Copilot, etc.).
 *
 * Selecting the action invokes `botx.applyAiFix`, which applies the proposed
 * replacements via a `vscode.WorkspaceEdit` so the user can review or undo
 * them (`Ctrl + Z`) before committing.
 */
export class BotXCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    constructor(
        private readonly source: FixSuggestionSource,
        private readonly deprecationSource?: DeprecationSource
    ) {}

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        // -------- Diagnostics-based fixes (Gemini analysis) --------
        if (SUPPORTED_LANGUAGES_SET.has(document.languageId)) {
            const diagnostics = context.diagnostics; // Only diagnostics in range.
            const suggestions = diagnostics.length > 0 ? this.source.getFixes(document.uri) : [];
            if (suggestions.length > 0) {
                const byLine = new Map<number, FixSuggestion[]>();
                for (const s of suggestions) {
                    const list = byLine.get(s.line) ?? [];
                    list.push(s);
                    byLine.set(s.line, list);
                }

                for (const diag of diagnostics) {
                    const line = diag.range.start.line + 1; // 1-based to align with fixes.
                    const lineSuggestions = byLine.get(line);
                    if (!lineSuggestions || lineSuggestions.length === 0) {
                        continue;
                    }

                    for (const fix of lineSuggestions) {
                        const action = new vscode.CodeAction(
                            '🤖 Fix with BotX (Aether Engine)',
                            vscode.CodeActionKind.QuickFix
                        );
                        action.command = {
                            command: 'botx.applyAiFix',
                            title: 'Apply the BotX (Aether Engine) suggested fix',
                            arguments: [
                                document.uri,
                                fix.line,
                                fix.suggestedCode,
                                fix.description
                            ]
                        };
                        action.isPreferred = true;
                        action.diagnostics = [diag];
                        actions.push(action);
                    }
                }
            }
        }

        // -------- Deprecated API modernization lightbulb --------
        if (this.deprecationSource) {
            const deprecations = this.deprecationSource.getDeprecations(document.uri);
            const overlapping = deprecations.find((dep) =>
                range.start.line <= dep.line - 1 &&
                range.end.line >= dep.line - 1
            );
            if (overlapping) {
                const action = new vscode.CodeAction(
                    '🤖 Modernize API with BotX (Aether Engine)',
                    vscode.CodeActionKind.QuickFix
                );
                action.command = {
                    command: 'botx.migrateApiCall',
                    title: 'Migrate the deprecated API call with the BotX Aether Engine',
                    arguments: [document.uri, overlapping.line]
                };
                action.isPreferred = true;
                actions.push(action);
            }
        }

        return actions;
    }
}
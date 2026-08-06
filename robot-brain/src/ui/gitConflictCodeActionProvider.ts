import * as vscode from 'vscode';
import type { GitConflictSensor } from '../sensors/gitConflictSensor';

/**
 * High-priority QuickFix provider for Git merge conflict markers. When the
 * cursor or selection overlaps a detected GitConflictBlock it offers
 * `🤖 Resolve Conflict with BotX (Aether Engine)` as the preferred action,
 * which invokes `botx.resolveGitConflict`.
 */
export class GitConflictCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    constructor(private readonly sensor: GitConflictSensor) {}

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        _context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        if (document.uri.scheme !== 'file') {
            return [];
        }

        const blocks = this.sensor.getConflicts(document.uri);
        if (blocks.length === 0) {
            return [];
        }

        const overlapping = blocks.find((block) =>
            range.start.line <= block.endLine - 1 &&
            range.end.line >= block.startLine - 1
        );
        if (!overlapping) {
            return [];
        }

        const action = new vscode.CodeAction(
            '🤖 Resolve Conflict with BotX (Aether Engine)',
            vscode.CodeActionKind.QuickFix
        );
        action.command = {
            command: 'botx.resolveGitConflict',
            title: 'Resolve the Git merge conflict with the BotX Aether Engine',
            arguments: [document.uri, overlapping.startLine]
        };
        action.isPreferred = true;
        return [action];
    }
}

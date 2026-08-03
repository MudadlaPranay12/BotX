import * as vscode from 'vscode';

export class BotXCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const diagnostics = context.diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

        for (const diag of diagnostics) {
            const action = new vscode.CodeAction(
                `Fix/Explain with BotX: ${diag.message.slice(0, 60)}`,
                vscode.CodeActionKind.QuickFix
            );
            action.command = {
                command: "botx.explainError",
                title: "Explain Error with BotX",
                arguments: [document.uri, diag.range, diag]
            };
            action.diagnostics = [diag];
            action.isPreferred = true;
            actions.push(action);
        }

        return actions;
    }
}

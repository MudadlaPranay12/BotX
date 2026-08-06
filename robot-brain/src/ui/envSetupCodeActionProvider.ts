import * as vscode from 'vscode';

const ENV_FILE_PREFIX = ".env";

/**
 * QuickFix CodeAction for `.env` files. Offers to auto-generate or update the
 * `.env` file from the workspace's `.env.example` / `.env.template` baseline.
 * Invokes the `botx.setupWorkspaceEnv` command.
 */
export class EnvSetupCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        _context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const fileName = document.fileName.split(/[\\/]/).pop() || "";
        if (!fileName.startsWith(ENV_FILE_PREFIX)) {
            return [];
        }

        const action = new vscode.CodeAction(
            "🤖 Auto-Generate .env Template",
            vscode.CodeActionKind.QuickFix
        );
        action.command = {
            command: "botx.setupWorkspaceEnv",
            title: "Auto-generate or update the .env file from the template"
        };
        return [action];
    }
}

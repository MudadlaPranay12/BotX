import * as vscode from 'vscode';

export class BotXHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover | undefined {
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        const line = position.line;
        const lineDiags = diagnostics.filter(d => d.range.start.line === line && d.severity === vscode.DiagnosticSeverity.Error);

        if (lineDiags.length === 0) {
            return undefined;
        }

        const markdownLines: string[] = [
            "---",
            "### $(robot) BotX Error Insight",
            "---"
        ];

        for (const diag of lineDiags) {
            const codeStr = diag.code ? `\`${diag.code}\`` : "Error";
            markdownLines.push(`**${codeStr}:** ${diag.message}`);
            markdownLines.push("");
            markdownLines.push("> Use the lightbulb action or run **BotX: Explain Error** for AI assistance.");
            markdownLines.push("---");
        }

        const hoverContent = new vscode.MarkdownString(markdownLines.join("\n"), true);
        hoverContent.isTrusted = true;

        return new vscode.Hover(hoverContent);
    }
}

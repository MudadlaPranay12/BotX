import * as vscode from "vscode";
import { AvatarProvider } from "./avatarProvider";
import type { AvatarExpression, AvatarAnimation } from "../core/types";

export class AvatarController {
    private provider: AvatarProvider;

    constructor(context: vscode.ExtensionContext) {
        this.provider = new AvatarProvider(context.extensionUri);

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                AvatarProvider.viewType,
                this.provider
            )
        );
    }

    sendInitialize(): void {
        this.provider.postMessage({ type: "initialize" });
    }

    showError(message: string): void {
        this.provider.postMessage({ type: "error", message });
    }

    showFix(message: string): void {
        this.provider.postMessage({ type: "fix", message });
    }

    showText(text: string): void {
        this.provider.postMessage({ type: "text", value: text });
    }

    setExpression(expr: AvatarExpression): void {
        this.provider.postMessage({ type: "expression", value: expr });
    }

    playAnimation(anim: AvatarAnimation): void {
        this.provider.postMessage({ type: "animation", value: anim });
    }

    reveal(): void {
        this.provider.reveal();
    }

    show(): void {
        this.reveal();
    }

    hide(): void {
        vscode.commands.executeCommand('workbench.action.closeSecondarySidebar');
    }

    getProvider(): AvatarProvider {
        return this.provider;
    }
}

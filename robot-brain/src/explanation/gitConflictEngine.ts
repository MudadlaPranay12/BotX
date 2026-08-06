import { Logger } from "../utils/logger";
import type { ExpressionType } from "../ai/gemini";

export interface GitConflictResolutionRequest {
    fileName: string;
    language: string;
    fileContent: string;
    startLine: number;
    endLine: number;
    currentBranchLabel: string;
    incomingBranchLabel: string;
    currentCode: string;
    incomingCode: string;
}

export interface GitConflictResolution {
    mergedCode: string;
    summary: string;
    expression: ExpressionType;
}

const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 2048;
const CONTEXT_WINDOW_LINES = 8;

const VALID_EXPRESSIONS: readonly string[] = [
    "IDLE", "THINKING", "HAPPY", "CONFUSED", "HELPFUL", "ALERT"
];

/**
 * Analyzes both sides of a Git merge conflict and synthesizes a merged code
 * block that preserves the intent of each branch. Falls back to the current
 * (HEAD) side whenever Gemini is unavailable so no incoming data is dropped
 * silently.
 */
export class GitConflictEngine {
    private apiKeyRetriever: (() => Promise<string | undefined>) | undefined;

    setApiKeyRetriever(retriever: () => Promise<string | undefined>): void {
        this.apiKeyRetriever = retriever;
    }

    public async resolveConflict(request: GitConflictResolutionRequest): Promise<GitConflictResolution> {
        Logger.info("GIT CONFLICT ENGINE", {
            "Event": "Resolving conflict",
            "File": request.fileName.split(/[\\/]/).pop() || request.fileName,
            "Current": request.currentBranchLabel,
            "Incoming": request.incomingBranchLabel
        });

        const prompt = this.buildPrompt(request);

        try {
            const data = await this.callGemini(prompt);
            const mergedCode = this.normalizeMergedCode(data["mergedCode"], request.currentCode);
            const result: GitConflictResolution = {
                mergedCode,
                summary: String(data["summary"] ?? "Merged both branches while preserving each side's intent.").slice(0, 500),
                expression: this.toValidExpression(data["expression"])
            };
            Logger.info("GIT CONFLICT ENGINE", {
                "Event": "Resolution complete",
                "Merged length": String(result.mergedCode.length),
                "Expression": result.expression
            });
            return result;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            Logger.info("GIT CONFLICT ENGINE", {
                "Event": "Resolution failed",
                "Reason": reason
            });
            return {
                mergedCode: request.currentCode,
                summary: `I could not reach the AI to merge this conflict — I kept the ${request.currentBranchLabel} (current) version. Review it manually.`,
                expression: "CONFUSED"
            };
        }
    }

    private buildPrompt(request: GitConflictResolutionRequest): string {
        const surroundingContext = this.buildSurroundingContext(request.fileContent, request.startLine, request.endLine);
        const fileName = request.fileName.split(/[\\/]/).pop() || request.fileName;
        const language = request.language || "code";

        return [
            "You are BotX, a paired-programming assistant embedded in a small desktop robot.",
            `A Git merge conflict in ${fileName} (${language}) needs a safe resolution.`,
            "Your job: understand the INTENT behind both changes and produce a merged code block that synthesizes both logic streams.",
            "",
            `<<<<<<< ${request.currentBranchLabel}  (current / HEAD)`,
            request.currentCode,
            "=======",
            `${request.incomingBranchLabel}  (incoming)`,
            request.incomingCode,
            ">>>>>>>",
            "",
            "Surrounding file context:",
            "```",
            surroundingContext,
            "```",
            "",
            "Rules:",
            "- Analyze the intent of each change (e.g. \"HEAD added error handling; incoming branch updated function arguments\").",
            "- Produce a mergedCode that synthesizes BOTH logic streams safely. Do not drop either side's unique contribution unless it is truly redundant.",
            "- Preserve the file's indentation and syntax exactly.",
            "- Respond ONLY with valid JSON:",
            '{ "summary": "1-2 sentence explanation of both intents and how they were merged", "mergedCode": "the exact replacement for the whole conflict block with the markers removed", "expression": "IDLE" | "THINKING" | "HAPPY" | "CONFUSED" | "HELPFUL" | "ALERT" }',
            "",
            "- The \"mergedCode\" field must be raw code, NOT wrapped in markdown code fences."
        ].join("\n");
    }

    private buildSurroundingContext(fileContent: string, startLine: number, endLine: number): string {
        if (!fileContent) {
            return "(file content unavailable)";
        }
        const lines = fileContent.split(/\r?\n/);
        const beforeStart = Math.max(0, startLine - 1 - CONTEXT_WINDOW_LINES);
        const afterEnd = Math.min(lines.length, endLine + CONTEXT_WINDOW_LINES);

        const before = lines.slice(beforeStart, Math.max(0, startLine - 1))
            .map((text, index) => `${beforeStart + index + 1}: ${text}`)
            .join("\n");
        const after = lines.slice(endLine, afterEnd)
            .map((text, index) => `${endLine + index + 1}: ${text}`)
            .join("\n");

        const parts: string[] = [];
        if (before) {
            parts.push(`--- Before conflict ---\n${before}`);
        }
        if (after) {
            parts.push(`--- After conflict ---\n${after}`);
        }
        return parts.join("\n\n") || "(no surrounding context)";
    }

    private async callGemini(prompt: string): Promise<Record<string, unknown>> {
        const apiKey = await this.resolveApiKey();
        if (!apiKey) {
            throw new Error("Gemini API key not found");
        }

        const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => { controller.abort(); }, GEMINI_TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: MAX_OUTPUT_TOKENS
                    }
                }),
                signal: controller.signal
            });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            throw new Error(`Gemini API request failed: ${String(fetchError)}`);
        }

        clearTimeout(timeoutId);

        if (!response.ok) {
            const rateLimited = response.status === 429;
            throw new Error(
                rateLimited
                    ? `Gemini API rate limited (${response.status})`
                    : `Gemini API error: ${response.status}`
            );
        }

        const data = await response.json() as Record<string, unknown>;
        const candidate = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;

        if (!candidate || candidate.length === 0) {
            throw new Error("Empty Gemini response");
        }

        const text = candidate[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new Error("No text in Gemini response");
        }

        const jsonStart = text.indexOf("{");
        const jsonEnd = text.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) {
            throw new Error("Invalid JSON in Gemini response");
        }

        return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    }

    private normalizeMergedCode(value: unknown, fallback: string): string {
        if (typeof value !== "string") {
            return fallback;
        }
        let code = value.trim();
        const fence = code.match(/^```(?:[A-Za-z0-9_-]*)?\n?([\s\S]*?)\n?```$/);
        if (fence) {
            code = fence[1].trim();
        }
        return code || fallback;
    }

    private async resolveApiKey(): Promise<string | undefined> {
        let apiKey = process.env[GEMINI_API_KEY_ENV];
        if (!apiKey && this.apiKeyRetriever) {
            apiKey = await this.apiKeyRetriever();
        }
        return apiKey;
    }

    private toValidExpression(value: unknown): ExpressionType {
        if (typeof value === "string" && VALID_EXPRESSIONS.includes(value)) {
            return value as ExpressionType;
        }
        return "CONFUSED";
    }
}

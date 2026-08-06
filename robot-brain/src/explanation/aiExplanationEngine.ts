import { BehaviourAction } from "../behaviour/behaviourAction";
import type { BehaviourEvent } from "../behaviour/behaviourPublisher";
import { ExplanationType, Explanation, DiagnosticAnalysisRequest, DiagnosticFix, LogicReviewRequest } from "./explanationTypes";
import { ExplanationPublisher } from "./explanationPublisher";
import { Logger } from "../utils/logger";
import { VocabularyAdapter } from "../learning/vocabularyAdapter";
import type { SkillProfile } from "../learning/skillProfile";
import { GeminiAgentEngine, type ExpressionType, type MultiErrorAnalysisResult } from "../ai/gemini";

interface PromptContext {
    language?: string;
    file?: string;
    message?: string;
    experienceLevel?: string;
    skillScores?: Record<string, number>;
    recentActions?: string[];
    skillProfile?: SkillProfile;
}

const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

export class AIExplanationEngine {
    private publisher: ExplanationPublisher;
    private context: PromptContext = {};
    private lastContextKey: string = '';
    private lastShortText: string = '';
    private apiKeyRetriever: (() => Promise<string | undefined>) | undefined;

    constructor() {
        this.publisher = new ExplanationPublisher();
    }

    setApiKeyRetriever(retriever: () => Promise<string | undefined>): void {
        this.apiKeyRetriever = retriever;
    }

    process(event: BehaviourEvent): void {
        const explanationType = this.mapActionToType(event.action);

        if (explanationType === ExplanationType.WHY_NONE) {
            return;
        }

        const eventData = event.data as Record<string, unknown> | undefined;
        const actionProfile = eventData?.["actionProfile"] as Record<string, unknown> | undefined;
        const isStuckOnError = actionProfile !== undefined;

        const profile = this.context.skillProfile;
        const skillLevel = profile?.skillLevel ?? "unknown";
        const skillScore = profile?.skillScore ?? 0;
        const explanationPref = profile?.preferredExplanationLength ?? "unknown";

        Logger.info("AI", {
            "Event": "Context received",
            "Type": explanationType,
            "Action": event.action
        });

        Logger.info("AI", {
            "Event": "Skill profile",
            "Level": skillLevel,
            "Score": String(skillScore),
            "Explanation mode": explanationPref
        });

        let isRepeat = false;
        if (isStuckOnError) {
            this.context.language = String(eventData?.["language"] ?? this.context.language ?? "code");
            this.context.file = String(eventData?.["file"] ?? this.context.file ?? "unknown");
            this.context.message = String(eventData?.["message"] ?? this.context.message ?? "");

            const file = this.context.file;
            const line = String(eventData?.["line"] ?? 0);
            const message = this.context.message;
            const contextKey = `${file}:${line}:${message}`;
            isRepeat = contextKey === this.lastContextKey;
            this.lastContextKey = contextKey;
        }

        const confidence = this.resolveConfidence(event.action, isStuckOnError);

        this.generateExplanation(event, explanationType, confidence, isStuckOnError, isRepeat);
    }

    setPromptContext(ctx: PromptContext): void {
        this.context = { ...this.context, ...ctx };
        if (ctx.skillProfile && !ctx.experienceLevel) {
            this.context.experienceLevel = ctx.skillProfile.skillLevel.toLowerCase();
        }
    }

    getPublisher(): ExplanationPublisher {
        return this.publisher;
    }

    /**
     * Analyzes the ENTIRE array of diagnostics in a single Gemini prompt and
     * publishes an Explanation carrying the 1-2 sentence overview, the array of
     * line-by-line fixes, and the expression trigger. Falls back to CONFUSED on
     * any Gemini failure or rate limit.
     */
    async analyzeDiagnostics(request: DiagnosticAnalysisRequest): Promise<Explanation> {
        Logger.info("AI", {
            "Event": "Analyzing diagnostic batch",
            "File": request.fileName,
            "Errors": String(request.errorCount),
            "Warnings": String(request.warningCount)
        });

        let result: MultiErrorAnalysisResult;
        try {
            const apiKey = await this.resolveApiKey();
            const engine = new GeminiAgentEngine(apiKey ?? "");
            result = await engine.analyzeMultipleErrors(
                request.file,
                request.fileContent,
                request.errors,
                request.resolvedDependencies
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            Logger.info("AI", {
                "Event": "Diagnostic analysis failed",
                "Reason": reason
            });
            result = {
                summary: "I hit a snag analyzing the errors — let me try again in a moment.",
                expression: "CONFUSED",
                fixes: []
            };
        }

        const expression = this.toValidExpression(result.expression);
        const fixes = Array.isArray(result.fixes) ? result.fixes : [];
        const fixCount = fixes.length;
        const shortText = result.summary || "I found some issues worth fixing.";

        const explanation: Explanation = {
            id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: ExplanationType.WHY_ERROR_HELP,
            action: BehaviourAction.SHOW_ERROR_HELP,
            shortText,
            longText: this.formatFixesAsLongText(fixes) || shortText,
            confidence: 0.98,
            timestamp: Date.now(),
            expression,
            fixes,
            fixCount
        };

        this.lastShortText = shortText;
        this.publisher.publish(explanation);

        Logger.info("AI EXPLANATION", {
            "Action": explanation.action,
            "Explanation": shortText.slice(0, 80),
            "Expression": expression,
            "Fixes": String(fixCount),
            "Confidence": String(explanation.confidence)
        });

        return explanation;
    }

    private async resolveApiKey(): Promise<string | undefined> {
        let apiKey = process.env[GEMINI_API_KEY_ENV];
        if (!apiKey && this.apiKeyRetriever) {
            apiKey = await this.apiKeyRetriever();
        }
        return apiKey;
    }

    private toValidExpression(value: unknown): ExpressionType {
        const valid: readonly string[] = ["IDLE", "THINKING", "HAPPY", "CONFUSED", "HELPFUL", "ALERT"];
        if (typeof value === "string" && valid.includes(value)) {
            return value as ExpressionType;
        }
        return "CONFUSED";
    }

    private formatFixesAsLongText(fixes: DiagnosticFix[]): string {
        if (fixes.length === 0) {
            return "";
        }
        return fixes
            .map((fix) => `Line ${fix.line}: ${fix.description}\n${fix.suggestedCode}`)
            .join("\n\n");
    }

    private async generateExplanation(
        event: BehaviourEvent,
        type: ExplanationType,
        confidence: number,
        isStuckOnError: boolean,
        isRepeat: boolean = false
    ): Promise<void> {
        let shortText: string;
        let longText: string;

        Logger.info("AI", { "Event": "Generating explanation" });

        const prompt = this.buildPrompt(event, type, isStuckOnError, isRepeat);
        Logger.info("AI", {
            "Event": "Final prompt",
            "Prompt": prompt.slice(0, 500)
        });

        try {
            const aiResult = await this.callGeminiWithRetry(prompt);
            shortText = aiResult.short;
            longText = aiResult.long || aiResult.short;
            Logger.info("AI", {
                "Event": "Gemini response",
                "Text": shortText
            });
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            Logger.info("AI", {
                "Event": "Fallback",
                "Reason": reason
            });
            const fallback = this.buildFallbackText(event, type, isStuckOnError);
            shortText = fallback.short;
            longText = fallback.long || fallback.short;
            Logger.info("AI", {
                "Event": "Fallback text",
                "Text": shortText
            });
        }

        this.lastShortText = shortText;

        const explanation: Explanation = {
            id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type,
            action: event.action,
            shortText,
            longText,
            confidence,
            timestamp: Date.now()
        };

        this.publisher.publish(explanation);

        Logger.info("AI EXPLANATION", {
            "Action": explanation.action,
            "Explanation": explanation.shortText,
            "Confidence": String(explanation.confidence),
            "Timestamp": new Date(explanation.timestamp).toISOString()
        });
    }

    private mapActionToType(action: BehaviourAction): ExplanationType {
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return ExplanationType.WHY_ERROR_HELP;

            case BehaviourAction.SHOW_HINT:
            case BehaviourAction.SHOW_WARNING:
            case BehaviourAction.SHOW_DOCUMENTATION:
                return ExplanationType.WHY_SUGGESTION;

            case BehaviourAction.SHOW_DEBUG_HELP:
                return ExplanationType.WHY_DEBUGGING;

            case BehaviourAction.SHOW_GIT_HELP:
                return ExplanationType.WHY_GIT_ACTION;

            case BehaviourAction.SHOW_EXTENSION_HELP:
                return ExplanationType.WHY_EXTENSION;

            case BehaviourAction.CELEBRATE:
                return ExplanationType.WHY_CELEBRATE;

            case BehaviourAction.NONE:
            case BehaviourAction.ASK_USER:
            default:
                return ExplanationType.WHY_NONE;
        }
    }

    private resolveConfidence(action: BehaviourAction, isStuckOnError: boolean): number {
        if (isStuckOnError) {return 0.99;}
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return 0.98;
            case BehaviourAction.SHOW_DEBUG_HELP:
                return 0.90;
            case BehaviourAction.SHOW_GIT_HELP:
                return 0.85;
            case BehaviourAction.SHOW_EXTENSION_HELP:
                return 0.80;
            case BehaviourAction.SHOW_HINT:
                return 0.75;
            case BehaviourAction.SHOW_WARNING:
                return 0.85;
            case BehaviourAction.SHOW_DOCUMENTATION:
                return 0.80;
            case BehaviourAction.CELEBRATE:
                return 0.95;
            default:
                return 0.70;
        }
    }

    private buildPrompt(event: BehaviourEvent, type: ExplanationType, isStuckOnError: boolean, isRepeat: boolean = false): string {
        const eventData = event.data as Record<string, unknown> | undefined;
        const language = String(eventData?.["language"] ?? this.context.language ?? "code");
        const file = String(eventData?.["file"] ?? this.context.file ?? "the current file");
        const message = String(eventData?.["message"] ?? this.context.message ?? "");
        const line = eventData?.["line"] ?? 0;
        const experience = this.context.experienceLevel || "beginner";

        const skillInstruction = this.context.skillProfile
            ? VocabularyAdapter.buildPromptModifier(this.context.skillProfile)
            : '';

        const prefix = skillInstruction
            ? `[Skill Instruction]\n${skillInstruction}\n\n`
            : '';

        if (isStuckOnError) {
            return prefix + [
                "You are Eilik, a small, highly expressive, enthusiastic, and empathetic desktop robot companion for beginner developers.",
                "",
                "You detect that the user is stuck on a coding error.",
                "Follow these rules STRICTLY:",
                "1. NEVER just repeat the raw error string. Do NOT say things like 'Syntax error, insert X' — always rephrase helpfully.",
                "2. Keep your response EXTREMELY CONCISE — maximum 1-2 small sentences. It must fit inside a tiny floating speech bubble.",
                "3. Use an encouraging, lighthearted, beginner-friendly tone.",
                "4. Always include a tiny hint about what went wrong and how to fix it.",
                "",
                "Context:",
                `- Language: ${language}`,
                `- File: ${file}`,
                `- Line: ${line}`,
                `- Error message: ${message}`,
                `- User experience: ${experience}`,
                "",
                ...(isRepeat ? [
                    "NOTE: The user is still stuck on the same issue. Do not repeat your previous advice. Provide an alternative technical approach or a deeper debugging insight.",
                    ""
                ] : []),
                "Respond with ONLY a JSON object with one field:",
                '{ "short": "1-2 sentence friendly tip for the speech bubble" }',
                "",
                "Example response:",
                '{ "short": "Uh oh! It looks like a tiny semicolon slipped away at the end of line 4! Let us pop it back in to fix this!" }'
            ].join("\n");
        }

        const skills = this.context.skillScores || {};
        const skillSummary = Object.entries(skills)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
        const recentActions = this.context.recentActions || [];
        const recentSummary = recentActions.slice(-5).join(", ");

        return prefix + [
            "You are Eilik, a friendly desktop robot coding companion.",
            "",
            "Generate a brief explanation for the following action.",
            `Action: ${event.action}`,
            `Explanation type: ${type}`,
            "",
            "User context:",
            `- Language: ${language}`,
            `- Current file: ${file}`,
            `- Error message: ${message}`,
            `- Experience level: ${experience}`,
            `- Skill scores: ${skillSummary}`,
            `- Recent actions: ${recentSummary}`,
            "",
            "Keep it concise (1-2 sentences) and encouraging.",
            "Respond in JSON format ONLY with one field:",
            '{ "short": "one-line friendly explanation" }'
        ].join("\n");
    }

    /**
     * Proactive logic review hook. Passes the active file's function context to
     * Gemini with a specialized prompt focused on logic errors, off-by-one bugs,
     * and unhandled edge cases (not syntax). Publishes the resulting Explanation
     * with an ALERT expression and falls back gracefully on any Gemini failure.
     */
    async proactiveLogicReview(request: LogicReviewRequest): Promise<Explanation> {
        Logger.info("AI", {
            "Event": "Proactive logic review",
            "File": request.fileName,
            "Function": request.functionName || "current function"
        });

        const prompt = this.buildLogicReviewPrompt(request);

        let shortText: string;
        let longText: string;
        try {
            const aiResult = await this.callGeminiWithRetry(prompt);
            shortText = aiResult.short;
            longText = aiResult.long || aiResult.short;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            Logger.info("AI", {
                "Event": "Logic review fallback",
                "Reason": reason
            });
            shortText = "If you are stuck, try tracing the values step-by-step or adding a couple of logs — the logic often hides in the details.";
            longText = shortText;
        }

        this.lastShortText = shortText;

        const explanation: Explanation = {
            id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: ExplanationType.WHY_LOGIC_REVIEW,
            action: BehaviourAction.SHOW_HINT,
            shortText,
            longText,
            confidence: 0.85,
            timestamp: Date.now(),
            expression: "ALERT"
        };

        this.publisher.publish(explanation);

        Logger.info("AI EXPLANATION", {
            "Action": explanation.action,
            "Explanation": explanation.shortText.slice(0, 80),
            "Expression": "ALERT",
            "Confidence": String(explanation.confidence)
        });

        return explanation;
    }

    private buildLogicReviewPrompt(request: LogicReviewRequest): string {
        const prefix = this.context.skillProfile
            ? `[Skill Instruction]\n${VocabularyAdapter.buildPromptModifier(this.context.skillProfile)}\n\n`
            : '';

        const code = request.functionCode || request.fileContent || "(function context unavailable)";
        const language = request.language || "code";
        const fileName = request.fileName || "the current file";
        const functionName = request.functionName || "current function";

        return prefix + [
            "You are Eilik, a small, highly expressive, and empathetic desktop robot companion for developers.",
            "",
            "The developer appears STUCK on a LOGIC bug — the code compiles and runs, but behaves incorrectly.",
            "Analyze the function below for LOGIC errors ONLY. Do NOT look for syntax problems.",
            "Focus on:",
            "1. Off-by-one errors in loops, indices, and slice/boundary math.",
            "2. Unhandled edge cases (empty input, null/undefined, negative values, min/max boundaries).",
            "3. Inverted conditions, wrong comparisons, or swapped operands.",
            "4. Unintended early returns, mutation/alias bugs, or incorrect state updates.",
            "",
            "Context:",
            `- Language: ${language}`,
            `- File: ${fileName}`,
            `- Function: ${functionName}`,
            "",
            "Function code:",
            "```",
            code,
            "```",
            "",
            "Respond with ONLY a JSON object:",
            '{ "short": "1-2 sentence friendly hint for a tiny speech bubble", "long": "a short, concrete logic analysis with a specific suggestion" }',
            "",
            "Rules:",
            "- 'short' must be EXTREMELY concise and encouraging — it fits in a tiny floating speech bubble.",
            "- Point out the most likely logic culprit and how to confirm it (e.g. a specific print/log to add).",
            "- Do not mention syntax at all."
        ].join("\n");
    }

    private async callGeminiWithRetry(prompt: string): Promise<{ short: string; long: string }> {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                return await this.callGemini(prompt);
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < MAX_RETRIES - 1) {
                    const delayMs = Math.pow(2, attempt) * 1000;
                    Logger.info("AI", {
                        "Event": "Retry",
                        "Attempt": String(attempt + 1),
                        "DelayMs": String(delayMs),
                        "Reason": lastError.message
                    });
                    await this.delay(delayMs);
                }
            }
        }
        throw lastError ?? new Error("Gemini API failed after retries");
    }

    private async callGemini(prompt: string): Promise<{ short: string; long: string }> {
        let apiKey = process.env[GEMINI_API_KEY_ENV];
        if (!apiKey && this.apiKeyRetriever) {
            apiKey = await this.apiKeyRetriever();
        }

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
                        temperature: 0.5,
                        maxOutputTokens: 100
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
            throw new Error(`Gemini API error: ${response.status}`);
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

        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { short?: string; long?: string };

        return {
            short: parsed.short || "Explanation available.",
            long: parsed.long || parsed.short || "Explanation available."
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private buildFallbackText(
        event: BehaviourEvent,
        type: ExplanationType,
        isStuckOnError: boolean
    ): { short: string; long: string } {
        const eventData = event.data as Record<string, unknown> | undefined;
        const language = String(eventData?.["language"] ?? this.context.language ?? "your code");
        const file = String(eventData?.["file"] ?? this.context.file ?? "the current file");
        const message = String(eventData?.["message"] ?? this.context.message ?? "");
        const line = eventData?.["line"] ?? 0;

        if (isStuckOnError) {
            const fileShort = file.split("\\").pop()?.split("/").pop() || file;
            if (message.toLowerCase().includes("semicolon") || message.toLowerCase().includes("';'")) {
                return {
                    short: `Uh oh! A tiny semicolon went missing at line ${line} in ${fileShort}! Pop it back in at the end of the line and we are golden!`,
                    long: `Missing semicolon at line ${line} in ${fileShort}. Add ';' at the end of the statement to fix the syntax error.`
                };
            }
            if (message.toLowerCase().includes("brace") || message.toLowerCase().includes("}")) {
                return {
                    short: `Looks like we need a closing curly brace '}' at line ${line} in ${fileShort} to finish off your code block!`,
                    long: `Missing closing brace in ${fileShort} at line ${line}. Add '}' to close the current block.`
                };
            }
            if (message.toLowerCase().includes("parenthesis") || message.toLowerCase().includes(")")) {
                return {
                    short: `A closing parenthesis ')' seems to have wandered off near line ${line} in ${fileShort}! Let us tuck it back in!`,
                    long: `Missing closing parenthesis near line ${line} in ${fileShort}. Add ')' to close the expression.`
                };
            }
            return {
                short: `Hmm, something is off at line ${line} in ${fileShort}! ${message}. Take a peek and see what might be missing — you have got this!`,
                long: `Syntax issue in ${fileShort} at line ${line}: ${message}. Check the line for missing punctuation or structure.`
            };
        }

        switch (type) {
            case ExplanationType.WHY_ERROR_HELP: {
                const detail = message ? `: ${message}` : " detected in your code";
                return {
                    short: `I can help fix the error${detail}.`,
                    long: `There's an error in ${file}${detail}. I can walk you through the fix or suggest a correction.`
                };
            }

            case ExplanationType.WHY_SUGGESTION: {
                return {
                    short: `Here's a suggestion to improve your ${language} code.`,
                    long: `Based on your current context in ${file}, I have a suggestion that can improve code quality or prevent potential issues in ${language}.`
                };
            }

            case ExplanationType.WHY_DEBUGGING: {
                return {
                    short: "I can assist with your debug session.",
                    long: "You're currently debugging. I can help inspect variables, evaluate expressions, or suggest breakpoint locations."
                };
            }

            case ExplanationType.WHY_GIT_ACTION: {
                return {
                    short: "I can help with your Git workflow.",
                    long: "I notice Git activity in your workspace. I can suggest commits, review changes, or help with branch management."
                };
            }

            case ExplanationType.WHY_EXTENSION: {
                return {
                    short: "I can suggest useful extensions.",
                    long: "Based on your current activity, there are extensions that could enhance your workflow in this project."
                };
            }

            case ExplanationType.WHY_CELEBRATE: {
                return {
                    short: "Great work! You achieved something notable.",
                    long: "I noticed a positive milestone in your workflow. Keep up the great progress!"
                };
            }

            default: {
                return {
                    short: "I'm monitoring your workspace.",
                    long: "Aether is observing your development activity and will provide assistance when relevant."
                };
            }
        }
    }
}

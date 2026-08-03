// robot-brain/src/ai/gemini.ts
import { Logger } from "../utils/logger";

export type ExpressionType = "IDLE" | "THINKING" | "HAPPY" | "CONFUSED" | "HELPFUL" | "ALERT";

export interface MultiErrorAnalysisResult {
  summary: string;
  expression: ExpressionType;
  fixes: {
    line: number;
    description: string;
    suggestedCode: string;
  }[];
}

export interface DiagnosticEntry {
  line: number;
  column: number;
  message: string;
  severity: string;
  code?: string;
}

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 2048;

const VALID_EXPRESSIONS: readonly ExpressionType[] = [
  "IDLE", "THINKING", "HAPPY", "CONFUSED", "HELPFUL", "ALERT"
];

export class GeminiAgentEngine {
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(apiKey: string, options?: { model?: string; timeoutMs?: number }) {
    this.apiKey = apiKey;
    this.model = options?.model ?? GEMINI_MODEL;
    this.timeoutMs = options?.timeoutMs ?? GEMINI_TIMEOUT_MS;
  }

  public async analyzeMultipleErrors(
    fileName: string,
    fileContent: string,
    errors: DiagnosticEntry[]
  ): Promise<MultiErrorAnalysisResult> {
    if (!this.apiKey) {
      throw new Error("Gemini API key not found");
    }

    const prompt = this.buildPrompt(fileName, fileContent, errors);

    try {
      const data = await this.callGemini(prompt);
      const result = this.normalizeResult(data);
      Logger.info("AI", {
        "Event": "Gemini multi-error analysis complete",
        "File": fileName,
        "Errors": String(errors.length),
        "Fixes": String(result.fixes.length),
        "Expression": result.expression
      });
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      Logger.info("AI", {
        "Event": "Gemini multi-error analysis failed",
        "File": fileName,
        "Reason": reason
      });
      return {
        summary: "I found some issues in your file but hit a snag analyzing them. Check the diagnostics panel for details.",
        expression: "CONFUSED",
        fixes: []
      };
    }
  }

  private buildPrompt(fileName: string, fileContent: string, errors: DiagnosticEntry[]): string {
    const errorLines = errors
      .map((e, idx) => `${idx + 1}. Line ${e.line} (col ${e.column}): [${e.severity}] ${e.message}`)
      .join("\n");

    return `
You are BotX, a helpful paired-programming AI assistant inside a small desktop robot.
Analyze EVERY diagnostic listed below for the file ${fileName} in a single pass — do not only focus on the first one.

File: ${fileName}

File Context:
\`\`\`
${fileContent || "(file content unavailable)"}
\`\`\`

All Diagnostics Found (${errors.length}):
${errorLines}

Respond ONLY with valid JSON in the following format:
{
  "summary": "Short 1-2 sentence overview of what went wrong across all diagnostics.",
  "expression": "IDLE" | "THINKING" | "HAPPY" | "CONFUSED" | "HELPFUL" | "ALERT",
  "fixes": [
    {
      "line": <line_number>,
      "description": "Short explanation of the fix",
      "suggestedCode": "Exact correct code replacement for that block"
    }
  ]
}

Rules:
- "summary" must be 1-2 sentences, friendly and beginner-focused.
- Provide one "fixes" entry per distinct diagnostic where a fix is possible. Keep "suggestedCode" as a precise replacement snippet.
- "expression" should reflect the overall state: "HAPPY" if issues are trivial/fixed, "CONFUSED" if unclear, "HELPFUL" for straightforward fixes, "ALERT" for serious problems.
`;
  }

  private async callGemini(prompt: string): Promise<Record<string, unknown>> {
    const url = `${GEMINI_API_URL}/${this.model}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
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

  private normalizeResult(data: Record<string, unknown>): MultiErrorAnalysisResult {
    const fixes = Array.isArray(data["fixes"]) ? data["fixes"] : [];
    const normalizedFixes = fixes
      .map((fix) => {
        const record = fix as Record<string, unknown>;
        return {
          line: Number(record["line"] ?? 0) || 0,
          description: String(record["description"] ?? ""),
          suggestedCode: String(record["suggestedCode"] ?? "")
        };
      })
      .filter((fix) => fix.line > 0 && (fix.description || fix.suggestedCode));

    return {
      summary: String(data["summary"] ?? "I found some issues worth fixing.").slice(0, 500),
      expression: this.toValidExpression(data["expression"]),
      fixes: normalizedFixes
    };
  }

  private toValidExpression(value: unknown): ExpressionType {
    if (typeof value === "string" && (VALID_EXPRESSIONS as readonly string[]).includes(value)) {
      return value as ExpressionType;
    }
    return "CONFUSED";
  }
}

import { classifyCodexFailure } from "./failure-classifier.js";
import { pruneCodexChildEnv } from "./codex-cli-domain.js";
import { composeCodexPrompt } from "./codex-prompt-composer.js";
const defaultTimeoutMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 512 * 1024;
export class PackagedCodexJsonExecutionEngine {
    options;
    kind = "packaged-json";
    capabilities = {
        supportsStructuredOutput: true,
        supportsJsonEvents: true,
        supportsThreadResume: false,
        requiresSchemaFile: false,
    };
    constructor(options) {
        this.options = options;
        if (!options.codexBinaryPath.trim()) {
            throw new Error("codex_packaged_binary_required");
        }
    }
    async run(input) {
        const args = buildCodexJsonExecArgs({
            jsonFlag: this.options.jsonFlag ?? "--json",
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            ...(input.sandboxMode === undefined
                ? {}
                : { sandboxMode: input.sandboxMode }),
        });
        const result = await input.runner.run({
            command: this.options.codexBinaryPath,
            args,
            cwd: input.workspacePath,
            env: {
                ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
                ...input.session.env,
                CI: "true",
            },
            stdin: new TextEncoder().encode(composeCodexPrompt({
                prompt: input.prompt,
                systemPrompt: input.systemPrompt,
            })),
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            abortSignal: input.abortSignal,
        });
        const stdout = input.redactor.redact(result.stdout);
        const stderr = input.redactor.redact(result.stderr);
        input.redactor.assertNoKnownSecret(stdout, "codex-json-stdout");
        input.redactor.assertNoKnownSecret(stderr, "codex-json-stderr");
        assertOutputWithinBounds(stdout, this.options.maxOutputBytes);
        assertOutputWithinBounds(stderr, this.options.maxOutputBytes);
        if (result.exitCode !== 0) {
            throw new Error(`codex_json_exec_failed:${result.exitCode}:${safeTail(`${stdout}\n${stderr}`)}`);
        }
        const outputText = extractFinalAssistantText(stdout);
        if (input.outputSchema) {
            return {
                outputText,
                structuredOutput: parseStructuredOutput(outputText),
                warnings: [],
            };
        }
        return {
            outputText,
            warnings: [],
        };
    }
    async prewarm() {
        return {
            kind: this.kind,
            reusable: false,
            warmedAt: new Date(),
            warnings: [
                {
                    code: "codex_packaged_exec_prewarm_skipped",
                    safeMessage: "Packaged Codex exec starts a fresh process for every task.",
                },
            ],
        };
    }
}
export function buildCodexJsonExecArgs(input) {
    return [
        "exec",
        input.jsonFlag,
        "--model",
        input.model,
        "--sandbox",
        input.sandboxMode ?? "read-only",
        "--config",
        'approval_policy="never"',
        "--config",
        `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
        "--config",
        'model_verbosity="low"',
        "--config",
        'web_search="disabled"',
        "--config",
        "features.apps=false",
        "--config",
        "features.hooks=false",
        "--config",
        "features.memories=false",
        "--config",
        "features.multi_agent=false",
        "--config",
        "features.shell_snapshot=false",
        "--config",
        "features.skill_mcp_dependency_install=false",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--color",
        "never",
        "--skip-git-repo-check",
        "-",
    ];
}
export function codexSandboxModeForPermissionMode(mode) {
    if (mode === "allow-edits")
        return "workspace-write";
    return "read-only";
}
export function codexExecutionFailure(error) {
    return {
        status: "failed",
        failure: classifyCodexFailure(error),
        warnings: [],
    };
}
function extractFinalAssistantText(stdout) {
    let finalText = null;
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let event;
        try {
            event = JSON.parse(trimmed);
        }
        catch (error) {
            if (looksLikeJsonLine(trimmed)) {
                throw new Error("codex_json_event_invalid", { cause: error });
            }
            continue;
        }
        const text = extractTextFromEvent(event);
        if (text) {
            finalText = text;
        }
    }
    if (!finalText) {
        throw new Error("codex_json_final_message_missing");
    }
    return finalText;
}
function looksLikeJsonLine(value) {
    return value.startsWith("{") || value.startsWith("[");
}
function extractTextFromEvent(event) {
    if (!event || typeof event !== "object")
        return null;
    const record = event;
    for (const key of [
        "message",
        "text",
        "output_text",
        "last_message",
        "content",
    ]) {
        const value = record[key];
        const text = stringifyContent(value);
        if (text)
            return text;
    }
    for (const key of ["data", "item", "delta", "response"]) {
        const nested = extractTextFromEvent(record[key]);
        if (nested)
            return nested;
    }
    return null;
}
function stringifyContent(value) {
    if (typeof value === "string" && value.trim())
        return value;
    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => {
            if (typeof entry === "string")
                return entry;
            if (entry && typeof entry === "object") {
                const record = entry;
                return stringifyContent(record.text ?? record.content);
            }
            return null;
        })
            .filter((entry) => typeof entry === "string");
        return parts.length > 0 ? parts.join("") : null;
    }
    return null;
}
function parseStructuredOutput(outputText) {
    try {
        return JSON.parse(outputText);
    }
    catch (error) {
        throw new Error("codex_structured_output_invalid", { cause: error });
    }
}
function assertOutputWithinBounds(output, maxOutputBytes = defaultMaxOutputBytes) {
    if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
        throw new Error("codex_json_output_too_large");
    }
}
function safeTail(value) {
    return value.slice(-4096);
}
//# sourceMappingURL=codex-json-execution-engine.js.map
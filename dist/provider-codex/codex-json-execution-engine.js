import { classifyCodexFailure } from "./failure-classifier.js";
import { pruneCodexChildEnv } from "./codex-cli-domain.js";
import { composeCodexPrompt } from "./codex-prompt-composer.js";
import { parseCodexStructuredOutput } from "./structured-output.js";
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
            ...(input.serviceTier === undefined
                ? {}
                : { serviceTier: input.serviceTier }),
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
        ...(input.serviceTier
            ? [
                "--config",
                `service_tier=${JSON.stringify(input.serviceTier)}`,
                ...(input.serviceTier === "fast"
                    ? ["--config", "features.fast_mode=true"]
                    : []),
            ]
            : []),
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
    const type = typeof record.type === "string" ? record.type : null;
    if (!hasAssistantRole(record))
        return null;
    if (type === "response.completed") {
        const response = record.response;
        return response && typeof response === "object"
            ? extractTextFromRecord(response)
            : null;
    }
    if (type && !isAssistantTextEventType(type))
        return null;
    return extractTextFromRecord(record);
}
function isAssistantTextEventType(type) {
    return (type === "agent_message" ||
        type === "assistant_message" ||
        type === "message" ||
        type === "result");
}
function extractTextFromRecord(record) {
    for (const key of [
        "message",
        "text",
        "output_text",
        "last_message",
        "content",
        "output",
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
            .map((entry) => stringifyContentEntry(entry))
            .filter((entry) => typeof entry === "string");
        return parts.length > 0 ? parts.join("") : null;
    }
    if (value && typeof value === "object") {
        const record = value;
        if (!isAssistantContentRecord(record))
            return null;
        return stringifyContent(record.text ?? record.output_text ?? record.content ?? record.output);
    }
    return null;
}
function stringifyContentEntry(entry) {
    if (typeof entry === "string")
        return entry;
    if (!entry || typeof entry !== "object")
        return null;
    const record = entry;
    if (!isAssistantContentRecord(record))
        return null;
    return stringifyContent(record.text ?? record.output_text ?? record.content ?? record.output);
}
function isAssistantContentRecord(record) {
    const type = typeof record.type === "string" ? record.type : null;
    if (!hasAssistantRole(record))
        return false;
    return (!type ||
        type === "agentMessage" ||
        type === "agent_message" ||
        type === "assistant_message" ||
        type === "message" ||
        type === "output_text" ||
        type === "text");
}
function hasAssistantRole(record) {
    const role = record.role;
    return typeof role !== "string" || role === "assistant";
}
function parseStructuredOutput(outputText) {
    return parseCodexStructuredOutput(outputText, "codex_structured_output_invalid");
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
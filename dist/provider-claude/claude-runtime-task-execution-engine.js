import { randomUUID } from "node:crypto";
import { diagnosticWarning, isAssistantMessageEvent, isDiagnosticEvent, isResultAvailableEvent, isToolResultEvent, isToolUseEvent, isUsageEvent, parseStructuredJson, resultText, runtimeUsage, toolResultCall, toolUseCall, } from "./claude-runtime-event-mapper.js";
import { createClaudeBgRuntimeContext, } from "./claude-bg-runtime-context.js";
export class ClaudeRuntimeTaskExecutionEngine {
    options;
    kind = "claude-runtime-bg";
    capabilities = {
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsUsage: true,
        supportsProviderRunId: true,
        supportsCleanup: true,
    };
    constructor(options = {}) {
        this.options = options;
    }
    async run(input) {
        let completed;
        for await (const event of this.stream(input)) {
            if (event.type === "completed")
                completed = event;
        }
        if (!completed)
            throw new Error("claude_runtime_result_missing");
        if (completed.result.status === "failed") {
            throw new Error(completed.result.failure.safeMessage);
        }
        return {
            outputText: completed.result.outputText,
            ...(completed.result.structuredOutput === undefined
                ? {}
                : { structuredOutput: completed.result.structuredOutput }),
            ...(completed.result.telemetry === undefined
                ? {}
                : { telemetry: completed.result.telemetry }),
            warnings: completed.result.warnings,
        };
    }
    async *stream(input) {
        const { runtime, provider } = await createClaudeBgRuntimeContext({
            configDir: input.session.configDir,
            oauthToken: input.session.oauthToken,
        }, this.options);
        const requestedAt = runtime.asIsoTimestamp(new Date().toISOString());
        const threadId = runtime.asThreadId(input.runtimeThread?.threadId ?? `subscription-runtime-${randomUUID()}`);
        const command = this.buildCommand(input, runtime, requestedAt, threadId);
        const handle = input.runtimeThread?.resumeSessionId === undefined
            ? await provider.start({
                command,
                providerId: provider.id,
                requestedAt,
                threadId,
            })
            : await sendFollowup({
                command,
                cwd: input.workspacePath,
                provider,
                requestedAt,
                resumeSessionId: input.runtimeThread.resumeSessionId,
                threadId,
            });
        const textParts = [];
        const warnings = [];
        let telemetry = {
            providerRunId: handle.runId,
            ...(handle.providerSessionId === undefined
                ? {}
                : { providerSessionId: handle.providerSessionId }),
        };
        yield {
            type: "started",
            occurredAt: new Date(),
            telemetry,
        };
        try {
            for await (const event of provider.observe(handle, {
                abortSignal: input.abortSignal,
                ...(this.options.pollIntervalMs === undefined
                    ? {}
                    : { pollIntervalMs: this.options.pollIntervalMs }),
            })) {
                if (isAssistantMessageEvent(event)) {
                    const text = input.redactor.redact(event.text);
                    textParts.push(text);
                    yield {
                        type: "text_delta",
                        occurredAt: new Date(),
                        text,
                        telemetry,
                    };
                }
                if (isToolUseEvent(event)) {
                    yield {
                        type: "tool_call",
                        occurredAt: new Date(),
                        toolCall: toolUseCall(event, input.redactor),
                        telemetry,
                    };
                }
                if (isToolResultEvent(event)) {
                    yield {
                        type: "tool_call",
                        occurredAt: new Date(),
                        toolCall: toolResultCall(event, input.redactor),
                        telemetry,
                    };
                }
                if (isUsageEvent(event)) {
                    const usage = runtimeUsage(event.usage);
                    telemetry = { ...telemetry, usage };
                    yield {
                        type: "usage",
                        occurredAt: new Date(),
                        usage,
                        telemetry,
                    };
                }
                if (isDiagnosticEvent(event)) {
                    const warning = diagnosticWarning(event, input.redactor);
                    warnings.push(warning);
                    yield {
                        type: "warning",
                        occurredAt: new Date(),
                        warning,
                        telemetry,
                    };
                }
                if (isResultAvailableEvent(event)) {
                    const text = input.redactor.redact(resultText(event.result));
                    if (text.length > 0 && !hasEquivalentTextPart(textParts, text)) {
                        textParts.push(text);
                        yield {
                            type: "text_delta",
                            occurredAt: new Date(),
                            text,
                            telemetry,
                        };
                    }
                    telemetry = {
                        ...telemetry,
                        ...(event.result.usage === undefined
                            ? {}
                            : { usage: runtimeUsage(event.result.usage) }),
                    };
                }
            }
        }
        finally {
            await provider.remove(handle).catch(() => undefined);
        }
        const outputText = input.redactor.redact(textParts.join("\n"));
        yield {
            type: "completed",
            occurredAt: new Date(),
            result: {
                status: "completed",
                outputText,
                ...(input.outputSchemaName === undefined
                    ? {}
                    : { structuredOutput: parseStructuredJson(outputText) }),
                telemetry,
                warnings,
            },
            telemetry,
        };
    }
    buildCommand(input, runtime, requestedAt, threadId) {
        assertReadOnlyToolPolicy(input.permissionMode, input.allowedTools);
        return {
            ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
            ...(input.appendSystemPrompt === undefined
                ? {}
                : { appendSystemPrompt: input.appendSystemPrompt }),
            createdAt: requestedAt,
            cwd: input.workspacePath,
            id: runtime.asCommandId(`subscription-runtime-${randomUUID()}`),
            ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
            ...(input.mcpConfig === undefined ? {} : { mcpConfig: input.mcpConfig }),
            mode: input.runtimeThread?.resumeSessionId === undefined
                ? "initial"
                : "followup",
            model: input.model,
            permissionMode: mapPermissionMode(input.permissionMode),
            ...(this.options.pluginDirs === undefined ? {} : { pluginDirs: this.options.pluginDirs }),
            prompt: input.prompt,
            ...(this.options.settingsPath === undefined
                ? {}
                : { settings: this.options.settingsPath }),
            ...(input.strictMcpConfig === undefined
                ? {}
                : { strictMcpConfig: input.strictMcpConfig }),
            threadId,
        };
    }
}
function mapPermissionMode(mode) {
    if (mode === "allow-edits")
        return "acceptEdits";
    if (mode === "bypass")
        return "bypassPermissions";
    if (mode === "read-only" || mode === "preapproved")
        return "dontAsk";
    return "default";
}
function assertReadOnlyToolPolicy(permissionMode, allowedTools) {
    if (permissionMode !== "read-only" || allowedTools === undefined)
        return;
    const unsafe = allowedTools.filter((tool) => !isReadOnlyClaudeTool(tool));
    if (unsafe.length === 0)
        return;
    throw new Error(`claude_read_only_allowed_tools_unsafe:${unsafe.join(",")}`);
}
const readOnlyClaudeTools = new Set([
    "Glob",
    "Grep",
    "LS",
    "Read",
    "TodoRead",
    "WebFetch",
]);
function isReadOnlyClaudeTool(tool) {
    const name = tool.split("(", 1)[0]?.trim();
    return name !== undefined && readOnlyClaudeTools.has(name);
}
function hasEquivalentTextPart(parts, text) {
    const normalized = text.trim();
    if (normalized.length === 0)
        return false;
    return parts.some((part) => part.trim() === normalized);
}
async function sendFollowup(input) {
    if (!input.provider.send) {
        throw new Error("claude_runtime_provider_send_required");
    }
    return input.provider.send({
        command: input.command,
        previousProviderSessionId: input.resumeSessionId,
        requestedAt: input.requestedAt,
        thread: {
            id: input.threadId,
            status: "done",
            createdAt: input.requestedAt,
            updatedAt: input.requestedAt,
            cwd: input.cwd,
            providerId: input.provider.id,
            latestProviderSessionId: input.resumeSessionId,
        },
    });
}
//# sourceMappingURL=claude-runtime-task-execution-engine.js.map
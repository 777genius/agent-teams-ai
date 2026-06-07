import { claudeBgTaskAgentCapabilities, claudeBgTaskAgentId, claudeProviderId, } from "./capabilities.js";
import { validateClaudeSessionArtifact, } from "./claude-session-codec.js";
import { classifyClaudeFailure } from "./failure-classifier.js";
import { registerClaudeSecrets } from "./claude-session-driver.js";
export class ClaudeTaskAgentDriver {
    options;
    agentId = claudeBgTaskAgentId;
    providerId = claudeProviderId;
    capabilities = claudeBgTaskAgentCapabilities;
    model;
    constructor(options) {
        this.options = options;
        this.model = options.model ?? "sonnet";
    }
    async runTask(input) {
        const startedAt = Date.now();
        if (!input.session) {
            return failedClaudeTask({
                code: "provider_session_invalid",
                retryable: false,
                reconnectRequired: true,
                safeMessage: "Claude requires a session artifact.",
                causeCategory: "provider_session_invalid",
            }, startedAt);
        }
        try {
            const prepared = this.prepareEngineInput(input.session, input);
            const result = await this.options.engine.run(prepared.engineInput);
            return redactProviderTaskResult({
                status: "completed",
                outputText: result.outputText,
                ...(result.structuredOutput === undefined
                    ? {}
                    : { structuredOutput: result.structuredOutput }),
                telemetry: {
                    durationMs: Date.now() - startedAt,
                    finishReason: "completed",
                    ...result.telemetry,
                },
                warnings: [...prepared.warnings, ...result.warnings],
            }, input.redactor);
        }
        catch (error) {
            return failedClaudeTask(classifyClaudeFailure(error), startedAt);
        }
    }
    async *streamTask(input) {
        const startedAt = Date.now();
        if (!input.session) {
            yield {
                type: "completed",
                occurredAt: new Date(),
                result: failedClaudeTask({
                    code: "provider_session_invalid",
                    retryable: false,
                    reconnectRequired: true,
                    safeMessage: "Claude requires a session artifact.",
                    causeCategory: "provider_session_invalid",
                }, startedAt),
            };
            return;
        }
        if (!this.options.engine.stream) {
            yield {
                type: "started",
                occurredAt: new Date(),
            };
            const result = await this.runTask(input);
            yield {
                type: "completed",
                occurredAt: new Date(),
                result,
                ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
            };
            return;
        }
        try {
            const prepared = this.prepareEngineInput(input.session, input);
            for (const warning of prepared.warnings) {
                yield {
                    type: "warning",
                    occurredAt: new Date(),
                    warning: redactRuntimeWarning(warning, input.redactor),
                };
            }
            for await (const event of this.options.engine.stream(prepared.engineInput)) {
                yield redactProviderTaskEvent(event, input.redactor);
            }
        }
        catch (error) {
            const result = redactProviderTaskResult(failedClaudeTask(classifyClaudeFailure(error), startedAt), input.redactor);
            yield {
                type: "completed",
                occurredAt: new Date(),
                result,
                ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
            };
        }
    }
    classifyRunFailure(error) {
        return classifyClaudeFailure(error);
    }
    async dispose() {
        await this.options.engine.dispose?.();
    }
    prepareEngineInput(session, input) {
        const validation = validateClaudeSessionArtifact(session);
        registerClaudeSecrets(input.redactor, validation.session.oauthToken);
        let engineInput = {
            prompt: input.task.prompt,
            session: validation.session,
            workspacePath: input.workspace.path,
            runner: input.runner,
            redactor: input.redactor,
            model: input.task.controls?.model ?? this.model,
            abortSignal: input.abortSignal,
        };
        const maxTurns = input.task.controls?.maxTurns ?? this.options.maxTurns;
        const allowedTools = input.task.controls?.allowedTools ?? this.options.allowedTools;
        const permissionMode = input.task.controls?.permissionMode;
        const outputSchemaName = input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
        if (this.options.appendSystemPrompt !== undefined) {
            engineInput = {
                ...engineInput,
                appendSystemPrompt: this.options.appendSystemPrompt,
            };
        }
        if (maxTurns !== undefined) {
            engineInput = { ...engineInput, maxTurns };
        }
        if (allowedTools !== undefined) {
            engineInput = { ...engineInput, allowedTools };
        }
        if (this.options.mcpConfig !== undefined) {
            engineInput = { ...engineInput, mcpConfig: this.options.mcpConfig };
        }
        if (permissionMode !== undefined) {
            engineInput = { ...engineInput, permissionMode };
        }
        if (this.options.strictMcpConfig !== undefined) {
            engineInput = {
                ...engineInput,
                strictMcpConfig: this.options.strictMcpConfig,
            };
        }
        if (outputSchemaName !== undefined) {
            engineInput = { ...engineInput, outputSchemaName };
        }
        return {
            engineInput,
            warnings: validation.warnings,
        };
    }
}
function failedClaudeTask(failure, startedAt) {
    return {
        status: "failed",
        failure,
        telemetry: {
            durationMs: Date.now() - startedAt,
            finishReason: finishReasonForFailure(failure.code),
        },
        warnings: [],
    };
}
function redactProviderTaskEvent(event, redactor) {
    if (event.type === "text_delta") {
        const text = redactor.redact(event.text);
        redactor.assertNoKnownSecret(text, "claude stream text delta");
        return {
            ...event,
            text,
            ...(event.telemetry === undefined
                ? {}
                : { telemetry: redactTelemetry(event.telemetry, redactor) }),
        };
    }
    if (event.type === "tool_call") {
        return {
            ...event,
            toolCall: redactToolCall(event.toolCall, redactor),
            ...(event.telemetry === undefined
                ? {}
                : { telemetry: redactTelemetry(event.telemetry, redactor) }),
        };
    }
    if (event.type === "warning") {
        return {
            ...event,
            warning: redactRuntimeWarning(event.warning, redactor),
            ...(event.telemetry === undefined
                ? {}
                : { telemetry: redactTelemetry(event.telemetry, redactor) }),
        };
    }
    if (event.type === "completed") {
        return {
            ...event,
            result: redactProviderTaskResult(event.result, redactor),
            ...(event.telemetry === undefined
                ? {}
                : { telemetry: redactTelemetry(event.telemetry, redactor) }),
        };
    }
    if (event.telemetry === undefined)
        return event;
    return {
        ...event,
        telemetry: redactTelemetry(event.telemetry, redactor),
    };
}
function redactProviderTaskResult(result, redactor) {
    if (result.status === "failed") {
        return {
            ...result,
            failure: {
                ...result.failure,
                safeMessage: redactor.redact(result.failure.safeMessage),
            },
            ...(result.telemetry === undefined
                ? {}
                : { telemetry: redactTelemetry(result.telemetry, redactor) }),
            warnings: result.warnings.map((warning) => redactRuntimeWarning(warning, redactor)),
        };
    }
    const outputText = redactor.redact(result.outputText);
    redactor.assertNoKnownSecret(outputText, "claude task output");
    const structuredOutput = result.structuredOutput === undefined
        ? undefined
        : redactStructured(result.structuredOutput, redactor);
    if (structuredOutput !== undefined) {
        redactor.assertNoKnownSecret(JSON.stringify(structuredOutput), "claude structured task output");
    }
    return {
        ...result,
        outputText,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        ...(result.telemetry === undefined
            ? {}
            : { telemetry: redactTelemetry(result.telemetry, redactor) }),
        warnings: result.warnings.map((warning) => redactRuntimeWarning(warning, redactor)),
    };
}
function redactTelemetry(telemetry, redactor) {
    return {
        ...telemetry,
        ...(telemetry.toolCalls === undefined
            ? {}
            : {
                toolCalls: telemetry.toolCalls.map((toolCall) => redactToolCall(toolCall, redactor)),
            }),
    };
}
function redactToolCall(toolCall, redactor) {
    const safeInput = toolCall.safeInput === undefined
        ? undefined
        : redactStructured(toolCall.safeInput, redactor);
    if (safeInput !== undefined) {
        redactor.assertNoKnownSecret(JSON.stringify(safeInput), "claude tool call safe input");
    }
    return {
        ...toolCall,
        ...(safeInput === undefined || !isRecord(safeInput) ? {} : { safeInput }),
        ...(toolCall.safeInputPreview === undefined
            ? {}
            : { safeInputPreview: redactor.redact(toolCall.safeInputPreview) }),
    };
}
function redactRuntimeWarning(warning, redactor) {
    return {
        ...warning,
        safeMessage: redactor.redact(warning.safeMessage),
        ...(warning.details === undefined
            ? {}
            : {
                details: Object.fromEntries(Object.entries(warning.details).map(([key, value]) => [
                    key,
                    redactor.redact(value),
                ])),
            }),
    };
}
function redactStructured(value, redactor) {
    if (typeof value === "string")
        return redactor.redact(value);
    if (Array.isArray(value)) {
        return value.map((item) => redactStructured(item, redactor));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            redactStructured(item, redactor),
        ]));
    }
    return value;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finishReasonForFailure(code) {
    if (code === "task_cancelled")
        return "cancelled";
    if (code === "task_timeout")
        return "timeout";
    return "provider_error";
}
//# sourceMappingURL=claude-task-agent-driver.js.map
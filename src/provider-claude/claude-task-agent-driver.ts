import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type AgentToolCall,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskEvent,
  type ProviderTaskControls,
  type ProviderTaskResult,
  type ProviderTaskTelemetry,
  type RedactorPort,
  type RuntimeWarning,
  type RunnerPort,
  type SessionArtifact,
  type StreamingAgentDriver,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  claudeBgTaskAgentCapabilities,
  claudeBgTaskAgentId,
  claudeProviderId,
} from "./capabilities";
import {
  type ClaudeOAuthSession,
  validateClaudeSessionArtifact,
} from "./claude-session-codec";
import { classifyClaudeFailure } from "./failure-classifier";
import { registerClaudeSecrets } from "./claude-session-driver";

export type ClaudeTaskExecutionResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly warnings: ProviderTaskResult["warnings"];
};

export const claudeRuntimeThreadIdMetadataKey = "claudeRuntimeThreadId";
export const claudeRuntimeResumeSessionIdMetadataKey =
  "claudeRuntimeResumeSessionId";

export type ClaudeRuntimeThreadInput = {
  readonly threadId: string;
  readonly resumeSessionId?: string;
};

export type ClaudeTaskEngineInput = {
  readonly prompt: string;
  readonly session: ClaudeOAuthSession;
  readonly workspacePath: string;
  readonly appendSystemPrompt?: string;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly model: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
  readonly strictMcpConfig?: boolean;
  readonly outputSchemaName?: string;
  readonly runtimeThread?: ClaudeRuntimeThreadInput;
  readonly abortSignal: AbortSignal;
};

export type ClaudeTaskExecutionEngine = {
  readonly kind: string;
  readonly capabilities: {
    readonly supportsStreaming: boolean;
    readonly supportsToolCalls: boolean;
    readonly supportsUsage: boolean;
    readonly supportsProviderRunId: boolean;
    readonly supportsCleanup: boolean;
  };
  run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult>;
  stream?(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent>;
  dispose?(): Promise<void>;
};

export type ClaudeTaskAgentDriverOptions = {
  readonly engine: ClaudeTaskExecutionEngine;
  readonly appendSystemPrompt?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly strictMcpConfig?: boolean;
};

export class ClaudeTaskAgentDriver implements AgentDriver, StreamingAgentDriver {
  readonly agentId = claudeBgTaskAgentId;
  readonly providerId = claudeProviderId;
  readonly capabilities = claudeBgTaskAgentCapabilities;
  private readonly model: string;

  constructor(private readonly options: ClaudeTaskAgentDriverOptions) {
    this.model = options.model ?? "sonnet";
  }

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (!input.session) {
      return failedClaudeTask(
        {
          code: "provider_session_invalid",
          retryable: false,
          reconnectRequired: true,
          safeMessage: "Claude requires a session artifact.",
          causeCategory: "provider_session_invalid",
        },
        startedAt,
      );
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
    } catch (error) {
      return failedClaudeTask(
        classifyClaudeFailure(error, { redactor: input.redactor }),
        startedAt,
      );
    }
  }

  async *streamTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): AsyncIterable<ProviderTaskEvent> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (!input.session) {
      yield {
        type: "completed",
        occurredAt: new Date(),
        result: failedClaudeTask(
          {
            code: "provider_session_invalid",
            retryable: false,
            reconnectRequired: true,
            safeMessage: "Claude requires a session artifact.",
            causeCategory: "provider_session_invalid",
          },
          startedAt,
        ),
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
    } catch (error) {
      const result = redactProviderTaskResult(
        failedClaudeTask(
          classifyClaudeFailure(error, { redactor: input.redactor }),
          startedAt,
        ),
        input.redactor,
      );
      yield {
        type: "completed",
        occurredAt: new Date(),
        result,
        ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
      };
    }
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return classifyClaudeFailure(error);
  }

  async dispose(): Promise<void> {
    await this.options.engine.dispose?.();
  }

  private prepareEngineInput(
    session: SessionArtifact,
    input: {
      readonly task: ProviderTask;
      readonly workspace: WorkspaceHandle;
      readonly runner: RunnerPort;
      readonly redactor: RedactorPort;
      readonly abortSignal: AbortSignal;
    },
  ): {
    readonly engineInput: ClaudeTaskEngineInput;
    readonly warnings: readonly ProviderTaskResult["warnings"][number][];
  } {
    const validation = validateClaudeSessionArtifact(session);
    registerClaudeSecrets(input.redactor, validation.session.oauthToken);
    let engineInput: ClaudeTaskEngineInput = {
      prompt: input.task.prompt,
      session: validation.session,
      workspacePath: input.workspace.path,
      runner: input.runner,
      redactor: input.redactor,
      model: input.task.controls?.model ?? this.model,
      abortSignal: input.abortSignal,
    };
    const maxTurns = input.task.controls?.maxTurns ?? this.options.maxTurns;
    const allowedTools =
      input.task.controls?.allowedTools ?? this.options.allowedTools;
    const disallowedTools =
      input.task.controls?.disallowedTools ?? this.options.disallowedTools;
    const editMode = input.task.controls?.editMode;
    const providerSandboxMode = input.task.controls?.providerSandboxMode;
    const outputSchemaName =
      input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
    const appendSystemPrompt = mergeSystemPrompts(
      this.options.appendSystemPrompt,
      input.task.systemPrompt,
    );
    if (appendSystemPrompt !== undefined) {
      engineInput = {
        ...engineInput,
        appendSystemPrompt,
      };
    }
    if (maxTurns !== undefined) {
      engineInput = { ...engineInput, maxTurns };
    }
    if (allowedTools !== undefined) {
      engineInput = { ...engineInput, allowedTools };
    }
    if (disallowedTools !== undefined) {
      engineInput = { ...engineInput, disallowedTools };
    }
    if (this.options.mcpConfig !== undefined) {
      engineInput = { ...engineInput, mcpConfig: this.options.mcpConfig };
    }
    if (editMode !== undefined) {
      engineInput = { ...engineInput, editMode };
    }
    if (providerSandboxMode !== undefined) {
      engineInput = { ...engineInput, providerSandboxMode };
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
    const runtimeThread = runtimeThreadFromMetadata(input.task.metadata);
    if (runtimeThread !== undefined) {
      engineInput = { ...engineInput, runtimeThread };
    }
    return {
      engineInput,
      warnings: validation.warnings,
    };
  }
}

function mergeSystemPrompts(
  base: string | undefined,
  task: string | undefined,
): string | undefined {
  const parts = [base, task]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function failedClaudeTask(
  failure: ProviderFailure,
  startedAt: number,
): Extract<ProviderTaskResult, { readonly status: "failed" }> {
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

function redactProviderTaskEvent(
  event: ProviderTaskEvent,
  redactor: RedactorPort,
): ProviderTaskEvent {
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
  if (event.telemetry === undefined) return event;
  return {
    ...event,
    telemetry: redactTelemetry(event.telemetry, redactor),
  };
}

function redactProviderTaskResult(
  result: ProviderTaskResult,
  redactor: RedactorPort,
): ProviderTaskResult {
  if (result.status === "failed") {
    return {
      ...result,
      failure: {
        ...result.failure,
        safeMessage: redactor.redact(result.failure.safeMessage),
        ...(result.failure.details === undefined
          ? {}
          : { details: redactStringRecord(result.failure.details, redactor) }),
      },
      ...(result.telemetry === undefined
        ? {}
        : { telemetry: redactTelemetry(result.telemetry, redactor) }),
      warnings: result.warnings.map((warning) =>
        redactRuntimeWarning(warning, redactor)
      ),
    };
  }

  const outputText = redactor.redact(result.outputText);
  redactor.assertNoKnownSecret(outputText, "claude task output");
  const structuredOutput =
    result.structuredOutput === undefined
      ? undefined
      : redactStructured(result.structuredOutput, redactor);
  if (structuredOutput !== undefined) {
    redactor.assertNoKnownSecret(
      JSON.stringify(structuredOutput),
      "claude structured task output",
    );
  }
  return {
    ...result,
    outputText,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(result.telemetry === undefined
      ? {}
      : { telemetry: redactTelemetry(result.telemetry, redactor) }),
    warnings: result.warnings.map((warning) =>
      redactRuntimeWarning(warning, redactor)
    ),
  };
}

function redactStringRecord(
  record: Readonly<Record<string, string>>,
  redactor: RedactorPort,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      redactor.redact(value),
    ]),
  );
}

function redactTelemetry(
  telemetry: ProviderTaskTelemetry,
  redactor: RedactorPort,
): ProviderTaskTelemetry {
  return {
    ...telemetry,
    ...(telemetry.toolCalls === undefined
      ? {}
      : {
          toolCalls: telemetry.toolCalls.map((toolCall) =>
            redactToolCall(toolCall, redactor)
          ),
        }),
  };
}

function redactToolCall(
  toolCall: AgentToolCall,
  redactor: RedactorPort,
): AgentToolCall {
  const safeInput =
    toolCall.safeInput === undefined
      ? undefined
      : redactStructured(toolCall.safeInput, redactor);
  if (safeInput !== undefined) {
    redactor.assertNoKnownSecret(
      JSON.stringify(safeInput),
      "claude tool call safe input",
    );
  }
  return {
    ...toolCall,
    ...(safeInput === undefined || !isRecord(safeInput) ? {} : { safeInput }),
    ...(toolCall.safeInputPreview === undefined
      ? {}
      : { safeInputPreview: redactor.redact(toolCall.safeInputPreview) }),
    ...(toolCall.safeOutputPreview === undefined
      ? {}
      : { safeOutputPreview: redactor.redact(toolCall.safeOutputPreview) }),
  };
}

function redactRuntimeWarning(
  warning: RuntimeWarning,
  redactor: RedactorPort,
): RuntimeWarning {
  return {
    ...warning,
    safeMessage: redactor.redact(warning.safeMessage),
    ...(warning.details === undefined
      ? {}
      : {
          details: Object.fromEntries(
            Object.entries(warning.details).map(([key, value]) => [
              key,
              redactor.redact(value),
            ]),
          ),
        }),
  };
}

function redactStructured(value: unknown, redactor: RedactorPort): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactStructured(item, redactor));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactStructured(item, redactor),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finishReasonForFailure(
  code: ProviderFailure["code"],
): "cancelled" | "timeout" | "provider_error" {
  if (code === "task_cancelled") return "cancelled";
  if (code === "task_timeout") return "timeout";
  return "provider_error";
}

function runtimeThreadFromMetadata(
  metadata: ProviderTask["metadata"],
): ClaudeRuntimeThreadInput | undefined {
  const threadId = metadata?.[claudeRuntimeThreadIdMetadataKey]?.trim();
  if (!threadId) return undefined;
  const resumeSessionId =
    metadata?.[claudeRuntimeResumeSessionIdMetadataKey]?.trim();
  return {
    threadId,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

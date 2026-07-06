import { randomUUID } from "node:crypto";
import type {
  ProviderTaskEvent,
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "../task/engine-contract";
import {
  diagnosticWarning,
  isAssistantMessageEvent,
  isDiagnosticEvent,
  isResultAvailableEvent,
  isToolResultEvent,
  isToolUseEvent,
  isUsageEvent,
  parseStructuredJson,
  resultText,
  runtimeUsage,
  toolResultCall,
  toolUseCall,
} from "../protocol/claude-runtime-events";
import {
  createClaudeBgRuntimeContext,
  type ClaudeBgRuntimeContextOptions,
} from "./claude-bg-runtime-context";
import { ClaudeProviderFailureError } from "../protocol/failure-classifier";
import {
  buildClaudeRuntimeCommand,
  type ClaudeRuntimeCommandOptions,
  sendClaudeRuntimeFollowup,
} from "./claude-runtime-command";

export type ClaudeRuntimeTaskExecutionEngineOptions =
  ClaudeBgRuntimeContextOptions & {
    readonly pluginDirs?: readonly string[];
    readonly settingsPath?: string;
  };

export class ClaudeRuntimeTaskExecutionEngine
  implements ClaudeTaskExecutionEngine
{
  readonly kind = "claude-runtime-bg" as const;
  readonly capabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  } as const;

  constructor(private readonly options: ClaudeRuntimeTaskExecutionEngineOptions = {}) {}

  async run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult> {
    let completed: Extract<ProviderTaskEvent, { readonly type: "completed" }> | undefined;
    for await (const event of this.stream(input)) {
      if (event.type === "completed") completed = event;
    }
    if (!completed) throw new Error("claude_runtime_result_missing");
    if (completed.result.status === "failed") {
      throw new ClaudeProviderFailureError(completed.result.failure);
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

  async *stream(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent> {
    const { runtime, provider } = await createClaudeBgRuntimeContext(
      {
        configDir: input.session.configDir,
        oauthToken: input.session.oauthToken,
      },
      this.options,
    );

    const requestedAt = runtime.asIsoTimestamp(new Date().toISOString());
    const threadId = runtime.asThreadId(
      input.runtimeThread?.threadId ?? `subscription-runtime-${cryptoRandomId()}`,
    );
    const command = buildClaudeRuntimeCommand({
      task: input,
      runtime,
      requestedAt,
      threadId,
      options: runtimeCommandOptions(this.options),
    });
    const handle =
      input.runtimeThread?.resumeSessionId === undefined
        ? await provider.start({
            command,
            providerId: provider.id,
            requestedAt,
            threadId,
          })
        : await sendClaudeRuntimeFollowup({
            command,
            cwd: input.workspacePath,
            provider,
            requestedAt,
            resumeSessionId: input.runtimeThread.resumeSessionId,
            threadId,
          });

    const textParts: string[] = [];
    const warnings: RuntimeWarning[] = [];
    let telemetry: ProviderTaskTelemetry = {
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
    } finally {
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
}

function cryptoRandomId(): string {
  return randomUUID();
}

function hasEquivalentTextPart(parts: readonly string[], text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return parts.some((part) => part.trim() === normalized);
}

function runtimeCommandOptions(
  options: ClaudeRuntimeTaskExecutionEngineOptions,
): ClaudeRuntimeCommandOptions {
  return {
    ...(options.pluginDirs === undefined
      ? {}
      : { pluginDirs: options.pluginDirs }),
    ...(options.settingsPath === undefined
      ? {}
      : { settingsPath: options.settingsPath }),
  };
}

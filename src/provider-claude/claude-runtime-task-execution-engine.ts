import { randomUUID } from "node:crypto";
import type {
  ProviderTaskControls,
  ProviderTaskEvent,
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "./claude-task-agent-driver";
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
} from "./claude-runtime-event-mapper";
import {
  createClaudeBgRuntimeContext,
  type AgentCommandLike,
  type AgentRuntimeThreadLike,
  type ClaudeBgRuntimeContextOptions,
  type ClaudeRuntimeModule,
} from "./claude-bg-runtime-context";
import { ClaudeProviderFailureError } from "./failure-classifier";

export type ClaudeRuntimeTaskExecutionEngineOptions = ClaudeBgRuntimeContextOptions & {
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
      input.runtimeThread?.threadId ?? `subscription-runtime-${randomUUID()}`,
    );
    const command = this.buildCommand(input, runtime, requestedAt, threadId);
    const handle =
      input.runtimeThread?.resumeSessionId === undefined
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

  private buildCommand(
    input: ClaudeTaskEngineInput,
    runtime: ClaudeRuntimeModule,
    requestedAt: string,
    threadId: string,
  ): AgentCommandLike {
    assertReadOnlyToolPolicy(input.editMode, input.allowedTools);
    return {
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined
        ? {}
        : { disallowedTools: input.disallowedTools }),
      ...(input.appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: input.appendSystemPrompt }),
      createdAt: requestedAt,
      cwd: input.workspacePath,
      id: runtime.asCommandId(`subscription-runtime-${randomUUID()}`),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.mcpConfig === undefined ? {} : { mcpConfig: input.mcpConfig }),
      mode:
        input.runtimeThread?.resumeSessionId === undefined
          ? "initial"
          : "followup",
      model: input.model,
      permissionMode: mapPermissionMode(input.editMode, input.providerSandboxMode),
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

function mapPermissionMode(
  editMode: ProviderTaskControls["editMode"] | undefined,
  providerSandboxMode:
    | ProviderTaskControls["providerSandboxMode"]
    | undefined,
): AgentCommandLike["permissionMode"] {
  assertProviderSandboxModeAllowed(editMode, providerSandboxMode);
  if (providerSandboxMode === "danger-full-access") return "bypassPermissions";
  if (editMode === "allow-edits") return "acceptEdits";
  if (editMode === "read-only") return "dontAsk";
  return "default";
}

function assertReadOnlyToolPolicy(
  editMode: ProviderTaskControls["editMode"] | undefined,
  allowedTools: readonly string[] | undefined,
): void {
  if (editMode !== "read-only" || allowedTools === undefined) return;
  const unsafe = allowedTools.filter((tool) => !isReadOnlyClaudeTool(tool));
  if (unsafe.length === 0) return;
  throw new Error(
    `claude_read_only_allowed_tools_unsafe:${unsafe.join(",")}`,
  );
}

function assertProviderSandboxModeAllowed(
  editMode: ProviderTaskControls["editMode"] | undefined,
  providerSandboxMode:
    | ProviderTaskControls["providerSandboxMode"]
    | undefined,
): void {
  if (providerSandboxMode === undefined || editMode === "allow-edits") return;
  throw new Error("claude_provider_sandbox_mode_requires_allow_edits");
}

const readOnlyClaudeTools = new Set([
  "Glob",
  "Grep",
  "LS",
  "Read",
  "TodoRead",
  "WebFetch",
]);

function isReadOnlyClaudeTool(tool: string): boolean {
  const name = tool.split("(", 1)[0]?.trim();
  return name !== undefined && readOnlyClaudeTools.has(name);
}

function hasEquivalentTextPart(parts: readonly string[], text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return parts.some((part) => part.trim() === normalized);
}

async function sendFollowup(input: {
  readonly command: AgentCommandLike;
  readonly cwd: string;
  readonly provider: {
    readonly id: string;
    readonly send?: (request: {
      readonly thread: AgentRuntimeThreadLike;
      readonly command: AgentCommandLike;
      readonly previousProviderSessionId?: string;
      readonly requestedAt: string;
    }) => Promise<{ readonly runId: string; readonly providerSessionId?: string }>;
  };
  readonly requestedAt: string;
  readonly resumeSessionId: string;
  readonly threadId: string;
}): Promise<{ readonly runId: string; readonly providerSessionId?: string }> {
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

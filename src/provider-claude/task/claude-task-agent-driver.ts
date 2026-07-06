import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskEvent,
  type ProviderTaskControls,
  type ProviderTaskResult,
  type RedactorPort,
  type RunnerPort,
  type SessionArtifact,
  type StreamingAgentDriver,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  claudeBgTaskAgentCapabilities,
  claudeBgTaskAgentId,
  claudeProviderId,
} from "../capabilities";
import { classifyClaudeFailure } from "../protocol/failure-classifier";
import {
  prepareClaudeTaskEngineInput,
  type ClaudeTaskAgentDriverOptions,
} from "./build-claude-task-engine-input";
import {
  type ClaudeRuntimeThreadInput,
  type ClaudeTaskEngineInput,
  type ClaudeTaskExecutionEngine,
  type ClaudeTaskExecutionResult,
} from "./engine-contract";
import {
  claudeRuntimeResumeSessionIdMetadataKey,
  claudeRuntimeThreadIdMetadataKey,
} from "./runtime-thread-metadata";
import { failedClaudeTask } from "./task-failure-result";
import {
  redactProviderTaskEvent,
  redactProviderTaskResult,
  redactRuntimeWarning,
} from "./task-output-redaction";

export type {
  ClaudeRuntimeThreadInput,
  ClaudeTaskAgentDriverOptions,
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
};
export {
  claudeRuntimeResumeSessionIdMetadataKey,
  claudeRuntimeThreadIdMetadataKey,
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
      return failedClaudeTask(missingClaudeSessionFailure(), startedAt);
    }

    try {
      const prepared = prepareClaudeTaskEngineInput(
        this.options,
        this.model,
        { ...input, session: input.session },
      );
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
        result: failedClaudeTask(missingClaudeSessionFailure(), startedAt),
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
      const prepared = prepareClaudeTaskEngineInput(
        this.options,
        this.model,
        { ...input, session: input.session },
      );
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
}

function missingClaudeSessionFailure(): ProviderFailure {
  return {
    code: "provider_session_invalid",
    retryable: false,
    reconnectRequired: true,
    safeMessage: "Claude requires a session artifact.",
    causeCategory: "provider_session_invalid",
  };
}

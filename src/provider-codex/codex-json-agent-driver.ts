import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskResult,
  type RedactorPort,
  type SessionArtifact,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  codexJsonAgentCapabilities,
  codexJsonAgentId,
  codexProviderId,
  defaultCodexModel,
} from "./capabilities";
import { classifyCodexFailure } from "./failure-classifier";
import {
  type CodexExecutionEngine,
  type CodexReasoningEffort,
  PackagedCodexJsonExecutionEngine,
  codexSandboxModeForPermissionMode,
  codexExecutionFailure,
} from "./codex-json-execution-engine";
import {
  CodexEphemeralSessionMaterializer,
  type CodexSessionMaterializer,
  type CodexSessionPrewarmResult,
  sessionArtifactHash,
} from "./codex-session-materializer";

type CodexJsonAgentDriverBaseOptions = {
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly warmupPrompt?: string;
  readonly sessionMaterializer?: CodexSessionMaterializer;
};

export type CodexJsonAgentDriverOptions = CodexJsonAgentDriverBaseOptions &
  (
    | {
        readonly engine: CodexExecutionEngine;
      }
    | {
        readonly codexBinaryPath: string;
        readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
        readonly timeoutMs?: number;
      }
  );

export class CodexJsonAgentDriver implements AgentDriver {
  readonly agentId = codexJsonAgentId;
  readonly providerId = codexProviderId;
  readonly capabilities = codexJsonAgentCapabilities;
  private readonly engine: CodexExecutionEngine;
  private readonly model: string;
  private readonly reasoningEffort: CodexReasoningEffort;
  private readonly sessionMaterializer: CodexSessionMaterializer;

  constructor(private readonly options: CodexJsonAgentDriverOptions) {
    this.engine =
      "engine" in options
        ? options.engine
        : new PackagedCodexJsonExecutionEngine({
            codexBinaryPath: options.codexBinaryPath,
            ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          });
    this.model = options.model ?? defaultCodexModel;
    this.reasoningEffort = options.reasoningEffort ?? "low";
    this.sessionMaterializer =
      options.sessionMaterializer ?? new CodexEphemeralSessionMaterializer();
  }

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (!input.session) {
      return {
        status: "failed",
        failure: {
          code: "provider_session_invalid",
          retryable: false,
          reconnectRequired: true,
          safeMessage: "Codex requires a session artifact.",
        },
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "provider_error",
        },
        warnings: [],
      };
    }

    let materialized: Awaited<
      ReturnType<CodexSessionMaterializer["materialize"]>
    > | null = null;
    try {
      materialized = await this.sessionMaterializer.materialize({
        session: input.session,
        redactor: input.redactor,
      });
      const outputSchemaName =
        input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
      const result = await this.engine.run({
        prompt: input.task.prompt,
        ...(input.task.systemPrompt !== undefined
          ? { systemPrompt: input.task.systemPrompt }
          : {}),
        outputSchema: outputSchemaName ? { name: outputSchemaName } : undefined,
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task.controls?.model ?? this.model,
        reasoningEffort: this.reasoningEffort,
        sandboxMode: codexSandboxModeForPermissionMode(
          input.task.controls?.permissionMode,
        ),
        abortSignal: input.abortSignal,
      });

      return {
        status: "completed",
        outputText: result.outputText,
        structuredOutput: result.structuredOutput,
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "completed",
        },
        warnings: result.warnings,
      };
    } catch (error) {
      const failure = codexExecutionFailure(error);
      return {
        ...failure,
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: finishReasonForFailure(failure.failure.code),
        },
      };
    } finally {
      await materialized?.release();
    }
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return classifyCodexFailure(error);
  }

  async prewarmSession(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
    readonly workspacePath?: string;
    readonly runner?: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly abortSignal?: AbortSignal;
  }): Promise<CodexSessionPrewarmResult> {
    const sessionPrewarm = this.sessionMaterializer.prewarm
      ? await this.sessionMaterializer.prewarm(input)
      : await this.prewarmMaterializerFallback(input);

    if (
      !sessionPrewarm.reusable ||
      !this.engine.prewarm ||
      !input.workspacePath ||
      !input.runner
    ) {
      return sessionPrewarm;
    }

    const materialized = await this.sessionMaterializer.materialize(input);
    try {
      const enginePrewarm = await this.engine.prewarm({
        session: materialized,
        workspacePath: input.workspacePath,
        runner: input.runner,
        redactor: input.redactor,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        ...(this.options.warmupPrompt
          ? { warmupPrompt: this.options.warmupPrompt }
          : {}),
        abortSignal: input.abortSignal ?? new AbortController().signal,
      });
      return {
        ...sessionPrewarm,
        engine: {
          kind: enginePrewarm.kind,
          reusable: enginePrewarm.reusable,
        },
        warmedAt: enginePrewarm.warmedAt,
        warnings: enginePrewarm.warnings,
      };
    } finally {
      await materialized.release();
    }
  }

  private async prewarmMaterializerFallback(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult> {
    const materialized = await this.sessionMaterializer.materialize(input);
    try {
      return {
        mode: this.sessionMaterializer.mode,
        home: materialized.home,
        codexHome: materialized.codexHome,
        sessionHash: sessionArtifactHash(input.session),
        reusable: false,
        warmedAt: new Date(),
      };
    } finally {
      await materialized.release();
    }
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.engine.dispose?.()),
      Promise.resolve().then(() => this.sessionMaterializer.dispose?.()),
    ]);
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (errors.length > 0) {
      const error = new AggregateError(
        errors,
        "codex_json_agent_dispose_failed",
      ) as AggregateError & { code: string };
      error.code = "codex_json_agent_dispose_failed";
      throw error;
    }
  }
}

function finishReasonForFailure(
  code: ProviderFailure["code"],
):
  | "completed"
  | "max_turns"
  | "cancelled"
  | "timeout"
  | "provider_error" {
  if (code === "task_cancelled") return "cancelled";
  if (code === "task_timeout") return "timeout";
  return "provider_error";
}

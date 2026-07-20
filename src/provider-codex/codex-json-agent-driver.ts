import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type ManagedRunResumeHandle,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskResult,
  type RedactorPort,
  type RuntimeWarning,
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
  type CodexMaterializedSession,
  type CodexOutputSchemaRequest,
  type CodexReasoningEffort,
  type CodexServiceTier,
  PackagedCodexJsonExecutionEngine,
  codexSandboxModeForControls,
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
  readonly serviceTier?: CodexServiceTier;
  readonly warmupPrompt?: string;
  readonly sessionMaterializer?: CodexSessionMaterializer;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
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
  private readonly serviceTier: CodexServiceTier | undefined;
  private readonly outputSchemas: Readonly<Record<string, unknown>>;
  private readonly sessionMaterializer: CodexSessionMaterializer;
  private readonly managedRunSessions = new Map<
    string,
    CodexMaterializedSession
  >();

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
    this.serviceTier = options.serviceTier;
    this.outputSchemas = options.outputSchemas ?? {};
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
    readonly onTaskStarted?: () => Promise<void> | void;
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
      const goalObjective = readTaskGoalObjective(input.task);
      const runId = readTaskManagedRunId(input.task);
      const engineInput = {
        ...(runId ? { runId } : {}),
        prompt: input.task.prompt,
        ...(goalObjective ? { goalObjective } : {}),
        ...(input.task.systemPrompt !== undefined
          ? { systemPrompt: input.task.systemPrompt }
          : {}),
        outputSchema: this.outputSchemaRequest(outputSchemaName),
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task.controls?.model ?? this.model,
        reasoningEffort: this.reasoningEffort,
        ...(this.serviceTier === undefined
          ? {}
          : { serviceTier: this.serviceTier }),
        sandboxMode: codexSandboxModeForControls(input.task.controls),
        abortSignal: input.abortSignal,
      };
      await input.onTaskStarted?.();
      const result = await this.engine.run(engineInput);
      if (result.status === "waiting_for_input") {
        this.managedRunSessions.set(result.runId, materialized);
        materialized = null;
        return {
          status: "waiting_for_input",
          runId: result.runId,
          outputText: result.outputText,
          ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: result.structuredOutput }),
          request: result.request,
          resumeHandle: result.resumeHandle,
          telemetry: {
            durationMs: Date.now() - startedAt,
            finishReason: "waiting_for_input",
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
          warnings: result.warnings,
        };
      }
      const snapshot = await snapshotSessionUpdate({
        materialized,
        previousSession: input.session,
        redactor: input.redactor,
      });

      return {
        status: "completed",
        outputText: result.outputText,
        structuredOutput: result.structuredOutput,
        ...(snapshot.sessionUpdate
          ? { sessionUpdate: snapshot.sessionUpdate }
          : {}),
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "completed",
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        },
        warnings: [...result.warnings, ...snapshot.warnings],
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

  async resumeManagedRun(input: {
    readonly session: SessionArtifact;
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly task?: Pick<ProviderTask, "controls" | "outputSchemaName">;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    if (!this.engine.resume) {
      return {
        status: "failed",
        failure: {
          code: "task_mode_unsupported",
          retryable: false,
          reconnectRequired: false,
          safeMessage:
            "Codex execution engine does not support managed run resume.",
        },
        warnings: [],
      };
    }

    const startedAt = Date.now();
    let materialized = this.managedRunSessions.get(input.runId) ?? null;
    let ownsMaterialized = false;
    if (!materialized) {
      materialized = await this.sessionMaterializer.materialize({
        session: input.session,
        redactor: input.redactor,
      });
      ownsMaterialized = true;
    }

    try {
      const outputSchemaName =
        input.task?.controls?.outputSchemaName ?? input.task?.outputSchemaName;
      const result = await this.engine.resume({
        runId: input.runId,
        requestId: input.requestId,
        answer: input.answer,
        resumeHandle: input.resumeHandle,
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task?.controls?.model ?? this.model,
        reasoningEffort: this.reasoningEffort,
        ...(this.serviceTier === undefined
          ? {}
          : { serviceTier: this.serviceTier }),
        sandboxMode: codexSandboxModeForControls(input.task?.controls),
        outputSchema: this.outputSchemaRequest(outputSchemaName),
        abortSignal: input.abortSignal,
      });
      if (result.status === "waiting_for_input") {
        if (result.runId !== input.runId) {
          this.managedRunSessions.delete(input.runId);
        }
        this.managedRunSessions.set(result.runId, materialized);
        ownsMaterialized = false;
        return {
          status: "waiting_for_input",
          runId: result.runId,
          outputText: result.outputText,
          ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: result.structuredOutput }),
          request: result.request,
          resumeHandle: result.resumeHandle,
          telemetry: {
            durationMs: Date.now() - startedAt,
            finishReason: "waiting_for_input",
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
          warnings: result.warnings,
        };
      }

      this.managedRunSessions.delete(input.runId);
      ownsMaterialized = true;
      const snapshot = await snapshotSessionUpdate({
        materialized,
        previousSession: input.session,
        redactor: input.redactor,
      });
      return {
        status: "completed",
        outputText: result.outputText,
        structuredOutput: result.structuredOutput,
        ...(snapshot.sessionUpdate
          ? { sessionUpdate: snapshot.sessionUpdate }
          : {}),
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "completed",
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        },
        warnings: [...result.warnings, ...snapshot.warnings],
      };
    } catch (error) {
      this.managedRunSessions.delete(input.runId);
      ownsMaterialized = true;
      const failure = codexExecutionFailure(error);
      return {
        ...failure,
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: finishReasonForFailure(failure.failure.code),
        },
      };
    } finally {
      if (ownsMaterialized) {
        await materialized.release();
      }
    }
  }

  hasManagedRunSession(runId: string): boolean {
    return this.managedRunSessions.has(runId);
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
        ...(this.serviceTier === undefined
          ? {}
          : { serviceTier: this.serviceTier }),
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
    const managedSessions = [...this.managedRunSessions.values()];
    this.managedRunSessions.clear();
    const results = await Promise.allSettled([
      ...managedSessions.map((session) =>
        Promise.resolve().then(() => session.release()),
      ),
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

  private outputSchemaRequest(
    outputSchemaName: string | undefined,
  ): CodexOutputSchemaRequest | undefined {
    if (!outputSchemaName) return undefined;
    const schema = this.outputSchemas[outputSchemaName];
    return {
      name: outputSchemaName,
      ...(schema === undefined ? {} : { schema }),
    };
  }
}

async function snapshotSessionUpdate(input: {
  readonly materialized: Awaited<
    ReturnType<CodexSessionMaterializer["materialize"]>
  >;
  readonly previousSession: SessionArtifact;
  readonly redactor: RedactorPort;
}): Promise<{
  readonly sessionUpdate?: SessionArtifact;
  readonly warnings: readonly RuntimeWarning[];
}> {
  if (!input.materialized.snapshotSession) {
    return { warnings: [] };
  }

  try {
    const snapshot = await input.materialized.snapshotSession();
    if (!snapshot) {
      return { warnings: [] };
    }
    input.redactor.registerSecret(snapshot.bytes, "codex-session-snapshot");
    if (
      sessionArtifactHash(snapshot) === sessionArtifactHash(input.previousSession)
    ) {
      return { warnings: [] };
    }
    return { sessionUpdate: snapshot, warnings: [] };
  } catch {
    return {
      warnings: [
        {
          code: "codex_session_snapshot_failed",
          safeMessage:
            "Codex session snapshot could not be captured after task execution.",
        },
      ],
    };
  }
}

function readTaskGoalObjective(task: ProviderTask): string | null {
  const value = task.metadata?.codexGoalObjective;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readTaskManagedRunId(task: ProviderTask): string | null {
  const value = task.metadata?.codexManagedRunId ?? task.metadata?.runId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finishReasonForFailure(
  code: ProviderFailure["code"],
):
  | "completed"
  | "waiting_for_input"
  | "max_turns"
  | "cancelled"
  | "timeout"
  | "provider_error" {
  if (code === "task_cancelled") return "cancelled";
  if (code === "task_timeout") return "timeout";
  if (code === "goal_slice_exhausted") return "max_turns";
  return "provider_error";
}

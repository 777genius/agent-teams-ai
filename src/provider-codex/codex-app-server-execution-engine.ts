import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter, once as onceEvent } from "node:events";
import type {
  AgentUsage,
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProviderFailure,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { pruneCodexChildEnv } from "./codex-cli-domain";
import type {
  CodexExecutionProfile,
  ResolvedCodexExecutionProfile,
} from "./codex-execution-profile";
import { resolveCodexExecutionProfile } from "./codex-execution-profile";
import type {
  CodexExecutionEngine,
  CodexExecutionPrewarmResult,
  CodexExecutionResult,
  CodexMaterializedSession,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "./codex-json-execution-engine";
import { codexOutputSchemaPayload } from "./codex-json-execution-engine";
import { parseCodexStructuredOutput } from "./structured-output";

export type CodexAppServerExecutionEngineOptions = {
  readonly codexBinaryPath: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly fallback?: CodexExecutionEngine;
  readonly processFactory?: CodexAppServerProcessFactory;
  readonly executionProfile?: CodexExecutionProfile;
  readonly cleanThreadPrewarm?: boolean;
  readonly reconnectGraceMs?: number;
  readonly goalMode?: boolean;
  readonly maxGoalTurns?: number;
  readonly goalContinuePrompt?: string;
  readonly runStore?: ManagedRunStorePort;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
};

export type CodexAppServerCommandApprovalInput = {
  readonly source:
    | "command_execution"
    | "legacy_exec"
    | "thread_shell_command";
  readonly command?: readonly string[];
  readonly commandText?: string;
  readonly cwd?: string;
};

export type CodexAppServerCommandApprovalDecision = {
  readonly approved: boolean;
  readonly reason?: string;
};

export type CodexAppServerCommandApprovalPolicy = {
  readonly reviewCommand: (
    input: CodexAppServerCommandApprovalInput,
  ) => CodexAppServerCommandApprovalDecision;
};

export type CodexAppServerProcessFactory = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}) => CodexAppServerChildProcess;

export type CodexAppServerChildProcess = {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on?(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

type AppServerSlot = {
  readonly key: string;
  readonly client: CodexAppServerClient;
  sessionHash: string | null;
};

type AppServerWarning = {
  readonly code: string;
  readonly safeMessage: string;
};

type AppServerWaitingForInputResult = {
  readonly status: "waiting_for_input";
  readonly runId: string;
  readonly outputText: string;
  readonly request: ManagedRunInputRequest;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly usage?: AgentUsage;
  readonly warnings: readonly AppServerWarning[];
};

type PreparedThread = {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sandboxMode: CodexSandboxMode;
  readonly systemPrompt: string | null;
};

type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

type CodexThreadGoal = {
  readonly threadId: string;
  readonly objective: string;
  readonly status: CodexThreadGoalStatus;
  readonly usage?: AgentUsage;
};

const defaultTimeoutMs = 10 * 60 * 1000;
const defaultControlRequestTimeoutMs = 30 * 1000;
const defaultReconnectGraceMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 512 * 1024;
const defaultMaxGoalTurns = 20;
const defaultGoalContinuePrompt =
  "Continue working toward the active goal. If the goal is complete, mark it complete and summarize the result.";

function normalizeSystemPrompt(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergeDeveloperInstructions(input: {
  readonly base: string | null;
  readonly systemPrompt?: string | undefined;
}): string | null {
  const systemPrompt = normalizeSystemPrompt(input.systemPrompt);
  if (!systemPrompt) return input.base;
  if (!input.base) return systemPrompt;
  return `${input.base}\n\n${systemPrompt}`;
}

export class CodexAppServerExecutionEngine implements CodexExecutionEngine {
  readonly kind: "app-server-pool" | "app-server-goal";
  readonly capabilities = {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
  } as const;

  private readonly executionProfile: ResolvedCodexExecutionProfile;
  private readonly runStore: ManagedRunStorePort;

  private readonly slots = new Map<string, AppServerSlot>();

  constructor(private readonly options: CodexAppServerExecutionEngineOptions) {
    if (!options.codexBinaryPath.trim()) {
      throw new Error("codex_app_server_binary_required");
    }
    this.kind = options.goalMode ? "app-server-goal" : "app-server-pool";
    this.executionProfile = resolveCodexExecutionProfile(
      options.executionProfile,
    );
    this.runStore = options.runStore ?? new InMemoryManagedRunStore();
  }

  async run(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    try {
      const result = await this.runViaAppServer(input);
      if (result.status === "waiting_for_input") return result;
      if (input.outputSchema) {
        try {
          return {
            ...result,
            structuredOutput: parseStructuredOutput(result.outputText),
          };
        } catch (error) {
          await this.failManagedRunForProviderOutput(input.runId);
          throw error;
        }
      }
      return result;
    } catch (error) {
      await this.disposeSessionSlot(input.session);
      if (input.abortSignal.aborted || isAbortLikeError(error)) throw error;
      if (!this.options.fallback) throw error;

      const fallbackResult = await this.options.fallback.run(input);
      return {
        ...fallbackResult,
        warnings: [appServerFallbackWarning(error), ...fallbackResult.warnings],
      };
    }
  }

  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    try {
      const result = await this.resumeViaAppServer(input);
      if (result.status === "waiting_for_input") return result;
      if (input.outputSchema) {
        try {
          return {
            ...result,
            structuredOutput: parseStructuredOutput(result.outputText),
          };
        } catch (error) {
          await this.failManagedRunForProviderOutput(input.runId);
          throw error;
        }
      }
      return result;
    } catch (error) {
      if (!isManagedRunResumeValidationError(error)) {
        await this.disposeSessionSlot(input.session);
      }
      throw error;
    }
  }

  private async failManagedRunForProviderOutput(
    runId: string | undefined,
  ): Promise<void> {
    if (!this.options.goalMode || !runId) return;
    await this.runStore.fail({
      runId,
      failure: {
        code: "provider_output_invalid",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex provider output was invalid.",
      },
      now: new Date(),
    }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(slots.map((slot) => slot.client.stop()));
    await this.options.fallback?.dispose?.();
  }

  async prewarm(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly warmupPrompt?: string;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionPrewarmResult> {
    try {
      const slot = await this.ensureSlot(input);
      const warmupPrompt = input.warmupPrompt?.trim();
      const warnings: AppServerWarning[] = [];
      if (warmupPrompt) {
        const result = await slot.client.runCleanTurn({
          prompt: warmupPrompt,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          sandboxMode: "read-only",
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
          prepareNext: false,
        });
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(
          outputText,
          "codex-app-server-prewarm-output",
        );
        assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
        warnings.push(...result.warnings);
      }

      warnings.push(
        ...(await slot.client.prewarmCleanThread({
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
        })),
      );
      return {
        kind: this.kind,
        reusable: true,
        warmedAt: new Date(),
        warnings,
      };
    } catch (error) {
      await this.disposeSessionSlot(input.session);
      throw error;
    }
  }

  private async runViaAppServer(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    const slot = await this.ensureSlot(input);
    const outputSchema = codexOutputSchemaPayload(input.outputSchema);
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const common = {
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      prompt: input.prompt,
      ...(input.goalObjective !== undefined
        ? { goalObjective: input.goalObjective }
        : {}),
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : {}),
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
    };
    const result = this.options.goalMode
      ? await slot.client.runGoal({
          ...common,
          maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
          goalContinuePrompt:
            this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
        })
      : await slot.client.runCleanTurn(common);

    const outputText = input.redactor.redact(result.outputText);
    input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
    assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
    if (isAppServerWaitingForInputResult(result)) {
      return redactWaitingForInputResult({
        result,
        outputText,
        redactor: input.redactor,
      });
    }
    return {
      outputText,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      warnings: [...schemaWarnings, ...result.warnings],
    };
  }

  private async resumeViaAppServer(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    if (!this.options.goalMode) {
      throw new Error("codex_app_server_resume_requires_goal_mode");
    }
    await this.assertManagedRunCanResume(input);
    const slot = await this.ensureSlot(input);
    const outputSchema = codexOutputSchemaPayload(input.outputSchema);
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const result = await slot.client.resumeGoal({
      runId: input.runId,
      requestId: input.requestId,
      answer: input.answer,
      resumeHandle: input.resumeHandle,
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
      maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
      goalContinuePrompt:
        this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
    });

    const outputText = input.redactor.redact(result.outputText);
    input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
    assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
    if (isAppServerWaitingForInputResult(result)) {
      return redactWaitingForInputResult({
        result,
        outputText,
        redactor: input.redactor,
      });
    }
    return {
      outputText,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      warnings: [...schemaWarnings, ...result.warnings],
    };
  }

  private async assertManagedRunCanResume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly workspacePath: string;
  }): Promise<void> {
    const threadId = input.resumeHandle.threadId;
    if (!threadId) throw new Error("codex_managed_run_thread_missing");
    if (input.resumeHandle.providerId !== "codex") {
      throw new Error("codex_managed_run_provider_mismatch");
    }
    if (
      input.resumeHandle.agentId !== undefined &&
      input.resumeHandle.agentId !== "codex-json"
    ) {
      throw new Error("codex_managed_run_agent_mismatch");
    }
    if (input.resumeHandle.runId !== input.runId) {
      throw new Error("codex_managed_run_resume_handle_mismatch");
    }
    if (input.resumeHandle.workspacePath !== input.workspacePath) {
      throw new Error("codex_managed_run_workspace_mismatch");
    }
    const current = await this.runStore.get({ runId: input.runId });
    if (!current || current.status !== "waiting_for_input") {
      throw new Error("codex_managed_run_not_waiting_for_input");
    }
    if (current.request?.id !== input.requestId) {
      throw new Error("codex_managed_run_request_mismatch");
    }
    if (
      current.resumeHandle?.runId !== input.runId ||
      current.resumeHandle.threadId !== threadId ||
      current.resumeHandle.workspacePath !== input.workspacePath
    ) {
      throw new Error("codex_managed_run_resume_handle_mismatch");
    }
  }

  private async ensureSlot(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<AppServerSlot> {
    const key = input.session.codexHome;
    const sessionHash = input.session.sessionHash ?? null;
    const existing = this.slots.get(key);
    if (existing && existing.sessionHash === sessionHash) {
      return existing;
    }

    if (existing) {
      await existing.client.stop();
      this.slots.delete(key);
    }

    throwIfAborted(input.abortSignal);
    const client = new CodexAppServerClient({
      codexBinaryPath: this.options.codexBinaryPath,
      sourceEnv: this.options.sourceEnv ?? process.env,
      processFactory: this.options.processFactory ?? spawnCodexAppServerProcess,
      runStore: this.runStore,
      session: input.session,
      workspacePath: input.workspacePath,
      executionProfile: this.executionProfile,
      ...(this.options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
      cleanThreadPrewarm: this.options.cleanThreadPrewarm ?? true,
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      reconnectGraceMs: this.options.reconnectGraceMs ?? defaultReconnectGraceMs,
      abortSignal: input.abortSignal,
    });
    try {
      await client.start();
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
    const slot = { key, client, sessionHash };
    this.slots.set(key, slot);
    return slot;
  }

  private async disposeSessionSlot(
    session: CodexMaterializedSession,
  ): Promise<void> {
    const slot = this.slots.get(session.codexHome);
    if (!slot) return;
    this.slots.delete(session.codexHome);
    await slot.client.stop();
  }
}

type JsonRpcResponse = {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
};

type TurnState = {
  outputText: string;
  usage: AgentUsage | undefined;
  completed: boolean;
  error: Error | null;
  waiters: ((state: TurnState) => void)[];
  reconnectGraceTimer: NodeJS.Timeout | null;
};

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

class CodexAppServerClient {
  private nextId = 1;
  private child: CodexAppServerChildProcess | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingTurnIdsByThread = new Map<string, string>();
  private readonly earlyTurnIdsByThread = new Map<string, string>();
  private readonly turnIdAliases = new Map<string, string>();
  private readonly serverRequests: AppServerWarning[] = [];
  private readonly backgroundWarnings: AppServerWarning[] = [];
  private preparedThread: PreparedThread | null = null;
  private prepareThreadInFlight: Promise<void> | null = null;
  private exited = false;
  private terminalError: Error | null = null;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly sourceEnv: Readonly<Record<string, string | undefined>>;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly runStore: ManagedRunStorePort;
      readonly session: CodexMaterializedSession;
      readonly workspacePath: string;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly cleanThreadPrewarm: boolean;
      readonly timeoutMs: number;
      readonly reconnectGraceMs: number;
      readonly abortSignal: AbortSignal;
    },
  ) {}

  async start(): Promise<void> {
    throwIfAborted(this.options.abortSignal);
    this.exited = false;
    this.terminalError = null;
    const env = {
      ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
      ...this.options.session.env,
      CI: "true",
    };
    this.child = this.options.processFactory({
      command: this.options.codexBinaryPath,
      args: ["app-server", "--listen", "stdio://"],
      cwd: this.options.session.home,
      env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    this.child.stderr.on("data", () => {
      // Keep stderr private. Codex may include environment or auth diagnostics.
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.recordTerminalError(
        new Error(`codex_app_server_exited:${code ?? signal}`),
      );
    });
    this.child.on("error", (error) => {
      this.recordTerminalError(error);
    });
    this.child.stdin.on?.("error", (error) => {
      this.recordTerminalError(error);
    });

    const response = await this.send(
      "initialize",
      {
        clientInfo: {
          name: "subscription-runtime",
          title: "ReviewRouter subscription runtime",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      {
        timeoutMs: this.options.timeoutMs,
        abortSignal: this.options.abortSignal,
      },
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_initialize_failed:${response.error.message ?? "unknown"}`,
      );
    }
  }

  async runCleanTurn(input: {
    readonly prompt: string;
    readonly systemPrompt?: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly prepareNext?: boolean;
  }): Promise<{
    readonly status?: "completed";
    readonly outputText: string;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const warnings = this.drainWarnings();
    const preparedThread = this.takePreparedThread(input);
    const threadId =
      preparedThread?.threadId ?? (await this.startThread(input));
    const turn = await this.startTurn({ ...input, threadId }).catch(
      async (error: unknown) => {
        if (!preparedThread) throw error;
        warnings.push({
          code: "codex_app_server_prepared_thread_failed",
          safeMessage:
            "Codex app-server prepared thread failed; retried with a fresh thread.",
        });
        const retryThreadId = await this.startThread(input);
        return await this.startTurn({ ...input, threadId: retryThreadId });
      },
    );
    if (turn.error) throw turn.error;
    if (!turn.outputText.trim()) {
      throw new Error("codex_app_server_final_message_missing");
    }
    if (input.prepareNext ?? true) {
      this.prepareCleanThreadBestEffort(input);
    }
    warnings.push(...this.drainWarnings());
    return {
      outputText: turn.outputText,
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      warnings,
    };
  }

  async runGoal(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
  }): Promise<{
    readonly status?: "completed" | "waiting_for_input";
    readonly runId?: string;
    readonly outputText: string;
    readonly request?: ManagedRunInputRequest;
    readonly resumeHandle?: ManagedRunResumeHandle;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const warnings = this.drainWarnings();
    const runId = normalizeRunId(input.runId);
    const threadId = await this.startThread({
      ...input,
      goalMode: true,
    });
    await this.setGoal({
      threadId,
      objective: input.goalObjective ?? input.prompt,
      status: "active",
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
    });

    return this.continueGoal({
      ...input,
      runId,
      threadId,
      firstPrompt: input.prompt,
      warnings,
    });
  }

  async resumeGoal(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
  }): Promise<{
    readonly status?: "completed" | "waiting_for_input";
    readonly runId?: string;
    readonly outputText: string;
    readonly request?: ManagedRunInputRequest;
    readonly resumeHandle?: ManagedRunResumeHandle;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const threadId = input.resumeHandle.threadId;
    if (!threadId) throw new Error("codex_managed_run_thread_missing");
    if (input.resumeHandle.providerId !== "codex") {
      throw new Error("codex_managed_run_provider_mismatch");
    }
    if (
      input.resumeHandle.agentId !== undefined &&
      input.resumeHandle.agentId !== "codex-json"
    ) {
      throw new Error("codex_managed_run_agent_mismatch");
    }
    if (input.resumeHandle.runId !== input.runId) {
      throw new Error("codex_managed_run_resume_handle_mismatch");
    }
    if (input.resumeHandle.workspacePath !== input.workspacePath) {
      throw new Error("codex_managed_run_workspace_mismatch");
    }
    const current = await this.options.runStore.get({ runId: input.runId });
    if (!current || current.status !== "waiting_for_input") {
      throw new Error("codex_managed_run_not_waiting_for_input");
    }
    if (current.request?.id !== input.requestId) {
      throw new Error("codex_managed_run_request_mismatch");
    }
    if (
      current.resumeHandle?.runId !== input.runId ||
      current.resumeHandle.threadId !== threadId ||
      current.resumeHandle.workspacePath !== input.workspacePath
    ) {
      throw new Error("codex_managed_run_resume_handle_mismatch");
    }
    await this.options.runStore.resume({
      runId: input.runId,
      requestId: input.requestId,
      answer: input.answer,
      now: new Date(),
    });

    try {
      return await this.continueGoal({
        ...input,
        threadId,
        firstPrompt: buildGoalResumePrompt(input),
        warnings: this.drainWarnings(),
      });
    } catch (error) {
      await this.options.runStore.fail({
        runId: input.runId,
        failure: managedRunFailureFromError(error),
        now: new Date(),
      });
      throw error;
    }
  }

  private async continueGoal(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly firstPrompt: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly warnings: AppServerWarning[];
  }): Promise<{
    readonly status?: "completed" | "waiting_for_input";
    readonly runId?: string;
    readonly outputText: string;
    readonly request?: ManagedRunInputRequest;
    readonly resumeHandle?: ManagedRunResumeHandle;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    let outputText = "";
    let turnUsage: AgentUsage | undefined;
    let goalUsage: AgentUsage | undefined;
    for (let turnNumber = 1; turnNumber <= input.maxGoalTurns; turnNumber += 1) {
      const turn = await this.startTurn({
        ...input,
        goalMode: true,
        prompt: turnNumber === 1 ? input.firstPrompt : input.goalContinuePrompt,
      });
      if (turn.error) throw turn.error;
      outputText = turn.outputText;
      turnUsage = mergeAgentUsage(turnUsage, turn.usage);

      const goal = await this.getGoal({
        threadId: input.threadId,
        timeoutMs: controlRequestTimeoutMs(input.timeoutMs),
        abortSignal: input.abortSignal,
      });
      if (!goal) {
        throw new Error("codex_app_server_goal_missing");
      }
      goalUsage = mergeAgentUsage(goalUsage, goal.usage);
      if (goal.status === "complete") {
        input.warnings.push(...this.drainWarnings());
        await this.options.runStore.complete({
          runId: input.runId,
          outputText,
          now: new Date(),
        });
        return {
          status: "completed",
          outputText,
          ...usageField(preferredUsage(turnUsage, goalUsage)),
          warnings: input.warnings,
        };
      }
      if (goal.status === "blocked" || goal.status === "paused") {
        return this.waitForGoalInput({
          runId: input.runId,
          threadId: input.threadId,
          goal,
          outputText,
          workspacePath: input.workspacePath,
          ...usageField(preferredUsage(turnUsage, goalUsage)),
          warnings: input.warnings,
        });
      }
      if (goal.status !== "active") {
        throw new Error(`codex_app_server_goal_${goal.status}`);
      }
      if (!outputText.trim()) {
        throw new Error("codex_app_server_goal_turn_output_missing");
      }
    }

    throw goalMaxTurnsExceededError({
      maxGoalTurns: input.maxGoalTurns,
      outputText,
    });
  }

  private async waitForGoalInput(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly goal: CodexThreadGoal;
    readonly outputText: string;
    readonly workspacePath: string;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }): Promise<{
    readonly status: "waiting_for_input";
    readonly runId: string;
    readonly outputText: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const request = goalInputRequest({
      runId: input.runId,
      goal: input.goal,
      outputText: input.outputText,
    });
    const resumeHandle: ManagedRunResumeHandle = {
      runId: input.runId,
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      providerState: {
        goalObjective: input.goal.objective,
        goalStatus: input.goal.status,
      },
    };
    await this.options.runStore.saveWaitingInput({
      runId: input.runId,
      request,
      resumeHandle,
      ...(input.outputText.trim() ? { outputText: input.outputText } : {}),
      now: new Date(),
    });
    return {
      status: "waiting_for_input",
      runId: input.runId,
      outputText: input.outputText.trim() ? input.outputText : request.question,
      request,
      resumeHandle,
      ...usageField(input.usage),
      warnings: input.warnings,
    };
  }

  async prewarmCleanThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<readonly AppServerWarning[]> {
    if (!this.cleanThreadPrewarmEnabled()) return [];
    try {
      await this.prepareCleanThreadNow(input);
      return this.drainWarnings();
    } catch (error) {
      return [cleanThreadPrewarmWarning(error)];
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (this.exited) return;
    const exit = onceEvent(child as unknown as EventEmitter, "exit").catch(
      () => undefined,
    );
    try {
      child.stdin.end();
    } catch {
      // The process may have already closed stdin.
    }
    signalChildGroup(child, "SIGTERM");
    const timeout = setTimeout(() => {
      signalChildGroup(child, "SIGKILL");
    }, 5_000);
    try {
      await exit;
    } catch {
      // Best-effort shutdown.
    } finally {
      clearTimeout(timeout);
      signalChildGroup(child, "SIGKILL");
    }
  }

  private drainWarnings(): AppServerWarning[] {
    const warnings = [...this.backgroundWarnings, ...this.serverRequests];
    this.backgroundWarnings.length = 0;
    this.serverRequests.length = 0;
    return warnings;
  }

  private takePreparedThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
  }): PreparedThread | null {
    const prepared = this.preparedThread;
    if (!prepared) return null;
    this.preparedThread = null;
    if (
      prepared.workspacePath !== input.workspacePath ||
      prepared.model !== input.model ||
      prepared.reasoningEffort !== input.reasoningEffort ||
      prepared.serviceTier !== input.serviceTier ||
      prepared.sandboxMode !== (input.sandboxMode ?? "read-only") ||
      prepared.systemPrompt !== normalizeSystemPrompt(input.systemPrompt)
    ) {
      this.backgroundWarnings.push({
        code: "codex_app_server_prepared_thread_discarded",
        safeMessage:
          "Codex app-server discarded a prepared thread because the next task used a different runtime context.",
      });
      return null;
    }
    return prepared;
  }

  private prepareCleanThreadBestEffort(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): void {
    if (!this.cleanThreadPrewarmEnabled() || input.abortSignal.aborted) return;
    void this.prepareCleanThreadNow(input).catch((error: unknown) => {
      this.backgroundWarnings.push(cleanThreadPrewarmWarning(error));
    });
  }

  private async prepareCleanThreadNow(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void> {
    if (!this.cleanThreadPrewarmEnabled()) return;
    if (this.preparedThread && this.preparedThreadMatches(input)) return;
    if (this.prepareThreadInFlight) return await this.prepareThreadInFlight;

    this.prepareThreadInFlight = this.startThread(input)
      .then((threadId) => {
        this.preparedThread = {
          threadId,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          sandboxMode: input.sandboxMode ?? "read-only",
          systemPrompt: normalizeSystemPrompt(input.systemPrompt),
        };
      })
      .finally(() => {
        this.prepareThreadInFlight = null;
      });
    await this.prepareThreadInFlight;
  }

  private preparedThreadMatches(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
  }): boolean {
    return (
      this.preparedThread?.workspacePath === input.workspacePath &&
      this.preparedThread.model === input.model &&
      this.preparedThread.reasoningEffort === input.reasoningEffort &&
      this.preparedThread.serviceTier === input.serviceTier &&
      this.preparedThread.sandboxMode === (input.sandboxMode ?? "read-only") &&
      this.preparedThread.systemPrompt === normalizeSystemPrompt(input.systemPrompt)
    );
  }

  private cleanThreadPrewarmEnabled(): boolean {
    return this.options.cleanThreadPrewarm ?? true;
  }

  private async startThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
  }): Promise<string> {
    const disableTools =
      this.options.executionProfile.disableTools && input.goalMode !== true;
    const features = {
      apps: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      shell_snapshot: false,
      skill_mcp_dependency_install: false,
      ...(input.serviceTier === "fast" ? { fast_mode: true } : {}),
      ...(input.goalMode ? { goals: true } : {}),
    };
    const response = await this.send(
      "thread/start",
      {
        model: input.model,
        modelProvider: null,
        serviceTier: input.serviceTier ?? null,
        cwd: input.workspacePath,
        runtimeWorkspaceRoots: [input.workspacePath],
        approvalPolicy: this.approvalPolicyForThread(),
        approvalsReviewer: null,
        sandbox: input.sandboxMode ?? "read-only",
        config: {
          model_reasoning_effort: input.reasoningEffort,
          model_verbosity: "low",
          ...(input.serviceTier === undefined
            ? {}
            : { service_tier: input.serviceTier }),
          approval_policy:
            this.options.commandApprovalPolicy === undefined ? "never" : "on-request",
          sandbox_mode: input.sandboxMode ?? "read-only",
          web_search: "disabled",
          features,
          apps: {
            _default: {
              enabled: false,
              destructive_enabled: false,
              open_world_enabled: false,
            },
          },
        },
        serviceName: "subscription-runtime",
        baseInstructions: this.options.executionProfile.baseInstructions,
        developerInstructions:
          mergeDeveloperInstructions({
            base: this.options.executionProfile.developerInstructions,
            ...(input.systemPrompt !== undefined
              ? { systemPrompt: input.systemPrompt }
              : {}),
          }),
        personality: null,
        ephemeral: input.goalMode ? false : true,
        sessionStartSource: "startup",
        threadSource: "user",
        ...(disableTools
          ? {
              environments: [],
              dynamicTools: [],
              experimentalRawEvents: false,
            }
          : {}),
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_thread_start_failed:${response.error.message ?? "unknown"}`,
      );
    }

    const threadId = nestedString(response.result, ["thread", "id"]);
    if (!threadId) throw new Error("codex_app_server_thread_id_missing");
    return threadId;
  }

  private async setGoal(input: {
    readonly threadId: string;
    readonly objective: string;
    readonly status: CodexThreadGoalStatus;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexThreadGoal> {
    const response = await this.send(
      "thread/goal/set",
      {
        threadId: input.threadId,
        objective: input.objective,
        status: input.status,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_goal_set_failed:${response.error.message ?? "unknown"}`,
      );
    }
    const goal = readGoal(response.result?.goal);
    if (!goal) throw new Error("codex_app_server_goal_set_missing");
    return goal;
  }

  private async getGoal(input: {
    readonly threadId: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexThreadGoal | null> {
    const response = await this.send(
      "thread/goal/get",
      {
        threadId: input.threadId,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_goal_get_failed:${response.error.message ?? "unknown"}`,
      );
    }
    return readGoal(response.result?.goal);
  }

  private async startTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
  }): Promise<TurnState> {
    const disableTools =
      this.options.executionProfile.disableTools && input.goalMode !== true;
    const response = await this.send(
      "turn/start",
      {
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: [],
          },
        ],
        responsesapiClientMetadata: null,
        additionalContext: null,
        ...(disableTools ? { environments: [] } : {}),
        cwd: null,
        runtimeWorkspaceRoots: null,
        approvalPolicy: this.approvalPolicyForThread(),
        approvalsReviewer: null,
        sandboxPolicy: null,
        model: input.model,
        serviceTier: input.serviceTier ?? null,
        effort: input.reasoningEffort,
        summary: "none",
        personality: null,
        outputSchema: input.outputSchema ?? null,
        collaborationMode: null,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_turn_start_failed:${response.error.message ?? "unknown"}`,
      );
    }

    const turnId = nestedString(response.result, ["turn", "id"]);
    if (!turnId) throw new Error("codex_app_server_turn_id_missing");
    return this.waitForTurn(turnId, input);
  }

  private send(
    method: string,
    params: unknown,
    input: {
      readonly timeoutMs?: number;
      readonly abortSignal?: AbortSignal;
    } = {},
  ): Promise<JsonRpcResponse> {
    if (!this.child) throw new Error("codex_app_server_not_started");
    throwIfAborted(input.abortSignal);
    if (this.terminalError) throw this.terminalError;
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutMs = input.timeoutMs ?? this.options.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        input.abortSignal?.removeEventListener("abort", abort);
        reject(new Error(`codex_app_server_request_timeout:${method}`));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`codex_app_server_aborted:${method}`));
      };
      input.abortSignal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          input.abortSignal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          input.abortSignal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
      try {
        this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        input.abortSignal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("codex_app_server_write_failed"),
        );
      }
    });
  }

  private approvalPolicyForThread(): unknown {
    if (this.options.commandApprovalPolicy === undefined) return "never";
    return {
      granular: {
        mcp_elicitations: false,
        request_permissions: false,
        rules: true,
        sandbox_approval: true,
        skill_approval: false,
      },
    };
  }

  private waitForTurn(
    turnId: string,
    input: {
      readonly threadId: string;
      readonly timeoutMs: number;
      readonly abortSignal: AbortSignal;
    },
  ): Promise<TurnState> {
    const earlyTurnId = this.earlyTurnIdsByThread.get(input.threadId);
    if (earlyTurnId) {
      this.earlyTurnIdsByThread.delete(input.threadId);
      this.aliasTurnId(earlyTurnId, turnId);
    }
    const existing = this.turns.get(turnId);
    if (existing?.completed || existing?.error) {
      this.clearTurnTracking(turnId, input.threadId);
      return Promise.resolve(existing);
    }
    if (this.terminalError) {
      return Promise.resolve({
        ...createTurnState(),
        error: this.terminalError,
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearTurnTracking(turnId, input.threadId);
        input.abortSignal.removeEventListener("abort", abort);
        reject(new Error(`codex_app_server_turn_timeout:${turnId}`));
      }, input.timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.clearTurnTracking(turnId, input.threadId);
        reject(new Error(`codex_app_server_turn_aborted:${turnId}`));
      };
      input.abortSignal.addEventListener("abort", abort, { once: true });
      const turn = existing ?? createTurnState();
      turn.waiters.push((state) => {
        clearTimeout(timer);
        input.abortSignal.removeEventListener("abort", abort);
        this.clearTurnTracking(turnId, input.threadId);
        resolve(state);
      });
      this.turns.set(turnId, turn);
      this.pendingTurnIdsByThread.set(input.threadId, turnId);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (
      typeof record.id === "number" &&
      ("result" in record || "error" in record)
    ) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      pending.resolve(record as JsonRpcResponse);
      return;
    }

    const params = readRecord(record.params);
    if (typeof record.id === "number" && typeof record.method === "string") {
      this.onServerRequest(record.id, record.method, params);
      return;
    }

    if (typeof record.method !== "string") return;
    if (record.method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId");
      const turn = this.ensureTurn(turnId);
      this.clearReconnectGraceTimer(turn);
      turn.outputText += stringField(params, "delta") ?? "";
      return;
    }
    if (record.method === "turn/started") {
      const threadId = stringField(params, "threadId");
      const turn = readRecord(params?.turn);
      const actualTurnId = stringField(turn, "id");
      const expectedTurnId = threadId
        ? this.pendingTurnIdsByThread.get(threadId)
        : undefined;
      if (actualTurnId && expectedTurnId && actualTurnId !== expectedTurnId) {
        this.aliasTurnId(actualTurnId, expectedTurnId);
      } else if (
        actualTurnId &&
        threadId &&
        !expectedTurnId &&
        !this.turnIdAliases.has(actualTurnId)
      ) {
        this.earlyTurnIdsByThread.set(threadId, actualTurnId);
      }
      return;
    }
    if (record.method === "item/completed") {
      const turnId = stringField(params, "turnId");
      const item = readRecord(params?.item);
      if (item?.type === "agentMessage") {
        const text = agentMessageText(item);
        if (text) {
          const turn = this.ensureTurn(turnId);
          this.clearReconnectGraceTimer(turn);
          turn.outputText = text;
        }
      }
      return;
    }
    if (record.method === "turn/completed") {
      const turn = readRecord(params?.turn);
      const turnId = stringField(turn, "id");
      const state = this.ensureTurn(turnId);
      state.completed = true;
      state.usage = mergeAgentUsage(
        state.usage,
        readUsageFromRecords(turn, params, record),
      );
      const status = readRecord(turn?.status);
      if (status?.type === "failed") {
        state.error = new Error(
          `codex_app_server_turn_failed:${safeMessage(
            turn?.error ?? status ?? params ?? record,
          )}`,
        );
      }
      this.resolveTurn(state);
      return;
    }
    if (record.method === "turn/aborted" || record.method === "turn_aborted") {
      const turnId =
        stringField(params, "turnId") ??
        stringField(params, "turn_id") ??
        stringField(readRecord(params?.turn), "id");
      const reason =
        stringField(params, "reason") ??
        stringField(readRecord(params?.status), "reason") ??
        "unknown";
      const error = new Error(
        `codex_app_server_turn_aborted:${reason}:${turnId ?? "unknown"}`,
      );
      if (!turnId) {
        for (const turn of this.turns.values()) {
          turn.error = error;
          this.resolveTurn(turn);
        }
        return;
      }
      const turn = this.ensureTurn(turnId);
      turn.error = error;
      this.resolveTurn(turn);
      return;
    }
    if (record.method === "error") {
      const turnId = stringField(params, "turnId");
      const message = safeMessage(params?.error ?? params ?? record);
      if (isCodexAppServerReconnectProgressMessage(message)) {
        this.deferTurnsForReconnectProgress(turnId, message);
        return;
      }
      const error = new Error(`codex_app_server_error:${message}`);
      if (!turnId) {
        for (const turn of this.turns.values()) {
          turn.error = error;
          this.resolveTurn(turn);
        }
        return;
      }
      const turn = this.ensureTurn(turnId);
      turn.error = error;
      this.resolveTurn(turn);
    }
  }

  private deferTurnsForReconnectProgress(
    turnId: string | null,
    message: string,
  ): void {
    const turns =
      turnId === null ? [...this.turns.values()] : [this.ensureTurn(turnId)];
    if (turns.length === 0) {
      this.backgroundWarnings.push({
        code: "codex_app_server_reconnecting",
        safeMessage: message,
      });
      return;
    }
    for (const turn of turns) {
      this.scheduleReconnectGraceTimeout(turn, message);
    }
  }

  private scheduleReconnectGraceTimeout(
    turn: TurnState,
    message: string,
  ): void {
    this.clearReconnectGraceTimer(turn);
    turn.reconnectGraceTimer = setTimeout(() => {
      if (turn.completed || turn.error) return;
      turn.error = new Error(
        `codex_app_server_reconnect_timeout:${safeMessage(message)}`,
      );
      this.resolveTurn(turn);
    }, this.options.reconnectGraceMs);
  }

  private onServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown> | null,
  ): void {
    if (this.tryHandleApprovalServerRequest(id, method, params)) return;
    this.serverRequests.push({
      code: "codex_app_server_unsupported_request",
      safeMessage: `Codex app-server requested unsupported client method: ${method}`,
    });
    this.respondServerRequestError(id, `unsupported_server_request:${method}`);
  }

  private tryHandleApprovalServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown> | null,
  ): boolean {
    if (method === "item/commandExecution/requestApproval") {
      const commandText = stringField(params, "command") ?? undefined;
      const cwd = stringField(params, "cwd") ?? undefined;
      const decision = this.reviewCommandApproval({
        source: "command_execution",
        ...(commandText === undefined ? {} : { commandText }),
        ...(cwd === undefined ? {} : { cwd }),
      });
      this.respondServerRequest(id, {
        decision: decision.approved ? "accept" : "decline",
      });
      return true;
    }
    if (method === "execCommandApproval") {
      const command = stringArrayField(params, "command") ?? undefined;
      const cwd = stringField(params, "cwd") ?? undefined;
      const decision = this.reviewCommandApproval({
        source: "legacy_exec",
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
      });
      this.respondServerRequest(id, {
        decision: decision.approved ? "approved" : "denied",
      });
      return true;
    }
    if (method === "item/fileChange/requestApproval") {
      this.serverRequests.push({
        code: "codex_app_server_file_change_approval_denied",
        safeMessage:
          "Codex app-server requested file change approval; subscription-runtime denies provider-side file grants.",
      });
      this.respondServerRequest(id, { decision: "decline" });
      return true;
    }
    if (method === "applyPatchApproval") {
      this.serverRequests.push({
        code: "codex_app_server_apply_patch_approval_denied",
        safeMessage:
          "Codex app-server requested patch approval; subscription-runtime denies provider-side patch grants.",
      });
      this.respondServerRequest(id, { decision: "denied" });
      return true;
    }
    if (method === "item/permissions/requestApproval") {
      this.serverRequests.push({
        code: "codex_app_server_permission_request_denied",
        safeMessage:
          "Codex app-server requested additional permissions; subscription-runtime denies provider-side permission expansion.",
      });
      this.respondServerRequestError(
        id,
        "codex_app_server_permission_request_denied",
      );
      return true;
    }
    return false;
  }

  private reviewCommandApproval(
    input: CodexAppServerCommandApprovalInput,
  ): CodexAppServerCommandApprovalDecision {
    const policy = this.options.commandApprovalPolicy;
    const decision = policy?.reviewCommand(input) ?? {
      approved: false,
      reason: "approval_policy_not_configured",
    };
    if (!decision.approved) {
      this.serverRequests.push({
        code: "codex_app_server_command_approval_denied",
        safeMessage: `Codex app-server command approval denied: ${safeMessage(decision.reason ?? "unknown")}`,
      });
    }
    return decision;
  }

  private respondServerRequest(id: number, result: Record<string, unknown>): void {
    try {
      this.child?.stdin.write(
        `${JSON.stringify({
          id,
          result,
        })}\n`,
      );
    } catch (error) {
      this.recordTerminalError(
        new Error(
          `codex_app_server_unsupported_response_failed:${safeMessage(error)}`,
        ),
      );
    }
  }

  private respondServerRequestError(id: number, message: string): void {
    try {
      this.child?.stdin.write(
        `${JSON.stringify({
          id,
          error: {
            code: -32000,
            message,
          },
        })}\n`,
      );
    } catch (error) {
      this.recordTerminalError(
        new Error(
          `codex_app_server_unsupported_response_failed:${safeMessage(error)}`,
        ),
      );
    }
  }

  private ensureTurn(turnId: string | null): TurnState {
    if (!turnId) return createTurnState();
    const canonicalTurnId = this.turnIdAliases.get(turnId) ?? turnId;
    let turn = this.turns.get(canonicalTurnId);
    if (!turn) {
      turn = createTurnState();
      this.turns.set(canonicalTurnId, turn);
    }
    return turn;
  }

  private resolveTurn(turn: TurnState): void {
    this.clearReconnectGraceTimer(turn);
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter(turn);
  }

  private failOutstanding(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      turn.error = error;
      this.resolveTurn(turn);
    }
    this.pendingTurnIdsByThread.clear();
    this.earlyTurnIdsByThread.clear();
    this.turnIdAliases.clear();
  }

  private recordTerminalError(error: Error): void {
    this.terminalError = this.terminalError ?? error;
    this.failOutstanding(this.terminalError);
  }

  private clearTurnTracking(turnId: string, threadId: string): void {
    this.turns.delete(turnId);
    this.pendingTurnIdsByThread.delete(threadId);
    this.earlyTurnIdsByThread.delete(threadId);
    this.deleteTurnAliases(turnId);
  }

  private deleteTurnAliases(turnId: string): void {
    for (const [actualTurnId, expectedTurnId] of this.turnIdAliases) {
      if (actualTurnId === turnId || expectedTurnId === turnId) {
        this.turnIdAliases.delete(actualTurnId);
      }
    }
  }

  private aliasTurnId(actualTurnId: string, expectedTurnId: string): void {
    if (actualTurnId === expectedTurnId) return;
    this.turnIdAliases.set(actualTurnId, expectedTurnId);
    const actual = this.turns.get(actualTurnId);
    if (!actual) return;
    const expected = this.turns.get(expectedTurnId);
    if (expected) {
      expected.outputText += actual.outputText;
      expected.completed = expected.completed || actual.completed;
      expected.error = expected.error ?? actual.error;
      expected.waiters.push(...actual.waiters);
      if (expected.completed || expected.error) {
        this.resolveTurn(expected);
      }
    } else {
      this.turns.set(expectedTurnId, actual);
    }
    this.turns.delete(actualTurnId);
  }

  private clearReconnectGraceTimer(turn: TurnState): void {
    if (!turn.reconnectGraceTimer) return;
    clearTimeout(turn.reconnectGraceTimer);
    turn.reconnectGraceTimer = null;
  }
}

function spawnCodexAppServerProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): CodexAppServerChildProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  return child;
}

function createTurnState(): TurnState {
  return {
    outputText: "",
    usage: undefined,
    completed: false,
    error: null,
    waiters: [],
    reconnectGraceTimer: null,
  };
}

function appServerFallbackWarning(error: unknown): AppServerWarning {
  return {
    code: "codex_app_server_fallback",
    safeMessage: `Codex app-server failed; used codex exec fallback: ${safeMessage(error)}`,
  };
}

function cleanThreadPrewarmWarning(error: unknown): AppServerWarning {
  return {
    code: "codex_app_server_clean_thread_prewarm_failed",
    safeMessage: `Codex app-server clean thread prewarm failed: ${safeMessage(error)}`,
  };
}

function appServerOutputSchemaNotNativeWarning(): AppServerWarning {
  return {
    code: "codex_app_server_output_schema_not_native",
    safeMessage:
      "Codex app-server used final-text structured output parsing because no native JSON schema was registered.",
  };
}

class InMemoryManagedRunStore implements ManagedRunStorePort {
  private readonly records = new Map<string, ManagedRunRecord>();

  async get(input: { readonly runId: string }): Promise<ManagedRunRecord | null> {
    return this.records.get(input.runId) ?? null;
  }

  async saveWaitingInput(input: {
    readonly runId: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly recoveryPacket?: ManagedRunRecord["recoveryPacket"];
    readonly taskId?: string;
    readonly assignedWorkerId?: string;
    readonly providerInstanceId?: string;
    readonly workspacePath?: string;
    readonly outputText?: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    const record: ManagedRunRecord = {
      runId: input.runId,
      status: "waiting_for_input",
      request: input.request,
      resumeHandle: input.resumeHandle,
      ...(input.recoveryPacket === undefined
        ? current?.recoveryPacket === undefined
          ? {}
          : { recoveryPacket: current.recoveryPacket }
        : { recoveryPacket: input.recoveryPacket }),
      ...(input.taskId === undefined
        ? current?.taskId === undefined
          ? {}
          : { taskId: current.taskId }
        : { taskId: input.taskId }),
      ...(input.assignedWorkerId === undefined
        ? current?.assignedWorkerId === undefined
          ? {}
          : { assignedWorkerId: current.assignedWorkerId }
        : { assignedWorkerId: input.assignedWorkerId }),
      ...(input.providerInstanceId === undefined
        ? current?.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: current.providerInstanceId }
        : { providerInstanceId: input.providerInstanceId }),
      ...(input.workspacePath === undefined
        ? current?.workspacePath === undefined
          ? {}
          : { workspacePath: current.workspacePath }
        : { workspacePath: input.workspacePath }),
      ...(input.outputText === undefined ? {} : { outputText: input.outputText }),
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }

  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    if (
      !current ||
      current.status !== "waiting_for_input" ||
      current.request?.id !== input.requestId
    ) {
      throw new Error("managed_run_request_mismatch");
    }
    const record: ManagedRunRecord = {
      runId: input.runId,
      status: "active",
      ...(current.recoveryPacket === undefined
        ? {}
        : { recoveryPacket: current.recoveryPacket }),
      ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
      ...(current.assignedWorkerId === undefined
        ? {}
        : { assignedWorkerId: current.assignedWorkerId }),
      ...(current.providerInstanceId === undefined
        ? {}
        : { providerInstanceId: current.providerInstanceId }),
      ...(current.workspacePath === undefined
        ? {}
        : { workspacePath: current.workspacePath }),
      ...(current.outputText === undefined
        ? {}
        : { outputText: current.outputText }),
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }

  async complete(input: {
    readonly runId: string;
    readonly outputText: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "completed",
      outputText: input.outputText,
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }

  async fail(
    input: Parameters<ManagedRunStorePort["fail"]>[0],
  ): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "failed",
      failure: input.failure,
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }
}

function isAppServerWaitingForInputResult(
  result: { readonly status?: string },
): result is AppServerWaitingForInputResult {
  return result.status === "waiting_for_input";
}

function redactWaitingForInputResult(input: {
  readonly result: AppServerWaitingForInputResult;
  readonly outputText: string;
  readonly redactor: RedactorPort;
}): CodexExecutionResult {
  const contextSummary = input.result.request.contextSummary;
  const suggestedAnswers = input.result.request.suggestedAnswers?.map((answer) =>
    input.redactor.redact(answer),
  );
  const providerState = input.result.resumeHandle.providerState;
  return {
    status: "waiting_for_input",
    runId: input.result.runId,
    outputText: input.outputText,
    request: {
      id: input.result.request.id,
      kind: input.result.request.kind,
      question: input.redactor.redact(input.result.request.question),
      ...(contextSummary === undefined
        ? {}
        : { contextSummary: input.redactor.redact(contextSummary) }),
      ...(suggestedAnswers === undefined ? {} : { suggestedAnswers }),
      audience: input.result.request.audience,
    },
    resumeHandle: {
      ...input.result.resumeHandle,
      ...(providerState === undefined
        ? {}
        : { providerState: redactStringRecord(providerState, input.redactor) }),
    },
    warnings: input.result.warnings,
  };
}

function redactStringRecord(
  record: Readonly<Record<string, string>>,
  redactor: RedactorPort,
): Readonly<Record<string, string>> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = redactor.redact(value);
  }
  return redacted;
}

function normalizeRunId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : `codex-managed-run-${randomUUID()}`;
}

function buildGoalResumePrompt(input: {
  readonly requestId: string;
  readonly answer: string;
  readonly goalContinuePrompt: string;
}): string {
  const answer = input.answer.trim() || "(empty answer)";
  return [
    `Additional information for pending request ${input.requestId}:`,
    answer,
    "",
    input.goalContinuePrompt,
  ].join("\n");
}

function goalInputRequest(input: {
  readonly runId: string;
  readonly goal: CodexThreadGoal;
  readonly outputText: string;
}): ManagedRunInputRequest {
  const question =
    input.outputText.trim() ||
    `Codex goal is ${input.goal.status} and needs input before it can continue.`;
  return {
    id: `managed-input-${randomUUID()}`,
    kind: input.goal.status === "paused" ? "decision_required" : "missing_context",
    question,
    contextSummary: `Goal: ${input.goal.objective}\nStatus: ${input.goal.status}`,
    audience: "orchestrator",
  };
}

function goalMaxTurnsExceededError(input: {
  readonly maxGoalTurns: number;
  readonly outputText: string;
}): Error {
  const error = new Error(
    `codex_app_server_goal_max_turns_exceeded:${input.maxGoalTurns}`,
  ) as Error & { lastOutputText?: string };
  const outputText = input.outputText.trim();
  if (outputText) error.lastOutputText = outputText;
  return error;
}

function managedRunFailureFromError(error: unknown): ProviderFailure {
  if (isAbortLikeError(error)) {
    return {
      code: "task_cancelled",
      retryable: false,
      reconnectRequired: false,
      safeMessage: "Codex managed run resume was cancelled.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return {
      code: "task_timeout",
      retryable: true,
      reconnectRequired: false,
      safeMessage: "Codex managed run resume timed out.",
    };
  }
  return {
    code: "unknown_runtime_failure",
    retryable: true,
    reconnectRequired: false,
    safeMessage: "Codex managed run resume failed.",
  };
}

function isManagedRunResumeValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("codex_managed_run_")
  );
}

function signalChildGroup(
  child: CodexAppServerChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform === "win32" || !child.pid) {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }
}

function nestedString(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    const record = readRecord(current);
    current = record?.[segment];
  }
  return typeof current === "string" ? current : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

function stringArrayField(
  record: Record<string, unknown> | null,
  field: string,
): readonly string[] | null {
  const value = record?.[field];
  if (!Array.isArray(value)) return null;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length === value.length ? values : null;
}

function agentMessageText(item: Record<string, unknown>): string | null {
  return stringifyContent(item.text) ?? stringifyContent(item.content);
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyContentEntry(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (!isAssistantContentRecord(record)) return null;
    return stringifyContent(
      record.text ?? record.output_text ?? record.content ?? record.output,
    );
  }
  return null;
}

function stringifyContentEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (!isAssistantContentRecord(record)) return null;
  return stringifyContent(
    record.text ?? record.output_text ?? record.content ?? record.output,
  );
}

function isAssistantContentRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : null;
  if (!hasAssistantRole(record)) return false;
  return (
    !type ||
    type === "agentMessage" ||
    type === "agent_message" ||
    type === "assistant_message" ||
    type === "message" ||
    type === "output_text" ||
    type === "text"
  );
}

function hasAssistantRole(record: Record<string, unknown>): boolean {
  const role = record.role;
  return typeof role !== "string" || role === "assistant";
}

function readGoal(value: unknown): CodexThreadGoal | null {
  const goal = readRecord(value);
  if (!goal) return null;
  const threadId = stringField(goal, "threadId");
  const objective = stringField(goal, "objective");
  const status = stringField(goal, "status");
  if (!threadId || !objective || !isGoalStatus(status)) return null;
  return {
    threadId,
    objective,
    status,
    ...usageField(readUsage(goal)),
  };
}

function readUsageFromRecords(...values: readonly unknown[]): AgentUsage | undefined {
  let usage: AgentUsage | undefined;
  for (const value of values) {
    usage = mergeAgentUsage(usage, readUsage(value));
  }
  return usage;
}

function readUsage(value: unknown): AgentUsage | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const direct = normalizeUsageRecord(record);
  const nested = readUsageFromRecords(
    record.usage,
    record.tokenUsage,
    record.token_usage,
    record.tokens,
    record.metrics,
    readRecord(record.status)?.usage,
  );
  return mergeAgentUsage(direct, nested);
}

function normalizeUsageRecord(
  record: Record<string, unknown>,
): AgentUsage | undefined {
  const inputTokens = numberField(
    record,
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "totalInputTokens",
    "total_input_tokens",
  );
  const outputTokens = numberField(
    record,
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalOutputTokens",
    "total_output_tokens",
  );
  const totalTokens =
    numberField(
      record,
      "totalTokens",
      "total_tokens",
      "tokensUsed",
      "tokens_used",
      "usedTokens",
      "used_tokens",
    ) ?? derivedTotalTokens(inputTokens, outputTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function numberField(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function derivedTotalTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}

function mergeAgentUsage(
  left: AgentUsage | undefined,
  right: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const inputTokens = sumOptional(left.inputTokens, right.inputTokens);
  const outputTokens = sumOptional(left.outputTokens, right.outputTokens);
  const totalTokens = sumOptional(left.totalTokens, right.totalTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function preferredUsage(
  turnUsage: AgentUsage | undefined,
  goalUsage: AgentUsage | undefined,
): AgentUsage | undefined {
  if (hasDetailedUsage(turnUsage)) return turnUsage;
  return turnUsage ?? goalUsage;
}

function hasDetailedUsage(usage: AgentUsage | undefined): boolean {
  return usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;
}

function usageField(
  usage: AgentUsage | undefined,
): { readonly usage: AgentUsage } | Record<string, never> {
  return usage === undefined ? {} : { usage };
}

function sumOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function isGoalStatus(value: string | null): value is CodexThreadGoalStatus {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete"
  );
}

function parseStructuredOutput(outputText: string): unknown {
  return parseCodexStructuredOutput(
    outputText,
    "codex_app_server_structured_output_invalid",
  );
}

function assertOutputWithinBounds(
  output: string,
  maxOutputBytes = defaultMaxOutputBytes,
): void {
  if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
    throw new Error("codex_app_server_output_too_large");
  }
}

function controlRequestTimeoutMs(taskTimeoutMs: number): number {
  return Math.min(taskTimeoutMs, defaultControlRequestTimeoutMs);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("codex_app_server_aborted");
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("codex_app_server_aborted") ||
      error.message.includes("codex_app_server_turn_aborted") ||
      error.message.includes("node_process_runner_aborted"))
  );
}

function isCodexAppServerReconnectProgressMessage(message: string): boolean {
  return /\breconnecting(?:\.{3}|…)?\s*\d+\s*\/\s*\d+\b/i.test(message);
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(-1000);
  if (typeof error === "string") return error.slice(-1000);
  const record = readRecord(error);
  if (typeof record?.message === "string") return record.message.slice(-1000);
  const nested = record ? readRecord(record.error) : null;
  if (typeof nested?.message === "string") return nested.message.slice(-1000);
  return "unknown";
}

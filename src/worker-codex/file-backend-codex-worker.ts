import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type ProviderTask,
  type ProviderTaskResult,
  type RefreshThenRunResult,
  type RedactorPort,
  type RuntimeDeps,
  assertProviderTaskSystemPrompt,
} from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexCliSessionDriver,
  type CodexExecutionProfile,
  CodexJsonAgentDriver,
  CodexWorkerCacheSessionPoolMaterializer,
  PackagedCodexJsonExecutionEngine,
  defaultCodexModel,
  type CodexAppServerProcessFactory,
  type CodexReasoningEffort,
  sessionArtifactFromCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import {
  SubscriptionWorkerError,
  type SubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
} from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import { NullWorkerObservability } from "../worker-local/observability";
import { StableWorkerWorkspace } from "../worker-local/temp-workspace";

export type FileBackendCodexWorkerOptions = {
  readonly workerId?: string;
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array | string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly sessionCacheSlots?: number;
  /**
   * Prompt used to fully warm the Codex app-server and model path.
   * Set to false to warm only the daemon process.
   */
  readonly warmupPrompt?: string | false;
  readonly taskTimeoutMs?: number;
  readonly refreshFreshnessMs?: number;
  readonly refreshBeforeExpiryMs?: number;
  readonly maxSessionAgeMs?: number;
  readonly refreshConflictRetryMaxMs?: number;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly appServerProcessFactory?: CodexAppServerProcessFactory;
  readonly executionProfile?: CodexExecutionProfile;
  readonly cleanThreadPrewarm?: boolean;
  readonly observability?: ObservabilityPort;
  readonly runner?: RuntimeDeps["runner"];
  readonly workspace?: RuntimeDeps["workspace"];
  readonly workspacePath?: string;
  readonly clock?: ClockPort;
};

export type FileBackendCodexWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type FileBackendCodexWorkerResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export class FileBackendCodexWorker implements SubscriptionWorker<
  FileBackendCodexWorkerJob,
  FileBackendCodexWorkerResult
> {
  readonly workerId: string;
  private workerState: SubscriptionWorkerState = "created";
  private readonly redactor: RedactorPort = new DefaultRedactor();
  private readonly runner: RuntimeDeps["runner"];
  private readonly workspace: RuntimeDeps["workspace"];
  private readonly observability: ObservabilityPort;
  private readonly clock: ClockPort;
  private readonly sessionDriver: CodexCliSessionDriver;
  private readonly agentDriver: CodexJsonAgentDriver;
  private readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  private readonly runtime;
  private readonly ownedWorkspace: StableWorkerWorkspace | null;

  constructor(private readonly options: FileBackendCodexWorkerOptions) {
    this.workerId =
      options.workerId ??
      `file-backend-codex:${hashText(options.providerInstanceId).slice(0, 12)}`;
    assertWorkerOptions(options);
    this.runner = options.runner ?? new NodeProcessRunner();
    // SAFETY (iliya — data-loss fix): derive a PRIVATE workspace path under
    // stateRootDir; do NOT fall back to `options.workspacePath`. The owned
    // StableWorkerWorkspace `rm -rf`s its rootDir on dispose, so when the caller
    // passes its real cwd as workspacePath (the agent-task-runner-cli does:
    // `workspacePath: input.cwd`), disposing this worker DELETES the caller's
    // working directory — observed wiping a whole repo checkout on a *failed*
    // codex run (the dispose runs on the failure path too). The claude worker
    // (file-backend-claude-worker.ts:161-168) already derives a private path for
    // exactly this reason; this matches it. `options.workspacePath` (an existing
    // caller checkout) must never be owned/deleted by the worker. Suggest also
    // hardening StableWorkerWorkspace.dispose() to refuse paths it didn't create
    // / outside the state+temp roots, as defense-in-depth.
    const defaultWorkspacePath = join(
      options.stateRootDir,
      "workspaces",
      hashText(this.workerId),
    );
    this.ownedWorkspace = options.workspace
      ? null
      : new StableWorkerWorkspace(defaultWorkspacePath);
    this.workspace = options.workspace ?? this.ownedWorkspace!;
    this.observability = options.observability ?? new NullWorkerObservability();
    this.clock = options.clock ?? systemClock;

    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "codex",
      rootDir: join(options.stateRootDir, "sessions"),
      encryptionKey: options.encryptionKey,
      metadata: { adapter: "file-backend-codex-worker" },
    });
    this.sessionStore = sessionStore;

    this.sessionDriver = new CodexCliSessionDriver({
      codexBinaryPath: options.codexBinaryPath,
      model: options.model ?? defaultCodexModel,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      refreshMode: "lazy-refresh",
    });

    const fallback = new PackagedCodexJsonExecutionEngine({
      codexBinaryPath: options.codexBinaryPath,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
    });
    this.agentDriver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: options.codexBinaryPath,
        ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
        ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
        ...(options.appServerProcessFactory
          ? { processFactory: options.appServerProcessFactory }
          : {}),
        ...(options.executionProfile
          ? { executionProfile: options.executionProfile }
          : {}),
        cleanThreadPrewarm: options.cleanThreadPrewarm ?? true,
        fallback,
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: `codex:${options.providerInstanceId}`,
        slots: options.sessionCacheSlots ?? 1,
      }),
      model: options.model ?? defaultCodexModel,
      reasoningEffort: options.reasoningEffort ?? "low",
      ...(options.warmupPrompt === false
        ? {}
        : { warmupPrompt: options.warmupPrompt ?? defaultWarmupPrompt }),
    });

    this.runtime = createSubscriptionRuntime({
      policy: {
        custodyMode: "local-only",
        requireNoBackendPlaintext: false,
        requireWritebackBeforeTask: true,
        requireCompareAndSwap: true,
        allowInteractiveSetupInRuntime: false,
        allowedProviderIds: [this.sessionDriver.providerId],
        allowedAgentIds: [this.agentDriver.agentId],
        allowedStoreIds: [sessionStore.storeId],
        allowedRunnerIds: [this.runner.runnerId],
        requestedTaskMode: "structured-prompt",
        refreshPolicy: {
          minFreshMs: options.refreshFreshnessMs ?? 15 * 60 * 1000,
          refreshBeforeExpiryMs: options.refreshBeforeExpiryMs ?? 5 * 60 * 1000,
          maxSessionAgeMs: options.maxSessionAgeMs ?? 24 * 60 * 60 * 1000,
        },
      },
      sessionDriver: this.sessionDriver,
      agentDriver: this.agentDriver,
      sessionStore,
      leaseStore,
      runner: this.runner,
      workspace: this.workspace,
      redactor: this.redactor,
      observability: this.observability,
      clock: this.clock,
      idGenerator: new DeterministicIdGenerator(),
    });
  }

  get state(): SubscriptionWorkerState {
    return this.workerState;
  }

  async start(): Promise<void> {
    if (this.workerState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Codex worker has been disposed.",
      );
    }
    if (this.workerState !== "created" && this.workerState !== "failed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_already_started",
        "Codex worker is already started.",
      );
    }
    this.workerState = "started";
  }

  async seedCodexAuthJsonFile(authJsonPath: string): Promise<void> {
    const authJson = await readFile(authJsonPath, "utf8");
    await this.seedCodexAuthJson(authJson);
  }

  async seedCodexAuthJson(authJson: string): Promise<void> {
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (existing) return;

    const artifact = sessionArtifactFromCodexAuthJson(authJson);
    await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(authJson)}`,
      leaseId: "seed-local-file-backend",
    });
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.assertStarted();
    this.workerState = "prewarming";
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "run",
    });
    if (!session) {
      this.workerState = "failed";
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Codex session is missing.",
      );
    }

    const workspace = await this.workspace.create({
      purpose: "run-task",
      isolation: "temp-dir",
    });
    try {
      const result = await this.agentDriver.prewarmSession({
        session: session.artifact,
        redactor: this.redactor,
        workspacePath: workspace.path,
        runner: this.runner,
        abortSignal: new AbortController().signal,
      });
      this.workerState = "ready";
      return {
        status: result.reusable ? "ready" : "skipped",
        warmedAt: result.warmedAt,
        warnings: result.warnings ?? [],
        details: {
          mode: result.mode,
          reusable: String(result.reusable),
          ...(result.engine
            ? {
                engine: result.engine.kind,
                engineReusable: String(result.engine.reusable),
              }
            : {}),
        },
      };
    } catch (error) {
      this.workerState = "failed";
      throw error;
    } finally {
      await workspace.dispose?.();
    }
  }

  async run(
    job: FileBackendCodexWorkerJob,
  ): Promise<FileBackendCodexWorkerResult> {
    this.assertStarted();
    assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
    const runId = job.runId ?? `local-${randomUUID()}`;
    const abortSignal = job.abortSignal ?? new AbortController().signal;
    const startedAt = this.clock.monotonicMs();
    const retryMaxMs = this.options.refreshConflictRetryMaxMs ?? 30_000;
    let attempt = 1;

    while (true) {
      const result = await this.runtime.refreshThenRunTask({
        providerInstanceId: this.options.providerInstanceId,
        task: {
          kind: job.kind ?? "structured-prompt",
          prompt: job.prompt,
          ...(job.systemPrompt !== undefined ? { systemPrompt: job.systemPrompt } : {}),
          ...(job.outputSchemaName
            ? { outputSchemaName: job.outputSchemaName }
            : {}),
          ...(job.controls ? { controls: job.controls } : {}),
          ...(job.metadata ? { metadata: job.metadata } : {}),
        },
        runContext: {
          runId,
          attempt,
          abortSignal,
        },
      });

      if (result.status === "completed") {
        return taskResultToOutput(result.task);
      }

      if (
        shouldRetryRefreshConflict(result) &&
        !abortSignal.aborted &&
        this.clock.monotonicMs() - startedAt < retryMaxMs
      ) {
        await delay(refreshConflictDelayMs(attempt), abortSignal);
        attempt += 1;
        continue;
      }

      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        result.safeMessage,
        { details: { reason: result.reason } },
      );
    }
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    try {
      const health = await this.runtime.healthCheck({
        providerInstanceId: this.options.providerInstanceId,
      });
      if (health.status === "healthy") {
        return {
          status: "healthy",
          state: this.workerState,
          checkedAt: this.clock.now(),
          warnings: health.warnings,
        };
      }
      return {
        status: "unhealthy",
        state: this.workerState,
        checkedAt: this.clock.now(),
        failures: health.failures.map((failure) => ({
          code: failure.code,
          safeMessage: failure.safeMessage,
        })),
        warnings: health.warnings,
      };
    } catch (error) {
      return {
        status: "unhealthy",
        state: "failed",
        checkedAt: this.clock.now(),
        failures: [
          {
            code: "subscription_worker_health_failed",
            safeMessage:
              error instanceof Error ? error.message : "Codex health failed.",
          },
        ],
        warnings: [],
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.workerState === "disposed") return;
    this.workerState = "draining";
    try {
      await this.agentDriver.dispose();
    } finally {
      await this.ownedWorkspace?.dispose();
      this.workerState = "disposed";
    }
  }

  private assertStarted(): void {
    if (this.workerState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Codex worker has been disposed.",
      );
    }
    if (this.workerState === "created") {
      throw new SubscriptionWorkerError(
        "subscription_worker_not_started",
        "Codex worker has not been started.",
      );
    }
  }
}

function taskResultToOutput(
  result: ProviderTaskResult,
): FileBackendCodexWorkerResult {
  if (result.status === "failed") {
    throw new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      result.failure.safeMessage,
      { details: { code: result.failure.code } },
    );
  }
  return {
    outputText: result.outputText,
    structuredOutput: result.structuredOutput,
    warnings: result.warnings,
  };
}

function shouldRetryRefreshConflict(result: RefreshThenRunResult): boolean {
  if (result.status !== "blocked") return false;
  if (result.reason === "stale_generation") return true;
  return (
    result.reason === "permission_required" &&
    /session refresh is already leased/i.test(result.safeMessage)
  );
}

function refreshConflictDelayMs(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
}

function delay(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return Promise.reject(new Error("subscription_worker_run_aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("subscription_worker_run_aborted"));
      },
      { once: true },
    );
  });
}

function assertWorkerOptions(options: FileBackendCodexWorkerOptions): void {
  if (!options.providerInstanceId.trim()) {
    throw new Error("file_backend_codex_provider_instance_required");
  }
  if (!options.stateRootDir.trim()) {
    throw new Error("file_backend_codex_state_root_required");
  }
  if (!options.codexBinaryPath.trim()) {
    throw new Error("file_backend_codex_binary_required");
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

const defaultWarmupPrompt = "Return exactly OK.";

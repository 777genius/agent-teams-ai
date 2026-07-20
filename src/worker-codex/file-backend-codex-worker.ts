import { createHash, randomUUID } from "node:crypto";
import {
  DefaultRedactor,
  type AgentUsage,
  type ClockPort,
  type ManagedRunInputRequest,
  type ManagedRunRecoveryPacket,
  type ManagedRunResumeHandle,
  type ObservabilityPort,
  type ProviderFailure,
  type ProviderTask,
  type RefreshThenRunResult,
  type RedactorPort,
  type RuntimeDeps,
  type SessionArtifact,
  assertProviderTaskSystemPrompt,
} from "@vioxen/subscription-runtime/core";
import {
  type CodexExecutionProfile,
  CodexJsonAgentDriver,
  type CodexAppServerProcessFactory,
  type CodexReasoningEffort,
  type CodexServiceTier,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  SubscriptionWorkerError,
  combineAbortSignals,
  type CapacityAwareSubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerRunOptions,
  type SubscriptionWorkerState,
  type WorkerCapacitySnapshot,
  type CommandPolicy,
} from "@vioxen/subscription-runtime/worker-core";
import { NullWorkerObservability } from "../worker-local/observability";
import {
  FileBackendCodexManagedRunCoordinator,
  type FileBackendCodexManagedRunResumeInput,
} from "./file-backend-codex-managed-run-recovery";
import {
  FileBackendCodexCapacityState,
  isSevereCapacity,
  type CodexWorkerCapacityPolicy,
} from "./file-backend-codex-capacity";
import {
  createFileBackendCodexWorkerRuntime,
  type CodexWorkerExecutionEngine,
  type FileBackendCodexWorkerRuntimeParts,
} from "./file-backend-codex-runtime-factory";
import { FileBackendCodexPrewarmer } from "./file-backend-codex-prewarm";
import { FileBackendCodexSessionSeeder } from "./file-backend-codex-session-seeding";

export type FileBackendCodexWorkerOptions = {
  readonly workerId?: string;
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array | string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sessionCacheSlots?: number;
  /**
   * Prompt used to fully warm the Codex app-server and model path.
   * Set to false to warm only the daemon process.
   */
  readonly warmupPrompt?: string | false;
  readonly taskTimeoutMs?: number;
  readonly appServerStartupTimeoutMs?: number;
  readonly refreshFreshnessMs?: number;
  readonly refreshBeforeExpiryMs?: number;
  readonly maxSessionAgeMs?: number;
  readonly refreshConflictRetryMaxMs?: number;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly executionEngine?: CodexWorkerExecutionEngine;
  readonly appServerProcessFactory?: CodexAppServerProcessFactory;
  readonly executionProfile?: CodexExecutionProfile;
  readonly cleanThreadPrewarm?: boolean;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  readonly observability?: ObservabilityPort;
  readonly runner?: RuntimeDeps["runner"];
  readonly commandPolicy?: CommandPolicy;
  readonly workspace?: RuntimeDeps["workspace"];
  readonly workspacePath?: string;
  readonly clock?: ClockPort;
  readonly capacityAccountId?: string;
  readonly capacityPolicy?: CodexWorkerCapacityPolicy;
};

export type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
export type { CodexWorkerCapacityPolicy } from "./file-backend-codex-capacity";
export type { FileBackendCodexManagedRunResumeInput } from "./file-backend-codex-managed-run-recovery";

export type FileBackendCodexWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly recoveryPacket?: ManagedRunRecoveryPacket;
};

export type FileBackendCodexWorkerResult = {
  readonly status?: "completed";
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly usage?: AgentUsage;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
} | {
  readonly status: "waiting_for_input";
  readonly runId: string;
  readonly outputText: string;
  readonly request: ManagedRunInputRequest;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly structuredOutput?: unknown;
  readonly usage?: AgentUsage;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export class FileBackendCodexWorker implements CapacityAwareSubscriptionWorker<
  FileBackendCodexWorkerJob,
  FileBackendCodexWorkerResult
> {
  readonly workerId: string;
  private workerState: SubscriptionWorkerState = "created";
  private readonly redactor: RedactorPort = new DefaultRedactor();
  private readonly runner: FileBackendCodexWorkerRuntimeParts["runner"];
  private readonly observability: ObservabilityPort;
  private readonly clock: ClockPort;
  private readonly agentDriver: FileBackendCodexWorkerRuntimeParts["agentDriver"];
  private readonly sessionStore: FileBackendCodexWorkerRuntimeParts["sessionStore"];
  private readonly runtime: FileBackendCodexWorkerRuntimeParts["runtime"];
  private readonly ownedWorkspace: FileBackendCodexWorkerRuntimeParts["ownedWorkspace"];
  private readonly capacityTracker: FileBackendCodexCapacityState;
  private readonly sessionSeeder: FileBackendCodexSessionSeeder;
  private readonly managedRuns: FileBackendCodexManagedRunCoordinator;
  private readonly prewarmer: FileBackendCodexPrewarmer;

  constructor(private readonly options: FileBackendCodexWorkerOptions) {
    this.workerId =
      options.workerId ??
      `file-backend-codex:${hashText(options.providerInstanceId).slice(0, 12)}`;
    assertWorkerOptions(options);
    this.observability = options.observability ?? new NullWorkerObservability();
    const runtimeParts = createFileBackendCodexWorkerRuntime({
      options,
      workerId: this.workerId,
      observability: this.observability,
      redactor: this.redactor,
      clock: options.clock ?? systemClock,
    });
    this.runner = runtimeParts.runner;
    this.clock = runtimeParts.clock;
    this.agentDriver = runtimeParts.agentDriver;
    this.sessionStore = runtimeParts.sessionStore;
    this.runtime = runtimeParts.runtime;
    this.ownedWorkspace = runtimeParts.ownedWorkspace;
    this.capacityTracker = new FileBackendCodexCapacityState({
      clock: this.clock,
      providerInstanceId: options.providerInstanceId,
      reasoningEffort: options.reasoningEffort ?? "low",
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.capacityAccountId === undefined
        ? {}
        : { configuredAccountId: options.capacityAccountId }),
      ...(options.serviceTier === undefined
        ? {}
        : { serviceTier: options.serviceTier }),
      ...(options.capacityPolicy === undefined
        ? {}
        : { policy: options.capacityPolicy }),
    });

    this.sessionSeeder = new FileBackendCodexSessionSeeder({
      providerInstanceId: options.providerInstanceId,
      sessionStore: this.sessionStore,
      observability: this.observability,
      clock: this.clock,
      agentId: this.agentDriver.agentId,
      onFailure: (failure) => this.recordFailure(failure),
      rememberQuotaGroup: (session) => this.rememberQuotaGroup(session),
      onAuthImported: () => this.capacityTracker.recordAuthImported(),
    });
    this.managedRuns = new FileBackendCodexManagedRunCoordinator({
      providerInstanceId: options.providerInstanceId,
      workerId: this.workerId,
      agentDriver:
        this.agentDriver instanceof CodexJsonAgentDriver ? this.agentDriver : null,
      sessionStore: this.sessionStore,
      managedRunStore: runtimeParts.managedRunStore,
      runner: this.runner,
      redactor: this.redactor,
      clock: this.clock,
      recordFailure: (failure) => this.recordFailure(failure),
      recordSuccessfulRun: () => this.recordSuccessfulRun(),
      exportAuthJsonFileQuietly: (context) =>
        this.sessionSeeder.exportAuthJsonFileQuietly(context),
      runRecoveryJob: async (job) => await this.run(job),
    });
    this.prewarmer = new FileBackendCodexPrewarmer({
      providerInstanceId: options.providerInstanceId,
      sessionStore: this.sessionStore,
      agentDriver: this.agentDriver,
      prewarmWorkspace: runtimeParts.prewarmWorkspace,
      runner: this.runner,
      redactor: this.redactor,
      now: () => this.clock.now(),
      importAuthJsonFileIfChanged: (context) =>
        this.sessionSeeder.importAuthJsonFileIfChanged(context),
      exportAuthJsonFileQuietly: (context) =>
        this.sessionSeeder.exportAuthJsonFileQuietly(context),
      rememberQuotaGroup: (session) => this.rememberQuotaGroup(session),
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
    await this.sessionSeeder.seedAuthJsonFile(authJsonPath);
  }

  async seedCodexAuthJson(authJson: string): Promise<boolean> {
    return await this.sessionSeeder.seedAuthJson(authJson);
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.assertStarted();
    this.workerState = "prewarming";
    try {
      const result = await this.prewarmer.prewarm();
      this.workerState = "ready";
      return result;
    } catch (error) {
      this.workerState = "failed";
      throw error;
    }
  }

  async run(
    job: FileBackendCodexWorkerJob,
    options: SubscriptionWorkerRunOptions = {},
  ): Promise<FileBackendCodexWorkerResult> {
    this.assertStarted();
    assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
    await this.sessionSeeder.importAuthJsonFileIfChanged("run");
    await this.rememberStoredQuotaGroup();
    const runId = job.runId ?? `local-${randomUUID()}`;
    const abort = combineAbortSignals(job.abortSignal, options.abortSignal);
    const abortSignal = abort.signal;
    const startedAt = this.clock.monotonicMs();
    const retryMaxMs = this.options.refreshConflictRetryMaxMs ?? 30_000;
    let attempt = 1;

    try {
      while (true) {
        let result: RefreshThenRunResult;
        try {
          result = await this.runtime.refreshThenRunTask({
            providerInstanceId: this.options.providerInstanceId,
            task: {
              kind: job.kind ?? "structured-prompt",
              prompt: job.prompt,
              ...(job.systemPrompt !== undefined
                ? { systemPrompt: job.systemPrompt }
                : {}),
              ...(job.outputSchemaName
                ? { outputSchemaName: job.outputSchemaName }
                : {}),
              ...(job.controls ? { controls: job.controls } : {}),
              metadata: {
                ...(job.metadata ?? {}),
                codexManagedRunId: runId,
              },
            },
            runContext: {
              runId,
              attempt,
              abortSignal,
              ...(options.onProviderTaskStarted
                ? { onProviderTaskStarted: options.onProviderTaskStarted }
                : {}),
            },
          });
        } catch (error) {
          const failure = this.agentDriver.classifyRunFailure(error);
          this.recordFailure(failure);
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            failure.safeMessage,
            {
              cause: error,
              details: {
                reason: failure.code,
                ...(failure.details ?? {}),
                ...(this.capacityTracker.accountId
                  ? { accountId: this.capacityTracker.accountId }
                  : {}),
              },
            },
          );
        }

        if (result.status === "completed") {
          return await this.managedRuns.taskResultToOutput(result.task, {
            kind: "run",
            runId,
            job,
            attempt,
          });
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

        this.recordBlocked(result.reason);
        throw new SubscriptionWorkerError(
          "subscription_worker_run_failed",
          result.safeMessage,
          { details: { reason: result.reason } },
        );
      }
    } finally {
      abort.dispose();
      await this.sessionSeeder.exportAuthJsonFileQuietly("run");
    }
  }

  async resumeManagedRun(
    input: FileBackendCodexManagedRunResumeInput,
  ): Promise<FileBackendCodexWorkerResult> {
    this.assertStarted();
    return await this.managedRuns.resume(input);
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    try {
      await this.rememberStoredQuotaGroup();
      const health = await this.runtime.healthCheck({
        providerInstanceId: this.options.providerInstanceId,
      });
      const capacity = this.capacity();
      const details = {
        ...(capacity.details ?? {}),
        availability: capacity.availability,
        recentRuns: String(capacity.recentRuns ?? 0),
      };
      if (health.status === "healthy" && isSevereCapacity(capacity)) {
        return {
          status: "degraded",
          state: this.workerState,
          checkedAt: this.clock.now(),
          failures: [
            {
              code: capacity.reason ?? capacity.availability,
              safeMessage: `Codex worker capacity is ${capacity.availability}.`,
            },
          ],
          warnings: health.warnings,
          details,
        };
      }
      if (health.status === "healthy") {
        return {
          status: "healthy",
          state: this.workerState,
          checkedAt: this.clock.now(),
          warnings: health.warnings,
          details,
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
        details,
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
      if ("dispose" in this.agentDriver) {
        await this.agentDriver.dispose();
      }
    } finally {
      await this.ownedWorkspace?.dispose();
      this.workerState = "disposed";
    }
  }

  capacity(): WorkerCapacitySnapshot {
    return this.capacityTracker.snapshot({
      workerState: this.workerState,
      authSourceChanged: this.sessionSeeder.authJsonFileChanged(),
    });
  }

  private recordSuccessfulRun(): void {
    this.capacityTracker.recordSuccessfulRun();
  }

  private recordFailure(failure: ProviderFailure): void {
    this.capacityTracker.recordFailure(failure);
  }

  private recordBlocked(reason: string): void {
    this.capacityTracker.recordBlocked(reason);
  }

  private async rememberStoredQuotaGroup(): Promise<void> {
    if (this.capacityTracker.hasKnownAccountIdentity()) return;
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (session) this.capacityTracker.rememberQuotaGroup(session.artifact);
  }

  private rememberQuotaGroup(session: SessionArtifact): void {
    this.capacityTracker.rememberQuotaGroup(session);
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
  if (options.workspace && options.workspacePath) {
    throw new Error("file_backend_codex_workspace_conflict");
  }
  if (
    options.executionEngine !== undefined &&
    options.executionEngine !== "app-server" &&
    options.executionEngine !== "app-server-goal" &&
    options.executionEngine !== "packaged-exec" &&
    options.executionEngine !== "plain-exec"
  ) {
    throw new Error("file_backend_codex_execution_engine_invalid");
  }
  assertPositiveInteger(
    options.appServerStartupTimeoutMs,
    "file_backend_codex_app_server_startup_timeout_invalid",
  );
  const softMaxRuns = options.capacityPolicy?.softMaxRunsPerWindow;
  if (
    softMaxRuns !== undefined &&
    (!Number.isInteger(softMaxRuns) || softMaxRuns <= 0)
  ) {
    throw new Error("file_backend_codex_soft_max_runs_invalid");
  }
  const windowMs = options.capacityPolicy?.windowMs;
  if (
    windowMs !== undefined &&
    (!Number.isFinite(windowMs) || windowMs <= 0)
  ) {
    throw new Error("file_backend_codex_capacity_window_invalid");
  }
  const quotaCooldownMs = options.capacityPolicy?.quotaCooldownMs;
  if (
    quotaCooldownMs !== undefined &&
    (!Number.isFinite(quotaCooldownMs) || quotaCooldownMs < 0)
  ) {
    throw new Error("file_backend_codex_quota_cooldown_invalid");
  }
}

function assertPositiveInteger(value: number | undefined, code: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

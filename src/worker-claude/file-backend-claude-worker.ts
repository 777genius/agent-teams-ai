import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskTelemetry,
  type RedactorPort,
  type RefreshThenRunResult,
  type RuntimeDeps,
  type SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import {
  ClaudeRuntimeTaskExecutionEngine,
  ClaudeSessionDriver,
  ClaudeTaskAgentDriver,
  claudeRuntimeResumeSessionIdMetadataKey,
  claudeRuntimeThreadIdMetadataKey,
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
  type ClaudeTaskExecutionEngine,
} from "@vioxen/subscription-runtime/provider-claude";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import {
  SubscriptionWorkerError,
  type CapacityAwareSubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
  type WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import { NullWorkerObservability } from "../worker-local/observability";
import { StableWorkerWorkspace } from "../worker-local/temp-workspace";
import {
  FileClaudeRateLimitTelemetry,
  type ClaudeRateLimitTelemetrySource,
  type ClaudeRateLimitWindowName,
} from "./rate-limit-telemetry";
import {
  FileClaudeLogicalThreadStore,
  FileClaudeTranscriptBundleStore,
  type ClaudeLogicalThreadState,
  type ClaudeLogicalThreadStore,
  type ClaudeTranscriptBundleStore,
} from "./thread-handoff";

export type ClaudeWorkerCapacityPolicy = {
  readonly softMaxRunsPerWindow?: number;
  readonly windowMs?: number;
  readonly quotaCooldownMs?: number;
  readonly rateLimitMinRemainingPercent?: number;
  readonly rateLimitWindows?: readonly ClaudeRateLimitWindowName[];
};

export type FileBackendClaudeWorkerOptions = {
  readonly workerId?: string;
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  readonly encryptionKey: Uint8Array | string;
  readonly configDir?: string;
  readonly model?: string;
  readonly appendSystemPrompt?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly strictMcpConfig?: boolean;
  readonly warmupPrompt?: string | false;
  readonly taskTimeoutMs?: number;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly claudePath?: string;
  readonly pollIntervalMs?: number;
  readonly capacityPolicy?: ClaudeWorkerCapacityPolicy;
  readonly rateLimitTelemetry?: ClaudeRateLimitTelemetrySource;
  readonly logicalThreadStore?: ClaudeLogicalThreadStore;
  readonly transcriptBundleStore?: ClaudeTranscriptBundleStore;
  readonly engine?: ClaudeTaskExecutionEngine;
  readonly observability?: ObservabilityPort;
  readonly runner?: RuntimeDeps["runner"];
  readonly workspace?: RuntimeDeps["workspace"];
  readonly workspacePath?: string;
  readonly clock?: ClockPort;
};

export type FileBackendClaudeWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type FileBackendClaudeWorkerResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export type FileBackendClaudeWorkerThreadJob = FileBackendClaudeWorkerJob & {
  readonly threadId: string;
};

export type FileBackendClaudeWorkerThreadResult =
  FileBackendClaudeWorkerResult & {
    readonly thread: ClaudeLogicalThreadState;
  };

export class FileBackendClaudeWorker implements CapacityAwareSubscriptionWorker<
  FileBackendClaudeWorkerJob,
  FileBackendClaudeWorkerResult
> {
  readonly workerId: string;
  readonly configDir: string;
  private workerState: SubscriptionWorkerState = "created";
  private readonly redactor: RedactorPort = new DefaultRedactor();
  private readonly runner: RuntimeDeps["runner"];
  private readonly workspace: RuntimeDeps["workspace"];
  private readonly observability: ObservabilityPort;
  private readonly clock: ClockPort;
  private readonly sessionDriver = new ClaudeSessionDriver();
  private readonly agentDriver: ClaudeTaskAgentDriver;
  private readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  private readonly runtime;
  private readonly ownedWorkspace: StableWorkerWorkspace | null;
  private readonly stableWorkspacePath: string | null;
  private readonly rateLimitTelemetry: ClaudeRateLimitTelemetrySource | null;
  private readonly logicalThreadStore: ClaudeLogicalThreadStore;
  private readonly transcriptBundleStore: ClaudeTranscriptBundleStore;
  private capacityState: WorkerCapacitySnapshot = { availability: "available" };
  private windowStartedAtMs: number;
  private runsInWindow = 0;
  private quotaGroup: string | null = null;

  constructor(private readonly options: FileBackendClaudeWorkerOptions) {
    this.workerId =
      options.workerId ??
      `file-backend-claude:${hashText(options.providerInstanceId).slice(0, 12)}`;
    assertWorkerOptions(options);
    this.configDir =
      options.configDir ??
      join(options.stateRootDir, "claude-configs", hashText(this.workerId));
    this.runner = options.runner ?? new NodeProcessRunner();
    const defaultWorkspacePath = join(
      options.stateRootDir,
      "workspaces",
      hashText(this.workerId),
    );
    this.ownedWorkspace = options.workspace
      ? null
      : new StableWorkerWorkspace(defaultWorkspacePath);
    this.workspace = options.workspace ?? this.ownedWorkspace!;
    this.stableWorkspacePath = options.workspace
      ? (options.workspacePath ?? null)
      : defaultWorkspacePath;
    this.observability = options.observability ?? new NullWorkerObservability();
    this.clock = options.clock ?? systemClock;
    this.windowStartedAtMs = this.clock.now().getTime();
    this.rateLimitTelemetry =
      options.rateLimitTelemetry ??
      (options.engine === undefined
        ? new FileClaudeRateLimitTelemetry({
            directory: join(this.configDir, "rate-limit-telemetry"),
          })
        : null);
    this.logicalThreadStore =
      options.logicalThreadStore ??
      new FileClaudeLogicalThreadStore(
        join(options.stateRootDir, "claude-logical-threads"),
      );
    this.transcriptBundleStore =
      options.transcriptBundleStore ??
      new FileClaudeTranscriptBundleStore(
        join(options.stateRootDir, "claude-transcript-bundles"),
      );

    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "claude",
      rootDir: join(options.stateRootDir, "sessions"),
      encryptionKey: options.encryptionKey,
      metadata: { adapter: "file-backend-claude-worker" },
    });
    this.sessionStore = sessionStore;

    this.agentDriver = new ClaudeTaskAgentDriver({
      engine:
        options.engine ??
        new ClaudeRuntimeTaskExecutionEngine({
          ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
          ...(options.claudePath ? { claudePath: options.claudePath } : {}),
          ...(options.taskTimeoutMs
            ? { commandTimeoutMs: options.taskTimeoutMs }
            : {}),
          ...(options.pollIntervalMs
            ? { pollIntervalMs: options.pollIntervalMs }
            : {}),
          ...(this.rateLimitTelemetry?.settingsPath
            ? { settingsPath: this.rateLimitTelemetry.settingsPath }
            : {}),
          stateFilePath: join(this.configDir, "subscription-runtime-state.json"),
        }),
      ...(options.appendSystemPrompt
        ? { appendSystemPrompt: options.appendSystemPrompt }
        : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.mcpConfig ? { mcpConfig: options.mcpConfig } : {}),
      ...(options.strictMcpConfig === undefined
        ? {}
        : { strictMcpConfig: options.strictMcpConfig }),
    });

    this.runtime = createSubscriptionRuntime({
      policy: {
        custodyMode: "local-only",
        requireNoBackendPlaintext: false,
        requireWritebackBeforeTask: false,
        requireCompareAndSwap: true,
        allowInteractiveSetupInRuntime: false,
        allowedProviderIds: [this.sessionDriver.providerId],
        allowedAgentIds: [this.agentDriver.agentId],
        allowedStoreIds: [sessionStore.storeId],
        allowedRunnerIds: [this.runner.runnerId],
        requestedTaskMode: "structured-prompt",
        refreshPolicy: {
          minFreshMs: 15 * 60 * 1000,
          refreshBeforeExpiryMs: 5 * 60 * 1000,
          maxSessionAgeMs: 24 * 60 * 60 * 1000,
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
        "Claude worker has been disposed.",
      );
    }
    if (this.workerState !== "created" && this.workerState !== "failed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_already_started",
        "Claude worker is already started.",
      );
    }
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await this.rateLimitTelemetry?.prepare?.();
    this.capacityState = { availability: "available" };
    this.workerState = "started";
  }

  async seedClaudeOAuth(input: {
    readonly oauthToken: string;
    readonly configDir?: string;
    readonly refreshedAt?: string;
    readonly expiresAt?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<void> {
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (existing) {
      this.rememberQuotaGroup(existing.artifact);
      return;
    }

    const artifact = sessionArtifactFromClaudeOAuth({
      oauthToken: input.oauthToken,
      configDir: input.configDir ?? this.configDir,
      refreshedAt: input.refreshedAt ?? this.clock.now().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(input.oauthToken)}`,
      leaseId: "seed-local-file-backend",
    });
    this.rememberQuotaGroup(artifact);
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.assertStarted();
    this.workerState = "prewarming";
    try {
      const health = await this.runtime.healthCheck({
        providerInstanceId: this.options.providerInstanceId,
      });
      if (health.status !== "healthy") {
        this.workerState = "failed";
        throw new SubscriptionWorkerError(
          "subscription_worker_prewarm_failed",
          "Claude session is not healthy.",
          {
            details: {
              reason:
                health.failures[0]?.safeMessage ?? "Claude health failed.",
            },
          },
        );
      }
      await this.assertStoredSessionHasConfigDir();
      if (this.options.warmupPrompt) {
        const warmup = await this.run({
          runId: `prewarm-${randomUUID()}`,
          kind: "health-check",
          prompt: this.options.warmupPrompt,
        });
        this.workerState = "ready";
        return {
          status: "ready",
          warmedAt: this.clock.now(),
          warnings: warmup.warnings,
          details: {
            mode: "warmup-task",
            configDir: this.configDir,
          },
        };
      }
      this.workerState = "ready";
      return {
        status: "ready",
        warmedAt: this.clock.now(),
        warnings: health.warnings,
        details: {
          mode: "context-only",
          configDir: this.configDir,
        },
      };
    } catch (error) {
      this.workerState = "failed";
      throw error;
    }
  }

  run(job: FileBackendClaudeWorkerThreadJob): Promise<FileBackendClaudeWorkerThreadResult>;
  run(job: FileBackendClaudeWorkerJob): Promise<FileBackendClaudeWorkerResult>;
  async run(
    job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob,
  ): Promise<FileBackendClaudeWorkerResult | FileBackendClaudeWorkerThreadResult> {
    if (isThreadJob(job)) return this.runThreadJob(job);
    return this.runProviderTask(job);
  }

  private async runProviderTask(
    job: FileBackendClaudeWorkerJob,
  ): Promise<FileBackendClaudeWorkerResult> {
    this.assertStarted();
    const runId = job.runId ?? `local-${randomUUID()}`;
    const abortSignal = job.abortSignal ?? new AbortController().signal;
    const result = await this.runtime.refreshThenRunTask({
      providerInstanceId: this.options.providerInstanceId,
      task: {
        kind: job.kind ?? "structured-prompt",
        prompt: job.prompt,
        ...(job.outputSchemaName
          ? { outputSchemaName: job.outputSchemaName }
          : {}),
        ...(job.controls ? { controls: job.controls } : {}),
        ...(job.metadata ? { metadata: job.metadata } : {}),
      },
      runContext: {
        runId,
        attempt: 1,
        abortSignal,
      },
    });

    if (result.status === "blocked") {
      this.recordBlocked(result.reason);
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        result.safeMessage,
        { details: { reason: result.reason } },
      );
    }

    return this.taskResultToOutput(result);
  }

  async runThreadJob(
    job: FileBackendClaudeWorkerThreadJob,
  ): Promise<FileBackendClaudeWorkerThreadResult> {
    this.assertStarted();
    const current = await this.logicalThreadStore.read(job.threadId);
    const workspacePath = this.threadWorkspacePath(job.threadId);
    const comparableWorkspacePath = current
      ? await canonicalPath(workspacePath)
      : workspacePath;
    this.assertThreadWorkspaceCompatible(
      job.threadId,
      current,
      comparableWorkspacePath,
    );
    if (current?.latestBundleId) {
      await this.transcriptBundleStore.materialize({
        bundleId: current.latestBundleId,
        targetConfigDir: this.configDir,
      });
    }

    const result = await this.runProviderTask({
      ...job,
      metadata: {
        ...(job.metadata ?? {}),
        [claudeRuntimeThreadIdMetadataKey]: job.threadId,
        ...(current?.latestSessionId === undefined
          ? {}
          : {
              [claudeRuntimeResumeSessionIdMetadataKey]:
                current.latestSessionId,
            }),
      },
    });
    const latestSessionId = result.telemetry?.providerSessionId;
    if (!latestSessionId) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Claude runtime did not return a provider session id for thread handoff.",
      );
    }

    const bundle = await this.transcriptBundleStore.capture({
      sourceConfigDir: this.configDir,
      cwd: workspacePath,
      sessionId: latestSessionId,
    });
    const thread = await this.logicalThreadStore.compareAndSwap({
      threadId: job.threadId,
      expectedGeneration: current?.generation ?? 0,
      next: {
        threadId: job.threadId,
        cwd: bundle.cwd,
        latestSessionId,
        latestBundleId: bundle.bundleId,
        latestProviderInstanceId: this.options.providerInstanceId,
        latestWorkerId: this.workerId,
        updatedAt: this.clock.now().toISOString(),
      },
    });

    return { ...result, thread };
  }

  capacity(): WorkerCapacitySnapshot {
    if (this.workerState === "created" || this.workerState === "starting") {
      return this.withCapacityDetails({
        availability: "disabled",
        reason: "not_started",
      });
    }
    if (this.workerState === "prewarming") {
      return this.withCapacityDetails({ availability: "warming" });
    }
    if (this.workerState === "disposed") {
      return this.withCapacityDetails({
        availability: "disabled",
        reason: "disposed",
      });
    }
    if (this.workerState === "failed") {
      return this.withCapacityDetails({
        availability: "degraded",
        reason: "worker_failed",
      });
    }

    this.rollCapacityWindow();
    const capacity = {
      ...this.capacityState,
      recentRuns: this.runsInWindow,
      ...(this.options.capacityPolicy?.softMaxRunsPerWindow === undefined
        ? {}
        : {
            softLimitRemainingRuns: Math.max(
              0,
              this.options.capacityPolicy.softMaxRunsPerWindow -
              this.runsInWindow,
            ),
          }),
    };
    return this.withCapacityDetails(
      mergeCapacity(capacity, this.rateLimitCapacity()),
    );
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    try {
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
              safeMessage: `Claude worker capacity is ${capacity.availability}.`,
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
              error instanceof Error ? error.message : "Claude health failed.",
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

  private taskResultToOutput(
    result: Extract<RefreshThenRunResult, { readonly status: "completed" }>,
  ): FileBackendClaudeWorkerResult {
    if (result.task.status === "failed") {
      this.recordFailure(result.task.failure);
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        result.task.failure.safeMessage,
        { details: { code: result.task.failure.code } },
      );
    }

    this.recordSuccessfulRun();
    return {
      outputText: result.task.outputText,
      structuredOutput: result.task.structuredOutput,
      ...(result.task.telemetry === undefined
        ? {}
        : { telemetry: result.task.telemetry }),
      warnings: result.task.warnings,
    };
  }

  private assertThreadWorkspaceCompatible(
    threadId: string,
    state: ClaudeLogicalThreadState | null,
    workspacePath: string,
  ): void {
    if (!state || state.cwd === workspacePath) return;
    throw new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Claude logical thread handoff requires all workers to use the same workspace path.",
      {
        details: {
          threadId,
          expectedCwd: state.cwd,
          actualCwd: workspacePath,
        },
      },
    );
  }

  private threadWorkspacePath(threadId: string): string {
    if (this.stableWorkspacePath) return this.stableWorkspacePath;
    throw new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Claude logical thread handoff requires a stable workspacePath when a custom workspace is injected.",
      { details: { threadId } },
    );
  }

  private recordSuccessfulRun(): void {
    this.rollCapacityWindow();
    this.runsInWindow += 1;
    const maxRuns = this.options.capacityPolicy?.softMaxRunsPerWindow;
    if (maxRuns === undefined || this.runsInWindow < maxRuns) return;
    const cooldownUntil = new Date(
      this.windowStartedAtMs + capacityWindowMs(this.options.capacityPolicy),
    );
    this.capacityState = {
      availability: "cooldown",
      reason: "soft_run_limit",
      cooldownUntil,
    };
  }

  private recordFailure(failure: ProviderFailure): void {
    if (failure.code === "quota_limited") {
      this.capacityState = {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil: new Date(
          this.clock.now().getTime() +
            (this.options.capacityPolicy?.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
      };
      return;
    }
    if (failure.reconnectRequired) {
      this.capacityState = {
        availability: "disabled",
        reason: failure.code,
      };
      return;
    }
    if (!failure.retryable) {
      this.capacityState = {
        availability: "degraded",
        reason: failure.code,
      };
    }
  }

  private recordBlocked(reason: string): void {
    if (reason === "quota_limited") {
      this.capacityState = {
        availability: "cooldown",
        reason,
        cooldownUntil: new Date(
          this.clock.now().getTime() +
            (this.options.capacityPolicy?.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
      };
      return;
    }
    if (reason === "provider_reconnect_required") {
      this.capacityState = {
        availability: "disabled",
        reason,
      };
    }
  }

  private rateLimitCapacity(): WorkerCapacitySnapshot | null {
    const minRemaining =
      this.options.capacityPolicy?.rateLimitMinRemainingPercent;
    if (minRemaining === undefined || this.rateLimitTelemetry === null) {
      return null;
    }

    const snapshot = this.rateLimitTelemetry.latest();
    if (!snapshot) return null;

    const windows =
      this.options.capacityPolicy?.rateLimitWindows ??
      (["five_hour", "seven_day"] as const);
    const nowMs = this.clock.now().getTime();
    let selected:
      | {
          readonly name: ClaudeRateLimitWindowName;
          readonly usedPercentage: number;
          readonly remainingPercentage: number;
          readonly resetsAt: Date;
        }
      | null = null;

    for (const name of windows) {
      const window = snapshot.windows[name];
      if (!window || window.resetsAt.getTime() <= nowMs) continue;
      if (window.remainingPercentage > minRemaining) continue;
      if (!selected || window.resetsAt.getTime() > selected.resetsAt.getTime()) {
        selected = {
          name,
          usedPercentage: window.usedPercentage,
          remainingPercentage: window.remainingPercentage,
          resetsAt: window.resetsAt,
        };
      }
    }

    if (!selected) return null;

    return {
      availability: "cooldown",
      reason: "rate_limit_threshold",
      cooldownUntil: selected.resetsAt,
      lastLimitSignalAt: snapshot.observedAt,
      details: {
        rateLimitWindow: selected.name,
        rateLimitMinRemainingPercent: String(minRemaining),
        rateLimitRemainingPercent: String(selected.remainingPercentage),
        rateLimitResetAt: selected.resetsAt.toISOString(),
        rateLimitUsedPercentage: String(selected.usedPercentage),
        ...(snapshot.model ? { rateLimitModel: snapshot.model } : {}),
        rateLimitObservedAt: snapshot.observedAt.toISOString(),
      },
    };
  }

  private rollCapacityWindow(): void {
    const nowMs = this.clock.now().getTime();
    const windowMs = capacityWindowMs(this.options.capacityPolicy);
    if (nowMs - this.windowStartedAtMs < windowMs) return;
    this.windowStartedAtMs = nowMs;
    this.runsInWindow = 0;
    if (this.capacityState.availability === "cooldown") {
      this.capacityState = { availability: "available" };
    }
  }

  private rememberQuotaGroup(session: SessionArtifact): void {
    try {
      const validation = validateClaudeSessionArtifact(session);
      this.quotaGroup = `claude-oauth:${hashText(
        validation.session.oauthToken,
      ).slice(0, 16)}`;
    } catch {
      this.quotaGroup = null;
    }
  }

  private withCapacityDetails(
    capacity: WorkerCapacitySnapshot,
  ): WorkerCapacitySnapshot {
    return {
      ...capacity,
      details: {
        ...(capacity.details ?? {}),
        providerInstanceId: this.options.providerInstanceId,
        configDir: this.configDir,
        ...(this.quotaGroup
          ? { accountId: this.quotaGroup, quotaGroup: this.quotaGroup }
          : {}),
      },
    };
  }

  private async assertStoredSessionHasConfigDir(): Promise<void> {
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (!session) {
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Claude session is missing.",
      );
    }
    const validation = validateClaudeSessionArtifact(session.artifact);
    if (!validation.session.configDir) {
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Claude session is missing a config dir.",
      );
    }
  }

  private assertStarted(): void {
    if (this.workerState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Claude worker has been disposed.",
      );
    }
    if (this.workerState === "created") {
      throw new SubscriptionWorkerError(
        "subscription_worker_not_started",
        "Claude worker has not been started.",
      );
    }
  }
}

function capacityWindowMs(policy: ClaudeWorkerCapacityPolicy | undefined): number {
  return policy?.windowMs ?? 5 * 60 * 60 * 1000;
}

function mergeCapacity(
  base: WorkerCapacitySnapshot,
  telemetry: WorkerCapacitySnapshot | null,
): WorkerCapacitySnapshot {
  if (telemetry === null) return base;
  if (base.availability === "available") {
    return telemetry;
  }
  if (
    base.availability === "cooldown" &&
    telemetry.availability === "cooldown"
  ) {
    const baseUntil = base.cooldownUntil?.getTime() ?? 0;
    const telemetryUntil = telemetry.cooldownUntil?.getTime() ?? 0;
    return telemetryUntil > baseUntil
      ? {
          ...telemetry,
          details: { ...(base.details ?? {}), ...(telemetry.details ?? {}) },
        }
      : {
          ...base,
          details: { ...(telemetry.details ?? {}), ...(base.details ?? {}) },
        };
  }
  return base;
}

function isSevereCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "quota_exhausted" ||
    capacity.availability === "degraded" ||
    capacity.availability === "disabled"
  );
}

function assertWorkerOptions(options: FileBackendClaudeWorkerOptions): void {
  if (!options.providerInstanceId.trim()) {
    throw new Error("file_backend_claude_provider_instance_required");
  }
  if (!options.stateRootDir.trim()) {
    throw new Error("file_backend_claude_state_root_required");
  }
  const minRemaining =
    options.capacityPolicy?.rateLimitMinRemainingPercent;
  if (
    minRemaining !== undefined &&
    (!Number.isFinite(minRemaining) || minRemaining < 0 || minRemaining > 100)
  ) {
    throw new Error("file_backend_claude_rate_limit_threshold_invalid");
  }
  if (options.capacityPolicy?.rateLimitWindows?.length === 0) {
    throw new Error("file_backend_claude_rate_limit_windows_empty");
  }
}

function isThreadJob(
  job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob,
): job is FileBackendClaudeWorkerThreadJob {
  return "threadId" in job && typeof job.threadId === "string";
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

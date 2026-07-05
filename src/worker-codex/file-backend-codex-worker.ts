import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  type AgentUsage,
  type ClockPort,
  type ManagedRunInputRequest,
  type ManagedRunRecord,
  type ManagedRunRecoveryPacket,
  type ManagedRunResumeHandle,
  type ManagedRunStorePort,
  type ObservabilityPort,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskResult,
  type RefreshThenRunResult,
  type RedactorPort,
  type RuntimeDeps,
  type RuntimeWarning,
  type SessionArtifact,
  type SessionEnvelope,
  type WorkspaceHandle,
  assertProviderTaskSystemPrompt,
} from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexCliAgentDriver,
  CodexCliSessionDriver,
  type CodexExecutionProfile,
  CodexJsonAgentDriver,
  CodexWorkerCacheSessionPoolMaterializer,
  PackagedCodexJsonExecutionEngine,
  defaultCodexModel,
  type CodexAppServerProcessFactory,
  type CodexAppServerCommandApprovalPolicy,
  type CodexReasoningEffort,
  type CodexServiceTier,
  classifyCodexFailure,
  sessionArtifactFromCodexAuthJson,
  codexAuthJsonFromArtifact,
  readCodexAuthJsonFreshness,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
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
  validateCommandAgainstPolicy,
} from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import { NullWorkerObservability } from "../worker-local/observability";
import {
  BorrowedRunTaskWorkspace,
  StableWorkerWorkspace,
} from "../worker-local/temp-workspace";
import { CommandPolicyRunner } from "./command-policy-runner";

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

export type CodexWorkerExecutionEngine =
  | "app-server"
  | "app-server-goal"
  | "packaged-exec"
  | "plain-exec";

export type CodexWorkerCapacityPolicy = {
  readonly softMaxRunsPerWindow?: number;
  readonly windowMs?: number;
  readonly quotaCooldownMs?: number;
  readonly reconnectCooldownMs?: number;
  readonly maxReconnectRetriesPerAccount?: number;
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

export type FileBackendCodexManagedRunResumeInput = {
  readonly runId: string;
  readonly requestId: string;
  readonly answer: string;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
};

type WaitingProviderTaskResult = Extract<
  ProviderTaskResult,
  { readonly status: "waiting_for_input" }
>;

type ManagedRunPersistContext =
  | {
      readonly kind: "run";
      readonly runId: string;
      readonly job: FileBackendCodexWorkerJob;
      readonly attempt: number;
    }
  | {
      readonly kind: "resume";
      readonly input: FileBackendCodexManagedRunResumeInput;
      readonly previousRecord: ManagedRunRecord | null;
    };

export class FileBackendCodexWorker implements CapacityAwareSubscriptionWorker<
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
  private readonly agentDriver: CodexJsonAgentDriver | CodexCliAgentDriver;
  private readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  private readonly managedRunStore: LocalFileManagedRunStore;
  private readonly runtime;
  private readonly ownedWorkspace: StableWorkerWorkspace | null;
  private readonly prewarmWorkspace: RuntimeDeps["workspace"];
  private capacityState: WorkerCapacitySnapshot = { availability: "available" };
  private windowStartedAtMs: number;
  private runsInWindow = 0;
  private consecutiveReconnectFailures = 0;
  private quotaGroup: string | null = null;
  private capacityAccountId: string | null = null;
  private seededCodexAuthJsonPath: string | null = null;

  constructor(private readonly options: FileBackendCodexWorkerOptions) {
    this.workerId =
      options.workerId ??
      `file-backend-codex:${hashText(options.providerInstanceId).slice(0, 12)}`;
    assertWorkerOptions(options);
    this.observability = options.observability ?? new NullWorkerObservability();
    const baseRunner = options.runner ?? new NodeProcessRunner();
    this.runner = options.commandPolicy?.validateCommands
      ? new CommandPolicyRunner(baseRunner, options.commandPolicy, {
          observability: this.observability,
          providerId: "codex",
          metadata: {
            workerId: this.workerId,
            providerInstanceId: options.providerInstanceId,
          },
        })
      : baseRunner;
    const defaultWorkspacePath = join(
      options.stateRootDir,
      "workspaces",
      hashText(this.workerId),
    );
    this.ownedWorkspace = options.workspace
      ? null
      : new StableWorkerWorkspace(defaultWorkspacePath, {
          allowedRootDir: options.stateRootDir,
        });
    this.workspace =
      options.workspace ??
      (options.workspacePath
        ? new BorrowedRunTaskWorkspace(options.workspacePath, this.ownedWorkspace!)
        : this.ownedWorkspace!);
    this.prewarmWorkspace = options.workspace ?? this.ownedWorkspace!;
    this.clock = options.clock ?? systemClock;
    this.windowStartedAtMs = this.clock.now().getTime();
    this.capacityAccountId = normalizeCapacityAccountId(
      options.capacityAccountId,
    );

    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "codex",
      rootDir: join(options.stateRootDir, "sessions"),
      encryptionKey: options.encryptionKey,
      metadata: { adapter: "file-backend-codex-worker" },
    });
    this.sessionStore = sessionStore;
    this.managedRunStore = new LocalFileManagedRunStore(
      join(options.stateRootDir, "managed-runs"),
    );

    this.sessionDriver = new CodexCliSessionDriver({
      codexBinaryPath: options.codexBinaryPath,
      model: options.model ?? defaultCodexModel,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      refreshMode: "lazy-refresh",
    });

    const executionEngine = options.executionEngine ?? "app-server";
    if (executionEngine === "plain-exec") {
      this.agentDriver = new CodexCliAgentDriver({
        codexBinaryPath: options.codexBinaryPath,
        model: options.model ?? defaultCodexModel,
        ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
        ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
      });
    } else {
      const packagedExec = new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: options.codexBinaryPath,
        ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
        ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
      });
      this.agentDriver = new CodexJsonAgentDriver({
        engine: executionEngine === "packaged-exec"
          ? packagedExec
          : new CodexAppServerExecutionEngine({
              codexBinaryPath: options.codexBinaryPath,
              ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
              ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
              ...(options.appServerProcessFactory
                ? { processFactory: options.appServerProcessFactory }
                : {}),
              ...(options.executionProfile
                ? { executionProfile: options.executionProfile }
                : {}),
              ...(options.commandPolicy?.validateCommands
                ? {
                    commandApprovalPolicy: codexAppServerCommandApprovalPolicy(
                      options.commandPolicy,
                      this.observability,
                      {
                        workerId: this.workerId,
                        providerInstanceId: options.providerInstanceId,
                      },
                    ),
                  }
                : {}),
              cleanThreadPrewarm: options.cleanThreadPrewarm ?? true,
              goalMode: executionEngine === "app-server-goal",
              runStore: this.managedRunStore,
              ...(executionEngine === "app-server-goal"
                ? {}
                : { fallback: packagedExec }),
            }),
        sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
          cacheKey: `codex:${options.providerInstanceId}`,
          slots: options.sessionCacheSlots ?? 1,
          rootDir: join(options.stateRootDir, "codex-session-cache"),
        }),
        model: options.model ?? defaultCodexModel,
        reasoningEffort: options.reasoningEffort ?? "low",
        ...(options.serviceTier === undefined
          ? {}
          : { serviceTier: options.serviceTier }),
        ...(options.outputSchemas === undefined
          ? {}
          : { outputSchemas: options.outputSchemas }),
        ...(options.warmupPrompt === false
          ? {}
          : { warmupPrompt: options.warmupPrompt ?? defaultWarmupPrompt }),
      });
    }

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
    this.seededCodexAuthJsonPath = authJsonPath;
    let authJson: string;
    try {
      authJson = await readFile(authJsonPath, "utf8");
    } catch {
      this.recordFailure(codexSeedSessionInvalidFailure());
      return;
    }
    await this.seedCodexAuthJson(authJson);
  }

  async seedCodexAuthJson(authJson: string): Promise<void> {
    let artifact: SessionArtifact;
    try {
      artifact = sessionArtifactFromCodexAuthJson(authJson);
    } catch (error) {
      this.recordFailure(classifyCodexFailure(error));
      return;
    }
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (existing) {
      if (
        shouldReplaceSeededCodexSession({
          existing,
          incoming: artifact,
          now: this.clock.now(),
        })
      ) {
        await this.sessionStore.write({
          providerInstanceId: this.options.providerInstanceId,
          expectedGeneration: existing.generation,
          nextArtifact: artifact,
          idempotencyKey: `seed:${hashText(authJson)}`,
          leaseId: "seed-local-file-backend",
        });
        this.rememberQuotaGroup(artifact);
        return;
      }
      this.rememberQuotaGroup(existing.artifact);
      return;
    }

    await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(authJson)}`,
      leaseId: "seed-local-file-backend",
    });
    this.rememberQuotaGroup(artifact);
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
    this.rememberQuotaGroup(session.artifact);

    if (!("prewarmSession" in this.agentDriver)) {
      this.workerState = "ready";
      try {
        return {
          status: "skipped",
          warmedAt: this.clock.now(),
          warnings: [],
          details: {
            engine: "plain-exec",
            engineReusable: "false",
          },
        };
      } finally {
        await this.exportSeededCodexAuthJsonFileQuietly("prewarm");
      }
    }

    const workspace = await this.prewarmWorkspace.create({
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
      await this.exportSeededCodexAuthJsonFileQuietly("prewarm");
    }
  }

  async run(
    job: FileBackendCodexWorkerJob,
    options: SubscriptionWorkerRunOptions = {},
  ): Promise<FileBackendCodexWorkerResult> {
    this.assertStarted();
    assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
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
                ...(this.capacityAccountId
                  ? { accountId: this.capacityAccountId }
                  : {}),
              },
            },
          );
        }

        if (result.status === "completed") {
          return await this.taskResultToOutput(result.task, {
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
      await this.exportSeededCodexAuthJsonFileQuietly("run");
    }
  }

  async resumeManagedRun(
    input: FileBackendCodexManagedRunResumeInput,
  ): Promise<FileBackendCodexWorkerResult> {
    this.assertStarted();
    if (!(this.agentDriver instanceof CodexJsonAgentDriver)) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Selected Codex worker engine does not support managed run resume.",
        { details: { reason: "task_mode_unsupported" } },
      );
    }
    this.assertResumeHandleMatchesWorker(input.resumeHandle);
    const abortSignal = input.abortSignal ?? new AbortController().signal;
    const durableRecord = await this.managedRunStore.get({ runId: input.runId });
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "run",
    });
    if (!session) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Codex session is missing.",
        { details: { reason: "needs_reconnect" } },
      );
    }
    if (!this.agentDriver.hasManagedRunSession(input.runId)) {
      return await this.recoverManagedRun({ input, record: durableRecord });
    }
    const workspace: WorkspaceHandle = { path: input.resumeHandle.workspacePath };
    try {
      const result = await this.agentDriver.resumeManagedRun({
        session: session.artifact,
        runId: input.runId,
        requestId: input.requestId,
        answer: input.answer,
        resumeHandle: input.resumeHandle,
        task: {
          ...(input.outputSchemaName
            ? { outputSchemaName: input.outputSchemaName }
            : {}),
          ...(input.controls ? { controls: input.controls } : {}),
        },
        workspace,
        runner: this.runner,
        redactor: this.redactor,
        abortSignal,
      });
      const persisted = await this.persistResumeSessionUpdate({
        result,
        session,
        runId: input.runId,
      });
      if (persisted.status === "failed" && canRecoverManagedRun(input, durableRecord)) {
        return await this.recoverManagedRun({ input, record: durableRecord });
      }
      return await this.taskResultToOutput(persisted, {
        kind: "resume",
        input,
        previousRecord: durableRecord,
      });
    } finally {
      await workspace.dispose?.();
      await this.exportSeededCodexAuthJsonFileQuietly("run");
    }
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
    const previousCapacity = this.capacityState;
    this.capacityState = normalizeResettableCapacity(
      this.capacityState,
      this.clock.now(),
    );
    if (
      previousCapacity.availability === "cooldown" &&
      previousCapacity.reason === "session_unhealthy" &&
      this.capacityState.availability === "available"
    ) {
      this.consecutiveReconnectFailures = 0;
    }
    return this.withCapacityDetails({
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
    });
  }

  private async recoverManagedRun(input: {
    readonly input: FileBackendCodexManagedRunResumeInput;
    readonly record: ManagedRunRecord | null;
  }): Promise<FileBackendCodexWorkerResult> {
    const record = input.record;
    if (!canRecoverManagedRun(input.input, record)) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Managed run cannot be recovered from durable state.",
        { details: { reason: "managed_run_recovery_unavailable" } },
      );
    }
    const packet = record.recoveryPacket;
    const outputSchemaName =
      input.input.outputSchemaName ?? packet.outputSchemaName;
    const controls = input.input.controls ?? packet.controls;
    return await this.run({
      runId: input.input.runId,
      prompt: buildManagedRunRecoveryPrompt({
        packet,
        answer: input.input.answer,
        requestId: input.input.requestId,
      }),
      ...(packet.systemPrompt === undefined
        ? {}
        : { systemPrompt: packet.systemPrompt }),
      kind: packet.kind ?? "structured-prompt",
      ...(outputSchemaName ? { outputSchemaName } : {}),
      ...(controls ? { controls } : {}),
      metadata: {
        ...(packet.metadata ?? {}),
        codexManagedRecovery: "true",
        codexManagedRecoveryRequestId: input.input.requestId,
        ...(packet.goalObjective
          ? { codexGoalObjective: packet.goalObjective }
          : {}),
      },
      ...(input.input.abortSignal ? { abortSignal: input.input.abortSignal } : {}),
      recoveryPacket: packet,
    });
  }

  private async taskResultToOutput(
    result: ProviderTaskResult,
    context?: ManagedRunPersistContext,
  ): Promise<FileBackendCodexWorkerResult> {
    if (result.status === "failed") {
      this.recordFailure(result.failure);
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        result.failure.safeMessage,
        {
          details: {
            code: result.failure.code,
            ...(result.failure.details ?? {}),
          },
        },
      );
    }
    if (result.status === "waiting_for_input") {
      const waiting = this.workerWaitingResult(result);
      if (context) {
        await this.persistWaitingManagedRun({ result: waiting, context });
      }
      return {
        status: "waiting_for_input",
        runId: waiting.runId,
        outputText: waiting.outputText,
        request: waiting.request,
        resumeHandle: waiting.resumeHandle,
        ...(waiting.structuredOutput === undefined
          ? {}
          : { structuredOutput: waiting.structuredOutput }),
        ...(waiting.telemetry?.usage === undefined
          ? {}
          : { usage: waiting.telemetry.usage }),
        warnings: waiting.warnings,
      };
    }
    this.recordSuccessfulRun();
    return {
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : { structuredOutput: result.structuredOutput }),
      ...(result.telemetry?.usage === undefined
        ? {}
        : { usage: result.telemetry.usage }),
      warnings: result.warnings,
    };
  }

  private async persistResumeSessionUpdate(input: {
    readonly result: ProviderTaskResult;
    readonly session: SessionEnvelope;
    readonly runId: string;
  }): Promise<ProviderTaskResult> {
    if (
      input.result.status !== "completed" ||
      !input.result.sessionUpdate ||
      sameArtifactBytes(input.result.sessionUpdate, input.session.artifact)
    ) {
      return input.result;
    }
    if (input.result.sessionUpdate.providerId !== input.session.providerId) {
      return appendWarnings(input.result, [
        {
          code: "managed_run_session_update_provider_mismatch",
          safeMessage:
            "Managed run session update was ignored because the provider did not match.",
        },
      ]);
    }

    const updateHash = hashArtifact(input.result.sessionUpdate);
    const writebackKey = hashText(
      `${this.options.providerInstanceId}:${input.runId}:${updateHash}`,
    );
    try {
      const writeback = await this.sessionStore.write({
        providerInstanceId: this.options.providerInstanceId,
        expectedGeneration: input.session.generation,
        nextArtifact: input.result.sessionUpdate,
        idempotencyKey: `managed-run-resume:${writebackKey.slice(0, 32)}`,
        leaseId: `managed-run-resume:${writebackKey.slice(0, 32)}`,
      });
      if (writeback.status === "stale_generation") {
        return appendWarnings(input.result, [
          {
            code: "managed_run_session_update_stale_generation",
            safeMessage:
              "Managed run session update was skipped because a newer session generation already exists.",
          },
        ]);
      }
      return input.result;
    } catch {
      return appendWarnings(input.result, [
        {
          code: "managed_run_session_update_writeback_failed",
          safeMessage:
            "Managed run session update could not be written back after resume.",
        },
      ]);
    }
  }

  private async persistWaitingManagedRun(input: {
    readonly result: WaitingProviderTaskResult;
    readonly context: ManagedRunPersistContext;
  }): Promise<void> {
    const recoveryPacket = buildManagedRunRecoveryPacket({
      result: input.result,
      context: input.context,
    });
    await this.managedRunStore.saveWaitingInput({
      runId: input.result.runId,
      request: input.result.request,
      resumeHandle: input.result.resumeHandle,
      recoveryPacket,
      taskId: input.result.runId,
      assignedWorkerId: this.workerId,
      providerInstanceId: this.options.providerInstanceId,
      workspacePath: input.result.resumeHandle.workspacePath,
      ...(input.result.outputText.trim()
        ? { outputText: input.result.outputText }
        : {}),
      now: this.clock.now(),
    });
  }

  private workerWaitingResult(
    result: WaitingProviderTaskResult,
  ): WaitingProviderTaskResult {
    return {
      ...result,
      resumeHandle: this.workerResumeHandle(result.resumeHandle),
    };
  }

  private workerResumeHandle(
    resumeHandle: ManagedRunResumeHandle,
  ): ManagedRunResumeHandle {
    return {
      ...resumeHandle,
      providerInstanceId: this.options.providerInstanceId,
      workerId: this.workerId,
    };
  }

  private assertResumeHandleMatchesWorker(
    resumeHandle: ManagedRunResumeHandle,
  ): void {
    if (
      resumeHandle.providerInstanceId !== undefined &&
      resumeHandle.providerInstanceId !== this.options.providerInstanceId
    ) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Managed run belongs to a different provider instance.",
        { details: { reason: "managed_run_provider_instance_mismatch" } },
      );
    }
    if (
      resumeHandle.workerId !== undefined &&
      resumeHandle.workerId !== this.workerId
    ) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Managed run belongs to a different worker.",
        { details: { reason: "managed_run_worker_mismatch" } },
      );
    }
  }

  private recordSuccessfulRun(): void {
    this.rollCapacityWindow();
    this.consecutiveReconnectFailures = 0;
    if (this.capacityState.reason === "reconnect_retry_pending") {
      this.capacityState = { availability: "available" };
    }
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
    if (failure.code === "provider_session_invalid") {
      this.capacityState = {
        availability: "disabled",
        reason: failure.code,
      };
      return;
    }
    if (failure.reconnectRequired) {
      this.recordReconnectRequired(failure.code);
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
      this.recordReconnectRequired(reason);
    }
  }

  private recordReconnectRequired(reason: string): void {
    const maxRetries =
      this.options.capacityPolicy?.maxReconnectRetriesPerAccount ?? 4;
    if (this.consecutiveReconnectFailures < maxRetries) {
      this.consecutiveReconnectFailures += 1;
      this.capacityState = {
        availability: "available",
        reason: "reconnect_retry_pending",
        lastLimitSignalAt: this.clock.now(),
        details: {
          reconnectReason: reason,
          reconnectRetry: String(this.consecutiveReconnectFailures),
          maxReconnectRetries: String(maxRetries),
        },
      };
      return;
    }

    this.capacityState = {
      availability: "cooldown",
      reason: "session_unhealthy",
      cooldownUntil: new Date(
        this.clock.now().getTime() +
          (this.options.capacityPolicy?.reconnectCooldownMs ??
            this.options.capacityPolicy?.quotaCooldownMs ??
            15 * 60 * 1000),
      ),
      lastLimitSignalAt: this.clock.now(),
      details: {
        reconnectReason: reason,
        maxReconnectRetries: String(maxRetries),
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

  private async rememberStoredQuotaGroup(): Promise<void> {
    if (this.quotaGroup || this.capacityAccountId) return;
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (session) this.rememberQuotaGroup(session.artifact);
  }

  private rememberQuotaGroup(session: SessionArtifact): void {
    try {
      const authJsonBytes = codexAuthJsonFromArtifact(session);
      const validation = validateCodexAuthJsonBytes({ authJsonBytes });
      this.quotaGroup = `codex-chatgpt:${hashText(
        validation.parsed.tokens.refresh_token,
      ).slice(0, 16)}`;
      this.capacityAccountId =
        normalizeCapacityAccountId(this.options.capacityAccountId) ??
        this.quotaGroup;
    } catch {
      this.quotaGroup = null;
      this.capacityAccountId = normalizeCapacityAccountId(
        this.options.capacityAccountId,
      );
    }
  }

  private async exportSeededCodexAuthJsonFileQuietly(
    context: "prewarm" | "run",
  ): Promise<void> {
    if (!this.seededCodexAuthJsonPath) return;
    try {
      const session = await this.sessionStore.read({
        providerInstanceId: this.options.providerInstanceId,
        expectedProviderId: "codex",
        purpose: "health-check",
      });
      if (!session) return;
      const authJsonBytes = codexAuthJsonFromArtifact(session.artifact);
      validateCodexAuthJsonBytes({ authJsonBytes });
      const existing = await readFile(
        this.seededCodexAuthJsonPath,
        "utf8",
      ).catch(() => null);
      if (existing === authJsonBytes) return;
      await writeCodexAuthJsonFileAtomic(
        this.seededCodexAuthJsonPath,
        authJsonBytes,
      );
      this.observability.count("subscription_runtime.codex_auth_path_exported");
    } catch {
      this.observability.count(
        "subscription_runtime.codex_auth_path_export_failed",
      );
      this.observability.emit({
        name: "codex.auth_path.export_failed",
        providerId: "codex",
        agentId: this.agentDriver.agentId,
        storeId: this.sessionStore.storeId,
        metadata: { context },
      });
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
        ...(this.capacityAccountId
          ? { accountId: this.capacityAccountId }
          : {}),
        ...(this.quotaGroup ? { quotaGroup: this.quotaGroup } : {}),
        capacityProvider: "codex",
        capacityModel: this.options.model ?? defaultCodexModel,
        capacityReasoningEffort: this.options.reasoningEffort ?? "low",
        ...(this.options.serviceTier
          ? { capacityServiceTier: this.options.serviceTier }
          : {}),
      },
    };
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

class LocalFileManagedRunStore implements ManagedRunStorePort {
  constructor(private readonly rootDir: string) {}

  async get(input: { readonly runId: string }): Promise<ManagedRunRecord | null> {
    const raw = await readFile(this.recordPath(input.runId), "utf8").catch(
      (error: unknown) => {
        if (isNodeErrorCode(error, "ENOENT")) return null;
        throw error;
      },
    );
    if (raw === null) return null;
    return parseManagedRunRecord(JSON.parse(raw));
  }

  async saveWaitingInput(input: {
    readonly runId: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly recoveryPacket?: ManagedRunRecoveryPacket;
    readonly taskId?: string;
    readonly assignedWorkerId?: string;
    readonly providerInstanceId?: string;
    readonly workspacePath?: string;
    readonly outputText?: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    const recoveryPacket = input.recoveryPacket ?? current?.recoveryPacket;
    const taskId = input.taskId ?? current?.taskId;
    const assignedWorkerId = input.assignedWorkerId ?? current?.assignedWorkerId;
    const providerInstanceId =
      input.providerInstanceId ?? current?.providerInstanceId;
    const workspacePath = input.workspacePath ?? current?.workspacePath;
    const outputText = input.outputText ?? current?.outputText;
    const record: ManagedRunRecord = {
      runId: input.runId,
      status: "waiting_for_input",
      request: input.request,
      resumeHandle: input.resumeHandle,
      ...(recoveryPacket === undefined ? {} : { recoveryPacket }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(assignedWorkerId === undefined ? {} : { assignedWorkerId }),
      ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(outputText === undefined ? {} : { outputText }),
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    if (
      !current ||
      current.status !== "waiting_for_input" ||
      current.request?.id !== input.requestId
    ) {
      throw new Error("managed_run_request_mismatch");
    }
    const {
      request: _request,
      ...currentWithoutRequest
    } = current;
    const record: ManagedRunRecord = {
      ...currentWithoutRequest,
      status: "active",
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  async complete(input: {
    readonly runId: string;
    readonly outputText: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "completed",
      outputText: input.outputText,
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  async fail(input: {
    readonly runId: string;
    readonly failure: ProviderFailure;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "failed",
      failure: input.failure,
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  private recordPath(runId: string): string {
    return join(this.rootDir, `${hashText(runId)}.json`);
  }

  private async writeRecord(record: ManagedRunRecord): Promise<void> {
    const path = this.recordPath(record.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tempPath, path);
  }
}

function codexSeedSessionInvalidFailure(): ProviderFailure {
  return {
    code: "provider_session_invalid",
    retryable: false,
    reconnectRequired: true,
    safeMessage: "Codex session is invalid.",
    causeCategory: "provider_session_invalid",
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

function canRecoverManagedRun(
  input: FileBackendCodexManagedRunResumeInput,
  record: ManagedRunRecord | null,
): record is ManagedRunRecord & {
  readonly recoveryPacket: ManagedRunRecoveryPacket;
} {
  if (!record?.recoveryPacket) return false;
  if (record.status === "completed" || record.status === "aborted") return false;
  if (record.runId !== input.runId) return false;
  if (record.request && record.request.id !== input.requestId) return false;
  if (record.resumeHandle?.runId && record.resumeHandle.runId !== input.runId) {
    return false;
  }
  return true;
}

function buildManagedRunRecoveryPacket(input: {
  readonly result: WaitingProviderTaskResult;
  readonly context: ManagedRunPersistContext;
}): ManagedRunRecoveryPacket {
  const previous =
    input.context.kind === "resume"
      ? input.context.previousRecord?.recoveryPacket
      : input.context.job.recoveryPacket;
  const job = input.context.kind === "run" ? input.context.job : null;
  const controls =
    input.context.kind === "resume"
      ? input.context.input.controls ?? previous?.controls
      : job?.controls ?? previous?.controls;
  const outputSchemaName =
    input.context.kind === "resume"
      ? input.context.input.outputSchemaName ?? previous?.outputSchemaName
      : job?.outputSchemaName ?? previous?.outputSchemaName;
  const metadata =
    input.context.kind === "run"
      ? job?.metadata ?? previous?.metadata
      : previous?.metadata;
  const goalObjective =
    metadata?.codexGoalObjective ?? previous?.goalObjective;
  const kind = job?.kind ?? previous?.kind;
  const systemPrompt = job?.systemPrompt ?? previous?.systemPrompt;
  return {
    originalPrompt: previous?.originalPrompt ?? job?.prompt ?? input.result.outputText,
    ...(goalObjective ? { goalObjective } : {}),
    lastOutput: input.result.outputText,
    blockerQuestion: input.result.request.question,
    ...(input.result.request.contextSummary
      ? { contextSummary: input.result.request.contextSummary }
      : previous?.contextSummary
        ? { contextSummary: previous.contextSummary }
        : {}),
    attemptSummary: managedRunAttemptSummary(input.context),
    ...(kind ? { kind } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(outputSchemaName ? { outputSchemaName } : {}),
    ...(controls ? { controls } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function managedRunAttemptSummary(context: ManagedRunPersistContext): string {
  if (context.kind === "run") {
    return `Blocked during worker attempt ${context.attempt}.`;
  }
  const answerPreview = context.input.answer.trim().slice(0, 240);
  return [
    `Recovered after answering request ${context.input.requestId}.`,
    answerPreview ? `Answer preview: ${answerPreview}` : "Answer preview: (empty answer)",
  ].join("\n");
}

function buildManagedRunRecoveryPrompt(input: {
  readonly packet: ManagedRunRecoveryPacket;
  readonly answer: string;
  readonly requestId: string;
}): string {
  return [
    "Continue a previously blocked managed run.",
    "",
    "Original task:",
    input.packet.originalPrompt,
    "",
    ...(input.packet.goalObjective
      ? ["Goal objective:", input.packet.goalObjective, ""]
      : []),
    "Last worker output before the blocker:",
    input.packet.lastOutput || "(no output)",
    "",
    "Blocking request:",
    `Request id: ${input.requestId}`,
    input.packet.blockerQuestion,
    "",
    ...(input.packet.contextSummary
      ? ["Context summary:", input.packet.contextSummary, ""]
      : []),
    ...(input.packet.attemptSummary
      ? ["Attempt summary:", input.packet.attemptSummary, ""]
      : []),
    "Answer from orchestrator:",
    input.answer.trim() || "(empty answer)",
    "",
    "Use the answer above and continue the original task from the recovered state. Do not restart from scratch unless the recovered context is insufficient.",
  ].join("\n");
}

function parseManagedRunRecord(value: unknown): ManagedRunRecord {
  if (!value || typeof value !== "object") {
    throw new Error("managed_run_record_invalid");
  }
  const record = value as ManagedRunRecord & { readonly updatedAt: unknown };
  if (typeof record.runId !== "string") {
    throw new Error("managed_run_record_run_id_invalid");
  }
  if (typeof record.status !== "string") {
    throw new Error("managed_run_record_status_invalid");
  }
  return {
    ...record,
    updatedAt: new Date(String(record.updatedAt)),
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function shouldReplaceSeededCodexSession(input: {
  readonly existing: SessionEnvelope;
  readonly incoming: SessionArtifact;
  readonly now: Date;
}): boolean {
  if (sameArtifactBytes(input.existing.artifact, input.incoming)) return false;

  const existingFreshness = safeReadCodexArtifactFreshness({
    artifact: input.existing.artifact,
    now: input.now,
  });
  if (!existingFreshness) return true;

  const incomingFreshness = safeReadCodexArtifactFreshness({
    artifact: input.incoming,
    now: input.now,
  });
  if (!incomingFreshness) return false;

  const existingLastRefresh = existingFreshness.lastRefreshAt?.getTime() ?? null;
  const incomingLastRefresh = incomingFreshness.lastRefreshAt?.getTime() ?? null;
  if (
    incomingLastRefresh !== null &&
    (existingLastRefresh === null || incomingLastRefresh >= existingLastRefresh)
  ) {
    return true;
  }
  if (existingLastRefresh === null && incomingLastRefresh === null) {
    return true;
  }

  const existingExpiry = existingFreshness.expiresAt?.getTime() ?? null;
  const incomingExpiry = incomingFreshness.expiresAt?.getTime() ?? null;
  return (
    incomingExpiry !== null &&
    (existingExpiry === null || incomingExpiry > existingExpiry)
  );
}

function safeReadCodexArtifactFreshness(input: {
  readonly artifact: SessionArtifact;
  readonly now: Date;
}): ReturnType<typeof readCodexAuthJsonFreshness> | null {
  try {
    return readCodexAuthJsonFreshness({
      authJsonBytes: codexAuthJsonFromArtifact(input.artifact),
      now: input.now,
    });
  } catch {
    return null;
  }
}

function sameArtifactBytes(
  left: SessionArtifact,
  right: SessionArtifact,
): boolean {
  return Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

function appendWarnings<T extends ProviderTaskResult>(
  result: T,
  warnings: readonly RuntimeWarning[],
): T {
  if (warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...result.warnings, ...warnings],
  };
}

function hashArtifact(artifact: SessionArtifact): string {
  return createHash("sha256").update(artifact.bytes).digest("hex");
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

function codexAppServerCommandApprovalPolicy(
  policy: CommandPolicy,
  observability: ObservabilityPort,
  metadata: Readonly<Record<string, string>>,
): CodexAppServerCommandApprovalPolicy {
  return {
    reviewCommand(input) {
      const command = commandApprovalVector(input);
      if (command === null) {
        observability.emit({
          name: "command_policy.denied",
          providerId: "codex",
          metadata: {
            ...metadata,
            reason: "command_unparseable",
            source: input.source,
          },
        });
        return { approved: false, reason: "command_unparseable" };
      }
      const decision = validateCommandAgainstPolicy({ command, policy });
      if (!decision.allowed) {
        observability.emit({
          name: "command_policy.denied",
          providerId: "codex",
          metadata: {
            ...metadata,
            reason: decision.reason,
            source: input.source,
            ...(decision.executableName === undefined
              ? {}
              : { executableName: decision.executableName }),
          },
        });
      }
      return {
        approved: decision.allowed,
        reason: decision.allowed ? "command_policy_allowed" : decision.reason,
      };
    },
  };
}

function commandApprovalVector(input: {
  readonly command?: readonly string[];
  readonly commandText?: string;
}): readonly string[] | null {
  if (input.command !== undefined) {
    return input.command.length > 0 && input.command.every((part) => part.trim())
      ? input.command
      : null;
  }
  const commandText = input.commandText?.trim();
  if (!commandText) return null;
  if (/[`$<>|;&\n\r]/.test(commandText)) {
    return ["sh", "-lc", commandText];
  }
  const parts = commandText.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : null;
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

function capacityWindowMs(policy: CodexWorkerCapacityPolicy | undefined): number {
  return policy?.windowMs ?? 5 * 60 * 60 * 1000;
}

function normalizeResettableCapacity(
  capacity: WorkerCapacitySnapshot,
  now: Date,
): WorkerCapacitySnapshot {
  if (
    !isResettableCapacity(capacity) ||
    !capacity.cooldownUntil ||
    capacity.cooldownUntil.getTime() > now.getTime()
  ) {
    return capacity;
  }

  const {
    cooldownUntil: _cooldownUntil,
    lastLimitSignalAt: _lastLimitSignalAt,
    reason: _reason,
    ...rest
  } = capacity;
  return {
    ...rest,
    availability: "available",
  };
}

function isResettableCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
}

function isSevereCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "quota_exhausted" ||
    capacity.availability === "degraded" ||
    capacity.availability === "disabled"
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCapacityAccountId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function writeCodexAuthJsonFileAtomic(
  authJsonPath: string,
  authJson: string,
): Promise<void> {
  await mkdir(dirname(authJsonPath), { recursive: true, mode: 0o700 });
  const tempPath = `${authJsonPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, authJson, { mode: 0o600 });
  await rename(tempPath, authJsonPath);
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

const defaultWarmupPrompt = "Return exactly OK.";

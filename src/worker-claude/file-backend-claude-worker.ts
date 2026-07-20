import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type ProviderTask,
  type ProviderTaskTelemetry,
  type RedactorPort,
  type RefreshThenRunResult,
  type RuntimeDeps,
  assertProviderTaskSystemPrompt,
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
  type ClaudeRuntimeTaskExecutionEngineOptions,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  createLocalFileBackendRuntimeAdapters,
  LocalFileWorkerControlInboxStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  SubscriptionWorkerError,
  WorkerControlService,
  combineAbortSignals,
  type CapacityAwareSubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerRunOptions,
  type SubscriptionWorkerState,
  type WorkerControlContinuationBatch,
  type WorkerControlContinuationSource,
  type WorkerControlTarget,
  type WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import { NullWorkerObservability } from "../worker-local/observability";
import { StableWorkerWorkspace } from "../worker-local/temp-workspace";
import {
  FileClaudeRateLimitTelemetry,
  type ClaudeRateLimitTelemetrySource,
} from "./rate-limit-telemetry";
import {
  FileClaudeRunArtifactStore,
  type ClaudeRunArtifactStoreOptions,
} from "./claude-run-artifacts";
import {
  FileClaudeLogicalThreadStore,
  FileClaudeTranscriptBundleStore,
  type ClaudeLogicalThreadState,
  type ClaudeLogicalThreadStore,
  type ClaudeTranscriptBundleStore,
} from "./thread-handoff";
import {
  FileBackendClaudeCapacityState,
  claudeCapacityAccountIdMetadataKey,
  hashText,
  isSevereCapacity,
  normalizeCapacityAccountId,
  type ClaudeWorkerCapacityPolicy,
} from "./file-backend-claude-capacity";

export type { ClaudeWorkerCapacityPolicy } from "./file-backend-claude-capacity";

export type FileBackendClaudeWorkerOptions = {
  readonly workerId?: string;
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  readonly encryptionKey: Uint8Array | string;
  readonly configDir?: string;
  readonly capacityAccountId?: string;
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
  readonly runtimeModuleLoader?: ClaudeRuntimeTaskExecutionEngineOptions["runtimeModuleLoader"];
  readonly providerModuleLoader?: ClaudeRuntimeTaskExecutionEngineOptions["providerModuleLoader"];
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
  readonly controlInbox?: WorkerControlContinuationSource;
  readonly runArtifactsRootDir?: string;
  readonly runArtifactHeartbeatMs?: number;
};

export type FileBackendClaudeWorkerJob = {
  readonly jobId?: string;
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly controlTarget?: WorkerControlTarget;
};

export type FileBackendClaudeWorkerResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly workerControlSignalIds?: readonly string[];
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
  private readonly controlInbox: WorkerControlContinuationSource | null;
  private readonly sessionDriver = new ClaudeSessionDriver();
  private readonly agentDriver: ClaudeTaskAgentDriver;
  private readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  private readonly runtime;
  private readonly ownedWorkspace: StableWorkerWorkspace | null;
  private readonly stableWorkspacePath: string | null;
  private readonly rateLimitTelemetry: ClaudeRateLimitTelemetrySource | null;
  private readonly logicalThreadStore: ClaudeLogicalThreadStore;
  private readonly transcriptBundleStore: ClaudeTranscriptBundleStore;
  private readonly runArtifacts: FileClaudeRunArtifactStore;
  private readonly runArtifactHeartbeatMs: number;
  private readonly capacityTracker: FileBackendClaudeCapacityState;

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
      : new StableWorkerWorkspace(defaultWorkspacePath, {
          allowedRootDir: options.stateRootDir,
        });
    this.workspace = options.workspace ?? this.ownedWorkspace!;
    this.stableWorkspacePath = options.workspace
      ? (options.workspacePath ?? null)
      : defaultWorkspacePath;
    this.observability = options.observability ?? new NullWorkerObservability();
    this.clock = options.clock ?? systemClock;
    this.controlInbox =
      options.controlInbox ??
      new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({
          rootDir: options.stateRootDir,
        }),
        ...(options.clock ? { clock: options.clock } : {}),
      });
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
    this.runArtifacts = new FileClaudeRunArtifactStore({
      rootDir: options.runArtifactsRootDir ??
        join(options.stateRootDir, "claude-run-artifacts"),
      ...(options.clock ? { clock: options.clock } : {}),
      redactor: this.redactor,
    } satisfies ClaudeRunArtifactStoreOptions);
    this.runArtifactHeartbeatMs = options.runArtifactHeartbeatMs ?? 30_000;

    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "claude",
      rootDir: join(options.stateRootDir, "sessions"),
      encryptionKey: options.encryptionKey,
      metadata: { adapter: "file-backend-claude-worker" },
    });
    this.sessionStore = sessionStore;
    this.capacityTracker = new FileBackendClaudeCapacityState({
      providerInstanceId: options.providerInstanceId,
      configDir: this.configDir,
      ...(options.capacityAccountId === undefined
        ? {}
        : { configuredCapacityAccountId: options.capacityAccountId }),
      ...(options.capacityPolicy === undefined
        ? {}
        : { capacityPolicy: options.capacityPolicy }),
      rateLimitTelemetry: this.rateLimitTelemetry,
      sessionStore: () => this.sessionStore,
      clock: this.clock,
    });

    this.agentDriver = new ClaudeTaskAgentDriver({
      engine:
        options.engine ??
        this.defaultClaudeTaskEngine(options),
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

  private defaultClaudeTaskEngine(
    options: FileBackendClaudeWorkerOptions,
  ): ClaudeTaskExecutionEngine {
    const primary = new ClaudeRuntimeTaskExecutionEngine({
      ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
      ...(options.runtimeModuleLoader
        ? { runtimeModuleLoader: options.runtimeModuleLoader }
        : {}),
      ...(options.providerModuleLoader
        ? { providerModuleLoader: options.providerModuleLoader }
        : {}),
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
    });
    return primary;
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
    this.capacityTracker.reset();
    this.workerState = "started";
  }

  async seedClaudeOAuth(input: {
    readonly oauthToken: string;
    readonly configDir?: string;
    readonly capacityAccountId?: string;
    readonly refreshedAt?: string;
    readonly expiresAt?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<void> {
    const capacityAccountId =
      normalizeCapacityAccountId(input.capacityAccountId) ??
      normalizeCapacityAccountId(this.options.capacityAccountId);
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (existing) {
      const capacityArtifact = await this.capacityTracker.persistStoredCapacityAccountId(
        existing,
        capacityAccountId,
      );
      this.capacityTracker.rememberQuotaGroup(capacityArtifact, capacityAccountId);
      return;
    }

    const metadata = {
      ...(input.metadata ?? {}),
      ...(capacityAccountId
        ? { [claudeCapacityAccountIdMetadataKey]: capacityAccountId }
        : {}),
    };
    const artifact = sessionArtifactFromClaudeOAuth({
      oauthToken: input.oauthToken,
      configDir: input.configDir ?? this.configDir,
      refreshedAt: input.refreshedAt ?? this.clock.now().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(input.oauthToken)}`,
      leaseId: "seed-local-file-backend",
    });
    this.capacityTracker.rememberQuotaGroup(artifact);
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

  run(
    job: FileBackendClaudeWorkerThreadJob,
    options?: SubscriptionWorkerRunOptions,
  ): Promise<FileBackendClaudeWorkerThreadResult>;
  run(
    job: FileBackendClaudeWorkerJob,
    options?: SubscriptionWorkerRunOptions,
  ): Promise<FileBackendClaudeWorkerResult>;
  async run(
    job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob,
    options: SubscriptionWorkerRunOptions = {},
  ): Promise<FileBackendClaudeWorkerResult | FileBackendClaudeWorkerThreadResult> {
    if (isThreadJob(job)) return this.runThreadJob(job, options);
    return this.runProviderTask(job, options);
  }

  private async runProviderTask(
    job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob,
    input: SubscriptionWorkerRunOptions & {
      readonly workspaceId?: string;
    } = {},
  ): Promise<FileBackendClaudeWorkerResult> {
    this.assertStarted();
    assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
    const runId = job.runId ?? `local-${randomUUID()}`;
    const abort = combineAbortSignals(job.abortSignal, input.abortSignal);
    const abortSignal = abort.signal;
    const workspaceId = input.workspaceId ?? this.stableWorkspacePath ?? undefined;
    const controlBatch = this.controlInbox
      ? await this.controlInbox.consumeForContinuation({
          target: job.controlTarget ??
            claudeControlTarget({
              job,
              runId,
              workerId: this.workerId,
              ...(workspaceId === undefined ? {} : { workspaceId }),
            }),
          deliveryAttemptId: `${runId}:worker-control`,
          now: this.clock.now(),
        })
      : undefined;
    await this.runArtifacts.startRun({
      runId,
      providerInstanceId: this.options.providerInstanceId,
      workerId: this.workerId,
      configDir: this.configDir,
      ...(workspaceId === undefined ? {} : { workspacePath: workspaceId }),
      ...(job.jobId === undefined ? {} : { jobId: job.jobId }),
      ...(isThreadJob(job) ? { threadId: job.threadId } : {}),
      ...(this.capacityTracker.accountId ?? this.options.capacityAccountId
        ? {
            capacityAccountId:
              this.capacityTracker.accountId ?? this.options.capacityAccountId,
          }
        : {}),
      workerState: this.workerState,
      capacity: this.capacity(),
      ...(controlBatch?.signalIds.length
        ? { controlSignalIds: controlBatch.signalIds }
        : {}),
    });
    const heartbeat = this.runArtifacts.startHeartbeat({
      runId,
      intervalMs: this.runArtifactHeartbeatMs,
      snapshot: () => ({
        workerState: this.workerState,
        capacity: this.capacity(),
        ...(controlBatch?.signalIds.length
          ? { controlSignalIds: controlBatch.signalIds }
          : {}),
      }),
    });
    const systemPrompt = appendWorkerControlSystemPrompt(
      job.systemPrompt,
      controlBatch?.message,
    );
    assertProviderTaskSystemPrompt(systemPrompt, "job.systemPrompt");
    let terminalRecorded = false;
    try {
      const result = await this.runtime.refreshThenRunTask({
        providerInstanceId: this.options.providerInstanceId,
        task: {
          kind: job.kind ?? "structured-prompt",
          prompt: appendWorkerControlPromptNotice(
            job.prompt,
            controlBatch?.message,
            controlBatch?.signals,
            shouldEchoWorkerControlInPrompt(job, this.options),
          ),
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
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
          ...(input.onProviderTaskStarted
            ? { onProviderTaskStarted: input.onProviderTaskStarted }
            : {}),
        },
      });

      if (result.status === "blocked") {
        this.capacityTracker.recordBlocked(result.reason);
        terminalRecorded = true;
        heartbeat.stop();
        await this.runArtifacts.failRun({
          runId,
          status: "blocked",
          reason: result.reason,
          safeMessage: result.safeMessage,
          warnings: result.warnings,
          workerState: this.workerState,
          capacity: this.capacity(),
        });
        throw new SubscriptionWorkerError(
          "subscription_worker_run_failed",
          result.safeMessage,
          { details: { reason: result.reason } },
        );
      }

      if (result.task.status === "failed") {
        this.capacityTracker.recordFailure(result.task.failure);
        terminalRecorded = true;
        heartbeat.stop();
        await this.runArtifacts.failRun({
          runId,
          status: "failed",
          reason: result.task.failure.code,
          safeMessage: result.task.failure.safeMessage,
          ...(result.task.failure.details === undefined
            ? {}
            : { failureDetails: result.task.failure.details }),
          ...(result.task.telemetry === undefined
            ? {}
            : { telemetry: result.task.telemetry }),
          warnings: result.task.warnings,
          workerState: this.workerState,
          capacity: this.capacity(),
        });
        throw new SubscriptionWorkerError(
          "subscription_worker_run_failed",
          result.task.failure.safeMessage,
          { details: { code: result.task.failure.code } },
        );
      }

      const output = this.taskResultToOutput(result, controlBatch?.signalIds ?? []);
      terminalRecorded = true;
      heartbeat.stop();
      await this.runArtifacts.completeRun({
        runId,
        outputText: output.outputText,
        ...(output.telemetry === undefined ? {} : { telemetry: output.telemetry }),
        warnings: output.warnings,
        workerState: this.workerState,
        capacity: this.capacity(),
      });
      return output;
    } catch (error) {
      if (!terminalRecorded) {
        await this.runArtifacts.failRun({
          runId,
          status: "failed",
          reason: errorCode(error),
          safeMessage:
            error instanceof Error ? error.message : "Claude worker task failed.",
          workerState: this.workerState,
          capacity: this.capacity(),
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      abort.dispose();
      heartbeat.stop();
    }
  }

  async runThreadJob(
    job: FileBackendClaudeWorkerThreadJob,
    options: SubscriptionWorkerRunOptions = {},
  ): Promise<FileBackendClaudeWorkerThreadResult> {
    this.assertStarted();
    const workspacePath = this.threadWorkspacePath(job.threadId);
    let capturedBundleId: string | undefined;
    let previousBundleId: string | undefined;
    try {
      const updated = await this.logicalThreadStore.updateExclusive({
        threadId: job.threadId,
        update: async (current) => {
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
          }, {
            ...options,
            workspaceId: workspacePath,
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
          capturedBundleId = bundle.bundleId;
          previousBundleId = current?.latestBundleId;
          return {
            next: {
              threadId: job.threadId,
              cwd: bundle.cwd,
              latestSessionId,
              latestBundleId: bundle.bundleId,
              latestProviderInstanceId: this.options.providerInstanceId,
              latestWorkerId: this.workerId,
              updatedAt: this.clock.now().toISOString(),
            },
            value: result,
          };
        },
      });
      if (previousBundleId && previousBundleId !== updated.state.latestBundleId) {
        await this.removeTranscriptBundle(previousBundleId);
      }
      return { ...updated.value, thread: updated.state };
    } catch (error) {
      if (capturedBundleId) {
        await this.removeTranscriptBundle(capturedBundleId);
      }
      throw error;
    }
  }

  private async removeTranscriptBundle(bundleId: string): Promise<void> {
    await this.transcriptBundleStore.remove?.({ bundleId }).catch(() => {
      // Best-effort cleanup; handoff correctness must not depend on GC.
    });
  }

  capacity(): WorkerCapacitySnapshot {
    return this.capacityTracker.capacity(this.workerState);
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
    workerControlSignalIds: readonly string[] = [],
  ): FileBackendClaudeWorkerResult {
    if (result.task.status === "failed") {
      this.capacityTracker.recordFailure(result.task.failure);
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        result.task.failure.safeMessage,
        { details: { code: result.task.failure.code } },
      );
    }

    this.capacityTracker.recordSuccessfulRun();
    return {
      outputText: result.task.outputText,
      structuredOutput: result.task.structuredOutput,
      ...(result.task.telemetry === undefined
        ? {}
        : { telemetry: result.task.telemetry }),
      ...(workerControlSignalIds.length === 0
        ? {}
        : { workerControlSignalIds }),
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

function appendWorkerControlSystemPrompt(
  systemPrompt: string | undefined,
  controlMessage: string | undefined,
): string | undefined {
  if (!controlMessage) return systemPrompt;
  return [systemPrompt?.trim(), controlMessage.trim()].filter(Boolean).join("\n\n");
}

function appendWorkerControlPromptNotice(
  prompt: string,
  controlMessage: string | undefined,
  signals: WorkerControlContinuationBatch["signals"] | undefined,
  echoControlMessage: boolean,
): string {
  if (!controlMessage) return prompt;
  const signalBodies = signals?.map((signal) => signal.body.trim())
    .filter(Boolean)
    .join("\n\n");
  const notice = [
    "Important runtime note: a trusted operator control update is available in the system prompt for this run. That update is newer than the task text below and overrides any conflicting older task details. Execute the system-prompt control update now; do not execute older conflicting details from the task text below.",
    "",
  ];
  if (signalBodies || echoControlMessage) {
    return [
      "Updated task from operator:",
      signalBodies || controlMessage.trim(),
      "",
      "Previous task text:",
      prompt,
    ].join("\n");
  }
  return [...notice, prompt].join("\n");
}

function shouldEchoWorkerControlInPrompt(
  job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob,
  options: FileBackendClaudeWorkerOptions,
): boolean {
  const tools = job.controls?.allowedTools ?? options.allowedTools;
  return tools?.some((tool) =>
    /(^|[,:\s])(Bash|Write|Edit|MultiEdit)(\(|$|[,:\s])/i.test(tool)
  ) ?? false;
}

function claudeControlTarget(input: {
  readonly job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob;
  readonly runId: string;
  readonly workerId: string;
  readonly workspaceId?: string;
}): WorkerControlTarget {
  const threadId = isThreadJob(input.job) ? input.job.threadId : undefined;
  return {
    jobId: input.job.jobId ?? threadId ?? input.job.runId ?? input.runId,
    taskId: input.job.runId ?? threadId ?? input.runId,
    workerId: input.workerId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };
}

function isThreadJob(
  job: FileBackendClaudeWorkerJob | FileBackendClaudeWorkerThreadJob,
): job is FileBackendClaudeWorkerThreadJob {
  return "threadId" in job && typeof job.threadId === "string";
}

function errorCode(error: unknown): string {
  if (error instanceof SubscriptionWorkerError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "unknown_runtime_failure";
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

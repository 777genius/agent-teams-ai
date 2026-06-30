import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createSubscriptionRuntime, DefaultRedactor, DeterministicIdGenerator, assertProviderTaskSystemPrompt, } from "@vioxen/subscription-runtime/core";
import { ClaudeCliTaskExecutionEngine, ClaudeRuntimeTaskExecutionEngine, ClaudeRuntimeWithCliFallbackExecutionEngine, ClaudeSessionDriver, ClaudeTaskAgentDriver, claudeRuntimeResumeSessionIdMetadataKey, claudeRuntimeThreadIdMetadataKey, sessionArtifactFromClaudeOAuth, validateClaudeSessionArtifact, } from "@vioxen/subscription-runtime/provider-claude";
import { createLocalFileBackendRuntimeAdapters, LocalFileWorkerControlInboxStore, } from "@vioxen/subscription-runtime/store-local-file";
import { SubscriptionWorkerError, WorkerControlService, } from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner.js";
import { NullWorkerObservability } from "../worker-local/observability.js";
import { StableWorkerWorkspace } from "../worker-local/temp-workspace.js";
import { FileClaudeRateLimitTelemetry, } from "./rate-limit-telemetry.js";
import { FileClaudeRunArtifactStore, } from "./claude-run-artifacts.js";
import { FileClaudeLogicalThreadStore, FileClaudeTranscriptBundleStore, } from "./thread-handoff.js";
const claudeCapacityAccountIdMetadataKey = "capacityAccountId";
export class FileBackendClaudeWorker {
    options;
    workerId;
    configDir;
    workerState = "created";
    redactor = new DefaultRedactor();
    runner;
    workspace;
    observability;
    clock;
    controlInbox;
    sessionDriver = new ClaudeSessionDriver();
    agentDriver;
    sessionStore;
    runtime;
    ownedWorkspace;
    stableWorkspacePath;
    rateLimitTelemetry;
    logicalThreadStore;
    transcriptBundleStore;
    runArtifacts;
    runArtifactHeartbeatMs;
    capacityState = { availability: "available" };
    windowStartedAtMs;
    runsInWindow = 0;
    quotaGroup = null;
    capacityAccountId = null;
    constructor(options) {
        this.options = options;
        this.workerId =
            options.workerId ??
                `file-backend-claude:${hashText(options.providerInstanceId).slice(0, 12)}`;
        assertWorkerOptions(options);
        this.configDir =
            options.configDir ??
                join(options.stateRootDir, "claude-configs", hashText(this.workerId));
        this.runner = options.runner ?? new NodeProcessRunner();
        const defaultWorkspacePath = join(options.stateRootDir, "workspaces", hashText(this.workerId));
        this.ownedWorkspace = options.workspace
            ? null
            : new StableWorkerWorkspace(defaultWorkspacePath, {
                allowedRootDir: options.stateRootDir,
            });
        this.workspace = options.workspace ?? this.ownedWorkspace;
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
                new FileClaudeLogicalThreadStore(join(options.stateRootDir, "claude-logical-threads"));
        this.transcriptBundleStore =
            options.transcriptBundleStore ??
                new FileClaudeTranscriptBundleStore(join(options.stateRootDir, "claude-transcript-bundles"));
        this.runArtifacts = new FileClaudeRunArtifactStore({
            rootDir: options.runArtifactsRootDir ??
                join(options.stateRootDir, "claude-run-artifacts"),
            ...(options.clock ? { clock: options.clock } : {}),
            redactor: this.redactor,
        });
        this.runArtifactHeartbeatMs = options.runArtifactHeartbeatMs ?? 30_000;
        const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
            providerId: "claude",
            rootDir: join(options.stateRootDir, "sessions"),
            encryptionKey: options.encryptionKey,
            metadata: { adapter: "file-backend-claude-worker" },
        });
        this.sessionStore = sessionStore;
        this.agentDriver = new ClaudeTaskAgentDriver({
            engine: options.engine ??
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
    defaultClaudeTaskEngine(options) {
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
        return new ClaudeRuntimeWithCliFallbackExecutionEngine({
            primary,
            fallback: new ClaudeCliTaskExecutionEngine({
                ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
                ...(options.claudePath ? { claudePath: options.claudePath } : {}),
                ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
            }),
        });
    }
    get state() {
        return this.workerState;
    }
    async start() {
        if (this.workerState === "disposed") {
            throw new SubscriptionWorkerError("subscription_worker_disposed", "Claude worker has been disposed.");
        }
        if (this.workerState !== "created" && this.workerState !== "failed") {
            throw new SubscriptionWorkerError("subscription_worker_already_started", "Claude worker is already started.");
        }
        await mkdir(this.configDir, { recursive: true, mode: 0o700 });
        await this.rateLimitTelemetry?.prepare?.();
        this.capacityState = { availability: "available" };
        this.workerState = "started";
    }
    async seedClaudeOAuth(input) {
        const capacityAccountId = normalizeCapacityAccountId(input.capacityAccountId) ??
            normalizeCapacityAccountId(this.options.capacityAccountId);
        const existing = await this.sessionStore.read({
            providerInstanceId: this.options.providerInstanceId,
            expectedProviderId: "claude",
            purpose: "health-check",
        });
        if (existing) {
            const capacityArtifact = await this.persistStoredCapacityAccountId(existing, capacityAccountId);
            this.rememberQuotaGroup(capacityArtifact, capacityAccountId);
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
        this.rememberQuotaGroup(artifact);
    }
    async prewarm() {
        this.assertStarted();
        this.workerState = "prewarming";
        try {
            const health = await this.runtime.healthCheck({
                providerInstanceId: this.options.providerInstanceId,
            });
            if (health.status !== "healthy") {
                this.workerState = "failed";
                throw new SubscriptionWorkerError("subscription_worker_prewarm_failed", "Claude session is not healthy.", {
                    details: {
                        reason: health.failures[0]?.safeMessage ?? "Claude health failed.",
                    },
                });
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
        }
        catch (error) {
            this.workerState = "failed";
            throw error;
        }
    }
    async run(job) {
        if (isThreadJob(job))
            return this.runThreadJob(job);
        return this.runProviderTask(job);
    }
    async runProviderTask(job, input = {}) {
        this.assertStarted();
        assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
        const runId = job.runId ?? `local-${randomUUID()}`;
        const abortSignal = job.abortSignal ?? new AbortController().signal;
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
            ...(this.capacityAccountId ?? this.options.capacityAccountId
                ? { capacityAccountId: this.capacityAccountId ?? this.options.capacityAccountId }
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
        let terminalRecorded = false;
        try {
            const result = await this.runtime.refreshThenRunTask({
                providerInstanceId: this.options.providerInstanceId,
                task: {
                    kind: job.kind ?? "structured-prompt",
                    prompt: appendWorkerControlPrompt(job.prompt, controlBatch?.message),
                    ...(job.systemPrompt !== undefined ? { systemPrompt: job.systemPrompt } : {}),
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
                throw new SubscriptionWorkerError("subscription_worker_run_failed", result.safeMessage, { details: { reason: result.reason } });
            }
            if (result.task.status === "failed") {
                this.recordFailure(result.task.failure);
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
                throw new SubscriptionWorkerError("subscription_worker_run_failed", result.task.failure.safeMessage, { details: { code: result.task.failure.code } });
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
        }
        catch (error) {
            if (!terminalRecorded) {
                await this.runArtifacts.failRun({
                    runId,
                    status: "failed",
                    reason: errorCode(error),
                    safeMessage: error instanceof Error ? error.message : "Claude worker task failed.",
                    workerState: this.workerState,
                    capacity: this.capacity(),
                }).catch(() => undefined);
            }
            throw error;
        }
        finally {
            heartbeat.stop();
        }
    }
    async runThreadJob(job) {
        this.assertStarted();
        const workspacePath = this.threadWorkspacePath(job.threadId);
        let capturedBundleId;
        let previousBundleId;
        try {
            const updated = await this.logicalThreadStore.updateExclusive({
                threadId: job.threadId,
                update: async (current) => {
                    const comparableWorkspacePath = current
                        ? await canonicalPath(workspacePath)
                        : workspacePath;
                    this.assertThreadWorkspaceCompatible(job.threadId, current, comparableWorkspacePath);
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
                                    [claudeRuntimeResumeSessionIdMetadataKey]: current.latestSessionId,
                                }),
                        },
                    }, { workspaceId: workspacePath });
                    const latestSessionId = result.telemetry?.providerSessionId;
                    if (!latestSessionId) {
                        throw new SubscriptionWorkerError("subscription_worker_run_failed", "Claude runtime did not return a provider session id for thread handoff.");
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
        }
        catch (error) {
            if (capturedBundleId) {
                await this.removeTranscriptBundle(capturedBundleId);
            }
            throw error;
        }
    }
    async removeTranscriptBundle(bundleId) {
        await this.transcriptBundleStore.remove?.({ bundleId }).catch(() => {
            // Best-effort cleanup; handoff correctness must not depend on GC.
        });
    }
    capacity() {
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
        this.capacityState = normalizeResettableCapacity(this.capacityState, this.clock.now());
        const capacity = {
            ...this.capacityState,
            recentRuns: this.runsInWindow,
            ...(this.options.capacityPolicy?.softMaxRunsPerWindow === undefined
                ? {}
                : {
                    softLimitRemainingRuns: Math.max(0, this.options.capacityPolicy.softMaxRunsPerWindow -
                        this.runsInWindow),
                }),
        };
        return this.withCapacityDetails(mergeCapacity(capacity, this.rateLimitCapacity()));
    }
    async health() {
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
        }
        catch (error) {
            return {
                status: "unhealthy",
                state: "failed",
                checkedAt: this.clock.now(),
                failures: [
                    {
                        code: "subscription_worker_health_failed",
                        safeMessage: error instanceof Error ? error.message : "Claude health failed.",
                    },
                ],
                warnings: [],
            };
        }
    }
    async dispose() {
        if (this.workerState === "disposed")
            return;
        this.workerState = "draining";
        try {
            await this.agentDriver.dispose();
        }
        finally {
            await this.ownedWorkspace?.dispose();
            this.workerState = "disposed";
        }
    }
    taskResultToOutput(result, workerControlSignalIds = []) {
        if (result.task.status === "failed") {
            this.recordFailure(result.task.failure);
            throw new SubscriptionWorkerError("subscription_worker_run_failed", result.task.failure.safeMessage, { details: { code: result.task.failure.code } });
        }
        this.recordSuccessfulRun();
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
    assertThreadWorkspaceCompatible(threadId, state, workspacePath) {
        if (!state || state.cwd === workspacePath)
            return;
        throw new SubscriptionWorkerError("subscription_worker_run_failed", "Claude logical thread handoff requires all workers to use the same workspace path.", {
            details: {
                threadId,
                expectedCwd: state.cwd,
                actualCwd: workspacePath,
            },
        });
    }
    threadWorkspacePath(threadId) {
        if (this.stableWorkspacePath)
            return this.stableWorkspacePath;
        throw new SubscriptionWorkerError("subscription_worker_run_failed", "Claude logical thread handoff requires a stable workspacePath when a custom workspace is injected.", { details: { threadId } });
    }
    recordSuccessfulRun() {
        this.rollCapacityWindow();
        this.runsInWindow += 1;
        const maxRuns = this.options.capacityPolicy?.softMaxRunsPerWindow;
        if (maxRuns === undefined || this.runsInWindow < maxRuns)
            return;
        const cooldownUntil = new Date(this.windowStartedAtMs + capacityWindowMs(this.options.capacityPolicy));
        this.capacityState = {
            availability: "cooldown",
            reason: "soft_run_limit",
            cooldownUntil,
        };
    }
    recordFailure(failure) {
        if (failure.code === "quota_limited") {
            this.capacityState = {
                availability: "cooldown",
                reason: "quota_limited",
                cooldownUntil: new Date(this.clock.now().getTime() +
                    (this.options.capacityPolicy?.quotaCooldownMs ?? 15 * 60 * 1000)),
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
    recordBlocked(reason) {
        if (reason === "quota_limited") {
            this.capacityState = {
                availability: "cooldown",
                reason,
                cooldownUntil: new Date(this.clock.now().getTime() +
                    (this.options.capacityPolicy?.quotaCooldownMs ?? 15 * 60 * 1000)),
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
    rateLimitCapacity() {
        const minRemaining = this.options.capacityPolicy?.rateLimitMinRemainingPercent;
        if (minRemaining === undefined || this.rateLimitTelemetry === null) {
            return null;
        }
        const snapshot = this.rateLimitTelemetry.latest();
        if (!snapshot)
            return null;
        const windows = this.options.capacityPolicy?.rateLimitWindows ??
            ["five_hour", "seven_day"];
        const nowMs = this.clock.now().getTime();
        let selected = null;
        for (const name of windows) {
            const window = snapshot.windows[name];
            if (!window || window.resetsAt.getTime() <= nowMs)
                continue;
            if (window.remainingPercentage > minRemaining)
                continue;
            if (!selected || window.resetsAt.getTime() > selected.resetsAt.getTime()) {
                selected = {
                    name,
                    usedPercentage: window.usedPercentage,
                    remainingPercentage: window.remainingPercentage,
                    resetsAt: window.resetsAt,
                };
            }
        }
        if (!selected)
            return null;
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
    rollCapacityWindow() {
        const nowMs = this.clock.now().getTime();
        const windowMs = capacityWindowMs(this.options.capacityPolicy);
        if (nowMs - this.windowStartedAtMs < windowMs)
            return;
        this.windowStartedAtMs = nowMs;
        this.runsInWindow = 0;
        if (this.capacityState.availability === "cooldown") {
            this.capacityState = { availability: "available" };
        }
    }
    rememberQuotaGroup(session, capacityAccountIdOverride) {
        try {
            const validation = validateClaudeSessionArtifact(session);
            this.quotaGroup = `claude-oauth:${hashText(validation.session.oauthToken).slice(0, 16)}`;
            this.capacityAccountId =
                normalizeCapacityAccountId(capacityAccountIdOverride) ??
                    normalizeCapacityAccountId(this.options.capacityAccountId) ??
                    normalizeCapacityAccountId(validation.session.metadata?.[claudeCapacityAccountIdMetadataKey]) ??
                    this.quotaGroup;
        }
        catch {
            this.quotaGroup = null;
            this.capacityAccountId = null;
        }
    }
    async persistStoredCapacityAccountId(session, capacityAccountId) {
        if (!capacityAccountId)
            return session.artifact;
        let current = session;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const updatedArtifact = this.withStoredCapacityAccountId(current.artifact, capacityAccountId);
            if (!updatedArtifact)
                return current.artifact;
            const write = await this.sessionStore.write({
                providerInstanceId: this.options.providerInstanceId,
                expectedGeneration: current.generation,
                nextArtifact: updatedArtifact,
                idempotencyKey: `seed-capacity-account:${hashText(`${capacityAccountId}:${current.generationHash}`)}`,
                leaseId: "seed-local-file-backend",
            });
            if (write.status === "accepted" ||
                write.status === "idempotent_replay") {
                return updatedArtifact;
            }
            const latest = await this.sessionStore.read({
                providerInstanceId: this.options.providerInstanceId,
                expectedProviderId: "claude",
                purpose: "health-check",
            });
            if (!latest)
                break;
            current = latest;
        }
        throw new Error("claude_capacity_account_update_conflict");
    }
    withStoredCapacityAccountId(session, capacityAccountId) {
        if (!capacityAccountId)
            return null;
        let validation;
        try {
            validation = validateClaudeSessionArtifact(session);
        }
        catch {
            return null;
        }
        const storedCapacityAccountId = normalizeCapacityAccountId(validation.session.metadata?.[claudeCapacityAccountIdMetadataKey]);
        if (storedCapacityAccountId === capacityAccountId)
            return null;
        return sessionArtifactFromClaudeOAuth({
            oauthToken: validation.session.oauthToken,
            ...(validation.session.configDir
                ? { configDir: validation.session.configDir }
                : {}),
            ...(validation.session.refreshedAt
                ? { refreshedAt: validation.session.refreshedAt }
                : {}),
            ...(validation.session.expiresAt
                ? { expiresAt: validation.session.expiresAt }
                : {}),
            metadata: {
                ...(validation.session.metadata ?? {}),
                [claudeCapacityAccountIdMetadataKey]: capacityAccountId,
            },
        });
    }
    withCapacityDetails(capacity) {
        return {
            ...capacity,
            details: {
                ...(capacity.details ?? {}),
                providerInstanceId: this.options.providerInstanceId,
                configDir: this.configDir,
                ...(this.capacityAccountId
                    ? { accountId: this.capacityAccountId }
                    : {}),
                ...(this.quotaGroup ? { quotaGroup: this.quotaGroup } : {}),
            },
        };
    }
    async assertStoredSessionHasConfigDir() {
        const session = await this.sessionStore.read({
            providerInstanceId: this.options.providerInstanceId,
            expectedProviderId: "claude",
            purpose: "health-check",
        });
        if (!session) {
            throw new SubscriptionWorkerError("subscription_worker_prewarm_failed", "Claude session is missing.");
        }
        const validation = validateClaudeSessionArtifact(session.artifact);
        if (!validation.session.configDir) {
            throw new SubscriptionWorkerError("subscription_worker_prewarm_failed", "Claude session is missing a config dir.");
        }
    }
    assertStarted() {
        if (this.workerState === "disposed") {
            throw new SubscriptionWorkerError("subscription_worker_disposed", "Claude worker has been disposed.");
        }
        if (this.workerState === "created") {
            throw new SubscriptionWorkerError("subscription_worker_not_started", "Claude worker has not been started.");
        }
    }
}
function capacityWindowMs(policy) {
    return policy?.windowMs ?? 5 * 60 * 60 * 1000;
}
function mergeCapacity(base, telemetry) {
    if (telemetry === null)
        return base;
    if (base.availability === "available") {
        return telemetry;
    }
    if (base.availability === "cooldown" &&
        telemetry.availability === "cooldown") {
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
function normalizeResettableCapacity(capacity, now) {
    if (!isResettableCapacity(capacity) ||
        !capacity.cooldownUntil ||
        capacity.cooldownUntil.getTime() > now.getTime()) {
        return capacity;
    }
    const { cooldownUntil: _cooldownUntil, lastLimitSignalAt: _lastLimitSignalAt, reason: _reason, ...rest } = capacity;
    return {
        ...rest,
        availability: "available",
    };
}
function isSevereCapacity(capacity) {
    return (capacity.availability === "quota_exhausted" ||
        capacity.availability === "degraded" ||
        capacity.availability === "disabled");
}
function isResettableCapacity(capacity) {
    return (capacity.availability === "cooldown" ||
        capacity.availability === "quota_exhausted");
}
function assertWorkerOptions(options) {
    if (!options.providerInstanceId.trim()) {
        throw new Error("file_backend_claude_provider_instance_required");
    }
    if (!options.stateRootDir.trim()) {
        throw new Error("file_backend_claude_state_root_required");
    }
    const minRemaining = options.capacityPolicy?.rateLimitMinRemainingPercent;
    if (minRemaining !== undefined &&
        (!Number.isFinite(minRemaining) || minRemaining < 0 || minRemaining > 100)) {
        throw new Error("file_backend_claude_rate_limit_threshold_invalid");
    }
    if (options.capacityPolicy?.rateLimitWindows?.length === 0) {
        throw new Error("file_backend_claude_rate_limit_windows_empty");
    }
}
function appendWorkerControlPrompt(prompt, controlMessage) {
    if (!controlMessage)
        return prompt;
    return [prompt.trimEnd(), controlMessage.trim()].join("\n\n");
}
function claudeControlTarget(input) {
    const threadId = isThreadJob(input.job) ? input.job.threadId : undefined;
    return {
        jobId: input.job.jobId ?? threadId ?? input.job.runId ?? input.runId,
        taskId: input.job.runId ?? threadId ?? input.runId,
        workerId: input.workerId,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    };
}
function isThreadJob(job) {
    return "threadId" in job && typeof job.threadId === "string";
}
function errorCode(error) {
    if (error instanceof SubscriptionWorkerError)
        return error.code;
    if (error instanceof Error && error.name)
        return error.name;
    return "unknown_runtime_failure";
}
async function canonicalPath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return path;
    }
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
function normalizeCapacityAccountId(value) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}
const systemClock = {
    now: () => new Date(),
    monotonicMs: () => performance.now(),
};
//# sourceMappingURL=file-backend-claude-worker.js.map
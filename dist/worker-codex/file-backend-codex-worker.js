import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSubscriptionRuntime, DefaultRedactor, DeterministicIdGenerator, assertProviderTaskSystemPrompt, } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine, CodexCliSessionDriver, CodexJsonAgentDriver, CodexWorkerCacheSessionPoolMaterializer, PackagedCodexJsonExecutionEngine, defaultCodexModel, sessionArtifactFromCodexAuthJson, codexAuthJsonFromArtifact, validateCodexAuthJsonBytes, } from "@vioxen/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import { SubscriptionWorkerError, } from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner.js";
import { NullWorkerObservability } from "../worker-local/observability.js";
import { BorrowedRunTaskWorkspace, StableWorkerWorkspace, } from "../worker-local/temp-workspace.js";
export class FileBackendCodexWorker {
    options;
    workerId;
    workerState = "created";
    redactor = new DefaultRedactor();
    runner;
    workspace;
    observability;
    clock;
    sessionDriver;
    agentDriver;
    sessionStore;
    runtime;
    ownedWorkspace;
    prewarmWorkspace;
    capacityState = { availability: "available" };
    windowStartedAtMs;
    runsInWindow = 0;
    quotaGroup = null;
    capacityAccountId = null;
    constructor(options) {
        this.options = options;
        this.workerId =
            options.workerId ??
                `file-backend-codex:${hashText(options.providerInstanceId).slice(0, 12)}`;
        assertWorkerOptions(options);
        this.runner = options.runner ?? new NodeProcessRunner();
        const defaultWorkspacePath = join(options.stateRootDir, "workspaces", hashText(this.workerId));
        this.ownedWorkspace = options.workspace
            ? null
            : new StableWorkerWorkspace(defaultWorkspacePath, {
                allowedRootDir: options.stateRootDir,
            });
        this.workspace =
            options.workspace ??
                (options.workspacePath
                    ? new BorrowedRunTaskWorkspace(options.workspacePath, this.ownedWorkspace)
                    : this.ownedWorkspace);
        this.prewarmWorkspace = options.workspace ?? this.ownedWorkspace;
        this.observability = options.observability ?? new NullWorkerObservability();
        this.clock = options.clock ?? systemClock;
        this.windowStartedAtMs = this.clock.now().getTime();
        this.capacityAccountId = normalizeCapacityAccountId(options.capacityAccountId);
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
    get state() {
        return this.workerState;
    }
    async start() {
        if (this.workerState === "disposed") {
            throw new SubscriptionWorkerError("subscription_worker_disposed", "Codex worker has been disposed.");
        }
        if (this.workerState !== "created" && this.workerState !== "failed") {
            throw new SubscriptionWorkerError("subscription_worker_already_started", "Codex worker is already started.");
        }
        this.workerState = "started";
    }
    async seedCodexAuthJsonFile(authJsonPath) {
        const authJson = await readFile(authJsonPath, "utf8");
        await this.seedCodexAuthJson(authJson);
    }
    async seedCodexAuthJson(authJson) {
        const existing = await this.sessionStore.read({
            providerInstanceId: this.options.providerInstanceId,
            expectedProviderId: "codex",
            purpose: "health-check",
        });
        if (existing) {
            this.rememberQuotaGroup(existing.artifact);
            return;
        }
        const artifact = sessionArtifactFromCodexAuthJson(authJson);
        await this.sessionStore.write({
            providerInstanceId: this.options.providerInstanceId,
            expectedGeneration: 0,
            nextArtifact: artifact,
            idempotencyKey: `seed:${hashText(authJson)}`,
            leaseId: "seed-local-file-backend",
        });
        this.rememberQuotaGroup(artifact);
    }
    async prewarm() {
        this.assertStarted();
        this.workerState = "prewarming";
        const session = await this.sessionStore.read({
            providerInstanceId: this.options.providerInstanceId,
            expectedProviderId: "codex",
            purpose: "run",
        });
        if (!session) {
            this.workerState = "failed";
            throw new SubscriptionWorkerError("subscription_worker_prewarm_failed", "Codex session is missing.");
        }
        this.rememberQuotaGroup(session.artifact);
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
        }
        catch (error) {
            this.workerState = "failed";
            throw error;
        }
        finally {
            await workspace.dispose?.();
        }
    }
    async run(job) {
        this.assertStarted();
        assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
        await this.rememberStoredQuotaGroup();
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
                return this.taskResultToOutput(result.task);
            }
            if (shouldRetryRefreshConflict(result) &&
                !abortSignal.aborted &&
                this.clock.monotonicMs() - startedAt < retryMaxMs) {
                await delay(refreshConflictDelayMs(attempt), abortSignal);
                attempt += 1;
                continue;
            }
            this.recordBlocked(result.reason);
            throw new SubscriptionWorkerError("subscription_worker_run_failed", result.safeMessage, { details: { reason: result.reason } });
        }
    }
    async health() {
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
        }
        catch (error) {
            return {
                status: "unhealthy",
                state: "failed",
                checkedAt: this.clock.now(),
                failures: [
                    {
                        code: "subscription_worker_health_failed",
                        safeMessage: error instanceof Error ? error.message : "Codex health failed.",
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
        return this.withCapacityDetails({
            ...this.capacityState,
            recentRuns: this.runsInWindow,
            ...(this.options.capacityPolicy?.softMaxRunsPerWindow === undefined
                ? {}
                : {
                    softLimitRemainingRuns: Math.max(0, this.options.capacityPolicy.softMaxRunsPerWindow -
                        this.runsInWindow),
                }),
        });
    }
    taskResultToOutput(result) {
        if (result.status === "failed") {
            this.recordFailure(result.failure);
            throw new SubscriptionWorkerError("subscription_worker_run_failed", result.failure.safeMessage, { details: { code: result.failure.code } });
        }
        this.recordSuccessfulRun();
        return {
            outputText: result.outputText,
            structuredOutput: result.structuredOutput,
            warnings: result.warnings,
        };
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
    async rememberStoredQuotaGroup() {
        if (this.quotaGroup || this.capacityAccountId)
            return;
        const session = await this.sessionStore.read({
            providerInstanceId: this.options.providerInstanceId,
            expectedProviderId: "codex",
            purpose: "health-check",
        });
        if (session)
            this.rememberQuotaGroup(session.artifact);
    }
    rememberQuotaGroup(session) {
        try {
            const authJsonBytes = codexAuthJsonFromArtifact(session);
            const validation = validateCodexAuthJsonBytes({ authJsonBytes });
            this.quotaGroup = `codex-chatgpt:${hashText(validation.parsed.tokens.refresh_token).slice(0, 16)}`;
            this.capacityAccountId =
                normalizeCapacityAccountId(this.options.capacityAccountId) ??
                    this.quotaGroup;
        }
        catch {
            this.quotaGroup = null;
            this.capacityAccountId = normalizeCapacityAccountId(this.options.capacityAccountId);
        }
    }
    withCapacityDetails(capacity) {
        return {
            ...capacity,
            details: {
                ...(capacity.details ?? {}),
                providerInstanceId: this.options.providerInstanceId,
                ...(this.capacityAccountId
                    ? { accountId: this.capacityAccountId }
                    : {}),
                ...(this.quotaGroup ? { quotaGroup: this.quotaGroup } : {}),
            },
        };
    }
    assertStarted() {
        if (this.workerState === "disposed") {
            throw new SubscriptionWorkerError("subscription_worker_disposed", "Codex worker has been disposed.");
        }
        if (this.workerState === "created") {
            throw new SubscriptionWorkerError("subscription_worker_not_started", "Codex worker has not been started.");
        }
    }
}
function shouldRetryRefreshConflict(result) {
    if (result.status !== "blocked")
        return false;
    if (result.reason === "stale_generation")
        return true;
    return (result.reason === "permission_required" &&
        /session refresh is already leased/i.test(result.safeMessage));
}
function refreshConflictDelayMs(attempt) {
    return Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
}
function delay(ms, abortSignal) {
    if (abortSignal.aborted) {
        return Promise.reject(new Error("subscription_worker_run_aborted"));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("subscription_worker_run_aborted"));
        }, { once: true });
    });
}
function assertWorkerOptions(options) {
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
    const softMaxRuns = options.capacityPolicy?.softMaxRunsPerWindow;
    if (softMaxRuns !== undefined &&
        (!Number.isInteger(softMaxRuns) || softMaxRuns <= 0)) {
        throw new Error("file_backend_codex_soft_max_runs_invalid");
    }
    const windowMs = options.capacityPolicy?.windowMs;
    if (windowMs !== undefined &&
        (!Number.isFinite(windowMs) || windowMs <= 0)) {
        throw new Error("file_backend_codex_capacity_window_invalid");
    }
    const quotaCooldownMs = options.capacityPolicy?.quotaCooldownMs;
    if (quotaCooldownMs !== undefined &&
        (!Number.isFinite(quotaCooldownMs) || quotaCooldownMs < 0)) {
        throw new Error("file_backend_codex_quota_cooldown_invalid");
    }
}
function capacityWindowMs(policy) {
    return policy?.windowMs ?? 5 * 60 * 60 * 1000;
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
function isResettableCapacity(capacity) {
    return (capacity.availability === "cooldown" ||
        capacity.availability === "quota_exhausted");
}
function isSevereCapacity(capacity) {
    return (capacity.availability === "quota_exhausted" ||
        capacity.availability === "degraded" ||
        capacity.availability === "disabled");
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
const defaultWarmupPrompt = "Return exactly OK.";
//# sourceMappingURL=file-backend-codex-worker.js.map
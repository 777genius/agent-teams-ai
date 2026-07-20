import { computeSessionGenerationHash } from "../domain/generation-hash";
import type {
  CompiledRuntimePolicy,
  ProviderTask,
  ProviderTaskResult,
  RefreshSessionResult,
  RefreshThenRunResult,
  RunContext,
  RuntimeHealthCheckResult,
  RuntimeEvent,
  RuntimeExecutionPlan,
  RuntimeWarning,
  SessionArtifact,
  SessionEnvelope,
} from "../domain/types";
import type { RuntimeDeps } from "../ports";
import { runtimeHealthCheck } from "./runtime-health";
import {
  blocked,
  failedTask,
  nextEnvelope,
  sessionForPostRefreshTask,
  shouldGuardedRefresh,
  unsupportedTaskFailure,
} from "./runtime-results";
import { validateStaticRuntimeSession } from "./runtime-static-session";
import { negotiateCapabilities } from "./policy";

export { combineSessionAndAgent } from "./runtime-results";

export type SubscriptionRuntime = {
  readonly capabilities: CompiledRuntimePolicy;
  readonly executionPlan: RuntimeExecutionPlan;
  refreshSession(input: {
    readonly providerInstanceId: string;
    readonly runContext: RunContext;
    readonly forceRefresh?: boolean;
  }): Promise<RefreshSessionResult>;
  runTask(input: {
    readonly providerInstanceId: string;
    readonly task: ProviderTask;
    readonly runContext: RunContext;
  }): Promise<ProviderTaskResult>;
  refreshThenRunTask(input: {
    readonly providerInstanceId: string;
    readonly task: ProviderTask;
    readonly runContext: RunContext;
  }): Promise<RefreshThenRunResult>;
  healthCheck(input: {
    readonly providerInstanceId: string;
  }): Promise<RuntimeHealthCheckResult>;
};

export function createSubscriptionRuntime(
  deps: RuntimeDeps,
): SubscriptionRuntime {
  const decision = negotiateCapabilities({
    requested: deps.policy,
    provider: deps.sessionDriver.capabilities,
    agent: deps.agentDriver.capabilities,
    runner: deps.runner.capabilities,
    ...(deps.sessionStore ? { store: deps.sessionStore.capabilities } : {}),
  });

  if (decision.status === "rejected") {
    throw new Error(decision.code);
  }

  const kernel = new RuntimeKernel(
    deps,
    decision.compiledPolicy,
    decision.executionPlan,
  );
  return {
    capabilities: decision.compiledPolicy,
    executionPlan: decision.executionPlan,
    refreshSession: (input) => kernel.refreshSession(input),
    runTask: (input) => kernel.runTask(input),
    refreshThenRunTask: (input) => kernel.refreshThenRunTask(input),
    healthCheck: (input) => kernel.healthCheck(input),
  };
}

class RuntimeKernel {
  constructor(
    private readonly deps: RuntimeDeps,
    private readonly policy: CompiledRuntimePolicy,
    private readonly executionPlan: RuntimeExecutionPlan,
  ) {}

  async refreshSession(input: {
    readonly providerInstanceId: string;
    readonly runContext: RunContext;
    readonly forceRefresh?: boolean;
  }): Promise<RefreshSessionResult> {
    if (this.executionPlan.kind === "no-session") {
      this.emit("provider.refresh.skipped", input.runContext.runId, {
        reason: "no_session",
      });
      return {
        status: "skipped",
        reason: "refresh_not_required",
        warnings: [],
      };
    }

    if (this.executionPlan.kind === "static-session") {
      return validateStaticRuntimeSession({
        deps: this.deps,
        executionPlan: this.executionPlan,
        providerInstanceId: input.providerInstanceId,
        runContext: input.runContext,
        emitFailure: (code, runId) => this.emitFailure(code, runId),
      });
    }

    const sessionStore = this.requireSessionStore();
    const leaseStore = this.requireLeaseStore();
    const sessionDriver = this.requireRefreshableSessionDriver();

    const readStartedAt = this.deps.clock.monotonicMs();
    this.emit("session.read.started", input.runContext.runId, {
      purpose: "refresh",
    });
    const session = await sessionStore.read({
      providerInstanceId: input.providerInstanceId,
      expectedProviderId: sessionDriver.providerId,
      purpose: "refresh",
    });
    this.emit(
      "session.read.completed",
      input.runContext.runId,
      {
        purpose: "refresh",
        found: session ? "true" : "false",
        generation: session ? String(session.generation) : "none",
      },
      this.deps.clock.monotonicMs() - readStartedAt,
    );

    if (!session) {
      this.emitFailure("provider_reconnect_required", input.runContext.runId);
      return blocked(
        "provider_reconnect_required",
        "Provider session is missing.",
      );
    }

    this.deps.redactor.registerSecret(session.artifact.bytes, "session");

    if (
      this.executionPlan.kind === "rotating-session" &&
      this.executionPlan.refresh === "lazy" &&
      !input.forceRefresh
    ) {
      const freshness = await this.inspectFreshness({
        session: session.artifact,
        runId: input.runContext.runId,
      });
      if (freshness.status === "fresh") {
        this.emit("provider.refresh.skipped", input.runContext.runId, {
          reason: freshness.reason,
          generation: String(session.generation),
        });
        return {
          status: "skipped",
          reason: "refresh_not_required",
          session,
          warnings: freshness.warnings,
        };
      }
      this.emit("provider.refresh.recommended", input.runContext.runId, {
        reason: freshness.reason,
        generation: String(session.generation),
      });
    }

    const leaseStartedAt = this.deps.clock.monotonicMs();
    this.emit("lease.acquire.started", input.runContext.runId, {
      generation: String(session.generation),
    });
    const lease = await leaseStore.acquire({
      providerInstanceId: input.providerInstanceId,
      runId: input.runContext.runId,
      attempt: input.runContext.attempt,
      ttlMs: this.policy.timeoutMs,
      restoredGenerationHash: session.generationHash,
    });
    this.emit(
      "lease.acquire.completed",
      input.runContext.runId,
      {
        status: lease.status,
      },
      this.deps.clock.monotonicMs() - leaseStartedAt,
    );

    if (lease.status === "stale") {
      this.deps.observability.count("subscription_runtime.stale_generation");
      this.emitFailure("stale_generation", input.runContext.runId);
      return {
        status: "skipped",
        reason: "stale_generation",
        warnings: [],
      };
    }

    if (lease.status === "denied") {
      this.emitFailure("permission_required", input.runContext.runId);
      return blocked("permission_required", lease.safeMessage);
    }

    let leaseClosed = false;
    try {
      const leasedSession = await sessionStore.read({
        providerInstanceId: input.providerInstanceId,
        expectedProviderId: sessionDriver.providerId,
        purpose: "refresh",
      });
      if (!leasedSession) {
        this.emitFailure("provider_reconnect_required", input.runContext.runId);
        return blocked(
          "provider_reconnect_required",
          "Provider session is missing.",
        );
      }
      if (leasedSession.generationHash !== session.generationHash) {
        this.deps.observability.count("subscription_runtime.stale_generation");
        this.emitFailure("stale_generation", input.runContext.runId);
        return {
          status: "skipped",
          reason: "stale_generation",
          warnings: [],
        };
      }

      const validation = await sessionDriver.validateSession({
        session: leasedSession.artifact,
        redactor: this.deps.redactor,
      });

      if (validation.status === "invalid") {
        this.emitFailure(validation.failure.code, input.runContext.runId);
        return blocked(
          validation.failure.reconnectRequired
            ? "provider_reconnect_required"
            : "permission_required",
          validation.failure.safeMessage,
        );
      }

      const workspace = await this.deps.workspace.create({
        purpose: "refresh",
        isolation: "temp-dir",
      });

      try {
        const refreshStartedAt = this.deps.clock.monotonicMs();
        this.emit("provider.refresh.started", input.runContext.runId, {
          generation: String(leasedSession.generation),
        });
        const refreshed = await sessionDriver.refreshSession({
          session: leasedSession.artifact,
          workspace,
          runner: this.deps.runner,
          redactor: this.deps.redactor,
          abortSignal: input.runContext.abortSignal,
        });
        this.emit(
          "provider.refresh.completed",
          input.runContext.runId,
          {
            providerState: refreshed.providerState,
          },
          this.deps.clock.monotonicMs() - refreshStartedAt,
        );
        this.deps.observability.timing(
          "subscription_runtime.provider_refresh_ms",
          this.deps.clock.monotonicMs() - refreshStartedAt,
        );

        if (refreshed.providerState === "needs-reconnect") {
          this.deps.observability.count(
            "subscription_runtime.reconnect_required",
          );
          this.emitFailure("needs_reconnect", input.runContext.runId);
          return blocked(
            "provider_reconnect_required",
            "Provider session needs reconnect.",
            refreshed.warnings,
          );
        }

        if (refreshed.providerState === "permission-required") {
          this.emitFailure("permission_required", input.runContext.runId);
          return blocked(
            "permission_required",
            "Provider permission is required.",
            refreshed.warnings,
          );
        }

        if (refreshed.providerState === "quota-limited") {
          this.deps.observability.count("subscription_runtime.quota_limited");
          this.emitFailure("quota_limited", input.runContext.runId);
          return blocked(
            "quota_limited",
            "Provider quota is limited.",
            refreshed.warnings,
          );
        }

        const nextHash = computeSessionGenerationHash({
          artifact: refreshed.artifact,
        });
        const idempotencyKey = this.deps.idGenerator.idempotencyKey({
          providerInstanceId: input.providerInstanceId,
          runId: input.runContext.runId,
          attempt: input.runContext.attempt,
          purpose: "writeback",
        });

        if (nextHash === leasedSession.generationHash) {
          await leaseStore.finalize({
            leaseId: lease.leaseId,
            restoredGenerationHash: leasedSession.generationHash,
          });
          await leaseStore.markWritebackCommitted({
            leaseId: lease.leaseId,
            nextGenerationHash: leasedSession.generationHash,
            idempotencyKey,
          });
          leaseClosed = true;
          this.emit("session.writeback.completed", input.runContext.runId, {
            status: "skipped_unchanged",
            generation: String(leasedSession.generation),
          });
          return {
            status: "skipped",
            reason: "session_unchanged",
            session: leasedSession,
            warnings: refreshed.warnings,
          };
        }

        await leaseStore.finalize({
          leaseId: lease.leaseId,
          restoredGenerationHash: leasedSession.generationHash,
        });
        this.emit("session.writeback.started", input.runContext.runId, {
          leaseId: lease.leaseId,
          expectedGeneration: String(leasedSession.generation),
        });
        await leaseStore.markWritebackStarted({
          leaseId: lease.leaseId,
        });

        const writeback = await sessionStore.write({
          providerInstanceId: input.providerInstanceId,
          expectedGeneration: leasedSession.generation,
          nextArtifact: refreshed.artifact,
          idempotencyKey,
          leaseId: lease.leaseId,
        });

        if (writeback.status === "stale_generation") {
          this.deps.observability.count(
            "subscription_runtime.writeback_conflict",
          );
          this.emit("session.writeback.completed", input.runContext.runId, {
            status: writeback.status,
          });
          this.emitFailure("stale_generation", input.runContext.runId);
          return {
            status: "skipped",
            reason: "stale_generation",
            warnings: refreshed.warnings,
          };
        }

        await leaseStore.markWritebackCommitted({
          leaseId: lease.leaseId,
          nextGenerationHash: writeback.generationHash,
          idempotencyKey,
        });
        leaseClosed = true;
        this.emit("session.writeback.completed", input.runContext.runId, {
          status: writeback.status,
          generation: String(writeback.generation),
        });
        this.deps.observability.count("subscription_runtime.refresh_success");

        return {
          status: "ready",
          session: nextEnvelope(leasedSession, refreshed.artifact, writeback),
          writeback,
          warnings: refreshed.warnings,
        };
      } finally {
        await workspace.dispose?.();
      }
    } finally {
      if (!leaseClosed) {
        await this.releaseLeaseQuietly({
          leaseId: lease.leaseId,
          runId: input.runContext.runId,
          reason: "refresh_completed_without_committed_writeback",
        });
      }
    }
  }

  async runTask(input: {
    readonly providerInstanceId: string;
    readonly task: ProviderTask;
    readonly runContext: RunContext;
  }): Promise<ProviderTaskResult> {
    const unsupported = this.unsupportedTaskFailure(input.task);
    if (unsupported) {
      this.emitFailure("task_mode_unsupported", input.runContext.runId);
      return unsupported;
    }

    if (this.executionPlan.kind === "no-session") {
      return this.runTaskWithSession({
        session: null,
        task: input.task,
        runContext: input.runContext,
      });
    }

    const sessionStore = this.requireSessionStore();
    const sessionDriver = this.requireSessionDriver();
    const readStartedAt = this.deps.clock.monotonicMs();
    this.emit("session.read.started", input.runContext.runId, {
      purpose: "run",
    });
    const session = await sessionStore.read({
      providerInstanceId: input.providerInstanceId,
      expectedProviderId: sessionDriver.providerId,
      purpose: "run",
    });
    this.emit(
      "session.read.completed",
      input.runContext.runId,
      {
        purpose: "run",
        found: session ? "true" : "false",
        generation: session ? String(session.generation) : "none",
      },
      this.deps.clock.monotonicMs() - readStartedAt,
    );

    if (!session) {
      this.emitFailure("needs_reconnect", input.runContext.runId);
      return failedTask("needs_reconnect", "Provider session is missing.");
    }

    if (this.executionPlan.kind === "static-session") {
      const validation = await sessionDriver.validateSession({
        session: session.artifact,
        redactor: this.deps.redactor,
      });
      if (validation.status === "invalid") {
        this.emitFailure(validation.failure.code, input.runContext.runId);
        return {
          status: "failed",
          failure: validation.failure,
          warnings: [],
        };
      }
    }

    return this.runTaskWithSession({
      session: session.artifact,
      sessionEnvelope: session,
      task: input.task,
      runContext: input.runContext,
    });
  }

  async refreshThenRunTask(input: {
    readonly providerInstanceId: string;
    readonly task: ProviderTask;
    readonly runContext: RunContext;
  }): Promise<RefreshThenRunResult> {
    const unsupported = this.unsupportedTaskFailure(input.task);
    if (unsupported) {
      this.emitFailure("task_mode_unsupported", input.runContext.runId);
      return {
        status: "blocked",
        reason: "task_mode_unsupported",
        safeMessage: unsupported.failure.safeMessage,
        warnings: [],
      };
    }

    const refresh = await this.refreshSession(input);

    if (
      this.executionPlan.kind === "no-session" &&
      refresh.status === "skipped" &&
      refresh.reason === "refresh_not_required"
    ) {
      const task = await this.runTaskWithSession({
        session: null,
        task: input.task,
        runContext: input.runContext,
      });
      return {
        status: "completed",
        refresh,
        task,
      };
    }

    if (
      this.executionPlan.kind === "static-session" &&
      refresh.status === "skipped" &&
      refresh.reason === "refresh_not_required" &&
      refresh.session
    ) {
      const task = await this.runTaskWithSession({
        session: refresh.session.artifact,
        sessionEnvelope: refresh.session,
        task: input.task,
        runContext: input.runContext,
      });
      return {
        status: "completed",
        refresh,
        task,
      };
    }

    if (refresh.status === "blocked") {
      return {
        status: "blocked",
        reason: refresh.reason,
        safeMessage: refresh.safeMessage,
        warnings: refresh.warnings,
      };
    }

    if (refresh.status === "skipped" && refresh.reason === "stale_generation") {
      return {
        status: "blocked",
        reason: "stale_generation",
        safeMessage: "A newer provider session generation already exists.",
        warnings: refresh.warnings,
      };
    }

    if (
      this.executionPlan.kind === "rotating-session" &&
      refresh.status === "skipped" &&
      refresh.reason === "refresh_not_required" &&
      refresh.session
    ) {
      const task = await this.runTaskWithSession({
        session: refresh.session.artifact,
        sessionEnvelope: refresh.session,
        task: input.task,
        runContext: input.runContext,
      });
      if (task.status === "failed" && shouldGuardedRefresh(task.failure)) {
        this.emit("provider.refresh.guard.started", input.runContext.runId, {
          reason: task.failure.code,
        });
        const guardedRefresh = await this.refreshSession({
          providerInstanceId: input.providerInstanceId,
          runContext: input.runContext,
          forceRefresh: true,
        });
        if (guardedRefresh.status === "blocked") {
          return {
            status: "blocked",
            reason: guardedRefresh.reason,
            safeMessage: guardedRefresh.safeMessage,
            warnings: guardedRefresh.warnings,
          };
        }
        if (
          guardedRefresh.status === "skipped" &&
          guardedRefresh.reason === "stale_generation"
        ) {
          return {
            status: "blocked",
            reason: "stale_generation",
            safeMessage: "A newer provider session generation already exists.",
            warnings: guardedRefresh.warnings,
          };
        }
        const guardedSession = sessionForPostRefreshTask(guardedRefresh);
        if (!guardedSession) {
          return {
            status: "blocked",
            reason: "provider_reconnect_required",
            safeMessage: "Provider session is missing after guarded refresh.",
            warnings: guardedRefresh.warnings,
          };
        }
        const retriedTask = await this.runTaskWithSession({
          session: guardedSession.artifact,
          sessionEnvelope: guardedSession,
          task: input.task,
          runContext: input.runContext,
        });
        return {
          status: "completed",
          refresh: guardedRefresh,
          task: retriedTask,
        };
      }
      return {
        status: "completed",
        refresh,
        task,
      };
    }

    const session = sessionForPostRefreshTask(refresh);
    if (!session) {
      return {
        status: "blocked",
        reason: "provider_reconnect_required",
        safeMessage: "Provider session is missing after refresh.",
        warnings: refresh.warnings,
      };
    }

    const task = await this.runTaskWithSession({
      session: session.artifact,
      sessionEnvelope: session,
      task: input.task,
      runContext: input.runContext,
    });
    return {
      status: "completed",
      refresh,
      task,
    };
  }

  async healthCheck(input: {
    readonly providerInstanceId: string;
  }): Promise<RuntimeHealthCheckResult> {
    return runtimeHealthCheck({
      deps: this.deps,
      executionPlan: this.executionPlan,
      providerInstanceId: input.providerInstanceId,
    });
  }

  private async runTaskWithSession(input: {
    readonly session: SessionArtifact | null;
    readonly sessionEnvelope?: SessionEnvelope;
    readonly task: ProviderTask;
    readonly runContext: RunContext;
  }): Promise<ProviderTaskResult> {
    if (input.session) {
      this.deps.redactor.registerSecret(input.session.bytes, "session");
    }

    const workspace = await this.deps.workspace.create({
      purpose: "run-task",
      isolation: "temp-dir",
    });

    try {
      const taskStartedAt = this.deps.clock.monotonicMs();
      const result = await this.deps.agentDriver.runTask({
        session: input.session,
        task: input.task,
        workspace,
        runner: this.deps.runner,
        redactor: this.deps.redactor,
        abortSignal: input.runContext.abortSignal,
        onTaskStarted: async () => {
          await input.runContext.onProviderTaskStarted?.();
          this.emit("provider.task.started", input.runContext.runId, {
            taskKind: input.task.kind,
          });
        },
      });
      this.emit(
        "provider.task.completed",
        input.runContext.runId,
        {
          taskKind: input.task.kind,
          status: result.status,
        },
        this.deps.clock.monotonicMs() - taskStartedAt,
      );
      this.deps.observability.timing(
        "subscription_runtime.provider_task_ms",
        this.deps.clock.monotonicMs() - taskStartedAt,
      );
      return this.maybeWritebackTaskSessionUpdate({
        result,
        ...(input.sessionEnvelope
          ? { sessionEnvelope: input.sessionEnvelope }
          : {}),
        runContext: input.runContext,
      });
    } finally {
      await workspace.dispose?.();
    }
  }

  private async maybeWritebackTaskSessionUpdate(input: {
    readonly result: ProviderTaskResult;
    readonly sessionEnvelope?: SessionEnvelope;
    readonly runContext: RunContext;
  }): Promise<ProviderTaskResult> {
    if (
      input.result.status !== "completed" ||
      !input.result.sessionUpdate ||
      !input.sessionEnvelope
    ) {
      return input.result;
    }

    const warnings = await this.writebackTaskSessionUpdate({
      sessionEnvelope: input.sessionEnvelope,
      sessionUpdate: input.result.sessionUpdate,
      runContext: input.runContext,
    });
    if (warnings.length === 0) {
      return input.result;
    }
    return {
      ...input.result,
      warnings: [...input.result.warnings, ...warnings],
    };
  }

  private async writebackTaskSessionUpdate(input: {
    readonly sessionEnvelope: SessionEnvelope;
    readonly sessionUpdate: SessionArtifact;
    readonly runContext: RunContext;
  }): Promise<readonly RuntimeWarning[]> {
    if (this.executionPlan.kind !== "rotating-session") {
      return [
        {
          code: "task_session_update_ignored",
          safeMessage:
            "Task session update was ignored because the runtime session does not rotate.",
        },
      ];
    }
    if (input.sessionUpdate.providerId !== input.sessionEnvelope.providerId) {
      return [
        {
          code: "task_session_update_provider_mismatch",
          safeMessage:
            "Task session update was ignored because the provider did not match.",
        },
      ];
    }

    const nextHash = computeSessionGenerationHash({
      artifact: input.sessionUpdate,
    });
    if (nextHash === input.sessionEnvelope.generationHash) {
      return [];
    }

    const sessionStore = this.requireSessionStore();
    const leaseStore = this.requireLeaseStore();
    const lease = await leaseStore.acquire({
      providerInstanceId: input.sessionEnvelope.providerInstanceId,
      runId: input.runContext.runId,
      attempt: input.runContext.attempt,
      ttlMs: this.policy.timeoutMs,
      restoredGenerationHash: input.sessionEnvelope.generationHash,
    });
    if (lease.status !== "granted") {
      return [
        {
          code: `task_session_update_writeback_${lease.status}`,
          safeMessage:
            "Task session update could not be written back because the session lease was unavailable.",
        },
      ];
    }

    let leaseClosed = false;
    const idempotencyKey = `${this.deps.idGenerator.idempotencyKey({
      providerInstanceId: input.sessionEnvelope.providerInstanceId,
      runId: input.runContext.runId,
      attempt: input.runContext.attempt,
      purpose: "writeback",
    })}:task-session-update:${nextHash.slice(0, 16)}`;

    try {
      await leaseStore.finalize({
        leaseId: lease.leaseId,
        restoredGenerationHash: input.sessionEnvelope.generationHash,
      });
      this.emit("session.task_update.writeback.started", input.runContext.runId, {
        leaseId: lease.leaseId,
        expectedGeneration: String(input.sessionEnvelope.generation),
      });
      await leaseStore.markWritebackStarted({
        leaseId: lease.leaseId,
      });
      const writeback = await sessionStore.write({
        providerInstanceId: input.sessionEnvelope.providerInstanceId,
        expectedGeneration: input.sessionEnvelope.generation,
        nextArtifact: input.sessionUpdate,
        idempotencyKey,
        leaseId: lease.leaseId,
      });

      if (writeback.status === "stale_generation") {
        return [
          {
            code: "task_session_update_writeback_stale_generation",
            safeMessage:
              "Task session update was skipped because a newer session generation already exists.",
          },
        ];
      }

      await leaseStore.markWritebackCommitted({
        leaseId: lease.leaseId,
        nextGenerationHash: writeback.generationHash,
        idempotencyKey,
      });
      leaseClosed = true;
      this.emit("session.task_update.writeback.completed", input.runContext.runId, {
        status: writeback.status,
        generation: String(writeback.generation),
      });
      this.deps.observability.count(
        "subscription_runtime.task_session_update_writeback_success",
      );
      return [];
    } catch (error) {
      this.emit("session.task_update.writeback.failed", input.runContext.runId, {
        reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
      return [
        {
          code: "task_session_update_writeback_failed",
          safeMessage:
            "Task session update could not be written back after task execution.",
        },
      ];
    } finally {
      if (!leaseClosed) {
        await this.releaseLeaseQuietly({
          leaseId: lease.leaseId,
          runId: input.runContext.runId,
          reason: "task_session_update_writeback_not_committed",
        });
      }
    }
  }

  private async inspectFreshness(input: {
    readonly session: SessionArtifact;
    readonly runId: string | undefined;
  }) {
    const sessionDriver = this.requireSessionDriver();
    if (!sessionDriver.inspectSessionFreshness) {
      return {
        status: "refresh_recommended" as const,
        reason: "freshness_unknown" as const,
        warnings: [],
      };
    }
    try {
      return await sessionDriver.inspectSessionFreshness({
        session: input.session,
        policy: this.policy.refreshPolicy,
        now: this.deps.clock.now(),
        redactor: this.deps.redactor,
      });
    } catch (error) {
      this.emit("provider.refresh.freshness_failed", input.runId, {
        reason:
          error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
      return {
        status: "refresh_recommended" as const,
        reason: "freshness_unknown" as const,
        warnings: [
          {
            code: "session_freshness_unknown",
            safeMessage: "Session freshness could not be determined.",
          },
        ],
      };
    }
  }

  private emit(
    name: string,
    runId: string | undefined,
    metadata: Readonly<Record<string, string>> = {},
    durationMs?: number,
  ): void {
    const event: RuntimeEvent = {
      name,
      providerId: this.deps.sessionDriver.providerId,
      agentId: this.deps.agentDriver.agentId,
      storeId: this.deps.sessionStore?.storeId ?? "none",
      metadata,
      ...(runId === undefined ? {} : { runId }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    this.deps.observability.emit(event);
  }

  private emitFailure(code: string, runId: string | undefined): void {
    this.emit("runtime.failure.classified", runId, { code });
  }

  private async releaseLeaseQuietly(input: {
    readonly leaseId: string;
    readonly runId: string;
    readonly reason: string;
  }): Promise<void> {
    if (!this.deps.leaseStore?.release) return;
    try {
      await this.deps.leaseStore.release({
        leaseId: input.leaseId,
        reason: input.reason,
      });
    } catch (error) {
      this.emit("lease.release.failed", input.runId, {
        leaseId: input.leaseId,
        reason: input.reason,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private unsupportedTaskFailure(
    task: ProviderTask,
  ): Extract<ProviderTaskResult, { readonly status: "failed" }> | null {
    return unsupportedTaskFailure({
      agentDriver: this.deps.agentDriver,
      task,
    });
  }

  private requireSessionStore(): NonNullable<RuntimeDeps["sessionStore"]> {
    if (!this.deps.sessionStore) {
      throw new Error("session_store_required");
    }
    return this.deps.sessionStore;
  }

  private requireLeaseStore(): NonNullable<RuntimeDeps["leaseStore"]> {
    if (!this.deps.leaseStore) {
      throw new Error("lease_store_required");
    }
    return this.deps.leaseStore;
  }

  private requireSessionDriver(): Extract<
    RuntimeDeps["sessionDriver"],
    { validateSession: unknown }
  > {
    if (!("validateSession" in this.deps.sessionDriver)) {
      throw new Error("session_driver_required");
    }
    return this.deps.sessionDriver;
  }

  private requireRefreshableSessionDriver(): Extract<
    RuntimeDeps["sessionDriver"],
    { refreshSession: unknown }
  > {
    const sessionDriver = this.requireSessionDriver();
    if (!("refreshSession" in sessionDriver)) {
      throw new Error("refreshable_session_driver_required");
    }
    return sessionDriver;
  }
}

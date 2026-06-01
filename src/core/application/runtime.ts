import { computeSessionGenerationHash } from "../domain/generation-hash";
import type {
  CompiledRuntimePolicy,
  ProviderFailure,
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
  SessionWriteResult,
} from "../domain/types";
import type { RuntimeDeps } from "../ports";
import { negotiateCapabilities } from "./policy";

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
      return this.validateStaticSession(input);
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
      const validation = await sessionDriver.validateSession({
        session: session.artifact,
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
          generation: String(session.generation),
        });
        const refreshed = await sessionDriver.refreshSession({
          session: session.artifact,
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

        if (nextHash === session.generationHash) {
          await leaseStore.finalize({
            leaseId: lease.leaseId,
            restoredGenerationHash: session.generationHash,
          });
          await leaseStore.markWritebackCommitted({
            leaseId: lease.leaseId,
            nextGenerationHash: session.generationHash,
            idempotencyKey,
          });
          leaseClosed = true;
          this.emit("session.writeback.completed", input.runContext.runId, {
            status: "skipped_unchanged",
            generation: String(session.generation),
          });
          return {
            status: "skipped",
            reason: "session_unchanged",
            session,
            warnings: refreshed.warnings,
          };
        }

        await leaseStore.finalize({
          leaseId: lease.leaseId,
          restoredGenerationHash: session.generationHash,
        });
        this.emit("session.writeback.started", input.runContext.runId, {
          leaseId: lease.leaseId,
          expectedGeneration: String(session.generation),
        });
        await leaseStore.markWritebackStarted({
          leaseId: lease.leaseId,
        });

        const writeback = await sessionStore.write({
          providerInstanceId: input.providerInstanceId,
          expectedGeneration: session.generation,
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
          session: nextEnvelope(session, refreshed.artifact, writeback),
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
    if (this.executionPlan.kind === "no-session") {
      return {
        status: "healthy",
        failures: [],
        warnings: [],
      };
    }

    const sessionStore = this.requireSessionStore();
    const sessionDriver = this.requireSessionDriver();
    const session = await sessionStore.read({
      providerInstanceId: input.providerInstanceId,
      expectedProviderId: sessionDriver.providerId,
      purpose: "health-check",
    });

    if (!session) {
      return {
        status: "unhealthy",
        failures: [missingSessionFailure()],
        warnings: [],
      };
    }

    const validation = await sessionDriver.validateSession({
      session: session.artifact,
      redactor: this.deps.redactor,
    });

    if (validation.status === "invalid") {
      return {
        status: "unhealthy",
        failures: [validation.failure],
        warnings: [],
      };
    }

    return {
      status: "healthy",
      failures: [],
      warnings: validation.warnings,
    };
  }

  private async runTaskWithSession(input: {
    readonly session: SessionArtifact | null;
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
      this.emit("provider.task.started", input.runContext.runId, {
        taskKind: input.task.kind,
      });
      const result = await this.deps.agentDriver.runTask({
        session: input.session,
        task: input.task,
        workspace,
        runner: this.deps.runner,
        redactor: this.deps.redactor,
        abortSignal: input.runContext.abortSignal,
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
      return result;
    } finally {
      await workspace.dispose?.();
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
    if (this.deps.agentDriver.capabilities.taskModes.includes(task.kind)) {
      return null;
    }

    return failedTask(
      "task_mode_unsupported",
      "Selected agent does not support the requested task mode.",
    ) as Extract<ProviderTaskResult, { readonly status: "failed" }>;
  }

  private async validateStaticSession(input: {
    readonly providerInstanceId: string;
    readonly runContext: RunContext;
  }): Promise<RefreshSessionResult> {
    const sessionStore = this.requireSessionStore();
    const sessionDriver = this.requireSessionDriver();
    const session = await sessionStore.read({
      providerInstanceId: input.providerInstanceId,
      expectedProviderId: sessionDriver.providerId,
      purpose: "refresh",
    });

    if (!session) {
      this.emitFailure("provider_reconnect_required", input.runContext.runId);
      return blocked(
        "provider_reconnect_required",
        "Provider session is missing.",
      );
    }

    if (this.executionPlan.refresh === "validate-only") {
      const validation = await sessionDriver.validateSession({
        session: session.artifact,
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
      return {
        status: "skipped",
        reason: "refresh_not_required",
        session,
        warnings: validation.warnings,
      };
    }

    return {
      status: "skipped",
      reason: "refresh_not_required",
      session,
      warnings: [],
    };
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

export function combineSessionAndAgent(input: {
  readonly sessionDriver: RuntimeDeps["sessionDriver"];
  readonly agentDriver: RuntimeDeps["agentDriver"];
}): RuntimeDeps["sessionDriver"] & {
  readonly agentId: string;
  readonly agentCapabilities: RuntimeDeps["agentDriver"]["capabilities"];
  runTask: RuntimeDeps["agentDriver"]["runTask"];
  classifyRunFailure: RuntimeDeps["agentDriver"]["classifyRunFailure"];
} {
  if (input.sessionDriver.providerId !== input.agentDriver.providerId) {
    throw new Error("agent_provider_mismatch");
  }

  return {
    ...input.sessionDriver,
    agentId: input.agentDriver.agentId,
    agentCapabilities: input.agentDriver.capabilities,
    runTask: (runInput) => input.agentDriver.runTask(runInput),
    classifyRunFailure: (error) => input.agentDriver.classifyRunFailure(error),
  };
}

function nextEnvelope(
  previous: SessionEnvelope,
  artifact: SessionEnvelope["artifact"],
  writeback: Extract<
    SessionWriteResult,
    { readonly status: "accepted" | "idempotent_replay" }
  >,
): SessionEnvelope {
  return {
    ...previous,
    artifact,
    generation: writeback.generation,
    generationHash: writeback.generationHash,
  };
}

function sessionForPostRefreshTask(
  refresh: RefreshSessionResult,
): SessionEnvelope | null {
  if (refresh.status === "ready") {
    return refresh.session;
  }
  if (
    refresh.status === "skipped" &&
    (refresh.reason === "session_unchanged" ||
      refresh.reason === "refresh_not_required")
  ) {
    return refresh.session ?? null;
  }
  return null;
}

function shouldGuardedRefresh(failure: ProviderFailure): boolean {
  return (
    failure.code === "needs_reconnect" ||
    failure.code === "provider_session_invalid" ||
    failure.causeCategory === "needs_reconnect"
  );
}

function blocked(
  reason:
    | "provider_reconnect_required"
    | "permission_required"
    | "quota_limited",
  safeMessage: string,
  warnings: readonly RuntimeWarning[] = [],
): RefreshSessionResult {
  return {
    status: "blocked",
    reason,
    safeMessage,
    warnings,
  };
}

function failedTask(
  code: ProviderFailure["code"],
  safeMessage: string,
): ProviderTaskResult {
  return {
    status: "failed",
    failure: {
      code,
      retryable: false,
      reconnectRequired: code === "needs_reconnect",
      safeMessage,
    },
    warnings: [],
  };
}

function missingSessionFailure(): ProviderFailure {
  return {
    code: "needs_reconnect",
    retryable: false,
    reconnectRequired: true,
    safeMessage: "Provider session is missing.",
  };
}

import { RuntimeConfigurationError } from "../domain/errors";
import type {
  AgentCapabilities,
  CompiledRuntimePolicy,
  ProviderCapabilities,
  RuntimeExecutionPlan,
  RuntimePolicy,
  RuntimeWarning,
  RunnerCapabilities,
  SessionStoreCapabilities,
} from "../domain/types";

export type CapabilityDecision =
  | {
      readonly status: "accepted";
      readonly compiledPolicy: CompiledRuntimePolicy;
      readonly executionPlan: RuntimeExecutionPlan;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "provider_store_incompatible"
        | "runner_provider_incompatible"
        | "custody_mode_forbidden"
        | "interactive_runtime_forbidden"
        | "missing_required_capability"
        | "task_mode_unsupported"
        | "history_mode_unsupported"
        | "session_store_required";
      readonly safeMessage: string;
      readonly details: Readonly<Record<string, string>>;
    };

export function assertRuntimeCapabilities(input: {
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store?: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
  readonly policy: RuntimePolicy;
}): void {
  const decision = negotiateCapabilities(input);
  if (decision.status === "rejected") {
    throw new RuntimeConfigurationError(decision.code);
  }
}

export function negotiateCapabilities(input: {
  readonly requested: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store?: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CapabilityDecision;
export function negotiateCapabilities(input: {
  readonly policy: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store?: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CapabilityDecision;
export function negotiateCapabilities(input: {
  readonly requested?: RuntimePolicy;
  readonly policy?: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store?: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CapabilityDecision {
  const policy = input.requested ?? input.policy;
  if (!policy) {
    throw new RuntimeConfigurationError("runtime_policy_missing");
  }

  if (input.provider.providerId !== input.agent.providerId) {
    return rejected("provider_store_incompatible", "Agent/provider mismatch.", {
      providerId: input.provider.providerId,
      agentProviderId: input.agent.providerId,
    });
  }

  if (!policy.allowedProviderIds.includes(input.provider.providerId)) {
    return rejected("missing_required_capability", "Provider is not allowed.", {
      providerId: input.provider.providerId,
    });
  }

  if (!policy.allowedAgentIds.includes(input.agent.agentId)) {
    return rejected("missing_required_capability", "Agent is not allowed.", {
      agentId: input.agent.agentId,
    });
  }

  if (!policy.allowedRunnerIds.includes(input.runner.runnerId)) {
    return rejected("missing_required_capability", "Runner is not allowed.", {
      runnerId: input.runner.runnerId,
    });
  }

  const requestedTaskMode = policy.requestedTaskMode ?? "review";
  if (!input.agent.taskModes.includes(requestedTaskMode)) {
    return rejected(
      "task_mode_unsupported",
      "Selected agent does not support the requested task mode.",
      {
        agentId: input.agent.agentId,
        taskMode: requestedTaskMode,
      },
    );
  }

  const requestedHistoryMode = policy.requestedHistoryMode ?? "unsupported";
  if (
    requestedHistoryMode !== "unsupported" &&
    input.agent.historyMode !== requestedHistoryMode
  ) {
    return rejected(
      "history_mode_unsupported",
      "Selected agent does not support the requested history mode.",
      {
        agentId: input.agent.agentId,
        historyMode: requestedHistoryMode,
      },
    );
  }

  if (policy.allowInteractiveSetupInRuntime !== false) {
    return rejected(
      "interactive_runtime_forbidden",
      "Interactive setup is forbidden in runtime jobs.",
      {},
    );
  }

  if (!input.runner.supportsEnvAllowlist) {
    return rejected(
      "missing_required_capability",
      "Runner must support environment allowlisting.",
      { runnerId: input.runner.runnerId },
    );
  }

  if (
    (input.provider.requiresWorkspace ||
      input.agent.supportsRepositoryContext) &&
    !input.runner.supportsWorkingDirectory
  ) {
    return rejected(
      "runner_provider_incompatible",
      "Provider or agent requires workspace support.",
      { runnerId: input.runner.runnerId },
    );
  }

  if (
    input.agent.requiresWritableWorkspace &&
    input.runner.readOnlyFilesystem
  ) {
    return rejected(
      "runner_provider_incompatible",
      "Agent requires writable workspace, but runner is read-only.",
      { agentId: input.agent.agentId },
    );
  }

  const executionPlan = compileRuntimeExecutionPlan({
    policy,
    provider: input.provider,
  });

  if (executionPlan.kind === "no-session") {
    return {
      status: "accepted",
      compiledPolicy: compileRuntimePolicy({
        requested: policy,
        provider: input.provider,
        agent: input.agent,
        runner: input.runner,
      }),
      executionPlan,
      warnings: [],
    };
  }

  if (!input.store) {
    return rejected(
      "session_store_required",
      "Selected provider requires a session store.",
      {
        providerId: input.provider.providerId,
      },
    );
  }

  if (!policy.allowedStoreIds.includes(input.store.storeId)) {
    return rejected("missing_required_capability", "Store is not allowed.", {
      storeId: input.store.storeId,
    });
  }

  if (policy.custodyMode === "no-plaintext-backend") {
    if (input.store.custody !== "no-plaintext-backend") {
      return rejected(
        "custody_mode_forbidden",
        "Selected store is not compatible with no-custody mode.",
        { storeId: input.store.storeId },
      );
    }
    if (input.store.plaintextAvailableToBackend) {
      return rejected(
        "custody_mode_forbidden",
        "Selected store exposes plaintext to backend.",
        { storeId: input.store.storeId },
      );
    }
  }

  if (
    policy.requireNoBackendPlaintext &&
    input.store.plaintextAvailableToBackend
  ) {
    return rejected(
      "custody_mode_forbidden",
      "Runtime policy forbids backend plaintext.",
      { storeId: input.store.storeId },
    );
  }

  if (policy.requireCompareAndSwap && !input.store.supportsCompareAndSwap) {
    return rejected(
      "missing_required_capability",
      "Runtime policy requires compare-and-swap writes.",
      { storeId: input.store.storeId },
    );
  }

  if (providerMayRotateSession(input.provider)) {
    if (!input.store.supportsWriteback) {
      return rejected(
        "provider_store_incompatible",
        "Provider can rotate sessions, but store cannot write back.",
        { providerId: input.provider.providerId },
      );
    }
    if (!input.store.supportsIdempotency) {
      return rejected(
        "provider_store_incompatible",
        "Provider can rotate sessions, but store cannot deduplicate writes.",
        { storeId: input.store.storeId },
      );
    }
  }

  return {
    status: "accepted",
    compiledPolicy: compileRuntimePolicy({
      requested: policy,
      provider: input.provider,
      agent: input.agent,
      store: input.store,
      runner: input.runner,
    }),
    executionPlan,
    warnings: [],
  };
}

export function compileRuntimePolicy(input: {
  readonly requested: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store?: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CompiledRuntimePolicy {
  const mayRotate = providerMayRotateSession(input.provider);
  return {
    trustMode: input.store?.custody ?? input.requested.custodyMode,
    providerId: input.provider.providerId,
    agentId: input.agent.agentId,
    storeId: input.store?.storeId ?? null,
    runnerId: input.runner.runnerId,
    requiresDurableWriteback: mayRotate,
    requiresLease: mayRotate,
    requiresCas: input.store?.supportsCompareAndSwap ?? false,
    allowsInteractiveRuntime: false,
    maxSessionBytes: input.store?.maxArtifactBytes ?? 0,
    maxTaskOutputBytes: input.requested.maxTaskOutputBytes ?? 1024 * 1024,
    timeoutMs: Math.min(
      input.provider.defaultTimeoutMs,
      input.agent.maxRuntimeMs,
    ),
    refreshPolicy: {
      minFreshMs: input.requested.refreshPolicy?.minFreshMs ?? 15 * 60 * 1000,
      refreshBeforeExpiryMs:
        input.requested.refreshPolicy?.refreshBeforeExpiryMs ?? 5 * 60 * 1000,
      maxSessionAgeMs:
        input.requested.refreshPolicy?.maxSessionAgeMs ?? 24 * 60 * 60 * 1000,
    },
  };
}

export function compileRuntimeExecutionPlan(input: {
  readonly policy: RuntimePolicy;
  readonly provider: ProviderCapabilities;
}): RuntimeExecutionPlan {
  if (input.provider.sessionRequirement.kind === "none") {
    return {
      kind: "no-session",
      readSession: false,
      acquireLease: false,
      refresh: "never",
      writeback: "never",
      sessionForAgent: "absent",
    };
  }

  if (!providerMayRotateSession(input.provider)) {
    return {
      kind: "static-session",
      readSession: true,
      acquireLease: false,
      refresh:
        input.provider.refreshMode === "validate-only"
          ? "validate-only"
          : "never",
      writeback: "never",
      sessionForAgent: "stored",
    };
  }

  return {
    kind: "rotating-session",
    readSession: true,
    acquireLease: true,
    refresh:
      input.provider.refreshMode === "lazy-refresh" ? "lazy" : "before-run",
    writeback: input.policy.requireWritebackBeforeTask
      ? "before-task"
      : "after-successful-refresh",
    sessionForAgent: "refreshed",
  };
}

export function providerMayRotateSession(
  provider: ProviderCapabilities,
): boolean {
  return (
    provider.sessionRotationMode === "may-rotate" ||
    provider.refreshMayRotateSession
  );
}

function rejected(
  code: Exclude<CapabilityDecision, { readonly status: "accepted" }>["code"],
  safeMessage: string,
  details: Readonly<Record<string, string>>,
): CapabilityDecision {
  return {
    status: "rejected",
    code,
    safeMessage,
    details,
  };
}

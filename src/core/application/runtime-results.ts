import type {
  ProviderFailure,
  ProviderTask,
  ProviderTaskResult,
  RefreshSessionResult,
  RuntimeWarning,
  SessionEnvelope,
  SessionWriteResult,
} from "../domain/types";
import type { RuntimeDeps } from "../ports";

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

export function nextEnvelope(
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

export function sessionForPostRefreshTask(
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

export function shouldGuardedRefresh(failure: ProviderFailure): boolean {
  return (
    failure.code === "needs_reconnect" ||
    failure.causeCategory === "needs_reconnect"
  );
}

export function blocked(
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

export function failedTask(
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

export function missingSessionFailure(): ProviderFailure {
  return {
    code: "needs_reconnect",
    retryable: false,
    reconnectRequired: true,
    safeMessage: "Provider session is missing.",
  };
}

export function unsupportedTaskFailure(input: {
  readonly agentDriver: RuntimeDeps["agentDriver"];
  readonly task: ProviderTask;
}): Extract<ProviderTaskResult, { readonly status: "failed" }> | null {
  if (input.agentDriver.capabilities.taskModes.includes(input.task.kind)) {
    return null;
  }

  return failedTask(
    "task_mode_unsupported",
    "Selected agent does not support the requested task mode.",
  ) as Extract<ProviderTaskResult, { readonly status: "failed" }>;
}

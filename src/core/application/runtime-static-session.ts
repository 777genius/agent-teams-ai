import type {
  RefreshSessionResult,
  RunContext,
  RuntimeExecutionPlan,
} from "../domain/types";
import type { RuntimeDeps } from "../ports";
import { blocked } from "./runtime-results";

export async function validateStaticRuntimeSession(input: {
  readonly deps: RuntimeDeps;
  readonly executionPlan: RuntimeExecutionPlan;
  readonly providerInstanceId: string;
  readonly runContext: RunContext;
  readonly emitFailure: (code: string, runId: string | undefined) => void;
}): Promise<RefreshSessionResult> {
  const sessionStore = requireSessionStore(input.deps);
  const sessionDriver = requireSessionDriver(input.deps);
  const session = await sessionStore.read({
    providerInstanceId: input.providerInstanceId,
    expectedProviderId: sessionDriver.providerId,
    purpose: "refresh",
  });

  if (!session) {
    input.emitFailure("provider_reconnect_required", input.runContext.runId);
    return blocked(
      "provider_reconnect_required",
      "Provider session is missing.",
    );
  }

  if (input.executionPlan.refresh === "validate-only") {
    const validation = await sessionDriver.validateSession({
      session: session.artifact,
      redactor: input.deps.redactor,
    });
    if (validation.status === "invalid") {
      input.emitFailure(validation.failure.code, input.runContext.runId);
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

function requireSessionStore(
  deps: RuntimeDeps,
): NonNullable<RuntimeDeps["sessionStore"]> {
  if (!deps.sessionStore) {
    throw new Error("session_store_required");
  }
  return deps.sessionStore;
}

function requireSessionDriver(
  deps: RuntimeDeps,
): Extract<RuntimeDeps["sessionDriver"], { validateSession: unknown }> {
  if (!("validateSession" in deps.sessionDriver)) {
    throw new Error("session_driver_required");
  }
  return deps.sessionDriver;
}

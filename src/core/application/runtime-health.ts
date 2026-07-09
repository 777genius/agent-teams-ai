import type {
  RuntimeExecutionPlan,
  RuntimeHealthCheckResult,
} from "../domain/types";
import type { RuntimeDeps } from "../ports";
import { missingSessionFailure } from "./runtime-results";

export async function runtimeHealthCheck(input: {
  readonly deps: RuntimeDeps;
  readonly executionPlan: RuntimeExecutionPlan;
  readonly providerInstanceId: string;
}): Promise<RuntimeHealthCheckResult> {
  if (input.executionPlan.kind === "no-session") {
    return {
      status: "healthy",
      failures: [],
      warnings: [],
    };
  }

  const sessionStore = requireSessionStore(input.deps);
  const sessionDriver = requireSessionDriver(input.deps);
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
    redactor: input.deps.redactor,
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

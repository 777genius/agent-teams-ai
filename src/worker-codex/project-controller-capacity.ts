import type { WorkerRuntimeDemand } from "@vioxen/subscription-runtime/worker-core";
import { WorkerAccountCapacitySignalScope } from "@vioxen/subscription-runtime/worker-core";
import { codexAccountCapacityStore } from "./application/codex-account-capacity-store";

export function isProjectControllerProviderSessionInvalid(
  safeMessage: string | undefined,
): boolean {
  return /\b(?:session is invalid|provider session invalid|needs reconnect|provider account session is unavailable)\b/i.test(
    safeMessage ?? "",
  );
}

export type ProjectControllerRuntimeConfig = {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly serviceTier?: string;
  readonly quotaCooldownMs?: number;
  readonly reconnectCooldownMs?: number;
};

export type ProjectControllerCapacityRun = {
  readonly status?: string;
  readonly safeMessage?: string;
  readonly capacityAccountId?: string;
  readonly capacityDemand?: WorkerRuntimeDemand;
};

export type RecordProjectControllerCapacitySignalInput = {
  readonly authRootDir: string;
  readonly controllerJobId: string;
  readonly config: ProjectControllerRuntimeConfig;
  readonly run: ProjectControllerCapacityRun;
  readonly observedAt?: Date;
};

export function projectControllerCapacityDemand(
  config: ProjectControllerRuntimeConfig,
): WorkerRuntimeDemand {
  return {
    provider: "codex",
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.reasoningEffort }),
    ...(config.serviceTier === undefined
      ? {}
      : { serviceTier: config.serviceTier }),
  };
}

export function recordProjectControllerCapacitySignal(
  input: RecordProjectControllerCapacitySignalInput,
): boolean {
  if (input.run.status !== "failed") return false;
  if (!input.run.capacityAccountId) return false;

  const signal = projectControllerCapacityFailureSignal({
    safeMessage: input.run.safeMessage,
    config: input.config,
    observedAt: input.observedAt ?? new Date(),
  });
  if (!signal) return false;

  codexAccountCapacityStore(input.authRootDir).observe({
    accountId: input.run.capacityAccountId,
    ...(signal.capacity.reason === "quota_limited"
      ? { scope: WorkerAccountCapacitySignalScope.AccountWide }
      : {}),
    ...(signal.capacity.reason === "quota_limited"
      ? {}
      : {
          demand:
            input.run.capacityDemand ??
            projectControllerCapacityDemand(input.config),
        }),
    capacity: signal.capacity,
    observedAt: signal.observedAt,
    sourceWorkerId: input.controllerJobId,
  });
  return true;
}

function projectControllerCapacityFailureSignal(input: {
  readonly safeMessage: string | undefined;
  readonly config: ProjectControllerRuntimeConfig;
  readonly observedAt: Date;
}) {
  if (isProjectControllerQuotaFailure(input.safeMessage)) {
    return {
      observedAt: input.observedAt,
      capacity: {
        availability: "cooldown" as const,
        reason: "quota_limited",
        cooldownUntil: new Date(
          input.observedAt.getTime() +
            (input.config.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
      },
    };
  }

  if (isProjectControllerSessionInvalidFailure(input.safeMessage)) {
    return {
      observedAt: input.observedAt,
      capacity: {
        availability: "cooldown" as const,
        reason: "provider_session_invalid",
        cooldownUntil: new Date(
          input.observedAt.getTime() +
            (input.config.reconnectCooldownMs ??
              input.config.quotaCooldownMs ??
              15 * 60 * 1000),
        ),
      },
    };
  }

  return null;
}

export function isProjectControllerQuotaFailure(
  safeMessage: string | undefined,
): boolean {
  return /\b(?:quota|billing limit|usage limit|rate limit)\b/i.test(
    safeMessage ?? "",
  );
}

export function isProjectControllerSessionInvalidFailure(
  safeMessage: string | undefined,
): boolean {
  return /\b(?:session is invalid|provider account session is unavailable)\b/i.test(
    safeMessage ?? "",
  );
}

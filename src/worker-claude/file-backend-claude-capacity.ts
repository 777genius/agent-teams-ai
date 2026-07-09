import { createHash } from "node:crypto";
import {
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
} from "@vioxen/subscription-runtime/provider-claude";
import type {
  ClockPort,
  ProviderFailure,
  RuntimeDeps,
  SessionArtifact,
  SessionEnvelope,
} from "@vioxen/subscription-runtime/core";
import type {
  SubscriptionWorkerState,
  WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  ClaudeRateLimitTelemetrySource,
  ClaudeRateLimitWindowName,
} from "./rate-limit-telemetry";

export const claudeCapacityAccountIdMetadataKey = "capacityAccountId";

export type ClaudeWorkerCapacityPolicy = {
  readonly softMaxRunsPerWindow?: number;
  readonly windowMs?: number;
  readonly quotaCooldownMs?: number;
  readonly rateLimitMinRemainingPercent?: number;
  readonly rateLimitWindows?: readonly ClaudeRateLimitWindowName[];
};

export class FileBackendClaudeCapacityState {
  private capacityState: WorkerCapacitySnapshot = { availability: "available" };
  private windowStartedAtMs: number;
  private runsInWindow = 0;
  private quotaGroup: string | null = null;
  private capacityAccountId: string | null = null;

  constructor(private readonly options: {
    readonly providerInstanceId: string;
    readonly configDir: string;
    readonly configuredCapacityAccountId?: string;
    readonly capacityPolicy?: ClaudeWorkerCapacityPolicy;
    readonly rateLimitTelemetry: ClaudeRateLimitTelemetrySource | null;
    readonly sessionStore: () => NonNullable<RuntimeDeps["sessionStore"]>;
    readonly clock: ClockPort;
  }) {
    this.windowStartedAtMs = options.clock.now().getTime();
  }

  get accountId(): string | null {
    return this.capacityAccountId;
  }

  reset(): void {
    this.capacityState = { availability: "available" };
  }

  capacity(workerState: SubscriptionWorkerState): WorkerCapacitySnapshot {
    if (workerState === "created" || workerState === "starting") {
      return this.withCapacityDetails({
        availability: "disabled",
        reason: "not_started",
      });
    }
    if (workerState === "prewarming") {
      return this.withCapacityDetails({ availability: "warming" });
    }
    if (workerState === "disposed") {
      return this.withCapacityDetails({
        availability: "disabled",
        reason: "disposed",
      });
    }
    if (workerState === "failed") {
      return this.withCapacityDetails({
        availability: "degraded",
        reason: "worker_failed",
      });
    }

    this.rollCapacityWindow();
    this.capacityState = normalizeResettableCapacity(
      this.capacityState,
      this.options.clock.now(),
    );
    const capacity = {
      ...this.capacityState,
      recentRuns: this.runsInWindow,
      ...(this.options.capacityPolicy?.softMaxRunsPerWindow === undefined
        ? {}
        : {
            softLimitRemainingRuns: Math.max(
              0,
              this.options.capacityPolicy.softMaxRunsPerWindow -
                this.runsInWindow,
            ),
          }),
    };
    return this.withCapacityDetails(
      mergeCapacity(capacity, this.rateLimitCapacity()),
    );
  }

  recordSuccessfulRun(): void {
    this.rollCapacityWindow();
    this.runsInWindow += 1;
    const maxRuns = this.options.capacityPolicy?.softMaxRunsPerWindow;
    if (maxRuns === undefined || this.runsInWindow < maxRuns) return;
    const cooldownUntil = new Date(
      this.windowStartedAtMs + capacityWindowMs(this.options.capacityPolicy),
    );
    this.capacityState = {
      availability: "cooldown",
      reason: "soft_run_limit",
      cooldownUntil,
    };
  }

  recordFailure(failure: ProviderFailure): void {
    if (failure.code === "quota_limited") {
      this.capacityState = {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil: new Date(
          this.options.clock.now().getTime() +
            (this.options.capacityPolicy?.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
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

  recordBlocked(reason: string): void {
    if (reason === "quota_limited") {
      this.capacityState = {
        availability: "cooldown",
        reason,
        cooldownUntil: new Date(
          this.options.clock.now().getTime() +
            (this.options.capacityPolicy?.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
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

  rememberQuotaGroup(
    session: SessionArtifact,
    capacityAccountIdOverride?: string | null,
  ): void {
    try {
      const validation = validateClaudeSessionArtifact(session);
      this.quotaGroup = `claude-oauth:${hashText(
        validation.session.oauthToken,
      ).slice(0, 16)}`;
      this.capacityAccountId =
        normalizeCapacityAccountId(capacityAccountIdOverride) ??
        normalizeCapacityAccountId(this.options.configuredCapacityAccountId) ??
        normalizeCapacityAccountId(
          validation.session.metadata?.[claudeCapacityAccountIdMetadataKey],
        ) ??
        this.quotaGroup;
    } catch {
      this.quotaGroup = null;
      this.capacityAccountId = null;
    }
  }

  async persistStoredCapacityAccountId(
    session: SessionEnvelope,
    capacityAccountId: string | null,
  ): Promise<SessionArtifact> {
    if (!capacityAccountId) return session.artifact;

    let current = session;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const updatedArtifact = this.withStoredCapacityAccountId(
        current.artifact,
        capacityAccountId,
      );
      if (!updatedArtifact) return current.artifact;

      const sessionStore = this.options.sessionStore();
      const write = await sessionStore.write({
        providerInstanceId: this.options.providerInstanceId,
        expectedGeneration: current.generation,
        nextArtifact: updatedArtifact,
        idempotencyKey: `seed-capacity-account:${hashText(
          `${capacityAccountId}:${current.generationHash}`,
        )}`,
        leaseId: "seed-local-file-backend",
      });
      if (
        write.status === "accepted" ||
        write.status === "idempotent_replay"
      ) {
        return updatedArtifact;
      }

      const latest = await sessionStore.read({
        providerInstanceId: this.options.providerInstanceId,
        expectedProviderId: "claude",
        purpose: "health-check",
      });
      if (!latest) break;
      current = latest;
    }

    throw new Error("claude_capacity_account_update_conflict");
  }

  private rateLimitCapacity(): WorkerCapacitySnapshot | null {
    const minRemaining =
      this.options.capacityPolicy?.rateLimitMinRemainingPercent;
    if (minRemaining === undefined || this.options.rateLimitTelemetry === null) {
      return null;
    }

    const snapshot = this.options.rateLimitTelemetry.latest();
    if (!snapshot) return null;

    const windows =
      this.options.capacityPolicy?.rateLimitWindows ??
      (["five_hour", "seven_day"] as const);
    const nowMs = this.options.clock.now().getTime();
    let selected:
      | {
          readonly name: ClaudeRateLimitWindowName;
          readonly usedPercentage: number;
          readonly remainingPercentage: number;
          readonly resetsAt: Date;
        }
      | null = null;

    for (const name of windows) {
      const window = snapshot.windows[name];
      if (!window || window.resetsAt.getTime() <= nowMs) continue;
      if (window.remainingPercentage > minRemaining) continue;
      if (!selected || window.resetsAt.getTime() > selected.resetsAt.getTime()) {
        selected = {
          name,
          usedPercentage: window.usedPercentage,
          remainingPercentage: window.remainingPercentage,
          resetsAt: window.resetsAt,
        };
      }
    }

    if (!selected) return null;

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

  private rollCapacityWindow(): void {
    const nowMs = this.options.clock.now().getTime();
    const windowMs = capacityWindowMs(this.options.capacityPolicy);
    if (nowMs - this.windowStartedAtMs < windowMs) return;
    this.windowStartedAtMs = nowMs;
    this.runsInWindow = 0;
    if (this.capacityState.availability === "cooldown") {
      this.capacityState = { availability: "available" };
    }
  }

  private withStoredCapacityAccountId(
    session: SessionArtifact,
    capacityAccountId: string | null,
  ): SessionArtifact | null {
    if (!capacityAccountId) return null;
    let validation;
    try {
      validation = validateClaudeSessionArtifact(session);
    } catch {
      return null;
    }
    const storedCapacityAccountId = normalizeCapacityAccountId(
      validation.session.metadata?.[claudeCapacityAccountIdMetadataKey],
    );
    if (storedCapacityAccountId === capacityAccountId) return null;
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

  private withCapacityDetails(
    capacity: WorkerCapacitySnapshot,
  ): WorkerCapacitySnapshot {
    return {
      ...capacity,
      details: {
        ...(capacity.details ?? {}),
        providerInstanceId: this.options.providerInstanceId,
        configDir: this.options.configDir,
        ...(this.capacityAccountId
          ? { accountId: this.capacityAccountId }
          : {}),
        ...(this.quotaGroup ? { quotaGroup: this.quotaGroup } : {}),
      },
    };
  }
}

function capacityWindowMs(policy: ClaudeWorkerCapacityPolicy | undefined): number {
  return policy?.windowMs ?? 5 * 60 * 60 * 1000;
}

function mergeCapacity(
  base: WorkerCapacitySnapshot,
  telemetry: WorkerCapacitySnapshot | null,
): WorkerCapacitySnapshot {
  if (telemetry === null) return base;
  if (base.availability === "available") {
    return telemetry;
  }
  if (
    base.availability === "cooldown" &&
    telemetry.availability === "cooldown"
  ) {
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

function normalizeResettableCapacity(
  capacity: WorkerCapacitySnapshot,
  now: Date,
): WorkerCapacitySnapshot {
  if (
    !isResettableCapacity(capacity) ||
    !capacity.cooldownUntil ||
    capacity.cooldownUntil.getTime() > now.getTime()
  ) {
    return capacity;
  }

  const {
    cooldownUntil: _cooldownUntil,
    lastLimitSignalAt: _lastLimitSignalAt,
    reason: _reason,
    ...rest
  } = capacity;
  return {
    ...rest,
    availability: "available",
  };
}

export function isSevereCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "quota_exhausted" ||
    capacity.availability === "degraded" ||
    capacity.availability === "disabled"
  );
}

function isResettableCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeCapacityAccountId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

import {
  type RuntimeFailureSignal,
  TEAM_RUNTIME_RECOVERY_INITIAL_DELAY_MAX_SECONDS,
  TEAM_RUNTIME_RECOVERY_INITIAL_DELAY_MIN_SECONDS,
  TEAM_RUNTIME_RECOVERY_MAX_ATTEMPTS_MAX,
  TEAM_RUNTIME_RECOVERY_MAX_ATTEMPTS_MIN,
  type TeamRuntimeRecoveryConfig,
} from '../../contracts';

import type { RuntimeFailureClassification } from './RuntimeFailureClassifier';

const TRANSIENT_BACKOFF_CAP_MS = 15 * 60_000;
const MAX_SCHEDULE_HORIZON_MS = 12 * 60 * 60_000;
const RATE_LIMIT_BUFFER_MS = 30_000;
const TRANSIENT_JOB_TTL_MS = 2 * 60 * 60_000;

export type RuntimeRecoveryPlan =
  | {
      kind: 'scheduled';
      nextAttemptAt: string;
      expiresAt: string;
      delayMs: number;
    }
  | {
      kind: 'manual';
      reason:
        | 'disabled'
        | 'not_retryable'
        | 'attempts_exhausted'
        | 'invalid_time'
        | 'schedule_too_far';
    };

export function normalizeTeamRuntimeRecoveryConfig(
  config: Partial<TeamRuntimeRecoveryConfig> | null | undefined
): TeamRuntimeRecoveryConfig {
  const initialDelaySeconds = Math.min(
    TEAM_RUNTIME_RECOVERY_INITIAL_DELAY_MAX_SECONDS,
    Math.max(
      TEAM_RUNTIME_RECOVERY_INITIAL_DELAY_MIN_SECONDS,
      Math.round(config?.initialDelaySeconds ?? 60)
    )
  );
  const maxAttempts = Math.min(
    TEAM_RUNTIME_RECOVERY_MAX_ATTEMPTS_MAX,
    Math.max(TEAM_RUNTIME_RECOVERY_MAX_ATTEMPTS_MIN, Math.round(config?.maxAttempts ?? 2))
  );
  return {
    transientErrorsEnabled: config?.transientErrorsEnabled === true,
    rateLimitsEnabled: config?.rateLimitsEnabled === true,
    initialDelaySeconds,
    maxAttempts,
  };
}

function stableUnitInterval(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 0xffffffff;
}

export function getStableRuntimeRecoveryJitterFactor(seed: string): number {
  return 0.8 + stableUnitInterval(seed) * 0.4;
}

export function planRuntimeRecovery(input: {
  signal: RuntimeFailureSignal;
  classification: RuntimeFailureClassification;
  config: TeamRuntimeRecoveryConfig;
  attempt: number;
  now: Date;
}): RuntimeRecoveryPlan {
  const config = normalizeTeamRuntimeRecoveryConfig(input.config);
  const nowMs = input.now.getTime();
  const observedAtMs = Date.parse(input.signal.observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedAtMs)) {
    return { kind: 'manual', reason: 'invalid_time' };
  }
  if (input.attempt >= config.maxAttempts) {
    return { kind: 'manual', reason: 'attempts_exhausted' };
  }

  const isRateLimitRecovery = input.classification.disposition === 'retry_at_reset';
  if (isRateLimitRecovery && !config.rateLimitsEnabled) {
    return { kind: 'manual', reason: 'disabled' };
  }
  if (input.classification.disposition === 'retry_transient' && !config.transientErrorsEnabled) {
    return { kind: 'manual', reason: 'disabled' };
  }
  if (!isRateLimitRecovery && input.classification.disposition !== 'retry_transient') {
    return { kind: 'manual', reason: 'not_retryable' };
  }

  const exponentialDelayMs = Math.min(
    config.initialDelaySeconds * 1000 * 2 ** Math.max(0, input.attempt),
    TRANSIENT_BACKOFF_CAP_MS
  );
  const jitteredDelayMs = Math.round(
    exponentialDelayMs * getStableRuntimeRecoveryJitterFactor(`${input.signal.id}:${input.attempt}`)
  );
  const hintedAtMs = Date.parse(input.classification.retryAt ?? '');
  const hintedDelayMs = Number.isFinite(hintedAtMs)
    ? Math.max(0, hintedAtMs - nowMs) + (isRateLimitRecovery ? RATE_LIMIT_BUFFER_MS : 0)
    : 0;
  const delayMs = Math.max(jitteredDelayMs, hintedDelayMs);
  if (delayMs > MAX_SCHEDULE_HORIZON_MS) {
    return { kind: 'manual', reason: 'schedule_too_far' };
  }

  const nextAttemptAtMs = nowMs + delayMs;
  const expiresAtMs = isRateLimitRecovery
    ? Math.min(observedAtMs + MAX_SCHEDULE_HORIZON_MS, nextAttemptAtMs + 60 * 60_000)
    : observedAtMs + TRANSIENT_JOB_TTL_MS;
  if (expiresAtMs <= nextAttemptAtMs) {
    return { kind: 'manual', reason: 'schedule_too_far' };
  }
  return {
    kind: 'scheduled',
    nextAttemptAt: new Date(nextAttemptAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    delayMs,
  };
}

function normalizeCircuitPart(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase() || fallback;
}

export function buildRuntimeRecoveryCircuitKey(signal: RuntimeFailureSignal): string {
  return [
    normalizeCircuitPart(signal.contextId, 'local'),
    normalizeCircuitPart(signal.teamName, 'unknown-team'),
    normalizeCircuitPart(signal.runId, 'unknown-run'),
    normalizeCircuitPart(signal.providerBackendId ?? signal.providerId, 'unknown-provider'),
    normalizeCircuitPart(signal.model, 'unknown-model'),
  ].join('\u0000');
}

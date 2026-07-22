import { getErrorMessage } from '@shared/utils/errorHandling';

import { cleanupStaleAnthropicTeamApiKeyHelpers } from '../../runtime/anthropicTeamApiKeyHelper';

export const STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const STALE_ANTHROPIC_TEAM_API_KEY_HELPER_RETRY_DELAYS_MS = [
  1_000, 5_000, 30_000, 120_000, 300_000,
] as const;
export const STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AUTOMATIC_RETRIES =
  STALE_ANTHROPIC_TEAM_API_KEY_HELPER_RETRY_DELAYS_MS.length;

export interface TeamProvisioningAnthropicApiKeyHelperCleanupLogger {
  warn(message: string): void;
}

export interface TeamProvisioningStaleAnthropicApiKeyHelperCleanupDeps {
  baseClaudeDir: string;
  cleanupStaleHelpers?: typeof cleanupStaleAnthropicTeamApiKeyHelpers;
  logger: TeamProvisioningAnthropicApiKeyHelperCleanupLogger;
  maxAgeMs?: number;
  retryDelaysMs?: readonly number[];
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface StaleAnthropicTeamApiKeyHelperCleanupRetryOwner {
  start(): void;
  retryNow(): Promise<void>;
  hasPendingCleanup(): boolean;
  getScheduledRetryCount(): number;
  dispose(): void;
}

/**
 * Owns the single startup sweep until it succeeds. Automatic retries use a
 * capped backoff with a finite number of automatic attempts. A failed sweep
 * remains explicitly owned after the schedule is exhausted and can be retried
 * through retryNow(), while retained state and scheduled work stay bounded.
 */
export function createStaleAnthropicTeamApiKeyHelperCleanupRetryOwner({
  baseClaudeDir,
  cleanupStaleHelpers = cleanupStaleAnthropicTeamApiKeyHelpers,
  logger,
  maxAgeMs = STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS,
  retryDelaysMs = STALE_ANTHROPIC_TEAM_API_KEY_HELPER_RETRY_DELAYS_MS,
  setTimeout: scheduleTimeout = setTimeout,
  clearTimeout: cancelTimeout = clearTimeout,
}: TeamProvisioningStaleAnthropicApiKeyHelperCleanupDeps): StaleAnthropicTeamApiKeyHelperCleanupRetryOwner {
  if (
    retryDelaysMs.length === 0 ||
    retryDelaysMs.length > STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AUTOMATIC_RETRIES ||
    retryDelaysMs.some(
      (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 24 * 60 * 60 * 1000
    )
  ) {
    throw new Error('Stale Anthropic helper cleanup requires a non-empty bounded retry schedule');
  }

  let disposed = false;
  let started = false;
  let succeeded = false;
  let pending = false;
  let retryIndex = 0;
  let scheduledRetryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const scheduleRetry = (): void => {
    if (disposed || retryTimer || retryIndex >= retryDelaysMs.length) {
      return;
    }
    const delay = retryDelaysMs[retryIndex];
    retryIndex += 1;
    scheduledRetryCount += 1;
    retryTimer = scheduleTimeout(() => {
      retryTimer = null;
      void runCleanup();
    }, delay);
    retryTimer.unref?.();
  };

  const runCleanup = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }
    pending = true;
    inFlight = cleanupStaleHelpers({ baseClaudeDir, maxAgeMs })
      .then(() => {
        pending = false;
        succeeded = true;
        retryIndex = 0;
        if (retryTimer) {
          cancelTimeout(retryTimer);
          retryTimer = null;
        }
      })
      .catch((error: unknown) => {
        logger.warn(
          `Failed to cleanup stale Anthropic team API-key helper material: ${getErrorMessage(error)}`
        );
        scheduleRetry();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      void runCleanup();
    },
    retryNow() {
      if (disposed || succeeded) {
        return Promise.resolve();
      }
      started = true;
      if (retryTimer) {
        cancelTimeout(retryTimer);
        retryTimer = null;
      }
      return runCleanup();
    },
    hasPendingCleanup() {
      return pending;
    },
    getScheduledRetryCount() {
      return scheduledRetryCount;
    },
    dispose() {
      disposed = true;
      pending = false;
      if (retryTimer) {
        cancelTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };
}

export function scheduleStaleAnthropicTeamApiKeyHelperCleanup(
  deps: TeamProvisioningStaleAnthropicApiKeyHelperCleanupDeps
): StaleAnthropicTeamApiKeyHelperCleanupRetryOwner {
  const owner = createStaleAnthropicTeamApiKeyHelperCleanupRetryOwner(deps);
  owner.start();
  return owner;
}

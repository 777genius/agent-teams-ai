export const DEFAULT_HOSTED_READINESS_PROBE_TIMEOUT_MS = 5_000;
export const MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS = 2_147_483_647;

export interface HostedReadinessBudget {
  /** Schedules one probe deadline and returns an idempotent cancellation callback. */
  scheduleDeadline(onDeadline: () => void): () => void;
}

function assertTimeoutMs(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Hosted readiness probe timeout must be an integer between 1 and ${MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS}`
    );
  }
}

/** Creates the main-process wall-clock budget used independently by each readiness probe. */
export function createHostedReadinessBudget(
  timeoutMs: number = DEFAULT_HOSTED_READINESS_PROBE_TIMEOUT_MS
): HostedReadinessBudget {
  assertTimeoutMs(timeoutMs);

  return Object.freeze({
    scheduleDeadline(onDeadline: () => void): () => void {
      let active = true;
      const timer = setTimeout(() => {
        if (!active) return;
        active = false;
        onDeadline();
      }, timeoutMs);
      timer.unref?.();

      return () => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
      };
    },
  });
}

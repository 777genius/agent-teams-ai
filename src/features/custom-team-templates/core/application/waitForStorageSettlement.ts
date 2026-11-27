/**
 * Upper bound for waiting on a failed storage writer's settlement.
 *
 * `InternalStorageWorkerClient.failWorker` only resolves `settled` after the
 * retired worker thread physically exits (or a confirmed terminate), and a
 * rejected terminate leaves the retirement unconfirmed, so the promise can stay
 * pending forever. Every consumer therefore waits through this bounded helper
 * instead of awaiting the promise directly.
 */
export const STORAGE_SETTLEMENT_TIMEOUT_MS = 5_000;

export type StorageSettlementOutcome = 'settled' | 'timedOut';

/**
 * Waits for a failed writer's settlement, bounded by a finite timeout.
 *
 * A rejection is treated exactly like a resolution: what matters to callers is
 * that the failed writer can no longer change the database, and the attached
 * handler also keeps a rejecting settlement promise from becoming a secondary
 * unhandled rejection when the timeout wins the race. The timer is always
 * cleared so a fast settlement never leaves a pending handle behind.
 */
export async function waitForStorageSettlement(
  settled: Promise<void>,
  timeoutMs: number = STORAGE_SETTLEMENT_TIMEOUT_MS
): Promise<StorageSettlementOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<StorageSettlementOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timedOut'), timeoutMs);
    });
    return await Promise.race([
      settled.then(
        () => 'settled' as const,
        () => 'settled' as const
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serializes heartbeat work and joins it before releasing the lease. This
 * keeps a late timer callback from using a recycled descriptor-rooted path.
 */
export async function withAtomicCreateCleanupLeaseLifetime<Lease, T>(
  operation: () => Promise<T>,
  acquire: () => Promise<Lease>,
  heartbeatLease: (lease: Lease) => Promise<void>,
  releaseLease: (lease: Lease) => Promise<void>,
  heartbeatMs: number
): Promise<T> {
  const lease = await acquire();
  let stopped = false;
  let heartbeatFailure: unknown = null;
  let heartbeatWork = Promise.resolve();
  const scheduleHeartbeat = (): void => {
    if (stopped) return;
    heartbeatWork = heartbeatWork.then(async () => {
      if (stopped) return;
      try {
        await heartbeatLease(lease);
      } catch (error) {
        heartbeatFailure ??= error;
      }
    });
  };
  const heartbeat = setInterval(scheduleHeartbeat, heartbeatMs);
  heartbeat.unref();

  let result: T | undefined;
  let primaryError: unknown = null;
  try {
    result = await operation();
    if (heartbeatFailure) primaryError = heartbeatFailure;
  } catch (error) {
    primaryError = error;
  }

  stopped = true;
  clearInterval(heartbeat);
  const cleanupErrors: unknown[] = [];
  try {
    await heartbeatWork;
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (heartbeatFailure && heartbeatFailure !== primaryError) cleanupErrors.push(heartbeatFailure);
  try {
    await releaseLease(lease);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Atomic-create cleanup failed and lease cleanup also failed'
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Atomic-create cleanup lease cleanup failed');
  }
  return result as T;
}

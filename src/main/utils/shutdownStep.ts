import type { TeamDataService, TeamTaskStallMonitor } from '@main/services';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { InternalStorageFeature } from '@features/internal-storage/main';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('App');
export const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

export async function runShutdownStep(
  label: string,
  action: () => void | Promise<void>,
  timeoutMs: number | null = SHUTDOWN_STEP_TIMEOUT_MS
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  logger.diagnostic('Shutdown step wait started', { label });
  try {
    if (timeoutMs === null) return void (await action()); // Caller already supplies a finite drain.
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          logger.warn(`Shutdown step timed out after ${timeoutMs}ms: ${label}`);
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    logger.warn(
      `Shutdown step failed (${label}): ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    logger.diagnostic('Shutdown step wait finished', { label });
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export interface InternalStorageShutdownServices {
  teamDataService?: Pick<TeamDataService, 'stopProcessHealthPolling'>;
  teamTaskStallMonitor?: Pick<TeamTaskStallMonitor, 'stop'> | null;
  memberWorkSyncFeature?: Pick<MemberWorkSyncFeatureFacade, 'dispose'> | null;
  internalStorageFeature?: Pick<InternalStorageFeature, 'dispose'> | null;
}

function beginShutdownWork(action: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Closes storage-backed polling and writer ingress immediately, then keeps the
 * storage close dependent on the actual writer drains. Each visible shutdown
 * step remains bounded, but a timeout never detaches storage disposal from the
 * underlying work that is still settling.
 */
export async function disposeInternalStorageAfterWriterDrains(
  services: InternalStorageShutdownServices,
  options: { stepTimeoutMs?: number } = {}
): Promise<void> {
  const stepTimeoutMs = options.stepTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS;

  // Invoke every stop synchronously before awaiting so all ingress is closed
  // even when an earlier stop takes a long time to drain.
  const teamDataPollingStop = beginShutdownWork(() =>
    services.teamDataService?.stopProcessHealthPolling()
  );
  const stallMonitorDrain = beginShutdownWork(() => services.teamTaskStallMonitor?.stop());
  const memberWorkSyncDrain = beginShutdownWork(() => services.memberWorkSyncFeature?.dispose());

  // Start the dependency now. If a bounded step below times out, this promise
  // still waits for its real work before it is allowed to close storage.
  const internalStorageDispose = Promise.allSettled([
    teamDataPollingStop,
    stallMonitorDrain,
    memberWorkSyncDrain,
  ]).then(() => services.internalStorageFeature?.dispose());

  if (services.teamDataService) {
    await runShutdownStep('team data polling stop', () => teamDataPollingStop, stepTimeoutMs);
  }
  if (services.teamTaskStallMonitor) {
    await runShutdownStep('team task stall monitor stop', () => stallMonitorDrain, stepTimeoutMs);
  }
  if (services.memberWorkSyncFeature) {
    await runShutdownStep('member work sync dispose', () => memberWorkSyncDrain, stepTimeoutMs);
  }
  if (services.internalStorageFeature) {
    // WAL checkpoint + close inside the worker, then terminate it.
    await runShutdownStep(
      'internal storage dispose',
      () => internalStorageDispose.then(() => undefined),
      stepTimeoutMs
    );
  }
  await internalStorageDispose.catch(() => undefined);
}

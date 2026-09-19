export interface StandaloneShutdownActions {
  stopHttpServer: () => Promise<void>;
  disposeLocalContext: () => void;
  flushConfig: () => Promise<void>;
  logInfo: (message: string) => void;
  logError: (message: string, error: unknown) => void;
  setExitCode: (code: number) => void;
  exit: (code: number) => void;
  requestedExitCode?: () => number;
}

export async function runStandaloneShutdownLifecycle(
  actions: StandaloneShutdownActions,
  initialExitCode = 0
): Promise<void> {
  actions.logInfo('Shutting down...');
  let exitCode = initialExitCode === 0 ? 0 : 1;
  if (exitCode !== 0) actions.setExitCode(1);
  const recordFailure = (label: string, error: unknown): void => {
    exitCode = 1;
    actions.setExitCode(1);
    actions.logError(`${label}:`, error);
  };
  try {
    await actions.stopHttpServer();
  } catch (error) {
    recordFailure('HTTP server shutdown failed', error);
  }
  try {
    actions.disposeLocalContext();
  } catch (error) {
    recordFailure('Local context shutdown failed', error);
  }
  try {
    await actions.flushConfig();
  } catch (error) {
    recordFailure('ConfigManager flush failed during shutdown', error);
  }
  exitCode = Math.max(exitCode, actions.requestedExitCode?.() ?? 0);
  if (exitCode === 0) {
    actions.logInfo('Shutdown complete');
  }
  actions.exit(exitCode);
}

export interface StandaloneFatalFailStopActions {
  closeAdmissions(): void;
  shutdown(): Promise<void>;
  setExitCode(code: number): void;
  exit(code: number): void;
  logError(message: string, error: unknown): void;
  setTimer(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  readonly hardExitTimeoutMs?: number;
}

export function createStandaloneOrderlyOwnerLossGuard<TOwner>(
  sameOwner: (left: TOwner, right: TOwner) => boolean
): Readonly<{
  beginOrderlyShutdown(owner: TOwner | null): void;
  isExpectedOwnerLoss(owner: TOwner): boolean;
}> {
  let orderlyShutdownRequested = false;
  let orderlyShutdownOwner: TOwner | null = null;
  return Object.freeze({
    beginOrderlyShutdown(owner: TOwner | null): void {
      if (orderlyShutdownRequested) return;
      orderlyShutdownRequested = true;
      orderlyShutdownOwner = owner;
    },
    isExpectedOwnerLoss(owner: TOwner): boolean {
      return (
        orderlyShutdownRequested &&
        orderlyShutdownOwner !== null &&
        sameOwner(orderlyShutdownOwner, owner)
      );
    },
  });
}

type SynchronousCallResult<T> = { success: true; value: T } | { success: false; error: unknown };

function captureSynchronousCall<T>(call: () => T): SynchronousCallResult<T> {
  try {
    return { success: true, value: call() };
  } catch (error) {
    return { success: false, error };
  }
}

/** First-fatal-only coordinator. Admission closes synchronously before any cleanup await. */
export function createStandaloneFatalFailStop(actions: StandaloneFatalFailStopActions) {
  let requested = false;
  return (label: string, error: unknown): void => {
    if (requested) return;
    requested = true;
    actions.setExitCode(1);
    try {
      actions.closeAdmissions();
    } catch (closeError) {
      actions.logError('Fatal admission closure failed:', closeError);
    }
    actions.logError(`${label}:`, error);
    const timer = actions.setTimer(() => actions.exit(1), actions.hardExitTimeoutMs ?? 10_000);
    timer.unref?.();
    const shutdown = captureSynchronousCall(() => actions.shutdown());
    if (!shutdown.success) {
      actions.logError('Fatal shutdown failed:', shutdown.error);
      actions.clearTimer(timer);
      actions.exit(1);
      return;
    }
    void shutdown.value.then(
      () => actions.clearTimer(timer),
      (shutdownError) => {
        actions.logError('Fatal shutdown failed:', shutdownError);
        actions.clearTimer(timer);
        actions.exit(1);
      }
    );
  };
}

type StandaloneShutdownSignal = 'SIGINT' | 'SIGTERM';
export function registerStandaloneShutdownSignalHandlers(input: {
  platform: NodeJS.Platform;
  onSignal: (signal: StandaloneShutdownSignal, listener: () => void) => void;
  beforeShutdown?: (signal: StandaloneShutdownSignal) => void;
  shutdown: () => Promise<void>;
}): void {
  const requestShutdown = (signal: StandaloneShutdownSignal): void => {
    input.beforeShutdown?.(signal);
    void input.shutdown();
  };
  input.onSignal('SIGINT', () => requestShutdown('SIGINT'));
  if (input.platform !== 'win32') input.onSignal('SIGTERM', () => requestShutdown('SIGTERM'));
}

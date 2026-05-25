type StartupIdleTask = () => void;

interface StartupIdleDeadline {
  didTimeout: boolean;
  timeRemaining: () => number;
}

type StartupIdleCallback = (deadline: StartupIdleDeadline) => void;

export interface StartupIdleTaskScheduler {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  requestIdleCallback?: (callback: StartupIdleCallback, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

export interface StartupIdleTaskOptions {
  minDelayMs: number;
  maxDelayMs: number;
  scheduler?: StartupIdleTaskScheduler;
}

function getDefaultStartupIdleTaskScheduler(): StartupIdleTaskScheduler {
  const timerHost = typeof window === 'undefined' ? globalThis : window;
  const idleWindow =
    typeof window === 'undefined'
      ? null
      : (window as Window &
          typeof globalThis & {
            requestIdleCallback?: StartupIdleTaskScheduler['requestIdleCallback'];
            cancelIdleCallback?: StartupIdleTaskScheduler['cancelIdleCallback'];
          });

  return {
    setTimeout: timerHost.setTimeout.bind(timerHost),
    clearTimeout: timerHost.clearTimeout.bind(timerHost),
    requestIdleCallback: idleWindow?.requestIdleCallback?.bind(idleWindow),
    cancelIdleCallback: idleWindow?.cancelIdleCallback?.bind(idleWindow),
  };
}

export function scheduleStartupIdleTask(
  task: StartupIdleTask,
  options: StartupIdleTaskOptions
): () => void {
  const scheduler = options.scheduler ?? getDefaultStartupIdleTaskScheduler();
  const minDelayMs = Math.max(0, options.minDelayMs);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs);
  let cancelled = false;
  let ran = false;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let idleHandle: number | null = null;

  const runOnce = (): void => {
    if (cancelled || ran) {
      return;
    }
    ran = true;
    task();
  };

  delayTimer = scheduler.setTimeout(() => {
    delayTimer = null;
    if (cancelled) {
      return;
    }

    const idleTimeoutMs = maxDelayMs - minDelayMs;
    if (scheduler.requestIdleCallback && idleTimeoutMs > 0) {
      idleHandle = scheduler.requestIdleCallback(
        () => {
          idleHandle = null;
          runOnce();
        },
        { timeout: idleTimeoutMs }
      );
      return;
    }

    runOnce();
  }, minDelayMs);

  return () => {
    cancelled = true;
    if (delayTimer) {
      scheduler.clearTimeout(delayTimer);
      delayTimer = null;
    }
    if (idleHandle !== null && scheduler.cancelIdleCallback) {
      scheduler.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
  };
}

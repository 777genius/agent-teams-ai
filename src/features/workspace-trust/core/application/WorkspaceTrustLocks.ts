export class WorkspaceTrustLockTimeoutError extends Error {
  constructor(readonly lockKey: string) {
    super(`Timed out waiting for workspace trust lock: ${lockKey}`);
    this.name = 'WorkspaceTrustLockTimeoutError';
  }
}

export class WorkspaceTrustLockCancelledError extends Error {
  constructor(readonly lockKey: string) {
    super(`Workspace trust lock wait cancelled: ${lockKey}`);
    this.name = 'WorkspaceTrustLockCancelledError';
  }
}

export interface WorkspaceTrustLockOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  isCancelled(): boolean;
}

export interface WorkspaceTrustLockRuntime {
  wait(delayMs: number): Promise<void>;
}

const PORTABLE_LOCK_RUNTIME: WorkspaceTrustLockRuntime = {
  wait(delayMs) {
    return new Promise((resolve) => {
      const signal = AbortSignal.timeout(delayMs);
      signal.addEventListener('abort', () => resolve(), { once: true });
      if (signal.aborted) {
        resolve();
      }
    });
  },
};

function positiveDuration(value: number | undefined, fallback: number): number | null {
  const duration = value ?? fallback;
  return Number.isSafeInteger(duration) && duration > 0 ? duration : null;
}

async function waitForLockTurn(
  previous: Promise<void>,
  lockKey: string,
  options: WorkspaceTrustLockOptions,
  runtime: WorkspaceTrustLockRuntime
): Promise<void> {
  const timeoutMs = positiveDuration(options.timeoutMs, 0);
  const pollIntervalMs = positiveDuration(options.pollIntervalMs, 50);
  if (timeoutMs === null || pollIntervalMs === null) {
    throw new WorkspaceTrustLockTimeoutError(lockKey);
  }
  let remainingMs = timeoutMs;

  while (remainingMs > 0) {
    if (options.isCancelled()) {
      throw new WorkspaceTrustLockCancelledError(lockKey);
    }

    const waitMs = Math.min(pollIntervalMs, remainingMs);
    const result = await Promise.race([
      previous.then(
        () => 'released' as const,
        () => 'released' as const
      ),
      runtime.wait(waitMs).then(
        () => 'poll' as const,
        () => 'runtime-unavailable' as const
      ),
    ]);
    if (result === 'released') {
      return;
    }
    if (result === 'runtime-unavailable') {
      throw new WorkspaceTrustLockTimeoutError(lockKey);
    }
    remainingMs -= waitMs;
  }

  throw new WorkspaceTrustLockTimeoutError(lockKey);
}

export class WorkspaceTrustLockRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly runtime: WorkspaceTrustLockRuntime = PORTABLE_LOCK_RUNTIME) {}

  async withWorkspaceLock<T>(
    lockKey: string,
    options: WorkspaceTrustLockOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.tails.get(lockKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = (previous ?? Promise.resolve()).catch(() => undefined).then(() => current);
    this.tails.set(lockKey, tail);

    try {
      if (previous) {
        await waitForLockTurn(previous, lockKey, options, this.runtime);
      }
      return await fn();
    } finally {
      release();
      void tail.finally(() => {
        if (this.tails.get(lockKey) === tail) {
          this.tails.delete(lockKey);
        }
      });
    }
  }

  async withWorkspaceLocks<T>(
    lockKeys: string[],
    options: WorkspaceTrustLockOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const uniqueKeys = [...new Set(lockKeys)].sort();
    const acquire = (index: number): Promise<T> => {
      const lockKey = uniqueKeys[index];
      if (!lockKey) {
        return fn();
      }
      return this.withWorkspaceLock(lockKey, options, () => acquire(index + 1));
    };
    return acquire(0);
  }
}

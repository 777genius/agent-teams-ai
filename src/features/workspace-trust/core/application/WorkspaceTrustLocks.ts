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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLockTurn(
  previous: Promise<void>,
  lockKey: string,
  options: WorkspaceTrustLockOptions
): Promise<void> {
  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 50;

  while (true) {
    if (options.isCancelled()) {
      throw new WorkspaceTrustLockCancelledError(lockKey);
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= options.timeoutMs) {
      throw new WorkspaceTrustLockTimeoutError(lockKey);
    }

    const waitMs = Math.min(pollIntervalMs, options.timeoutMs - elapsedMs);
    const result = await Promise.race([
      previous.then(
        () => 'released' as const,
        () => 'released' as const
      ),
      sleep(waitMs).then(() => 'poll' as const),
    ]);
    if (result === 'released') {
      return;
    }
  }
}

export class WorkspaceTrustLockRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async withWorkspaceLock<T>(
    lockKey: string,
    options: WorkspaceTrustLockOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.tails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(lockKey, tail);

    try {
      await waitForLockTurn(previous, lockKey, options);
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

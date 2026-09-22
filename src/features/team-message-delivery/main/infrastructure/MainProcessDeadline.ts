import { withTimeoutValue } from '@main/utils/withTimeoutValue';

import type { DeadlinePort } from '../../core/application/ports/TeamMessageDeliveryPorts';

export class MainProcessDeadline implements DeadlinePort {
  async raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise.then((value) => ({ kind: 'value' as const, value })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => {
            onTimeout();
            resolve({ kind: 'timeout' });
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  withTimeoutValue<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
    return withTimeoutValue(promise, timeoutMs, timeoutValue);
  }
}

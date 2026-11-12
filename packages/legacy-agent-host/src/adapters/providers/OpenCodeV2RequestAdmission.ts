import { raceOpenCodeV2Revocation } from './OpenCodeV2RevocationWait.js';

/** Reserve verified native I/O until its transport releases it. A new probe
 * blocks new requests, then drains existing I/O before invalidating readiness. */
export function createOpenCodeV2RequestAdmission(options: {
  isCurrent(): boolean;
  isReady(): boolean;
  reattestations: ReadonlySet<Promise<void>>;
  signal: AbortSignal;
}) {
  let requests = 0;
  let drained = Promise.withResolvers<void>();
  drained.resolve();
  let acquiring = 0;
  let acquisitionsDrained = Promise.withResolvers<void>();
  acquisitionsDrained.resolve();
  const closing = new AbortController();
  const current = (signal: AbortSignal) =>
    !signal.aborted && !closing.signal.aborted && !options.signal.aborted && options.isCurrent();

  return {
    hasRequest: () => requests > 0,
    async beforeRequest(signal: AbortSignal): Promise<() => void> {
      if (acquiring++ === 0) acquisitionsDrained = Promise.withResolvers<void>();
      try {
        const combined = AbortSignal.any([signal, options.signal, closing.signal]);
        while (current(combined)) {
          if (options.isReady() && options.reattestations.size === 0) {
            // Reserve before resolving: a probe in the caller's await gap must
            // drain this request before it can invalidate credential authority.
            if (requests++ === 0) drained = Promise.withResolvers<void>();
            let released = false;
            return () => {
              if (released) return;
              released = true;
              if (--requests === 0) drained.resolve();
            };
          }
          const pending = [...options.reattestations];
          if (!pending.length) break;
          const result = await raceOpenCodeV2Revocation(Promise.all(pending), combined);
          if (result.kind === 'revoked') break;
        }
        throw new Error('V2 native custody revoked');
      } finally {
        if (--acquiring === 0) acquisitionsDrained.resolve();
      }
    },
    async waitForDrain(signal: AbortSignal): Promise<boolean> {
      const combined = AbortSignal.any([signal, options.signal]);
      while (requests > 0 && current(combined)) {
        const result = await raceOpenCodeV2Revocation(drained.promise, combined);
        if (result.kind === 'revoked') return false;
      }
      return current(combined);
    },
    async close(signal: AbortSignal): Promise<boolean> {
      // Fence new acquisitions, but do not abort an already admitted HTTP body.
      // A queued probe cannot keep its admission waiter alive during close.
      closing.abort();
      while (requests > 0 || acquiring > 0) {
        if (signal.aborted) return false;
        const result = await raceOpenCodeV2Revocation(
          Promise.all([drained.promise, acquisitionsDrained.promise]),
          signal
        );
        if (result.kind === 'revoked') return false;
      }
      return !signal.aborted;
    },
  };
}

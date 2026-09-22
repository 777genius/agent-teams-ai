import { randomBytes } from 'node:crypto';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface NodeHostedDiagnosticsPlatform {
  nowEpochMs(): number;
  nowMonotonicMs(): number;
  randomBytes(size: number): Uint8Array;
  schedule(delayMs: number, callback: () => void): () => void;
}

function schedule(delayMs: number, callback: () => void): () => void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || typeof callback !== 'function') {
    throw new TypeError('hosted-diagnostics-timer-invalid');
  }

  let active = true;
  let remainingMs = delayMs;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const sliceMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    handle = setTimeout(() => {
      handle = undefined;
      if (!active) return;
      remainingMs -= sliceMs;
      if (remainingMs > 0) {
        arm();
        return;
      }
      active = false;
      callback();
    }, sliceMs);
    handle.unref();
  };
  arm();

  return () => {
    if (!active) return;
    active = false;
    if (handle !== undefined) clearTimeout(handle);
    handle = undefined;
  };
}

export function createNodeHostedDiagnosticsPlatform(): NodeHostedDiagnosticsPlatform {
  return Object.freeze({
    nowEpochMs: () => Date.now(),
    nowMonotonicMs: () => Math.floor(performance.now()),
    randomBytes(size: number): Uint8Array {
      if (!Number.isSafeInteger(size) || size < 1) {
        throw new TypeError('hosted-diagnostics-random-size-invalid');
      }
      return randomBytes(size);
    },
    schedule,
  });
}

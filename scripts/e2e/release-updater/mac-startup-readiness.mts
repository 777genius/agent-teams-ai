import assert from 'node:assert/strict';
import type { Cdp } from './cdp.mts';

interface StartupStatus {
  phase: string;
  message: string;
  ready: boolean;
  error?: string | null;
  startedAt: number;
  updatedAt: number;
}
interface Evaluation {
  result: { value: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}
async function observe(client: Pick<Cdp, 'send'>, expression: string, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Evaluation;
  try {
    result = await Promise.race([
      client.send<Evaluation>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Public startup readiness deadline exceeded')),
          Math.max(0, deadline - Date.now())
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Startup IPC evaluation failed'
    );
  return result.result.value;
}
// Both immutable signed 2.17.1 and 2.17.10 expose this public lifecycle contract.
export async function waitMacStartupReady(
  client: Pick<Cdp, 'send'>,
  version: string,
  timeoutMs = 30_000,
  pollMs = 100
) {
  assert(version === '2.17.1' || version === '2.17.10');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000);
  assert(Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 100);
  const deadline = Date.now() + timeoutMs;
  assert.equal(
    await observe(client, 'typeof window.electronAPI?.startup?.getStatus === "function"', deadline),
    true,
    'Required public startup API absent'
  );
  const observations: StartupStatus[] = [];
  while (Date.now() < deadline) {
    const raw = await observe(client, 'window.electronAPI.startup.getStatus()', deadline);
    assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid public startup status');
    const value = raw as StartupStatus;
    assert(
      typeof value.phase === 'string' &&
        value.phase.length > 0 &&
        typeof value.message === 'string' &&
        typeof value.ready === 'boolean' &&
        Number.isFinite(value.startedAt) &&
        Number.isFinite(value.updatedAt) &&
        (value.error === undefined || value.error === null || typeof value.error === 'string'),
      'Invalid public startup status'
    );
    observations.push(value);
    assert(value.phase !== 'failed' && !value.error, 'Public startup failed');
    if (value.ready) {
      assert.equal(value.phase, 'ready', 'Inconsistent public startup readiness');
      assert(Date.now() < deadline, 'Public startup readiness deadline exceeded');
      return { version, observations };
    }
    assert(value.phase !== 'ready', 'Inconsistent public startup readiness');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now())))
    );
  }
  throw new Error('Public startup readiness deadline exceeded');
}

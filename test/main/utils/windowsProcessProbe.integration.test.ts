// @vitest-environment node
import { readProcessStartTimeMs } from '@main/utils/processStartTime';
import { listWindowsProcessTable, listWindowsProcessTableSync, WindowsProcessTableProbeError } from '@main/utils/windowsProcessTable';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');
vi.unmock('child_process');

async function readSafely<T>(probe: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    const failure = error && typeof error === 'object' ? error as { code?: unknown; signal?: unknown } : {};
    console.log(JSON.stringify({ phase: 'windows_process_identity', probe, failed: true,
      exitCode: typeof failure.code === 'number' && Number.isInteger(failure.code) ? failure.code : null,
      nativeCode: typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : null,
      signal: failure.signal === 'SIGTERM' || failure.signal === 'SIGKILL' ? failure.signal : null,
      ...(error instanceof WindowsProcessTableProbeError ? error.failureFacts : {}) }));
    // execFileSync errors can retain an entire process table in stdout. Never
    // hand that native error to the test reporter or print its message.
    throw new Error(`Windows process identity reader failed: ${probe}`);
  }
}

/** Real host observation only: no process launched other than the existing read-only
 * PowerShell probes, no kill calls, and no command-line or provider payload output.
 */
describe.skipIf(process.platform !== 'win32')('real Windows process identity readers', () => {
  it('observes this Node process through both table transports and its birth reader', async () => {
    const syncRows = await readSafely('sync_table', () => listWindowsProcessTableSync());
    const asyncRows = await readSafely('fresh_async_table', () => listWindowsProcessTable(undefined, { bypassCache: true }));
    const birth = await readProcessStartTimeMs(process.pid, 'win32');
    const facts = {
      syncSelfPresent: syncRows.some(row => row.pid === process.pid),
      freshAsyncSelfPresent: asyncRows.some(row => row.pid === process.pid),
      birthFinitePositive: birth !== null && Number.isFinite(birth) && birth > 0 && birth <= Date.now(),
    };
    console.log(JSON.stringify({ phase: 'windows_process_identity', ...facts }));
    expect(facts).toEqual({ syncSelfPresent: true, freshAsyncSelfPresent: true, birthFinitePositive: true });
  });
});

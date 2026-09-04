import {
  OPEN_CODE_STARTUP_SWEEP_HOST_SETTLE_MS,
  runOpenCodeStartupRuntimeSweepTail,
} from '@main/services/team/opencode/bridge/OpenCodeStartupRuntimeSweep';
import {
  beginOpenCodeStartupRuntimeSweep,
  OPEN_CODE_STARTUP_SWEEP_WAIT_TIMEOUT_MS,
  whenOpenCodeStartupRuntimeSweepSettled,
} from '@main/services/team/opencode/bridge/OpenCodeStartupSweepGate';
import { addLogSink, createLogger, type LogSinkEntry } from '@shared/utils/logger';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeManagedHostCleanupResult } from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';

function sweepResult(
  overrides: Partial<OpenCodeManagedHostCleanupResult> = {}
): OpenCodeManagedHostCleanupResult {
  return { scanned: 0, killed: 0, candidates: [], diagnostics: [], ...overrides };
}

function sweepPorts(
  overrides: Partial<Parameters<typeof runOpenCodeStartupRuntimeSweepTail>[0]> = {}
) {
  return {
    sweepCommandIssuedAtMs: 1_000,
    logSweepResult: vi.fn(),
    logWarning: vi.fn(),
    waitMs: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('runOpenCodeStartupRuntimeSweepTail', () => {
  it('fences the reap by the moment the sweep command was issued', async () => {
    const sweepManagedHosts = vi.fn(() => Promise.resolve(sweepResult({ scanned: 3, killed: 1 })));
    const ports = sweepPorts({
      sweepCommandIssuedAtMs: 4_242,
      sweepManagedHosts,
    });

    await runOpenCodeStartupRuntimeSweepTail(ports);

    expect(ports.waitMs).toHaveBeenCalledWith(OPEN_CODE_STARTUP_SWEEP_HOST_SETTLE_MS);
    expect(sweepManagedHosts).toHaveBeenCalledWith({ startedBeforeMs: 4_242 });
    expect(ports.logSweepResult).toHaveBeenCalledWith(
      'opencode_managed_hosts_killed sweep=startup count=1 scanned=3'
    );
  });

  // The settle window comes first or the reap finds nothing: the orchestrator
  // is still booting the host this tail exists to remove when the sweep
  // command returns, and a reap that ran immediately would report a clean
  // sweep and leave the host holding the loopback port.
  it('waits out the settle window before it reaps anything', async () => {
    const order: string[] = [];
    const ports = sweepPorts({
      waitMs: vi.fn(() => {
        order.push('wait');
        return Promise.resolve();
      }),
      sweepManagedHosts: () => {
        order.push('sweep');
        return Promise.resolve(sweepResult());
      },
    });

    await runOpenCodeStartupRuntimeSweepTail(ports);

    expect(order).toEqual(['wait', 'sweep']);
  });

  // The destructive counter has to outlive the process without costing every
  // developer a console line - the reason it is `diagnostic` and not `warn`,
  // and the reason the suite needs no per-event console allowlist for it.
  it('records the kill count durably without writing to the console', async () => {
    const entries: LogSinkEntry[] = [];
    const removeSink = addLogSink((entry) => entries.push(entry));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = createLogger('OpenCode:startup-sweep');

    try {
      await runOpenCodeStartupRuntimeSweepTail(
        sweepPorts({
          logSweepResult: (message) => logger.diagnostic(message),
          sweepManagedHosts: () => Promise.resolve(sweepResult({ scanned: 2, killed: 2 })),
        })
      );

      expect(entries).toEqual([
        expect.objectContaining({
          level: 'diagnostic',
          args: ['opencode_managed_hosts_killed sweep=startup count=2 scanned=2'],
        }),
      ]);
      expect(consoleWarn).toHaveBeenCalledTimes(0);
    } finally {
      removeSink();
      consoleWarn.mockRestore();
    }
  });

  it('reports what the sweep could not do without failing the startup', async () => {
    const ports = sweepPorts({
      sweepManagedHosts: () =>
        Promise.resolve(sweepResult({ scanned: 1, diagnostics: ['pid=91 identity changed'] })),
    });

    await runOpenCodeStartupRuntimeSweepTail(ports);

    expect(ports.logWarning).toHaveBeenCalledWith(
      '[OpenCode] startup sweep host cleanup: pid=91 identity changed'
    );
  });
});

describe('OpenCodeStartupSweepGate', () => {
  it('resolves at once when no sweep is pending', async () => {
    const onWaitStart = vi.fn();

    await whenOpenCodeStartupRuntimeSweepSettled({ onWaitStart });

    expect(onWaitStart).not.toHaveBeenCalled();
  });

  it('parks a caller until the pending sweep settles, and reports the wait', async () => {
    const settle = beginOpenCodeStartupRuntimeSweep();
    const onWaitStart = vi.fn();
    const logWaited = vi.fn();
    let now = 0;

    const waiting = whenOpenCodeStartupRuntimeSweepSettled({
      onWaitStart,
      logWaited,
      nowMs: () => now,
    });
    expect(onWaitStart).toHaveBeenCalledTimes(1);
    now = 2_500;
    settle();
    await waiting;

    expect(logWaited).toHaveBeenCalledWith(
      'opencode_startup_sweep_wait waitedMs=2500 settled=true'
    );
    // The gate is clear again: the next caller must not pay the wait twice.
    await whenOpenCodeStartupRuntimeSweepSettled({ onWaitStart });
    expect(onWaitStart).toHaveBeenCalledTimes(1);
  });

  // A sweep that throws still has to release everything waiting on it, which is
  // why the settle callback is invoked from a `finally` at the call site.
  it('releases waiters when the sweep it fronts fails', async () => {
    const settle = beginOpenCodeStartupRuntimeSweep();
    const waiting = whenOpenCodeStartupRuntimeSweepSettled({});

    await Promise.reject(new Error('sweep exploded'))
      .catch(() => undefined)
      .finally(settle);

    await expect(waiting).resolves.toBeUndefined();
  });

  it('gives up after the bound rather than parking a launch forever', async () => {
    beginOpenCodeStartupRuntimeSweep();
    const logWaited = vi.fn();
    const onWaitStart = vi.fn();
    let now = 0;

    await whenOpenCodeStartupRuntimeSweepSettled({
      logWaited,
      nowMs: () => now,
      setTimeoutImpl: ((resolve: () => void) => {
        now = OPEN_CODE_STARTUP_SWEEP_WAIT_TIMEOUT_MS;
        resolve();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    });

    expect(logWaited).toHaveBeenCalledWith(
      `opencode_startup_sweep_wait waitedMs=${OPEN_CODE_STARTUP_SWEEP_WAIT_TIMEOUT_MS} settled=false`
    );
    // Giving up once is enough: the abandoned sweep must not charge the next
    // launch the same bound all over again.
    await whenOpenCodeStartupRuntimeSweepSettled({ onWaitStart });
    expect(onWaitStart).not.toHaveBeenCalled();
  });
});

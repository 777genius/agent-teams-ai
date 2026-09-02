import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeProcessOwnershipMarkers,
  type OpenCodeLifecycleCleanupTailPorts,
  runOpenCodeLifecycleCleanupTail,
} from './OpenCodeLifecycleCleanupTail';

const steps: string[] = [];

const cleanupManagedOpenCodeServeProcesses = vi.hoisted(() =>
  vi.fn(async (_options: unknown) => ({
    scanned: 0,
    killed: 0,
    candidates: [],
    diagnostics: [] as string[],
  }))
);
const purgeStaleOpenCodeHostStartupLocks = vi.hoisted(() =>
  vi.fn(async (_options: unknown) => ({
    locksDir: '/locks',
    scanned: 0,
    removed: 0,
    kept: 0,
    diagnostics: [] as string[],
  }))
);
const runOpenCodeStartupRuntimeSweepTail = vi.hoisted(() => vi.fn(async (_ports: unknown) => {}));

vi.mock('./OpenCodeManagedHostProcessCleanup', () => ({
  cleanupManagedOpenCodeServeProcesses,
}));
// Only the destructive purge is replaced; the floor it is called with stays the
// real one, so this test cannot drift from the platform rule that picks it.
vi.mock('./OpenCodeHostStartupLockCleanup', async (importActual) => ({
  ...(await importActual<typeof import('./OpenCodeHostStartupLockCleanup')>()),
  purgeStaleOpenCodeHostStartupLocks,
}));
vi.mock('./OpenCodeStartupRuntimeSweep', () => ({ runOpenCodeStartupRuntimeSweepTail }));

function createPorts(): OpenCodeLifecycleCleanupTailPorts & {
  sweepResults: string[];
  warnings: string[];
  errors: string[];
} {
  const sweepResults: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    sweepResults,
    warnings,
    errors,
    logSweepResult: (message) => {
      sweepResults.push(message);
    },
    logWarning: (message) => {
      warnings.push(message);
    },
    logError: (message) => {
      errors.push(message);
    },
  };
}

const APP_STARTED_AT_MS = Date.parse('2026-09-02T09:00:00.000Z');
const SWEEP_COMMAND_SETTLED_AT_MS = Date.parse('2026-09-02T09:00:12.000Z');

function baseInput(reason: 'startup' | 'shutdown'): {
  reason: 'startup' | 'shutdown';
  registryHostPids: ReadonlySet<number>;
  registryCleanupAvailable: boolean;
  appStartedAtMs: number;
  sweepCommandSettledAtMs: number;
  managedHostInstanceId: string;
} {
  return {
    reason,
    registryHostPids: new Set([4242]),
    registryCleanupAvailable: true,
    appStartedAtMs: APP_STARTED_AT_MS,
    sweepCommandSettledAtMs: SWEEP_COMMAND_SETTLED_AT_MS,
    managedHostInstanceId: '1234-1756803600000',
  };
}

function recordSteps(): void {
  steps.length = 0;
  cleanupManagedOpenCodeServeProcesses.mockImplementation(async () => {
    steps.push('host-process-fallback');
    return { scanned: 0, killed: 0, candidates: [], diagnostics: [] };
  });
  runOpenCodeStartupRuntimeSweepTail.mockImplementation(async () => {
    steps.push('startup-runtime-sweep-tail');
  });
  purgeStaleOpenCodeHostStartupLocks.mockImplementation(async () => {
    steps.push('startup-lock-purge');
    return { locksDir: '/locks', scanned: 0, removed: 0, kept: 0, diagnostics: [] };
  });
}

describe('runOpenCodeLifecycleCleanupTail', () => {
  it('forces the shutdown sweep against this instance markers and runs no startup steps', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('shutdown'), ports });

    expect(steps).toEqual(['host-process-fallback']);
    const [options] = cleanupManagedOpenCodeServeProcesses.mock.calls[0] as [
      {
        mode: string;
        excludePids?: ReadonlySet<number>;
        startedBeforeMs?: number | null;
        requiredDetailsMarkers?: readonly string[];
        requiredServeConfigMarkersAny?: readonly string[];
      },
    ];
    expect(options.mode).toBe('force');
    expect(options.excludePids).toBeUndefined();
    expect(options.startedBeforeMs).toBeNull();
    expect({
      requiredDetailsMarkers: options.requiredDetailsMarkers,
      requiredServeConfigMarkersAny: options.requiredServeConfigMarkersAny,
    }).toEqual({
      requiredDetailsMarkers: undefined,
      requiredServeConfigMarkersAny: undefined,
      ...buildOpenCodeProcessOwnershipMarkers('1234-1756803600000'),
    });
    expect(ports.warnings).toEqual([]);
  });

  it('runs the startup steps in order behind the host process fallback', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });

    expect(steps).toEqual([
      'host-process-fallback',
      'startup-runtime-sweep-tail',
      'startup-lock-purge',
    ]);
    const [options] = cleanupManagedOpenCodeServeProcesses.mock.calls[0] as [
      { mode: string; excludePids?: ReadonlySet<number>; startedBeforeMs?: number | null },
    ];
    expect(options.mode).toBe('orphaned');
    expect([...(options.excludePids ?? [])]).toEqual([4242]);
    expect(options.startedBeforeMs).toBe(APP_STARTED_AT_MS);
    const [sweepPorts] = runOpenCodeStartupRuntimeSweepTail.mock.calls[0] as [
      {
        sweepCommandSettledAtMs: number;
        ownershipMarkers?: {
          requiredDetailsMarkers?: readonly string[];
          requiredServeConfigMarkersAny?: readonly string[];
        };
      },
    ];
    expect(sweepPorts.sweepCommandSettledAtMs).toBe(SWEEP_COMMAND_SETTLED_AT_MS);
    // The startup reap is destructive and unfenced by lineage, so it carries
    // this instance's ownership proof just like the shutdown sweep does.
    expect(sweepPorts.ownershipMarkers).toEqual(
      buildOpenCodeProcessOwnershipMarkers('1234-1756803600000')
    );
  });

  it('kills nothing at startup when the registry sweep could not answer', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      registryCleanupAvailable: false,
      ports,
    });

    expect(steps).toEqual([]);
    expect(ports.warnings).toEqual([
      '[OpenCode] Startup fallback cleanup skipped because host registry cleanup is unavailable',
    ]);
  });

  it('still forces the shutdown sweep when the registry sweep could not answer', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('shutdown'),
      registryCleanupAvailable: false,
      ports,
    });

    expect(steps).toEqual(['host-process-fallback']);
  });

  it('reports the kill count as a durable sweep result and the rest as warnings', async () => {
    vi.clearAllMocks();
    recordSteps();
    cleanupManagedOpenCodeServeProcesses.mockImplementation(async () => ({
      scanned: 3,
      killed: 2,
      candidates: [],
      diagnostics: ['host 7 refused to die'],
    }));
    purgeStaleOpenCodeHostStartupLocks.mockImplementation(async () => ({
      locksDir: '/locks',
      scanned: 4,
      removed: 1,
      kept: 3,
      diagnostics: ['lock 9 is held'],
    }));
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });

    expect(ports.sweepResults).toEqual([
      '[OpenCode] opencode_managed_hosts_killed sweep=startup fallback count=2',
      'opencode_startup_locks_purged phase=startup removed=1 kept=3 dir=/locks',
    ]);
    expect(ports.warnings).toEqual([
      '[OpenCode] startup fallback cleanup: host 7 refused to die',
      '[OpenCode] startup lock purge: lock 9 is held',
    ]);
  });
});

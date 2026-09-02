import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeProcessOwnershipMarkers,
  type OpenCodeLifecycleCleanupTailInput,
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

const OWNED_WORKSPACES = ['C:\\workspaces\\example', 'C:\\workspaces\\other'];

const sweepCursorAgentTrees = vi.fn(
  (_input: { ownedWorkspaceCwds: readonly string[]; startedBeforeMs?: number | null }) =>
    Promise.resolve({
      scanned: 0,
      killed: [] as number[],
      keptRecent: [] as number[],
      diagnostics: [] as string[],
    })
);

function baseInput(
  reason: 'startup' | 'shutdown'
): Omit<OpenCodeLifecycleCleanupTailInput, 'ports'> {
  return {
    reason,
    registryHostPids: new Set([4242]),
    registryCleanupAvailable: true,
    appStartedAtMs: APP_STARTED_AT_MS,
    sweepCommandSettledAtMs: SWEEP_COMMAND_SETTLED_AT_MS,
    managedHostInstanceId: '1234-1756803600000',
    // The real port reads the host process table and kills what it finds; every
    // case here hands in a stub so the assertions are about scope, not luck.
    cursorAgentTreeSweep: { isEnabled: () => true, sweepCursorAgentTrees },
    listOwnedLeadWorkspaces: () => Promise.resolve(OWNED_WORKSPACES),
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
  sweepCursorAgentTrees.mockImplementation(() => {
    steps.push('cursor-agent-tree-sweep');
    return Promise.resolve({ scanned: 0, killed: [], keptRecent: [], diagnostics: [] });
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
      'cursor-agent-tree-sweep',
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

  /**
   * Both fences at once: the trees have to name a workspace this app has a team
   * for, and they have to predate this instance - anything younger belongs to a
   * launch happening right now.
   */
  it('scopes the lead tree reap to this app teams and fences it by this instance start', async () => {
    vi.clearAllMocks();
    recordSteps();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports: createPorts() });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      ownedWorkspaceCwds: OWNED_WORKSPACES,
      startedBeforeMs: APP_STARTED_AT_MS,
    });
  });

  /**
   * The negative control for the attribution. A startup that can read no team
   * config can attribute no tree, so it must reach the process table not at all
   * - the opposite reading, "no filter means everything", is a sweep that kills
   * a `cursor-agent --print` a user is running in their own terminal.
   */
  it('reaps nothing at startup when no team workspace can be read', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      listOwnedLeadWorkspaces: () => Promise.resolve([]),
      ports,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 skipped=no_owned_workspace'
    );
  });

  it('never reaps lead trees on shutdown, where every tree may be a live team', async () => {
    vi.clearAllMocks();
    recordSteps();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('shutdown'), ports: createPorts() });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
  });

  it('reaps nothing and says so when the lead tree sweep port is disabled', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();
    const disabledSweep = vi.fn();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      cursorAgentTreeSweep: { isEnabled: () => false, sweepCursorAgentTrees: disabledSweep },
      ports,
    });

    expect(disabledSweep).not.toHaveBeenCalled();
    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 skipped=sweep_disabled'
    );
  });

  /**
   * The shared runtime is released only once the hosts are gone: while one is
   * still up it is a process of this app that may yet send the runtime work.
   */
  it('releases the shared runtime after the shutdown host sweep', async () => {
    vi.clearAllMocks();
    recordSteps();
    const releaseSharedRuntime = vi.fn(async () => {
      steps.push('shared-runtime-release');
    });

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('shutdown'),
      releaseSharedRuntime,
      ports: createPorts(),
    });

    expect(steps).toEqual(['host-process-fallback', 'shared-runtime-release']);
  });

  it('never releases the shared runtime at startup, where teams are about to run', async () => {
    vi.clearAllMocks();
    recordSteps();
    const releaseSharedRuntime = vi.fn(() => Promise.resolve());

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      releaseSharedRuntime,
      ports: createPorts(),
    });

    expect(releaseSharedRuntime).not.toHaveBeenCalled();
  });

  // The port carries no default, so the common case is that no caller supplies
  // one, and that case has to be indistinguishable from before it existed.
  it('runs the same shutdown steps when no release port is supplied', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('shutdown'), ports });

    expect(steps).toEqual(['host-process-fallback']);
    expect(ports.warnings).toEqual([]);
    expect(ports.sweepResults).toEqual([]);
  });

  it('reports a failing release as a warning and still finishes the shutdown', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('shutdown'),
      releaseSharedRuntime: () => Promise.reject(new Error('runtime unreachable')),
      ports,
    });

    expect(steps).toEqual(['host-process-fallback']);
    expect(ports.warnings).toEqual([
      '[OpenCode] shutdown shared runtime release: runtime unreachable',
    ]);
  });

  it('surfaces what the lead tree sweep kept as a warning', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 2,
      killed: [8100],
      keptRecent: [8200],
      diagnostics: ['Kept cursor-agent tree pid=8200: process start time could not be verified'],
    });

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });

    expect(ports.warnings).toContain(
      '[OpenCode] startup cursor-agent sweep: Kept cursor-agent tree pid=8200: process start time could not be verified'
    );
  });
});

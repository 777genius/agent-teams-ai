import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeProcessOwnershipMarkers,
  type OpenCodeLifecycleCleanupTailInput,
  type OpenCodeLifecycleCleanupTailPorts,
  runOpenCodeLifecycleCleanupTail,
} from './OpenCodeLifecycleCleanupTail';

import type { CursorAgentAtomicReapPort } from './CursorAgentAtomicReapBridge';
import type { AttributedCursorAgentProcess } from './CursorAgentAttributionRecords';

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

const readAttributedProcesses = vi.fn<() => Promise<readonly AttributedCursorAgentProcess[]>>(() =>
  Promise.resolve([])
);

function attributedProcess(
  pid: number,
  owners: AttributedCursorAgentProcess['owners'] = []
): AttributedCursorAgentProcess {
  return {
    record: {
      schemaVersion: 1,
      kind: 'cursor-agent',
      attributionId: 'aaaa1111aaaa1111aaaa1111aaaa1111',
      pid,
      parentPid: pid - 1,
      startedAtMs: APP_STARTED_AT_MS - 60_000,
      startTimeToleranceMs: 2000,
      nativeStartToken: null,
      workspacePath: OWNED_WORKSPACES[0],
      cwd: OWNED_WORKSPACES[0],
      appInstanceId: '9100-1756803000000',
      appProfileScope: 'this-install',
      hostPid: 999,
      runtimeVersion: '0.0.95',
      writtenAtMs: APP_STARTED_AT_MS - 59_000,
      exitedAtMs: null,
    },
    host: {
      schemaVersion: 1,
      attributionId: 'aaaa1111aaaa1111aaaa1111aaaa1111',
      hostPid: 999,
      hostStartedAtNative: null,
      hostStartTimeFormat: null,
      projectPath: OWNED_WORKSPACES[0],
      appInstanceId: '9100-1756803000000',
      appProfileScope: 'this-install',
      runtimeVersion: '0.0.95',
      owners,
      updatedAt: null,
    },
    owners,
  };
}

const sweepCursorAgentTrees = vi.fn(
  (_input: { ownedWorkspaceCwds: readonly string[]; startedBeforeMs?: number | null }) =>
    Promise.resolve({
      scanned: 0,
      killed: [] as number[],
      keptRecent: [] as number[],
      incomplete: false,
      diagnostics: [] as string[],
    })
);

const reapUnleasedCursorAgentTrees =
  vi.fn<CursorAgentAtomicReapPort['reapUnleasedCursorAgentTrees']>();

beforeEach(() => {
  readAttributedProcesses.mockReset();
  readAttributedProcesses.mockResolvedValue([attributedProcess(4321)]);
  reapUnleasedCursorAgentTrees.mockReset();
});
afterEach(() => {
  expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
});

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
    cursorAgentAtomicReap: { reapUnleasedCursorAgentTrees },
    // Even an enabled legacy sweep is never consulted.
    cursorAgentTreeSweep: {
      isEnabled: () => true,
      allowsUnattributedReap: () => true,
      sweepCursorAgentTrees,
    },
    // The real port reads this install's record directory off disk; the cases
    // here say what the runtime wrote, so none of them depends on the machine.
    cursorAgentAttribution: { readAttributedProcesses: readAttributedProcesses },
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
  reapUnleasedCursorAgentTrees.mockImplementation(async () => {
    steps.push('cursor-agent-tree-sweep');
    return { contractVersion: 1, status: 'completed', killedPids: [], diagnostics: [] };
  });
}

describe('runOpenCodeLifecycleCleanupTail', () => {
  it('retains the application profile fence on the startup fallback', async () => {
    vi.clearAllMocks();
    recordSteps();
    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      profileScope: 'test-profile-scope',
      ports: createPorts(),
    });
    expect(cleanupManagedOpenCodeServeProcesses).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'orphaned', requiredProfileScope: 'test-profile-scope' })
    );
  });

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

  /**
   * The keep list a failed registry sweep did not produce is what the process
   * fallback needs to spare a live host, so that step goes. The steps behind it
   * are scoped by file age and by this app's own workspaces, so they still run:
   * the stale locks a skipped purge leaves behind are exactly what the next
   * launch queues on.
   */
  it('skips only the host fallback at startup when the registry sweep could not answer', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      registryCleanupAvailable: false,
      ports,
    });

    expect(steps).toEqual([
      'startup-runtime-sweep-tail',
      'startup-lock-purge',
      'cursor-agent-tree-sweep',
    ]);
    expect(steps).not.toContain('host-process-fallback');
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
      'opencode_cursor_agent_attribution_records sweep=startup count=1 owned=0',
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 status=completed',
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

    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      contractVersion: 1,
      reason: 'startup',
      ownedWorkspaceCwds: OWNED_WORKSPACES,
      startedBeforeMs: APP_STARTED_AT_MS,
      canDispatch: undefined,
    });
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
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

    expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 skipped=no_owned_workspace'
    );
  });

  it('reports snapshot owners but sends no snapshot authority to the runtime', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();
    const owned = attributedProcess(4321, [
      {
        teamId: 'team-1',
        teamName: 'alpha',
        laneId: 'primary',
        memberName: 'lead',
        runId: 'run-1',
        sessionId: 'session-1',
        createdAt: '2026-09-02T08:00:00.000Z',
        updatedAt: '2026-09-02T08:30:00.000Z',
      },
    ]);
    const unowned = attributedProcess(4322);
    readAttributedProcesses.mockResolvedValueOnce([owned, unowned]);

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      cursorAgentTreeSweep: {
        isEnabled: () => true,
        allowsUnattributedReap: () => false,
        sweepCursorAgentTrees,
      },
      ports,
    });

    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_attribution_records sweep=startup count=2 owned=1'
    );
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      contractVersion: 1,
      reason: 'startup',
      canDispatch: undefined,
      ownedWorkspaceCwds: OWNED_WORKSPACES,
      startedBeforeMs: APP_STARTED_AT_MS,
    });
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
  });

  /**
   * The control: against a runtime that writes no record the startup tail says
   * exactly what it said before, and - with the command-line path off - reads no
   * process table at all, which is the state this app ships in today.
   */
  it.each(['unknown-only', 'missing host', 'empty owners'])(
    'reports zero recorded owners for %s',
    async (scenario) => {
      vi.clearAllMocks();
      recordSteps();
      const ports = createPorts();
      const entry = attributedProcess(
        4321,
        scenario === 'empty owners'
          ? []
          : [
              {
                teamId: null,
                teamName: scenario === 'missing host' ? 'alpha' : null,
                laneId: null,
                memberName: null,
                runId: null,
                sessionId: null,
                createdAt: null,
                updatedAt: null,
              },
            ]
      );
      if (scenario === 'missing host') entry.host = null;
      readAttributedProcesses.mockResolvedValueOnce([entry]);

      await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });

      expect(ports.sweepResults).toContain(
        'opencode_cursor_agent_attribution_records sweep=startup count=1 owned=0'
      );
    }
  );

  it('says nothing about attribution when the runtime recorded none', async () => {
    vi.clearAllMocks();
    recordSteps();
    readAttributedProcesses.mockResolvedValueOnce([]);
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      cursorAgentTreeSweep: {
        isEnabled: () => true,
        allowsUnattributedReap: () => false,
        sweepCursorAgentTrees,
      },
      ports,
    });

    expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 skipped=no_attribution_record'
    );
    expect(ports.sweepResults.filter((entry) => entry.includes('attribution_records'))).toEqual([]);
    expect(ports.warnings).toEqual([]);
  });

  it('never reaps lead trees on shutdown, where every tree may be a live team', async () => {
    vi.clearAllMocks();
    recordSteps();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('shutdown'), ports: createPorts() });

    expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
  });

  it('ignores the deprecated local sweep switch and uses only the runtime', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();
    const disabledSweep = vi.fn();

    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      cursorAgentTreeSweep: {
        isEnabled: () => false,
        allowsUnattributedReap: () => true,
        sweepCursorAgentTrees: disabledSweep,
      },
      ports,
    });

    expect(disabledSweep).not.toHaveBeenCalled();
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledOnce();
    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_trees_reaped sweep=startup count=0 status=completed'
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
      '[OpenCode] shutdown shared runtime release failed: runtime unreachable',
    ]);
  });

  /**
   * Every step here is best effort and none is a precondition of the next. The
   * process table the first sweep reads can refuse to answer, and letting that
   * rejection leave this function took the stale-lock purge with it - the locks
   * a failed reap could not clear being exactly what the next launch then
   * queues behind.
   */
  it('runs the rest of the startup tail after the host process sweep fails', async () => {
    vi.clearAllMocks();
    recordSteps();
    cleanupManagedOpenCodeServeProcesses.mockRejectedValueOnce(
      new Error('process table unavailable')
    );
    const ports = createPorts();

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });

    expect(steps).toEqual([
      'startup-runtime-sweep-tail',
      'startup-lock-purge',
      'cursor-agent-tree-sweep',
    ]);
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledOnce();
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(ports.warnings).toEqual([
      '[OpenCode] startup fallback failed: process table unavailable',
    ]);
  });

  it('surfaces what the lead tree sweep kept as a warning', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();
    reapUnleasedCursorAgentTrees.mockResolvedValueOnce({
      contractVersion: 1,
      status: 'kept',
      killedPids: [8100],
      diagnostics: ['Kept cursor-agent tree pid=8200: process start time could not be verified'],
    });

    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });

    expect(ports.warnings).toEqual([
      '[OpenCode] startup cursor-agent sweep: Kept cursor-agent tree pid=8200: process start time could not be verified',
    ]);
    expect(ports.sweepResults).toContain(
      'opencode_cursor_agent_trees_reaped sweep=startup count=1 status=kept'
    );
  });

  it.each(['unsupported', 'unknown', 'incomplete'] as const)(
    'reports runtime %s without local fallback or retry',
    async (status) => {
      vi.clearAllMocks();
      recordSteps();
      const ports = createPorts();
      reapUnleasedCursorAgentTrees.mockResolvedValueOnce({
        contractVersion: 1,
        status,
        killedPids: [],
        diagnostics: ['runtime unavailable'],
      });
      await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });
      expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledOnce();
      expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
      expect(ports.warnings).toEqual([
        '[OpenCode] startup cursor-agent sweep: runtime unavailable',
        `[OpenCode] startup cursor-agent reap incomplete: ${status}`,
      ]);
    }
  );

  it('contains a rejected runtime port without local fallback', async () => {
    vi.clearAllMocks();
    recordSteps();
    const ports = createPorts();
    reapUnleasedCursorAgentTrees.mockRejectedValueOnce(new Error('offline'));
    await runOpenCodeLifecycleCleanupTail({ ...baseInput('startup'), ports });
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledOnce();
    expect(ports.warnings).toEqual(['[OpenCode] startup cursor-agent sweep failed: offline']);
  });

  it('rechecks startup admission after reading workspaces', async () => {
    vi.clearAllMocks();
    recordSteps();
    let admitted = true;
    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      canAdmitStartupWork: () => admitted,
      listOwnedLeadWorkspaces: async () => {
        admitted = false;
        return OWNED_WORKSPACES;
      },
      ports: createPorts(),
    });
    expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
  });

  it('forwards startup admission to the atomic port', async () => {
    vi.clearAllMocks();
    recordSteps();
    const canAdmitStartupWork = () => true;
    await runOpenCodeLifecycleCleanupTail({
      ...baseInput('startup'),
      canAdmitStartupWork,
      ports: createPorts(),
    });
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      contractVersion: 1,
      reason: 'startup',
      ownedWorkspaceCwds: OWNED_WORKSPACES,
      startedBeforeMs: APP_STARTED_AT_MS,
      canDispatch: canAdmitStartupWork,
    });
  });
});

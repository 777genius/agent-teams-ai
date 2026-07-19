import { describe, expect, it } from 'vitest';

import {
  createPreparePrimaryOwnedMemberRestartRuntimeUseCase,
  type PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts,
} from '../TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';

function createPorts(
  overrides: {
    paneRuntimeInfo?: Map<string, { panePid: number; currentCommand?: string }>;
    processCommandByPid?: (pid: number) => string | null;
    processRows?: readonly { pid: number; ppid: number; command: string }[] | null;
    lingeringPids?: number[];
    lingeringPaneIds?: string[];
    throwOnPane?: string;
    throwOnPid?: number;
    throwOnPaneWait?: Error;
  } = {}
) {
  const calls = {
    listedPaneIds: [] as string[][],
    killedPanes: [] as string[],
    killedPids: [] as number[],
    waitPidCalls: [] as Array<{ pids: readonly number[]; timeoutMs: number; pollMs: number }>,
    waitPaneCalls: [] as Array<{ paneIds: readonly string[]; timeoutMs: number; pollMs: number }>,
    info: [] as string[],
    debug: [] as string[],
    warnings: [] as string[],
    processTableReads: [] as { bypassCache: boolean }[],
  };

  const ports: PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts = {
    async listTmuxPaneRuntimeInfo(paneIds) {
      calls.listedPaneIds.push([...paneIds]);
      return overrides.paneRuntimeInfo ?? new Map();
    },
    async listRuntimeProcesses(options) {
      calls.processTableReads.push(options);
      return overrides.processRows ?? [];
    },
    readProcessCommandByPid(pid) {
      return overrides.processCommandByPid?.(pid) ?? null;
    },
    killTmuxPane(paneId) {
      calls.killedPanes.push(paneId);
      if (paneId === overrides.throwOnPane) {
        throw new Error(`pane failed ${paneId}`);
      }
    },
    killProcess(pid) {
      calls.killedPids.push(pid);
      if (pid === overrides.throwOnPid) {
        throw new Error(`pid failed ${pid}`);
      }
    },
    async waitForPidsToExit(pids, options) {
      calls.waitPidCalls.push({ pids, ...options });
      return overrides.lingeringPids ?? [];
    },
    async waitForTmuxPanesToExit(paneIds, options) {
      calls.waitPaneCalls.push({ paneIds, ...options });
      if (overrides.throwOnPaneWait) {
        throw overrides.throwOnPaneWait;
      }
      return overrides.lingeringPaneIds ?? [];
    },
    logInfo(message) {
      calls.info.push(message);
    },
    logDebug(message) {
      calls.debug.push(message);
    },
    logWarning(message) {
      calls.warnings.push(message);
    },
  };

  return { calls, ports };
}

describe('TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase', () => {
  it('ignores persisted backend types owned by unrelated members', async () => {
    const { calls, ports } = createPorts();
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [
          { name: 'Other', backendType: 'in-process' },
          { name: 'Other-2', backendType: 'process' },
        ],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: false,
    });

    expect(calls.listedPaneIds).toEqual([]);
    expect(calls.killedPanes).toEqual([]);
    expect(calls.killedPids).toEqual([]);
  });

  it('never probes an unrelated persisted tmux pane even when it contains the target command', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-other', { panePid: 400, currentCommand: 'node' }]]),
      processRows: [
        {
          pid: 401,
          ppid: 400,
          command: 'bun cli.js --team-name team-a --agent-name Worker --agent-id Worker@team-a',
        },
      ],
    });
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [
          {
            name: 'Other',
            backendType: 'tmux',
            tmuxPaneId: 'pane-other',
            runtimePid: 401,
          },
        ],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: false,
    });

    expect(calls.listedPaneIds).toEqual([]);
    expect(calls.processTableReads).toEqual([]);
    expect(calls.killedPanes).toEqual([]);
    expect(calls.waitPaneCalls).toEqual([]);
  });

  it('uses normalized target and suffixed base identities for persisted backend selection', async () => {
    const exactPorts = createPorts();
    const prepareExactRestart = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
      exactPorts.ports
    );

    await expect(
      prepareExactRestart({
        teamName: 'team-a',
        memberName: ' Worker ',
        persistedRuntimeMembers: [{ name: ' Worker ', backendType: 'process' }],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: true,
    });

    const basePorts = createPorts();
    const prepareBaseRestart = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
      basePorts.ports
    );
    await expect(
      prepareBaseRestart({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker-2', backendType: 'in-process' }],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).rejects.toThrow('Member "Worker" uses an in-process runtime and cannot be restarted here');
  });

  it('keeps an idle tmux pane reusable while stopping matching live process handles', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { panePid: 410, currentCommand: 'bash' }]]),
    });
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker', backendType: 'tmux', tmuxPaneId: ' pane-a ' }],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () =>
          new Map([
            ['Worker', { alive: true, backendType: 'process', pid: 222 }],
            ['Other', { alive: true, backendType: 'process', pid: 333 }],
          ]),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: 'pane-a',
      shouldDirectProcessRestart: true,
    });

    expect(calls.listedPaneIds).toEqual([['pane-a']]);
    expect(calls.killedPanes).toEqual([]);
    expect(calls.killedPids).toEqual([222]);
    expect(calls.waitPidCalls).toEqual([{ pids: [222], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.waitPaneCalls).toEqual([]);
  });

  it('kills and verifies stale tmux panes when no reusable shell pane is available', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { panePid: 420, currentCommand: 'node' }]]),
      processRows: [
        {
          pid: 421,
          ppid: 420,
          command: 'bun cli.js --team-name team-a --agent-name Worker --agent-id Worker@team-a',
        },
      ],
    });
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker', backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: false,
    });

    expect(calls.killedPanes).toEqual(['pane-a']);
    expect(calls.processTableReads).toEqual([{ bypassCache: true }]);
    expect(calls.waitPaneCalls).toEqual([{ paneIds: ['pane-a'], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.info).toEqual([
      '[team-a] Killed teammate pane Worker (pane-a) for manual restart',
    ]);
  });

  it('keeps a foreign pane alive when stale restart metadata points at another runtime', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { panePid: 430, currentCommand: 'node' }]]),
      processRows: [
        { pid: 431, ppid: 430, command: '/bin/zsh -l' },
        {
          pid: 432,
          ppid: 431,
          command: 'bun cli.js --team-name team-a --agent-name Other --agent-id Other@team-a',
        },
      ],
    });
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [
          { name: 'Worker', backendType: 'tmux', tmuxPaneId: 'pane-a', runtimePid: 432 },
        ],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: false,
    });

    expect(calls.killedPanes).toEqual([]);
    expect(calls.waitPaneCalls).toEqual([]);
    expect(calls.warnings).toEqual([
      expect.stringContaining('pane runtime identity does not match the exact team and member'),
    ]);
  });

  it('keeps an exact-command root pane alive when its persisted runtime pid differs', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { panePid: 440, currentCommand: 'node' }]]),
      processCommandByPid: (pid) =>
        pid === 440
          ? 'bun cli.js --team-name team-a --agent-name Worker --agent-id Worker@team-a'
          : null,
    });
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [
          { name: 'Worker', backendType: 'tmux', tmuxPaneId: 'pane-a', runtimePid: 441 },
        ],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: false,
    });

    expect(calls.killedPanes).toEqual([]);
    expect(calls.waitPaneCalls).toEqual([]);
    expect(calls.warnings).toEqual([
      expect.stringContaining('pane runtime identity does not match the exact team and member'),
    ]);
  });

  it('surfaces previous process and pane exit evidence after stop attempts', async () => {
    const processPorts = createPorts({ lingeringPids: [222] });
    const prepareProcessRestart = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
      processPorts.ports
    );

    await expect(
      prepareProcessRestart({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker', backendType: 'process' }],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () =>
          new Map([['Worker', { alive: true, backendType: 'process', pid: 222 }]]),
      })
    ).rejects.toThrow(
      'Restart for teammate "Worker" is still waiting for the previous process to exit (222).'
    );

    const panePorts = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { panePid: 450, currentCommand: 'node' }]]),
      processRows: [
        {
          pid: 451,
          ppid: 450,
          command: 'bun cli.js --team-name team-a --agent-name Worker --agent-id Worker@team-a',
        },
      ],
      lingeringPaneIds: ['pane-a'],
    });
    const preparePaneRestart = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
      panePorts.ports
    );

    await expect(
      preparePaneRestart({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker', backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).rejects.toThrow(
      'Restart for teammate "Worker" is still waiting for the previous tmux pane to exit (pane-a).'
    );
  });

  it('rejects in-process and alive-without-pid runtimes before stop attempts', async () => {
    const inProcessPorts = createPorts();
    const prepareInProcessRestart = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
      inProcessPorts.ports
    );
    let inProcessInvalidated = false;
    let inProcessLoadedRuntime = false;

    await expect(
      prepareInProcessRestart({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker', backendType: 'in-process' }],
        invalidateRuntimeSnapshotCaches: () => {
          inProcessInvalidated = true;
        },
        loadLiveRuntimeByMember: async () => {
          inProcessLoadedRuntime = true;
          return new Map();
        },
      })
    ).rejects.toThrow('Member "Worker" uses an in-process runtime and cannot be restarted here');
    expect(inProcessInvalidated).toBe(false);
    expect(inProcessLoadedRuntime).toBe(false);
    expect(inProcessPorts.calls.killedPanes).toEqual([]);
    expect(inProcessPorts.calls.killedPids).toEqual([]);

    const noPidPorts = createPorts();
    const prepareNoPidRestart = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
      noPidPorts.ports
    );

    await expect(
      prepareNoPidRestart({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () =>
          new Map([['Worker', { alive: true, backendType: 'process' }]]),
      })
    ).rejects.toThrow(
      'Member "Worker" is running, but its backend does not expose a restartable pid yet'
    );
    expect(noPidPorts.calls.killedPanes).toEqual([]);
    expect(noPidPorts.calls.killedPids).toEqual([]);
  });

  it('honors stale-run guards after live runtime loading before stop attempts', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { panePid: 460, currentCommand: 'node' }]]),
    });
    const prepareRestartRuntime = createPreparePrimaryOwnedMemberRestartRuntimeUseCase(ports);
    let current = true;

    await expect(
      prepareRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [{ name: 'Worker', backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        assertStillCurrent: () => {
          if (!current) {
            throw new Error('stale run');
          }
        },
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => {
          current = false;
          return new Map([['Worker', { alive: true, backendType: 'process', pid: 222 }]]);
        },
      })
    ).rejects.toThrow('stale run');

    expect(calls.listedPaneIds).toEqual([]);
    expect(calls.killedPanes).toEqual([]);
    expect(calls.killedPids).toEqual([]);
    expect(calls.waitPidCalls).toEqual([]);
    expect(calls.waitPaneCalls).toEqual([]);
  });
});

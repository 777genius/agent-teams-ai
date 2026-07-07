import { describe, expect, it } from 'vitest';

import {
  createPreparePrimaryOwnedMemberRestartRuntimeUseCase,
  type PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts,
} from '../TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';

function createPorts(
  overrides: {
    paneRuntimeInfo?: Map<string, { currentCommand?: string }>;
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
  };

  const ports: PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts = {
    async listTmuxPaneRuntimeInfo(paneIds) {
      calls.listedPaneIds.push([...paneIds]);
      return overrides.paneRuntimeInfo ?? new Map();
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
  };

  return { calls, ports };
}

describe('TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase', () => {
  it('keeps an idle tmux pane reusable while stopping matching live process handles', async () => {
    const { calls, ports } = createPorts({
      paneRuntimeInfo: new Map([['pane-a', { currentCommand: 'bash' }]]),
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
      paneRuntimeInfo: new Map([['pane-a', { currentCommand: 'node' }]]),
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
    expect(calls.waitPaneCalls).toEqual([{ paneIds: ['pane-a'], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.info).toEqual([
      '[team-a] Killed teammate pane Worker (pane-a) for manual restart',
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

    const panePorts = createPorts({ lingeringPaneIds: ['pane-a'] });
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
});

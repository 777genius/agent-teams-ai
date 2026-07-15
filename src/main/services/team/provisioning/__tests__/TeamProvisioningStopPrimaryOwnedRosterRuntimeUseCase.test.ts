import { describe, expect, it } from 'vitest';

import { createStopPrimaryOwnedRosterRuntimeUseCase } from '../TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';

function createPorts(
  overrides: {
    alivePids?: readonly number[];
    lingeringPids?: number[];
    lingeringPaneIds?: string[];
    paneInfo?: ReadonlyMap<string, { panePid: number }>;
    processCommandByPid?: (pid: number) => string | null;
    processRows?: readonly { pid: number; ppid: number; command: string }[] | null;
    throwOnPane?: string;
    throwOnPid?: number;
  } = {}
) {
  const calls = {
    killedPanes: [] as string[],
    killedPids: [] as number[],
    waitPidCalls: [] as Array<{ pids: readonly number[]; timeoutMs: number; pollMs: number }>,
    waitPaneCalls: [] as Array<{ paneIds: readonly string[]; timeoutMs: number; pollMs: number }>,
    debug: [] as string[],
    warnings: [] as string[],
    paneInfoReads: [] as string[][],
    processTableReads: [] as { bypassCache: boolean }[],
  };

  const alivePids = new Set(overrides.alivePids ?? []);

  return {
    calls,
    ports: {
      isProcessAlive(pid: number) {
        return alivePids.has(pid);
      },
      readProcessCommandByPid(pid: number) {
        return (
          overrides.processCommandByPid?.(pid) ??
          'bun cli.js --team-name team-a --agent-name Worker --agent-id Worker@team-a'
        );
      },
      async listTmuxPaneRuntimeInfo(paneIds: readonly string[]) {
        calls.paneInfoReads.push([...paneIds]);
        return (
          overrides.paneInfo ??
          new Map(paneIds.map((paneId, index) => [paneId, { panePid: 900 + index }]))
        );
      },
      async listRuntimeProcesses(options: { bypassCache: boolean }) {
        calls.processTableReads.push(options);
        return overrides.processRows ?? [];
      },
      killTmuxPane(paneId: string) {
        calls.killedPanes.push(paneId);
        if (paneId === overrides.throwOnPane) {
          throw new Error(`pane failed ${paneId}`);
        }
      },
      killProcess(pid: number) {
        calls.killedPids.push(pid);
        if (pid === overrides.throwOnPid) {
          throw new Error(`pid failed ${pid}`);
        }
      },
      async waitForPidsToExit(
        pids: readonly number[],
        options: { timeoutMs: number; pollMs: number }
      ) {
        calls.waitPidCalls.push({ pids, ...options });
        return overrides.lingeringPids ?? [];
      },
      async waitForTmuxPanesToExit(
        paneIds: readonly string[],
        options: { timeoutMs: number; pollMs: number }
      ) {
        calls.waitPaneCalls.push({ paneIds, ...options });
        return overrides.lingeringPaneIds ?? [];
      },
      logDebug(message: string) {
        calls.debug.push(message);
      },
      logWarning(message: string) {
        calls.warnings.push(message);
      },
    },
  };
}

describe('TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase', () => {
  it('stops persisted and live primary-owned runtime handles through narrow ports', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await stopPrimaryOwnedRosterRuntime({
      teamName: 'team-a',
      memberName: 'Worker',
      actionLabel: 'Detach for teammate "Worker"',
      persistedRuntimeMembers: [
        { backendType: 'process', runtimePid: 111 },
        { backendType: 'tmux', tmuxPaneId: ' pane-a ' },
      ],
      liveRuntimeByMember: new Map([
        [
          'Worker',
          {
            alive: true,
            backendType: 'tmux',
            tmuxPaneId: 'pane-b',
            pid: 222,
            metricsPid: 333,
          },
        ],
        ['Other', { alive: true, backendType: 'process', pid: 444 }],
      ]),
    });

    expect(calls.killedPanes).toEqual(['pane-a', 'pane-b']);
    expect(calls.killedPids).toEqual([111, 222, 333]);
    expect(calls.waitPidCalls).toEqual([{ pids: [111, 222, 333], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.waitPaneCalls).toEqual([
      { paneIds: ['pane-a', 'pane-b'], timeoutMs: 1_500, pollMs: 100 },
    ]);
  });

  it('logs stop-handle kill failures and still waits for collected handles', async () => {
    const { calls, ports } = createPorts({ throwOnPane: 'pane-a', throwOnPid: 111 });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await stopPrimaryOwnedRosterRuntime({
      teamName: 'team-a',
      memberName: 'Worker',
      actionLabel: 'Update for teammate "Worker"',
      persistedRuntimeMembers: [
        { backendType: 'process', runtimePid: 111 },
        { backendType: 'tmux', tmuxPaneId: 'pane-a' },
      ],
      liveRuntimeByMember: new Map(),
    });

    expect(calls.waitPidCalls).toEqual([{ pids: [111], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.waitPaneCalls).toEqual([{ paneIds: ['pane-a'], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.debug).toEqual([
      expect.stringContaining('Failed to stop teammate pane Worker pane-a'),
      expect.stringContaining('Failed to stop teammate process Worker pid=111'),
    ]);
  });

  it('rejects alive runtime metadata without a pid or tmux pane', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [],
        liveRuntimeByMember: new Map([['Worker', { alive: true, backendType: 'process' }]]),
      })
    ).rejects.toThrow(
      'Detach for teammate "Worker" cannot stop the existing runtime because it does not expose a pid or tmux pane.'
    );
    expect(calls.killedPanes).toEqual([]);
    expect(calls.killedPids).toEqual([]);
  });

  it('refuses a recycled persisted pid whose command belongs to another runtime', async () => {
    const { calls, ports } = createPorts({
      alivePids: [111],
      processCommandByPid: () => 'node unrelated.js --team-name another-team --agent-name Worker',
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow('does not expose a pid or tmux pane');

    expect(calls.killedPids).toEqual([]);
    expect(calls.waitPidCalls).toEqual([]);
    expect(calls.warnings).toEqual([
      expect.stringContaining('process identity does not match the exact team and member'),
    ]);
  });

  it('refuses a persisted tmux pane whose descendant belongs to another member', async () => {
    const { calls, ports } = createPorts({
      paneInfo: new Map([['pane-a', { panePid: 420 }]]),
      processCommandByPid: () => '/bin/zsh',
      processRows: [
        { pid: 421, ppid: 420, command: '/bin/zsh -l' },
        {
          pid: 422,
          ppid: 421,
          command: 'bun cli.js --team-name team-a --agent-name Other --agent-id Other@team-a',
        },
      ],
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        ]),
      })
    ).rejects.toThrow('does not expose a pid or tmux pane');

    expect(calls.killedPanes).toEqual([]);
    expect(calls.processTableReads).toEqual([{ bypassCache: true }]);
    expect(calls.warnings).toEqual([
      expect.stringContaining('pane runtime identity does not match the exact team and member'),
    ]);
  });

  it('stops a persisted tmux pane with an exact teammate descendant', async () => {
    const { calls, ports } = createPorts({
      paneInfo: new Map([['pane-a', { panePid: 430 }]]),
      processCommandByPid: () => '/bin/zsh',
      processRows: [
        { pid: 431, ppid: 430, command: '/bin/zsh -l' },
        {
          pid: 432,
          ppid: 431,
          command: 'bun cli.js --team-name team-a --agent-id Worker@team-a',
        },
      ],
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a', runtimePid: 432 }],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        ]),
      })
    ).resolves.toBeUndefined();

    expect(calls.killedPanes).toEqual(['pane-a']);
    expect(calls.waitPaneCalls).toEqual([{ paneIds: ['pane-a'], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.processTableReads).toEqual([{ bypassCache: true }]);
  });

  it('stops killable handles when another matching live runtime is handle-less', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'process' }],
          ['Worker-2', { alive: true, backendType: 'process', pid: 222 }],
        ]),
      })
    ).resolves.toBeUndefined();

    expect(calls.killedPids).toEqual([222]);
    expect(calls.waitPidCalls).toEqual([{ pids: [222], timeoutMs: 1_500, pollMs: 100 }]);
  });

  it('surfaces lingering process and pane evidence after stop attempts', async () => {
    const processPorts = createPorts({ lingeringPids: [111] });
    const stopProcessRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(processPorts.ports);

    await expect(
      stopProcessRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow('Detach for teammate "Worker" is still waiting for process exit (111).');

    const panePorts = createPorts({ lingeringPaneIds: ['pane-a'] });
    const stopPaneRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(panePorts.ports);

    await expect(
      stopPaneRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow('Detach for teammate "Worker" is still waiting for tmux pane exit (pane-a).');
  });
});

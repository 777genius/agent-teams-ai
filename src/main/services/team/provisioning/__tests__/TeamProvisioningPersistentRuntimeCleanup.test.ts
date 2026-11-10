import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { killProcessByPid } from '@main/utils/processKill';
import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningPersistentRuntimeCleanup } from '../TeamProvisioningPersistentRuntimeCleanup';
import { stopTeamFlow, type TeamProvisioningStopTeamPorts } from '../TeamProvisioningStopFlow';
import { killOrphanedTeamAgentProcesses } from '../TeamProvisioningStopProcessCleanup';

import type { PersistentRuntimeStopVerdict } from '../TeamProvisioningPersistentRuntimeCleanup';
import type { PersistedRuntimeMemberLike } from '../TeamProvisioningRuntimeSnapshot';

type Ports = Parameters<typeof createTeamProvisioningPersistentRuntimeCleanup>[0];

function createPorts(overrides: Partial<Ports> = {}): Ports {
  return {
    readPersistedRuntimeMembers: vi.fn((): PersistedRuntimeMemberLike[] => []),
    killPersistedPaneMembers: vi.fn(() => ({ confirmed: true })),
    killOrphanedTeamAgentProcesses: vi.fn(() => ({ confirmed: true })),
    getCurrentRunPid: vi.fn(() => 123),
    cleanupAnthropicTeamApiKeyHelperForTeam: vi.fn(async () => undefined),
    getClaudeBasePath: vi.fn(() => '/claude'),
    sleep: vi.fn(async () => undefined),
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('TeamProvisioningPersistentRuntimeCleanup', () => {
  it('cleans persisted panes and orphaned agent processes for a stopped team', () => {
    const members = [{ name: 'Worker', tmuxPaneId: '%1', backendType: 'tmux' }];
    const ports = createPorts({
      readPersistedRuntimeMembers: vi.fn(() => members as PersistedRuntimeMemberLike[]),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);

    expect(ports.killPersistedPaneMembers).toHaveBeenCalledWith('team-a', members);
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123, []);
  });

  it('clears leftover live runtime handles in the awaited stopped-team cleanup', async () => {
    const clearPersistedLiveRuntimeHandles = vi.fn(() => true);
    const ports = createPorts({ clearPersistedLiveRuntimeHandles });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);
    expect(clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
    await cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');
    expect(clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith('team-a');
  });

  it('still cleans orphaned agent processes when no persisted panes exist', () => {
    const ports = createPorts();
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);

    expect(ports.killPersistedPaneMembers).not.toHaveBeenCalled();
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123, []);
  });

  it('reports unconfirmed persistent cleanup when any owned process stop fails', () => {
    const members = [{ name: 'Worker', tmuxPaneId: '%1', backendType: 'tmux' }];
    const clearPersistedLiveRuntimeHandles = vi.fn(() => true);
    const ports = createPorts({
      readPersistedRuntimeMembers: vi.fn(() => members as PersistedRuntimeMemberLike[]),
      killPersistedPaneMembers: vi.fn(() => ({
        confirmed: false,
        reason: 'pane_kill_failed' as const,
      })),
      clearPersistedLiveRuntimeHandles,
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123, []);
    expect(clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
  });

  it('still reports confirmed Stop when clearing persisted live runtime handles throws', async () => {
    const clearPersistedLiveRuntimeHandles = vi.fn(() => {
      throw new Error('File lock timeout');
    });
    const ports = createPorts({ clearPersistedLiveRuntimeHandles });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);
    await cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');
    expect(clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith('team-a');
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to clear persisted live runtime handles: File lock timeout'
    );
  });

  it('uses the configured Claude base path for Anthropic helper cleanup', async () => {
    const ports = createPorts();
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    await cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');

    expect(ports.cleanupAnthropicTeamApiKeyHelperForTeam).toHaveBeenCalledWith({
      teamName: 'team-a',
      baseClaudeDir: '/claude',
    });
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('logs and propagates Anthropic helper cleanup failures to the stop caller', async () => {
    const ports = createPorts({
      cleanupAnthropicTeamApiKeyHelperForTeam: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    await expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).rejects.toThrow('permission denied');

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to cleanup Anthropic team API-key helper material: permission denied'
    );
  });

  it('awaits durable native terminal facts before clearing discovery or helper material', async () => {
    let finish!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ports = createPorts({
      confirmNativeTeamStopped: vi.fn(() => persisted),
      clearPersistedLiveRuntimeHandles: vi.fn(() => true),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);
    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);
    const completing = cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');
    expect(ports.confirmNativeTeamStopped).toHaveBeenCalledWith('team-a');
    expect(ports.clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicTeamApiKeyHelperForTeam).not.toHaveBeenCalled();
    finish();
    await completing;
    expect(ports.clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith('team-a');
    expect(ports.cleanupAnthropicTeamApiKeyHelperForTeam).toHaveBeenCalled();
  });

  it('preserves discovery on terminal persistence failure and retries before cleanup', async () => {
    const ports = createPorts({
      confirmNativeTeamStopped: vi
        .fn()
        .mockRejectedValueOnce(new Error('ledger write failed'))
        .mockResolvedValue(undefined),
      clearPersistedLiveRuntimeHandles: vi.fn(() => true),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);
    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);
    await expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).rejects.toThrow('ledger write failed');
    expect(ports.clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicTeamApiKeyHelperForTeam).not.toHaveBeenCalled();
    await cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');
    expect(ports.confirmNativeTeamStopped).toHaveBeenCalledTimes(2);
    expect(ports.clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith('team-a');
  });

  it('confirms termination at cleanup once the explicit stop settled the dispatch-time leftovers', async () => {
    const killOrphanedTeamAgentProcesses = vi
      .fn()
      .mockReturnValueOnce({ confirmed: false, reason: 'live_agent_processes' as const })
      .mockReturnValueOnce({ confirmed: true });
    const confirmNativeTeamStopped = vi.fn(async () => undefined);
    const clearPersistedLiveRuntimeHandles = vi.fn(() => true);
    const ports = createPorts({
      killOrphanedTeamAgentProcesses,
      confirmNativeTeamStopped,
      clearPersistedLiveRuntimeHandles,
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
    await expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).resolves.toBeUndefined();

    expect(killOrphanedTeamAgentProcesses).toHaveBeenCalledTimes(2);
    expect(confirmNativeTeamStopped).toHaveBeenCalledWith('team-a');
    expect(clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith('team-a');
  });

  it('skips settled pane kills during the settle re-check', async () => {
    const members = [{ name: 'Worker', tmuxPaneId: '%1', backendType: 'tmux' }];
    const killPersistedPaneMembers = vi.fn(() => ({ confirmed: true }));
    const killOrphanedTeamAgentProcesses = vi
      .fn()
      .mockReturnValueOnce({ confirmed: false, reason: 'live_agent_processes' as const })
      .mockReturnValueOnce({ confirmed: true });
    const ports = createPorts({
      readPersistedRuntimeMembers: vi.fn(() => members as PersistedRuntimeMemberLike[]),
      killPersistedPaneMembers,
      killOrphanedTeamAgentProcesses,
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
    await expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).resolves.toBeUndefined();

    // The pane kill settled on the first pass; a replay would report a false
    // pane_kill_failed for an already-gone pane and starve the re-checks.
    expect(killPersistedPaneMembers).toHaveBeenCalledTimes(1);
    expect(killOrphanedTeamAgentProcesses).toHaveBeenCalledTimes(2);
    expect(killOrphanedTeamAgentProcesses).toHaveBeenLastCalledWith('team-a', 123, [], {
      isRecheck: true,
    });
  });

  it('cannot publish terminal facts or clear discovery after an unconfirmed stop', async () => {
    const ports = createPorts({
      killOrphanedTeamAgentProcesses: vi.fn(() => ({
        confirmed: false,
        reason: 'live_agent_processes' as const,
      })),
      confirmNativeTeamStopped: vi.fn(async () => undefined),
      clearPersistedLiveRuntimeHandles: vi.fn(() => true),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);
    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
    await expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).rejects.toThrow(
      '[team-a] Persistent runtime termination could not be confirmed: live_agent_processes'
    );
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledTimes(5);
    expect(ports.confirmNativeTeamStopped).not.toHaveBeenCalled();
    expect(ports.clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicTeamApiKeyHelperForTeam).not.toHaveBeenCalled();
  });

  it('passes recorded runtime pids to the process stop so exit is provable', () => {
    const members = [
      { name: 'Worker', tmuxPaneId: '%1', backendType: 'tmux', runtimePid: 51 },
      { name: 'Solo', runtimePid: 52 },
    ];
    const ports = createPorts({
      readPersistedRuntimeMembers: vi.fn(() => members as PersistedRuntimeMemberLike[]),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);

    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123, [51, 52]);
  });

  it('takes recorded runtime pids from launch discovery when config members carry none', () => {
    const members = [{ name: 'Worker', tmuxPaneId: '%1', backendType: 'tmux' }, { name: 'Solo' }];
    const ports = createPorts({
      readPersistedRuntimeMembers: vi.fn(() => members as PersistedRuntimeMemberLike[]),
      readRecordedRuntimePids: vi.fn(() => [51, 52]),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);

    expect(ports.readRecordedRuntimePids).toHaveBeenCalledWith('team-a');
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123, [51, 52]);
  });

  it.each(['live_agent_processes', 'process_table_unreadable'] as const)(
    'settles dispatched kills before declaring the stop unconfirmed (%s)',
    async (reason) => {
      const killOrphanedTeamAgentProcesses = vi
        .fn((): PersistentRuntimeStopVerdict => ({ confirmed: true }))
        .mockReturnValueOnce({ confirmed: false, reason })
        .mockReturnValueOnce({ confirmed: false, reason })
        .mockReturnValueOnce({ confirmed: true });
      const confirmNativeTeamStopped = vi.fn(async () => undefined);
      const clearPersistedLiveRuntimeHandles = vi.fn(() => true);
      const ports = createPorts({
        killOrphanedTeamAgentProcesses,
        confirmNativeTeamStopped,
        clearPersistedLiveRuntimeHandles,
      });
      const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

      expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
      await expect(
        cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
      ).resolves.toBeUndefined();

      expect(killOrphanedTeamAgentProcesses).toHaveBeenCalledTimes(3);
      expect(confirmNativeTeamStopped).toHaveBeenCalledWith('team-a');
      expect(clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith('team-a');
    }
  );

  it('retains an outstanding descendant receipt across repeated Stop until its captured child exits', async () => {
    let childAlive = true;
    const confirmStopped = vi.fn(async () => !childAlive);
    const stopNewProcesses = vi.fn();
    const killOrphaned = vi
      .fn<Ports['killOrphanedTeamAgentProcesses']>()
      .mockReturnValueOnce({ confirmStopped, stopNewProcesses })
      .mockReturnValue({ confirmed: true }); // Root is now gone: rediscovery alone would falsely confirm.
    const confirmNativeTeamStopped = vi.fn(async () => undefined);
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(
      createPorts({
        killOrphanedTeamAgentProcesses: killOrphaned,
        confirmNativeTeamStopped,
      })
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
      await expect(
        cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
      ).rejects.toThrow('termination could not be confirmed');
    }
    expect(killOrphaned).toHaveBeenCalledTimes(1);
    expect(confirmNativeTeamStopped).not.toHaveBeenCalled();
    childAlive = false;
    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
    await cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');
    expect(killOrphaned).toHaveBeenCalledTimes(1);
    expect(confirmNativeTeamStopped).toHaveBeenCalledTimes(1);
    expect(stopNewProcesses.mock.calls).toEqual([[123], [123]]);
  });

  it('does not replace a newer stop receipt with a delayed earlier confirmation', async () => {
    let release!: (confirmed: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const ports = createPorts({
      killOrphanedTeamAgentProcesses: vi.fn(() => ({
        confirmStopped: () => pending,
        stopNewProcesses: vi.fn(),
      })),
      confirmNativeTeamStopped: vi.fn(async () => undefined),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);
    cleanup.stopPersistentTeamMembers('team-a');
    const finalizing = expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).rejects.toThrow('stop ownership changed');
    cleanup.stopPersistentTeamMembers('team-a');
    release(true);
    await finalizing;
    expect(ports.confirmNativeTeamStopped).not.toHaveBeenCalled();
  });

  it('does not clear discovery or delete a newer receipt after terminal persistence awaited', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const confirmNativeTeamStopped = vi
      .fn(async (): Promise<void> => undefined)
      .mockReturnValueOnce(persisted);
    const clearPersistedLiveRuntimeHandles = vi.fn(() => true);
    const ports = createPorts({ confirmNativeTeamStopped, clearPersistedLiveRuntimeHandles });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);
    cleanup.stopPersistentTeamMembers('team-a');
    const finalizing = expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).rejects.toThrow('stop ownership changed');
    cleanup.stopPersistentTeamMembers('team-a');
    release();
    await finalizing;
    expect(clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
    await cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a');
    expect(confirmNativeTeamStopped).toHaveBeenCalledTimes(2);
    expect(clearPersistedLiveRuntimeHandles).toHaveBeenCalledTimes(1);
  });

  it('preserves an unconfirmed tmux stop even when native process confirmation is available', async () => {
    const confirmStopped = vi.fn(async () => true);
    const ports = createPorts({
      readPersistedRuntimeMembers: () => [
        { name: 'worker', tmuxPaneId: '%1', backendType: 'tmux' },
      ],
      killPersistedPaneMembers: () => ({ confirmed: false, reason: 'pane_kill_failed' as const }),
      killOrphanedTeamAgentProcesses: () => ({ confirmStopped, stopNewProcesses: vi.fn() }),
      confirmNativeTeamStopped: vi.fn(async () => undefined),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);
    cleanup.stopPersistentTeamMembers('team-a');
    await expect(
      cleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam('team-a')
    ).rejects.toThrow('could not be confirmed');
    expect(confirmStopped).not.toHaveBeenCalled();
    expect(ports.confirmNativeTeamStopped).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('wired owned native Stop confirmation', () => {
  it('confirms a captured native teammate after it exits without replaying its signal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-owned-native-stop-'));
    const teamName = `TEST-native-stop-${path.basename(directory)}`;
    const script = path.join(directory, 'worker.ts');
    await fs.writeFile(
      script,
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));\nprocess.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n"
    );
    const child = spawn(
      process.execPath,
      [script, '--team-name', teamName, '--agent-id', `bob@${teamName}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const exited = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      const killPid = vi.fn((pid: number) => killProcessByPid(pid));
      const confirmNativeTeamStopped = vi.fn(async () => undefined);
      const clearPersistedLiveRuntimeHandles = vi.fn(() => true);
      const persistent = createTeamProvisioningPersistentRuntimeCleanup(
        createPorts({
          getCurrentRunPid: () => undefined,
          killOrphanedTeamAgentProcesses: (name) =>
            killOrphanedTeamAgentProcesses(
              { teamName: name, logger: { info: vi.fn(), debug: vi.fn() } },
              { killPid }
            ),
          confirmNativeTeamStopped,
          clearPersistedLiveRuntimeHandles,
        })
      );
      const run = {
        runId: 'run-owned',
        teamName,
        anthropicApiKeyHelper: null,
        processKilled: false,
        cancelRequested: false,
        child: null,
        onProgress: vi.fn(),
      };
      const ports: TeamProvisioningStopTeamPorts<typeof run> = {
        cancelOpenCodePromptDeliveries: vi.fn(async () => undefined),
        invalidateRuntimeSnapshotCaches: vi.fn(),
        pauseActiveIntervalsForTeam: vi.fn(),
        stopPersistentTeamMembers: (name) => {
          persistent.stopPersistentTeamMembers(name);
        },
        openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
        getTrackedRunId: () => run.runId,
        getAliveRunId: () => run.runId,
        runs: new Map([[run.runId, run]]),
        runtimeAdapterProgressByRunId: new Map(),
        isCancellableRuntimeAdapterProgress: () => false,
        cancelRuntimeAdapterProvisioning: vi.fn(async () => undefined),
        cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (name) =>
          persistent.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(name),
        runtimeAdapterRunByTeam: new Map(),
        withTeamLock: async (_name, operation) => operation(),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
        hasSecondaryRuntimeRuns: () => false,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        provisioningRunByTeam: new Map([[teamName, run.runId]]),
        deleteAliveRunId: vi.fn(),
        killTeamProcess: vi.fn(),
        killTeamProcessAndWait: async () => {
          await exited;
        },
        updateProgress: (_run, state, message) => ({
          runId: run.runId,
          teamName,
          state,
          message,
          startedAt: '',
          updatedAt: '',
        }),
        cleanupRun: vi.fn(),
        cleanupRunOwnedAnthropicApiKeyHelper: vi.fn(async () => undefined),
        logger: { info: vi.fn() },
      };
      await expect(stopTeamFlow(teamName, ports)).resolves.toBeUndefined();
      expect(killPid.mock.calls).toEqual([[child.pid]]);
      expect(child.exitCode).toBe(0);
      expect(confirmNativeTeamStopped).toHaveBeenCalledWith(teamName);
      expect(clearPersistedLiveRuntimeHandles).toHaveBeenCalledWith(teamName);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningPersistentRuntimeCleanup } from '../TeamProvisioningPersistentRuntimeCleanup';

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
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123);
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
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123);
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
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123);
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
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledTimes(2);
    expect(ports.confirmNativeTeamStopped).not.toHaveBeenCalled();
    expect(ports.clearPersistedLiveRuntimeHandles).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicTeamApiKeyHelperForTeam).not.toHaveBeenCalled();
  });
});

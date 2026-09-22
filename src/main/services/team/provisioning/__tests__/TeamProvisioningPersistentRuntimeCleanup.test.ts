import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningPersistentRuntimeCleanup } from '../TeamProvisioningPersistentRuntimeCleanup';

import type { PersistedRuntimeMemberLike } from '../TeamProvisioningRuntimeSnapshot';

type Ports = Parameters<typeof createTeamProvisioningPersistentRuntimeCleanup>[0];

function createPorts(overrides: Partial<Ports> = {}): Ports {
  return {
    readPersistedRuntimeMembers: vi.fn((): PersistedRuntimeMemberLike[] => []),
    killPersistedPaneMembers: vi.fn(() => true),
    killOrphanedTeamAgentProcesses: vi.fn(() => true),
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

  it('still cleans orphaned agent processes when no persisted panes exist', () => {
    const ports = createPorts();
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(true);

    expect(ports.killPersistedPaneMembers).not.toHaveBeenCalled();
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123);
  });

  it('reports unconfirmed persistent cleanup when any owned process stop fails', () => {
    const members = [{ name: 'Worker', tmuxPaneId: '%1', backendType: 'tmux' }];
    const ports = createPorts({
      readPersistedRuntimeMembers: vi.fn(() => members as PersistedRuntimeMemberLike[]),
      killPersistedPaneMembers: vi.fn(() => false),
    });
    const cleanup = createTeamProvisioningPersistentRuntimeCleanup(ports);

    expect(cleanup.stopPersistentTeamMembers('team-a')).toBe(false);
    expect(ports.killOrphanedTeamAgentProcesses).toHaveBeenCalledWith('team-a', 123);
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
});

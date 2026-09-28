import { describe, expect, it } from 'vitest';

import { HostedCreateTaskSession } from '@features/team-task-board/renderer/hosted';
import { createHostedCreateSessionRegistry } from '@renderer/hosted/hostedCreateSessionRegistry';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

describe('hosted create session authority', () => {
  it('retains an intent for the same authority and disposes it after confirmed replacement', () => {
    const workspaceId = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
    const teamId = parseTeamId(`team_${'b'.repeat(32)}`);
    const scope = { key: `${workspaceId}:${teamId}`, authorityEpoch: 'deployment:boot:1' };
    const registry = createHostedCreateSessionRegistry();
    const session = registry.getOrCreate(scope, () => new HostedCreateTaskSession(scope, teamId));

    registry.reconcileAuthorities([{ workspaceId, epoch: scope.authorityEpoch }]);
    expect(registry.getOrCreate(scope, () => new HostedCreateTaskSession(scope, teamId))).toBe(session);

    registry.reconcileAuthorities([{ workspaceId, epoch: 'deployment:new-boot:1' }]);
    expect(session.controller.getSnapshot().phase).toBe('disposed');
  });
});

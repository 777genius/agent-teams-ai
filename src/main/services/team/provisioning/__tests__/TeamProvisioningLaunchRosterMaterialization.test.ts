import { describe, expect, it, vi } from 'vitest';

import {
  materializeTeamProvisioningLaunchRoster,
  type TeamProvisioningLaunchRosterInput,
  type TeamProvisioningLaunchRosterPorts,
} from '../TeamProvisioningLaunchRosterMaterialization';
import { resolveRuntimeRecipientProviderIdFromSources } from '../TeamProvisioningRuntimeRecipientResolution';

import type { TeamConfig, TeamMember } from '@shared/types';

function createHarness() {
  const state = {
    current: true,
    raw: JSON.stringify({
      leadSessionId: 'lead-session',
      members: [
        { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' },
        { name: 'haiku', providerId: 'anthropic', model: 'claude-haiku-4-5' },
      ],
    }),
    meta: [{ name: 'opencode-worker', providerId: 'opencode' }] as TeamMember[],
    beforeWrite: () => {},
  };
  const input: TeamProvisioningLaunchRosterInput = {
    teamName: 'sandbox-mixed',
    members: [
      { name: 'haiku', role: 'Native', providerId: 'anthropic' },
      { name: 'opencode-worker', role: 'Worker', providerId: 'opencode', model: 'openai/gpt-5' },
    ],
    isCurrentRun: () => state.current,
  };
  const ports: TeamProvisioningLaunchRosterPorts = {
    readConfig: vi.fn(async () => state.raw),
    readMetaMembers: vi.fn(async () => state.meta),
    writeConfig: vi.fn(async (raw, beforeCommit) => {
      state.beforeWrite();
      await beforeCommit();
      state.raw = raw;
    }),
    invalidateTeam: vi.fn(),
    now: () => 123,
  };
  return { state, input, ports };
}

describe('TeamProvisioningLaunchRosterMaterialization', () => {
  it('makes a bootstrap-complete mixed roster authoritative before the first lead result', async () => {
    const { state, input, ports } = createHarness();
    const resolve = () =>
      resolveRuntimeRecipientProviderIdFromSources({
        memberName: 'opencode-worker',
        config: JSON.parse(state.raw) as TeamConfig,
        metaMembers: state.meta,
      });
    expect(resolve).toThrow('no authoritative config identity');
    expect(await materializeTeamProvisioningLaunchRoster(input, ports)).toBe(true);
    expect(resolve()).toBe('opencode');
    expect(JSON.parse(state.raw)).toMatchObject({
      leadSessionId: 'lead-session',
      members: [
        { name: 'team-lead', providerId: 'anthropic' },
        { name: 'haiku', providerId: 'anthropic', model: 'claude-haiku-4-5' },
        {
          name: 'opencode-worker',
          agentId: 'opencode-worker@sandbox-mixed',
          providerId: 'opencode',
          model: 'openai/gpt-5',
        },
      ],
    });
    expect(ports.invalidateTeam).toHaveBeenCalledWith('sandbox-mixed');
    expect(await materializeTeamProvisioningLaunchRoster(input, ports)).toBe(true);
    expect(ports.writeConfig).toHaveBeenCalledTimes(1);
  });

  it('materializes create-team lanes even before members metadata is first persisted', async () => {
    const { state, input, ports } = createHarness();
    state.meta = [];
    expect(await materializeTeamProvisioningLaunchRoster(input, ports)).toBe(true);
    expect(JSON.parse(state.raw).members).toHaveLength(3);
  });

  it.each(['config', 'metadata'])('preserves a removed member tombstone in %s', async (source) => {
    const { state, input, ports } = createHarness();
    const removed = { name: 'OPENCODE-WORKER', removedAt: 456 };
    if (source === 'metadata') state.meta.push(removed);
    else {
      const config = JSON.parse(state.raw);
      config.members.push(removed);
      state.raw = JSON.stringify(config);
    }
    const original = state.raw;
    expect(await materializeTeamProvisioningLaunchRoster(input, ports)).toBe(false);
    expect(state.raw).toBe(original);
    expect(ports.writeConfig).not.toHaveBeenCalled();
  });

  it('does not read or write for an already cancelled or superseded run', async () => {
    const { state, input, ports } = createHarness();
    state.current = false;
    expect(await materializeTeamProvisioningLaunchRoster(input, ports)).toBe(false);
    expect(ports.readConfig).not.toHaveBeenCalled();
    expect(ports.writeConfig).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'config-changed', 'removed'])(
    'aborts atomic publication when the launch becomes %s during the write',
    async (change) => {
      const { state, input, ports } = createHarness();
      state.beforeWrite = () => {
        if (change === 'cancelled') state.current = false;
        if (change === 'config-changed') state.raw = JSON.stringify({ members: [] });
        if (change === 'removed') state.meta[0].removedAt = 456;
      };
      await expect(materializeTeamProvisioningLaunchRoster(input, ports)).rejects.toThrow(
        'roster changed before config commit'
      );
      expect(JSON.parse(state.raw).members).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: 'opencode-worker@sandbox-mixed' }),
        ])
      );
      expect(ports.invalidateTeam).not.toHaveBeenCalled();
    }
  );
});

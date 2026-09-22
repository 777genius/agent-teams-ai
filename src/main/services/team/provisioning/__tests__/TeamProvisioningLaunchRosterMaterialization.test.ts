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

  it('rebases a concurrent native startup update without waiting for the first lead turn', async () => {
    const { state, input, ports } = createHarness();
    state.beforeWrite = () => {
      state.beforeWrite = () => {};
      const latest = JSON.parse(state.raw);
      latest.members[1].lastHeartbeatAt = 456;
      latest.members.push({ name: 'native-worker', providerId: 'codex', model: 'gpt-5.6-luna' });
      latest.updatedAt = 456;
      state.raw = JSON.stringify(latest);
    };
    await expect(materializeTeamProvisioningLaunchRoster(input, ports)).resolves.toBe(true);
    expect(JSON.parse(state.raw)).toMatchObject({
      updatedAt: 456,
      members: [
        { name: 'team-lead' },
        { name: 'haiku', lastHeartbeatAt: 456 },
        { name: 'native-worker', providerId: 'codex' },
        { name: 'opencode-worker', providerId: 'opencode' },
      ],
    });
    expect(ports.writeConfig).toHaveBeenCalledTimes(2);
    expect(ports.invalidateTeam).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated conflicts without publishing a stale snapshot', async () => {
    const { state, input, ports } = createHarness();
    let updates = 0;
    state.beforeWrite = () => {
      state.raw = JSON.stringify({ ...JSON.parse(state.raw), updatedAt: ++updates });
    };
    await expect(materializeTeamProvisioningLaunchRoster(input, ports)).rejects.toThrow(
      'roster changed before config commit'
    );
    expect(ports.writeConfig).toHaveBeenCalledTimes(3);
    expect(JSON.parse(state.raw).members).toHaveLength(2);
    expect(ports.invalidateTeam).not.toHaveBeenCalled();
  });

  it.each(['lead-session', 'provider', 'model', 'removed-config', 'cancelled', 'removed-meta'])(
    'does not retry publication across %s changes',
    async (change) => {
      const { state, input, ports } = createHarness();
      state.beforeWrite = () => {
        const latest = JSON.parse(state.raw);
        if (change === 'lead-session') latest.leadSessionId = 'replacement-session';
        if (change === 'provider') latest.members[1].providerId = 'codex';
        if (change === 'model') latest.members[1].model = 'replacement-model';
        if (change === 'removed-config')
          latest.members.push({ name: 'opencode-worker', removedAt: 456 });
        if (change === 'cancelled') state.current = false;
        if (change === 'removed-meta') state.meta[0].removedAt = 456;
        state.raw = JSON.stringify({ ...latest, updatedAt: 456 });
      };
      await expect(materializeTeamProvisioningLaunchRoster(input, ports)).rejects.toThrow(
        'roster changed before config commit'
      );
      expect(ports.writeConfig).toHaveBeenCalledTimes(1);
      expect(ports.invalidateTeam).not.toHaveBeenCalled();
    }
  );

  it('does not retry an unrelated storage error', async () => {
    const { input, ports } = createHarness();
    vi.mocked(ports.writeConfig).mockRejectedValue(new Error('disk full'));
    await expect(materializeTeamProvisioningLaunchRoster(input, ports)).rejects.toThrow(
      'disk full'
    );
    expect(ports.writeConfig).toHaveBeenCalledTimes(1);
  });

  it('rejects a replacement lead appearing between a conflict and the next read', async () => {
    const { state, input, ports } = createHarness();
    state.beforeWrite = () => {
      state.raw = JSON.stringify({ ...JSON.parse(state.raw), updatedAt: 456 });
    };
    const read = ports.readConfig;
    let reads = 0;
    ports.readConfig = async () => {
      if (++reads === 3) {
        state.raw = JSON.stringify({ ...JSON.parse(state.raw), leadSessionId: 'replacement' });
      }
      return read();
    };
    await expect(materializeTeamProvisioningLaunchRoster(input, ports)).rejects.toThrow(
      'roster changed before config commit'
    );
    expect(ports.writeConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state.raw).leadSessionId).toBe('replacement');
  });

  it.each([
    ['opencode', { providerId: 'opencode' }, true],
    ['codex', { providerId: 'codex' }, false],
    ['matching legacy provider', { providerId: 'opencode', provider: 'opencode' }, true],
    ['conflicting legacy provider', { providerId: 'opencode', provider: 'codex' }, false],
    ['matching backend', { providerId: 'opencode', providerBackendId: 'opencode-cli' }, true],
    ['conflicting backend', { providerId: 'opencode', providerBackendId: 'codex-native' }, false],
  ])(
    'handles a concurrent %s member with the same target name',
    async (_label, identity, compatible) => {
      const { state, input, ports } = createHarness();
      state.beforeWrite = () => {
        state.beforeWrite = () => {};
        const latest = JSON.parse(state.raw);
        latest.members.push({
          name: 'opencode-worker',
          agentId: 'opencode-worker@sandbox-mixed',
          ...identity,
          model: 'openai/gpt-5',
        });
        state.raw = JSON.stringify(latest);
      };
      const result = materializeTeamProvisioningLaunchRoster(input, ports);
      if (compatible) await expect(result).resolves.toBe(true);
      else await expect(result).rejects.toThrow('roster changed before config commit');
      expect(ports.writeConfig).toHaveBeenCalledTimes(1);
      expect(JSON.parse(state.raw).members).toHaveLength(3);
      expect(JSON.parse(state.raw).members[2]).toMatchObject(identity);
    }
  );

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

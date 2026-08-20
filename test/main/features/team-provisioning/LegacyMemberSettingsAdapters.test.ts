import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import { LegacyMemberSettingsLifecycleAdapter } from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsLifecycleAdapter';
import { LegacyMemberSettingsMutationGateAdapter } from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsMutationGateAdapter';
import { LegacyMemberSettingsRepositoryAdapter } from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsRepositoryAdapter';
import { fingerprintResolvedMember } from '@features/team-provisioning/renderer/utils/memberSettingsPresentation';
import { describe, expect, it, vi } from 'vitest';

import type { EditableMemberSettings } from '@features/team-provisioning/contracts/memberSettings';
import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';

const cleared: EditableMemberSettings = {
  role: null,
  workflow: null,
  isolation: null,
  providerId: null,
  providerBackendId: null,
  model: null,
  effort: null,
  fastMode: null,
  mcpPolicy: null,
};

function fixture() {
  let meta: TeamMembersMetaFile = {
    version: 1,
    providerBackendId: 'cli-sdk',
    members: [
      {
        name: 'Alice',
        role: 'builder',
        workflow: 'ship',
        isolation: 'worktree',
        providerId: 'codex',
        providerBackendId: 'cli-sdk',
        model: 'gpt-old',
        effort: 'high',
        fastMode: 'on',
        mcpPolicy: { mode: 'appOnly' },
        agentId: 'agent-a',
        joinedAt: 11,
        color: 'blue',
      },
      { name: 'Bob', role: 'reviewer', agentId: 'agent-b', color: 'green' },
    ],
  };
  let config = {
    name: 'Team',
    description: 'preserve',
    members: [
      {
        name: 'ALICE',
        role: 'builder',
        workflow: 'ship',
        isolation: 'worktree',
        provider: 'codex',
        providerId: 'codex',
        providerBackendId: 'cli-sdk',
        model: 'gpt-old',
        effort: 'high',
        fastMode: 'on',
        mcpPolicy: { mode: 'appOnly' },
        agentId: 'agent-a',
        joinedAt: 11,
        runtimePid: 9001,
        subscriptions: ['task'],
      },
      { name: 'Bob', role: 'reviewer', agentId: 'agent-b', runtimePid: 9002 },
    ],
  };
  const invalidateCaches = vi.fn();
  let failConfigWrite = false;
  const adapter = new LegacyMemberSettingsRepositoryAdapter({
    membersMetaStore: {
      getMeta: async () => structuredClone(meta),
      writeMembers: async (_teamName, members, options) => {
        meta = {
          version: 1,
          providerBackendId: options?.providerBackendId,
          members: structuredClone(members),
        };
      },
    },
    readConfigJson: async () => JSON.stringify(config),
    writeConfigJsonAtomic: async (_teamName, contents) => {
      if (failConfigWrite) throw new Error('config write failed');
      config = JSON.parse(contents) as typeof config;
    },
    withConfigLock: async (_teamName, operation) => operation(),
    readLeadProviderId: async () => 'codex',
    teamExists: async () => true,
    isTeamAlive: () => true,
    invalidateCaches,
  });
  return {
    adapter,
    invalidateCaches,
    get meta() {
      return meta;
    },
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    set meta(value) {
      meta = value;
    },
    failConfigWrite() {
      failConfigWrite = true;
    },
  };
}

describe('LegacyMemberSettingsRepositoryAdapter', () => {
  it('reads and saves an offline meta-only target without creating config.json', async () => {
    let meta: TeamMembersMetaFile = {
      version: 1,
      members: [{ name: 'DraftWorker', role: 'draft', providerId: 'opencode' }],
    };
    const writeConfigJsonAtomic = vi.fn();
    const adapter = new LegacyMemberSettingsRepositoryAdapter({
      membersMetaStore: {
        getMeta: async () => structuredClone(meta),
        writeMembers: async (_teamName, members) => {
          meta = { version: 1, members: structuredClone(members) };
        },
      },
      readConfigJson: async () => null,
      writeConfigJsonAtomic,
      withConfigLock: async (_teamName, operation) => operation(),
      readLeadProviderId: async () => 'codex',
      teamExists: async () => true,
      isTeamAlive: () => false,
      invalidateCaches: vi.fn(),
    });
    const before = await adapter.findTarget('draft-team', 'draftworker');

    expect(before).toMatchObject({
      name: 'DraftWorker',
      teamIsAlive: false,
      teamIsMixed: true,
      runtimeLane: 'opencode_secondary',
    });
    await expect(
      adapter.applyTarget({
        teamName: 'draft-team',
        memberName: 'DRAFTWORKER',
        expectedFingerprint: createMemberSettingsFingerprint(before!),
        settings: { ...cleared, role: 'ready', providerId: 'opencode' },
      })
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(meta.members).toEqual([
      expect.objectContaining({ name: 'DraftWorker', role: 'ready', providerId: 'opencode' }),
    ]);
    expect(writeConfigJsonAtomic).not.toHaveBeenCalled();
  });

  it('treats tombstones in either store as authoritative for targets and mixed policy', async () => {
    const state = fixture();
    state.meta.members[1] = {
      ...state.meta.members[1]!,
      providerId: 'opencode',
    };
    state.config.members[1] = {
      ...state.config.members[1]!,
      providerId: 'opencode',
      removedAt: Date.now(),
    } as unknown as (typeof state.config.members)[number];
    await expect(state.adapter.findTarget('team-a', 'Alice')).resolves.toMatchObject({
      teamIsMixed: false,
    });

    delete (state.config.members[1] as { removedAt?: number }).removedAt;
    state.meta.members[1] = { ...state.meta.members[1]!, removedAt: Date.now() };
    await expect(state.adapter.findTarget('team-a', 'Alice')).resolves.toMatchObject({
      teamIsMixed: false,
    });

    state.meta.members[0] = { ...state.meta.members[0]!, removedAt: Date.now() };
    await expect(state.adapter.findTarget('team-a', 'Alice')).resolves.toBeNull();

    delete state.meta.members[0]!.removedAt;
    state.config.members[0] = {
      ...state.config.members[0]!,
      removedAt: Date.now(),
    } as unknown as (typeof state.config.members)[number];
    await expect(state.adapter.findTarget('team-a', 'Alice')).resolves.toBeNull();
  });

  it('clears exact target settings in meta and config while preserving siblings and runtime fields', async () => {
    const state = fixture();
    const before = await state.adapter.findTarget('team-a', 'alice');
    expect(before).not.toBeNull();
    const bobMeta = structuredClone(state.meta.members[1]);
    const bobConfig = structuredClone(state.config.members[1]);

    const result = await state.adapter.applyTarget({
      teamName: 'team-a',
      memberName: 'aLiCe',
      expectedFingerprint: createMemberSettingsFingerprint(before!),
      settings: cleared,
    });

    expect(result.outcome).toBe('applied');
    const metaAlice = state.meta.members.find((member) => member.name === 'Alice')!;
    const configAlice = state.config.members.find((member) => member.name === 'ALICE')!;
    for (const key of Object.keys(cleared)) {
      expect(metaAlice).not.toHaveProperty(key);
      expect(configAlice).not.toHaveProperty(key);
    }
    expect(configAlice).not.toHaveProperty('provider');
    expect(metaAlice).toMatchObject({ agentId: 'agent-a', joinedAt: 11, color: 'blue' });
    expect(configAlice).toMatchObject({ runtimePid: 9001, subscriptions: ['task'] });
    expect(state.meta.members[1]).toEqual(bobMeta);
    expect(state.config.members[1]).toEqual(bobConfig);
    expect(state.invalidateCaches).toHaveBeenCalledOnce();
  });

  it('restores divergent raw metadata and config target snapshots exactly', async () => {
    const state = fixture();
    state.meta.members[0] = { ...state.meta.members[0]!, model: 'meta-model', effort: 'low' };
    state.config.members[0] = {
      ...state.config.members[0]!,
      agentId: 'config-agent',
      joinedAt: 22,
      provider: 'anthropic',
      providerId: 'codex',
      model: 'config-model',
      effort: 'high',
    } as (typeof state.config.members)[number];
    const originalMetaTarget = structuredClone(state.meta.members[0]);
    const originalConfigTarget = structuredClone(state.config.members[0]);
    const before = (await state.adapter.findTarget('team-a', 'alice'))!;
    expect(before).toMatchObject({
      agentId: 'config-agent',
      joinedAt: 22,
      settings: { model: 'config-model', effort: 'high', providerId: 'codex' },
    });
    expect(
      fingerprintResolvedMember({
        name: 'ALICE',
        agentId: 'config-agent',
        joinedAt: 22,
        status: 'idle',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
        role: 'builder',
        workflow: 'ship',
        isolation: 'worktree',
        providerId: 'codex',
        providerBackendId: 'cli-sdk',
        model: 'config-model',
        effort: 'high',
        selectedFastMode: 'on',
        configuredRuntimeSettings: {
          providerId: 'codex',
          providerBackendId: 'cli-sdk',
          model: 'config-model',
          effort: 'high',
          fastMode: 'on',
        },
        mcpPolicy: { mode: 'appOnly' },
      })
    ).toBe(createMemberSettingsFingerprint(before));
    const applied = await state.adapter.applyTarget({
      teamName: 'team-a',
      memberName: 'Alice',
      expectedFingerprint: createMemberSettingsFingerprint(before),
      settings: { ...cleared, role: 'temporary' },
    });
    expect(applied.outcome).toBe('applied');
    if (applied.outcome !== 'applied') return;

    await expect(
      state.adapter.restoreTarget({
        teamName: 'team-a',
        memberName: 'Alice',
        expectedFingerprint: createMemberSettingsFingerprint(applied.snapshot),
        snapshot: before,
        rollbackToken: applied.rollbackToken,
      })
    ).resolves.toBe(true);

    expect(state.meta.members[0]).toEqual(originalMetaTarget);
    expect(state.config.members[0]).toEqual(originalConfigTarget);
  });

  it('rolls back only target metadata when config persistence fails', async () => {
    const state = fixture();
    const original = structuredClone(state.meta);
    const before = await state.adapter.findTarget('team-a', 'alice');
    state.failConfigWrite();

    await expect(
      state.adapter.applyTarget({
        teamName: 'team-a',
        memberName: 'Alice',
        expectedFingerprint: createMemberSettingsFingerprint(before!),
        settings: cleared,
      })
    ).rejects.toThrow('Config update failed');

    expect(state.meta).toEqual(original);
    expect(state.invalidateCaches).toHaveBeenCalledOnce();
  });

  it('restore changes only target settings and preserves concurrently updated siblings', async () => {
    const state = fixture();
    const before = (await state.adapter.findTarget('team-a', 'alice'))!;
    const applied = await state.adapter.applyTarget({
      teamName: 'team-a',
      memberName: 'Alice',
      expectedFingerprint: createMemberSettingsFingerprint(before),
      settings: { ...cleared, role: 'new role' },
    });
    expect(applied.outcome).toBe('applied');
    if (applied.outcome !== 'applied') return;

    state.meta.members[1] = { ...state.meta.members[1]!, role: 'concurrent meta' };
    state.config.members[1] = { ...state.config.members[1]!, role: 'concurrent config' };
    const restored = await state.adapter.restoreTarget({
      teamName: 'team-a',
      memberName: 'alice',
      expectedFingerprint: createMemberSettingsFingerprint(applied.snapshot),
      snapshot: before,
      rollbackToken: applied.rollbackToken,
    });

    expect(restored).toBe(true);
    expect(state.meta.members[1]).toMatchObject({ role: 'concurrent meta' });
    expect(state.config.members[1]).toMatchObject({ role: 'concurrent config' });
    expect(state.meta.members[0]).toMatchObject({ role: 'builder', agentId: 'agent-a' });
    expect(state.config.members[0]).toMatchObject({ role: 'builder', runtimePid: 9001 });
  });

  it.each(['metadata', 'config'] as const)(
    'restores exact target entry presence when %s originally had no target',
    async (missingStore) => {
      const state = fixture();
      if (missingStore === 'metadata') {
        state.meta = { ...state.meta, members: state.meta.members.slice(1) };
      } else {
        state.config = { ...state.config, members: state.config.members.slice(1) };
      }
      const before = (await state.adapter.findTarget('team-a', 'alice'))!;
      const applied = await state.adapter.applyTarget({
        teamName: 'team-a',
        memberName: 'Alice',
        expectedFingerprint: createMemberSettingsFingerprint(before),
        settings: { ...cleared, role: 'new role' },
      });
      expect(applied.outcome).toBe('applied');
      if (applied.outcome !== 'applied') return;

      await expect(
        state.adapter.restoreTarget({
          teamName: 'team-a',
          memberName: 'Alice',
          expectedFingerprint: createMemberSettingsFingerprint(applied.snapshot),
          snapshot: before,
          rollbackToken: applied.rollbackToken,
        })
      ).resolves.toBe(true);

      expect(state.meta.members.some((member) => member.name.toLowerCase() === 'alice')).toBe(
        missingStore !== 'metadata'
      );
      expect(
        state.config.members.some((member) => String(member.name).toLowerCase() === 'alice')
      ).toBe(missingStore !== 'config');
    }
  );
});

describe('LegacyMemberSettingsLifecycleAdapter', () => {
  it('keeps persisted settings without attach when the team stopped before lifecycle', async () => {
    const attachLiveRosterMember = vi.fn(async () => undefined);
    const adapter = new LegacyMemberSettingsLifecycleAdapter({
      attachLiveRosterMember,
      isTeamAlive: () => false,
    });
    const snapshot = (await fixture().adapter.findTarget('team-a', 'Alice'))!;

    await expect(
      adapter.applyEffect({
        teamName: 'team-a',
        before: snapshot,
        after: snapshot,
        action: 'restart_member',
      })
    ).resolves.toBe('persisted_only');
    expect(attachLiveRosterMember).not.toHaveBeenCalled();
  });

  it('performs exactly one factual attach for primary and OpenCode lane effects', async () => {
    const attachLiveRosterMember = vi.fn(async () => undefined);
    const adapter = new LegacyMemberSettingsLifecycleAdapter({
      attachLiveRosterMember,
      isTeamAlive: () => true,
    });
    const snapshot = (await fixture().adapter.findTarget('team-a', 'Alice'))!;

    await expect(
      adapter.applyEffect({
        teamName: 'team-a',
        before: snapshot,
        after: snapshot,
        action: 'restart_member',
      })
    ).resolves.toBe('member_restart_started');
    expect(attachLiveRosterMember).toHaveBeenCalledTimes(1);
    expect(attachLiveRosterMember).toHaveBeenLastCalledWith('team-a', 'ALICE', {
      reason: 'member_updated',
    });

    attachLiveRosterMember.mockClear();
    await expect(
      adapter.applyEffect({
        teamName: 'team-a',
        before: snapshot,
        after: snapshot,
        action: 'restart_opencode_lane',
      })
    ).resolves.toBe('opencode_lane_restart_started');
    expect(attachLiveRosterMember).toHaveBeenCalledTimes(1);

    attachLiveRosterMember.mockClear();
    await expect(
      adapter.restore({
        teamName: 'team-a',
        before: snapshot,
        after: snapshot,
        attemptedAction: 'restart_member',
      })
    ).resolves.toBe(true);
    expect(attachLiveRosterMember).toHaveBeenCalledTimes(1);
    expect(attachLiveRosterMember).toHaveBeenCalledWith('team-a', 'ALICE', {
      reason: 'member_updated',
    });
  });
});

describe('LegacyMemberSettingsMutationGateAdapter', () => {
  it('rejects an already occupied team operation without running the mutation', async () => {
    const operation = vi.fn(async () => 'result');
    const adapter = new LegacyMemberSettingsMutationGateAdapter({
      runLiveRosterMutation: vi.fn(),
      tryRunLiveRosterMutation: vi.fn(async () => false),
    });

    await expect(adapter.runExclusive('team-a', operation)).rejects.toThrow(
      'Team mutation is already in progress'
    );
    expect(operation).not.toHaveBeenCalled();
  });
});

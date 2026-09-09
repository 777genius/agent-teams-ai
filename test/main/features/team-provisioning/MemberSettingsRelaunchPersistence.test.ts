import { fingerprintSavedLaunchSettings } from '@features/team-provisioning/contracts';
import { TeamProvisioningRuntimeStateProjection } from '@main/services/team/provisioning/TeamProvisioningRuntimeStateProjection';
import { executeTeamRelaunch } from '@renderer/components/team/dialogs/teamRelaunchFlow';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import { validateMemberSettingsRelaunch } from '@features/team-provisioning/main/adapters/input/validateMemberSettingsRelaunch';
import { LegacyMemberSettingsRepositoryAdapter } from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsRepositoryAdapter';
import { persistMemberSettingsRelaunch } from '@features/team-provisioning/main/adapters/output/MemberSettingsRelaunchPersistence';
import { describe, expect, it, vi } from 'vitest';

import type { LegacyMemberSettingsRepositoryDependencies } from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsRepositoryAdapter';
import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';

function fixture() {
  let meta: TeamMembersMetaFile = {
    version: 1,
    members: [
      { name: 'team-lead', agentType: 'team-lead', model: 'glm-5.3', agentId: 'lead-1' },
      { name: 'worker', model: 'glm-5.3', agentId: 'worker-1' },
      { name: 'inherited', agentId: 'sibling-1' },
    ],
  };
  let config = JSON.stringify({
    name: 'sandbox',
    custom: 'keep',
    members: meta.members.map((m) => ({ ...m, runtimeModel: 'observed-only' })),
  });
  let team: TeamMetaFile = {
    version: 1,
    cwd: '/sandbox/test-only',
    createdAt: 1,
    providerId: 'opencode',
    model: 'glm-5.3',
    syncModelsWithLead: true,
  };
  let locked = false;
  const writeConfig = vi.fn(async (_name: string, value: string) => {
    config = value;
  });
  const deps: LegacyMemberSettingsRepositoryDependencies & { hasProvisioningRun: (name: string) => boolean } = {
    hasProvisioningRun: () => false,
    membersMetaStore: {
      getMeta: async () => structuredClone(meta),
      writeMembers: vi.fn(async (_name, members) => {
        meta = { ...meta, members: structuredClone(members) };
      }),
    },
    readConfigJson: async () => config,
    writeConfigJsonAtomic: writeConfig,
    withConfigLock: async (_name, operation) => {
      expect(locked).toBe(false);
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    readLeadProviderId: async () => 'opencode',
    teamExists: async () => true,
    isTeamAlive: () => false,
    invalidateCaches: vi.fn(),
  };
  const teamMetaStore = {
    getMeta: async () => structuredClone(team),
    updateMeta: vi.fn(
      async (
        _name: string,
        update: (
          current: TeamMetaFile
        ) => Promise<Omit<TeamMetaFile, 'version'>> | Omit<TeamMetaFile, 'version'>
      ) => {
        team = { version: 1, ...(await update(structuredClone(team))) };
      }
    ),
  };
  const repository = new LegacyMemberSettingsRepositoryAdapter(deps);
  async function intent(memberName = 'worker') {
    const snapshots = await Promise.all(
      meta.members.map((m) => repository.findTarget('sandbox', m.name))
    );
    return {
      memberName,
      expectedTeamSettingsFingerprint: fingerprintSavedLaunchSettings(team),
      targetKind: memberName === 'team-lead' ? ('lead' as const) : ('member' as const),
      expectedFingerprint: createMemberSettingsFingerprint(
        snapshots.find((s) => s?.name === memberName)!
      ),
      baseline: snapshots.map((s) => ({
        memberName: s!.name,
        expectedFingerprint: createMemberSettingsFingerprint(s!),
      })),
      model: 'glm-5.3-flash',
      effort: null,
    };
  }
  return {
    deps,
    teamMetaStore,
    repository,
    intent,
    writeConfig,
    get meta() {
      return meta;
    },
    get config() {
      return JSON.parse(config);
    },
    get team() {
      return team;
    },
    changeTarget() {
      meta.members[1].agentId = 'replacement';
      config = JSON.stringify({ ...JSON.parse(config), members: meta.members });
    },
  };
}

describe('model relaunch durable persistence', () => {
  it('persists explicit member intent to both canonical sources and preserves inherited siblings/default', async () => {
    const f = fixture();
    const intent = await f.intent();
    const members = f.meta.members
      .filter((m) => m.name !== 'team-lead')
      .map((m) => ({ ...m, ...(m.name === 'worker' ? { model: intent.model } : {}) }));
    await persistMemberSettingsRelaunch(
      'sandbox',
      { members, memberSettingsRelaunch: intent },
      f.deps,
      f.teamMetaStore
    );
    expect((await f.repository.findTarget('sandbox', 'worker'))?.settings.model).toBe(
      'glm-5.3-flash'
    );
    expect(f.meta.members.find((m) => m.name === 'worker')?.model).toBe('glm-5.3-flash');
    expect(f.config.members.find((m: { name: string }) => m.name === 'worker').model).toBe(
      'glm-5.3-flash'
    );
    expect(f.meta.members.find((m) => m.name === 'inherited')).not.toHaveProperty('model');
    expect(f.team.model).toBe('glm-5.3');
    expect(f.teamMetaStore.updateMeta).not.toHaveBeenCalled();
    expect(f.config.custom).toBe('keep');
    expect(f.config.members[1].runtimeModel).toBe('observed-only');
  });

  it('rejects a replaced target at the write boundary without writes', async () => {
    const f = fixture();
    const intent = await f.intent();
    f.changeTarget();
    await expect(
      persistMemberSettingsRelaunch(
        'sandbox',
        { members: f.meta.members.slice(1), memberSettingsRelaunch: intent },
        f.deps,
        f.teamMetaStore
      )
    ).rejects.toThrow(/changed|conflict/i);
    expect(f.writeConfig).not.toHaveBeenCalled();
    expect(f.teamMetaStore.updateMeta).not.toHaveBeenCalled();
  });

  it('persists lead model in config, members metadata and saved launch defaults', async () => {
    const f = fixture();
    await persistMemberSettingsRelaunch(
      'sandbox',
      { members: f.meta.members.slice(1), memberSettingsRelaunch: await f.intent('team-lead') },
      f.deps,
      f.teamMetaStore
    );
    expect(f.team.model).toBe('glm-5.3-flash');
    expect(f.meta.members[0].model).toBe('glm-5.3-flash');
    expect(f.config.members[0].model).toBe('glm-5.3-flash');
    expect(f.meta.members[1].model).toBe('glm-5.3');
    expect(f.meta.members[2]).not.toHaveProperty('model');
  });
});

describe('relaunch persistence failure and inheritance safety', () => {
  it('refuses a live team before writing', async () => {
    const f = fixture();
    const intent = await f.intent();
    f.deps.isTeamAlive = () => true;
    await expect(
      persistMemberSettingsRelaunch(
        'sandbox',
        { members: f.meta.members.slice(1), memberSettingsRelaunch: intent },
        f.deps,
        f.teamMetaStore
      )
    ).rejects.toThrow(/Stop the team/);
    expect(f.writeConfig).not.toHaveBeenCalled();
  });

  it('clears an explicit member override without copying the observed model', async () => {
    const f = fixture();
    const intent = await f.intent();
    const members = f.meta.members.slice(1).map((member) => ({ ...member, model: undefined }));
    await persistMemberSettingsRelaunch(
      'sandbox',
      { members, memberSettingsRelaunch: { ...intent, model: null } },
      f.deps,
      f.teamMetaStore
    );
    expect((await f.repository.findTarget('sandbox', 'worker'))?.settings.model).toBeNull();
    expect(f.config.members[1]).not.toHaveProperty('model');
    expect(f.config.members[1].runtimeModel).toBe('observed-only');
    expect(f.team.model).toBe('glm-5.3');
  });

  it('rolls back canonical member sources when lead defaults fail to persist', async () => {
    const f = fixture();
    const before = structuredClone(f.meta);
    const config = structuredClone(f.config);
    const intent = await f.intent('team-lead');
    f.teamMetaStore.updateMeta.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      persistMemberSettingsRelaunch(
        'sandbox',
        { members: f.meta.members.slice(1), memberSettingsRelaunch: intent },
        f.deps,
        f.teamMetaStore
      )
    ).rejects.toThrow('disk full');
    expect(f.meta).toEqual(before);
    expect(f.config).toEqual(config);
    expect(f.team.model).toBe('glm-5.3');
  });

  it('updates lead launch identity together with compatibility fields', async () => {
    const f = fixture();
    f.team.launchIdentity = {
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      selectedModel: 'glm-5.3',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'glm-5.3',
      catalogId: 'glm-5.3',
      catalogSource: 'runtime',
      catalogFetchedAt: null,
      selectedEffort: null,
      resolvedEffort: null,
    };
    await persistMemberSettingsRelaunch(
      'sandbox',
      { members: f.meta.members.slice(1), memberSettingsRelaunch: await f.intent('team-lead') },
      f.deps,
      f.teamMetaStore
    );
    expect(f.team.launchIdentity).toMatchObject({
      selectedModel: 'glm-5.3-flash',
      resolvedLaunchModel: 'glm-5.3-flash',
      catalogId: 'glm-5.3-flash',
      providerId: 'opencode',
    });
    expect(f.team.model).toBe('glm-5.3-flash');
    expect(f.team.syncModelsWithLead).toBe(true);
  });
});

it('validates optional relaunch IPC intent and rejects malformed or duplicate baselines', async () => {
  const valid = await fixture().intent();
  expect(validateMemberSettingsRelaunch(undefined)).toBeUndefined();
  expect(validateMemberSettingsRelaunch(valid)).toEqual(valid);
  for (const invalid of [
    null,
    {},
    { ...valid, expectedTeamSettingsFingerprint: undefined },
    { ...valid, effort: 'bogus' },
    { ...valid, model: 3 },
    { ...valid, baseline: [...valid.baseline, valid.baseline[0]] },
  ]) {
    expect(() => validateMemberSettingsRelaunch(invalid)).toThrow(/Invalid/);
  }
});


it('refuses stale sibling settings at the write boundary', async () => {
  const f = fixture();
  const intent = await f.intent();
  f.meta.members[2].model = 'external-choice';
  await expect(persistMemberSettingsRelaunch('sandbox', { members: f.meta.members.slice(1), memberSettingsRelaunch: intent }, f.deps, f.teamMetaStore)).rejects.toThrow(/changed/);
  expect(f.writeConfig).not.toHaveBeenCalled();
  expect(f.meta.members[2].model).toBe('external-choice');
});

it('refuses config-only roster additions at the write boundary', async () => {
  const f = fixture();
  const intent = await f.intent();
  f.deps.readConfigJson = async () => JSON.stringify({ ...f.config, members: [...f.config.members, { name: 'new-member' }] });
  await expect(persistMemberSettingsRelaunch('sandbox', { members: f.meta.members.slice(1), memberSettingsRelaunch: intent }, f.deps, f.teamMetaStore)).rejects.toThrow(/roster changed/);
  expect(f.writeConfig).not.toHaveBeenCalled();
});

it('clears lead defaults without materializing them into inherited siblings', async () => {
  const f = fixture();
  const intent = { ...await f.intent('team-lead'), model: null };
  await persistMemberSettingsRelaunch('sandbox', { members: f.meta.members.slice(1), memberSettingsRelaunch: intent }, f.deps, f.teamMetaStore);
  expect(f.team.model).toBeUndefined();
  expect(f.config.members[0]).not.toHaveProperty('model');
  expect(f.meta.members[0]).not.toHaveProperty('model');
  expect(f.meta.members[1].model).toBe('glm-5.3');
  expect(f.meta.members[2]).not.toHaveProperty('model');
});

// A successor can release launch admission while configuring, before alive promotion.
it('rejects a lead-only configuring successor under the existing mutation gate with zero writes', async () => {
  const f = fixture();
  f.meta.members.splice(1);
  f.deps.readConfigJson = async () => JSON.stringify({ members: f.meta.members });
  const intent = await f.intent('team-lead');
  const provisioningRunByTeam = new Map<string, string>();
  const run = { runId: 'successor', child: {}, processKilled: false, cancelRequested: false,
    progress: { runId: 'successor', teamName: 'sandbox', state: 'configuring' as const, message: '', startedAt: '', updatedAt: '' } };
  const projection = new TeamProvisioningRuntimeStateProjection({
    state: { provisioningRunByTeam, runs: new Map([['successor', run]]), runtimeAdapterRunByTeam: new Map(),
      runtimeAdapterProgressByRunId: new Map(), getRetainedProvisioningProgressMap: () => new Map() },
    ports: { getAliveRunId: () => null, getTrackedRunId: () => provisioningRunByTeam.get('sandbox') ?? null,
      getAliveTeamNames: () => [], hasSecondaryRuntimeRuns: () => false, readBootstrapRuntimeState: async () => null },
  });
  f.deps.isTeamAlive = name => projection.isTeamAlive(name);
  const launchTeam = vi.fn();
  let mutationLocked = false;
  const gate = f.deps.withConfigLock;
  f.deps.withConfigLock = (name, operation) => gate(name, async () => {
    mutationLocked = true;
    try { return await operation(); } finally { mutationLocked = false; }
  });
  f.deps.hasProvisioningRun = name => { expect(mutationLocked).toBe(true); return projection.hasProvisioningRun(name); };
  await expect(executeTeamRelaunch({
    teamName: 'sandbox', isTeamAlive: true, request: { teamName: 'sandbox', cwd: '/sandbox/test-only' },
    members: [], memberSettingsRelaunch: intent,
    stopTeam: async () => {
      // Competing admission captures old settings, then releases the same gate.
      await f.deps.withConfigLock('sandbox', async () => { provisioningRunByTeam.set('sandbox', run.runId); });
      expect(projection.isTeamAlive('sandbox')).toBe(false);
      expect(projection.hasProvisioningRun('sandbox')).toBe(true);
      expect(run.progress.state).toBe('configuring');
    },
    replaceMembers: (name, request) => persistMemberSettingsRelaunch(name, request, f.deps, f.teamMetaStore), launchTeam,
  })).rejects.toThrow(/Stop the team/);
  expect(f.writeConfig).not.toHaveBeenCalled();
  expect(f.deps.membersMetaStore.writeMembers).not.toHaveBeenCalled();
  expect(f.teamMetaStore.updateMeta).not.toHaveBeenCalled();
  expect(launchTeam).not.toHaveBeenCalled();
});

it.each(['model', 'effort', 'syncModelsWithLead', 'fastMode', 'skipPermissions', 'worktree', 'extraCliArgs', 'limitContext', 'providerId', 'launchIdentity'] as const)(
  'rejects teammeta-only stale %s from the editor baseline with zero writes', async key => {
    const f = fixture();
    const intent = await f.intent('team-lead');
    const changes = {
      model: 'newer-external-default', effort: 'high', syncModelsWithLead: false, fastMode: 'on',
      skipPermissions: true, worktree: 'external-branch', extraCliArgs: '--max-turns 5', limitContext: true,
      providerId: 'codex', launchIdentity: {
        providerId: 'opencode', providerBackendId: 'opencode-cli', selectedModel: 'newer-external-default',
        selectedModelKind: 'explicit', resolvedLaunchModel: 'newer-external-default', catalogId: null,
        catalogSource: 'runtime', catalogFetchedAt: null, selectedEffort: null, resolvedEffort: null,
      },
    };
    Object.assign(f.team, { [key]: changes[key] });
    await expect(persistMemberSettingsRelaunch('sandbox', { members: f.meta.members.slice(1), memberSettingsRelaunch: intent }, f.deps, f.teamMetaStore)).rejects.toThrow(/launch settings changed/);
    expect(f.writeConfig).not.toHaveBeenCalled();
    expect(f.deps.membersMetaStore.writeMembers).not.toHaveBeenCalled();
    expect(f.teamMetaStore.updateMeta).not.toHaveBeenCalled();
  }
);

import { describe, expect, it, vi } from 'vitest';

import { createMemberSettingsFingerprint, MemberSettingsCommandExecutor, createTeamMemberSettingsFeature } from '../../src/features/team-provisioning/main';
import { createProjectMemberSettingsWriter } from '../../src/main/projectLiveMemberSettings';
import { TeamProvisioningService } from '../../src/main/services/team/TeamProvisioningService';

import type { MemberSettingsTargetSnapshot } from '../../src/features/team-provisioning/core/domain/memberSettingsPolicy';
import type { MemberSettingsRepositoryPort } from '../../src/features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import type { UpdateMemberSettingsRequest } from '../../src/features/team-provisioning/contracts';

function snapshot(alive: boolean): MemberSettingsTargetSnapshot {
  return { name: 'alice', agentType: 'developer', agentId: alive ? 'alice@ptc' : null, joinedAt: alive ? 1 : null,
    settings: { role: 'developer', workflow: null, isolation: null, providerId: 'anthropic',
      providerBackendId: null, model: null, effort: null, fastMode: null, mcpPolicy: null },
    teamIsAlive: alive, leadProviderId: 'anthropic', teamIsMixed: false, runtimeLane: 'primary' };
}

function fixture() {
  const service = new TeamProvisioningService();
  const targets = new Map([['builders', snapshot(false)], ['ptc-a', snapshot(true)]]);
  let failDefinition = false;
  let pending = false;
  const repository: MemberSettingsRepositoryPort = {
    findTarget: async (team) => targets.get(team) ?? null,
    classifyMissingTarget: async () => 'member_not_found',
    applyTarget: async ({ teamName, settings }) => {
      if (teamName === 'builders' && failDefinition) throw new Error('synthetic disk failure');
      const next = { ...targets.get(teamName)!, settings };
      targets.set(teamName, next);
      return { outcome: 'applied', snapshot: next, rollbackToken: null };
    },
    restoreTarget: async () => true,
  };
  const applyEffect = vi.fn(async () => 'member_restart_started' as const);
  const feature = createTeamMemberSettingsFeature({
    repository,
    mutationSource: {
      runLiveRosterMutation: service.runLiveRosterMutation.bind(service),
      tryRunLiveRosterMutation: service.tryRunLiveRosterMutation.bind(service),
    },
    lifecycle: { assess: async () => ({ outcome: 'ready' }), applyEffect, restore: async () => true },
  });
  const runConfigurationOperation = async <T>(team: string, operation: () => Promise<T>): Promise<T> => {
    let result!: T;
    await service.runLiveRosterMutation(team, async () => { result = await operation(); });
    return result;
  };
  const editor = {
    findRunningContextForEdit: async () => ({ executionTeamName: 'ptc-a', runId: 'run-1' }),
    projectToAliases: async () => ({ failed: [] }),
  };
  const journal = { hasPending: async () => pending, begin: async () => { pending = true; },
    clear: async () => { pending = false; } };
  const writer = createProjectMemberSettingsWriter({ team: feature, definitionLead: feature },
    { data: () => ({ runConfigurationOperation }) } as never,
    new MemberSettingsCommandExecutor('test-project-live'), () => journal);
  const before = targets.get('builders')!;
  const request: UpdateMemberSettingsRequest = { teamName: 'builders', memberName: 'alice', commandId: 'c1',
    idempotencyKey: 'c1', expectedFingerprint: createMemberSettingsFingerprint(before), targetKind: 'member',
    settings: { ...before.settings, role: 'reviewer' } };
  return { writer, editor, request, targets, applyEffect, pending: () => pending,
    failDefinition: () => { failDefinition = true; } };
}

describe('project live settings with real use case and runtime gates', () => {
  it('restarts the physical member once and persists the definition; retry replays', async () => {
    const f = fixture();
    expect(await f.writer(f.editor as never, f.request)).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
    expect(f.targets.get('builders')?.settings.role).toBe('reviewer');
    expect(f.targets.get('ptc-a')?.settings.role).toBe('reviewer');
    expect(f.targets.get('ptc-a')?.agentId).toBe('alice@ptc');
    expect(await f.writer(f.editor as never, f.request)).toMatchObject({ replayed: true });
    expect(f.applyEffect).toHaveBeenCalledOnce();
    expect(f.pending()).toBe(false);
  });

  it('keeps recovery fenced when the physical effect succeeds but the logical save fails', async () => {
    const f = fixture();
    f.failDefinition();
    expect(await f.writer(f.editor as never, f.request)).toMatchObject({ outcome: 'completed', effect: 'recovery_required' });
    expect(f.targets.get('builders')?.settings.role).toBe('developer');
    expect(f.targets.get('ptc-a')?.settings.role).toBe('reviewer');
    expect(f.pending()).toBe(true);
    expect(f.applyEffect).toHaveBeenCalledOnce();
  });
});

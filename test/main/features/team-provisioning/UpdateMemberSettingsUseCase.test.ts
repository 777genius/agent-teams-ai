import {
  MemberSettingsLifecycleFailedError,
  MemberSettingsMutationBusyError,
  MemberSettingsPersistenceFailedError,
} from '@features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import { UpdateMemberSettingsUseCase } from '@features/team-provisioning/core/application/use-cases/UpdateMemberSettingsUseCase';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import { describe, expect, it, vi } from 'vitest';

import type { EditableMemberSettings } from '@features/team-provisioning/contracts/memberSettings';
import type {
  MemberSettingsLifecyclePort,
  MemberSettingsMutationGatePort,
  MemberSettingsRepositoryPort,
} from '@features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import type { MemberSettingsTargetSnapshot } from '@features/team-provisioning/core/domain/memberSettingsPolicy';

function settings(overrides: Partial<EditableMemberSettings> = {}): EditableMemberSettings {
  return {
    role: 'Developer',
    workflow: null,
    isolation: null,
    providerId: 'codex',
    providerBackendId: null,
    model: 'gpt-5.6',
    effort: 'medium',
    fastMode: null,
    mcpPolicy: null,
    ...overrides,
  };
}

function target(
  overrides: Partial<MemberSettingsTargetSnapshot> = {}
): MemberSettingsTargetSnapshot {
  return {
    name: 'Worker',
    agentType: 'general-purpose',
    agentId: 'worker@team-a',
    joinedAt: 123,
    settings: settings(),
    teamIsAlive: true,
    leadProviderId: 'anthropic',
    teamIsMixed: false,
    runtimeLane: 'primary',
    ...overrides,
  };
}

function harness(current: MemberSettingsTargetSnapshot | null = target()) {
  const events: string[] = [];
  let stored = current;
  const mutationGate: MemberSettingsMutationGatePort = {
    async runExclusive(_teamName, operation) {
      events.push('gate');
      return operation();
    },
  };
  const repository: MemberSettingsRepositoryPort = {
    findTarget: vi.fn(async () => {
      events.push('read-target');
      return stored;
    }),
    classifyMissingTarget: vi.fn(async () => 'member_not_found' as const),
    applyTarget: vi.fn(async (input) => {
      events.push('apply-target');
      if (!stored || createMemberSettingsFingerprint(stored) !== input.expectedFingerprint) {
        return { outcome: 'target_conflict' as const, current: stored };
      }
      stored = { ...stored, settings: input.settings };
      return { outcome: 'applied' as const, snapshot: stored, rollbackToken: current };
    }),
    restoreTarget: vi.fn(async (input) => {
      events.push('restore-target');
      if (!stored || createMemberSettingsFingerprint(stored) !== input.expectedFingerprint) {
        return false;
      }
      stored = input.snapshot;
      return true;
    }),
  };
  const lifecycle: MemberSettingsLifecyclePort = {
    assess: vi.fn(async () => ({ outcome: 'ready' as const })),
    applyEffect: vi.fn(async (input) => {
      events.push(`lifecycle:${input.action}`);
      if (input.action === 'restart_opencode_lane') {
        return 'opencode_lane_restart_started';
      }
      if (input.action === 'require_team_relaunch') {
        return 'team_relaunch_required';
      }
      return 'member_restart_started';
    }),
    restore: vi.fn(async () => {
      events.push('restore-lifecycle');
      return true;
    }),
  };

  return {
    events,
    mutationGate,
    repository,
    lifecycle,
    useCase: new UpdateMemberSettingsUseCase({ mutationGate, repository, lifecycle }),
    getStored: () => stored,
  };
}

function request(
  current: MemberSettingsTargetSnapshot,
  nextSettings: EditableMemberSettings = settings({ role: 'Reviewer' })
) {
  return {
    commandId: 'command-1',
    idempotencyKey: 'update-member:team-a:worker:1',
    teamName: 'team-a',
    memberName: 'worker',
    expectedFingerprint: createMemberSettingsFingerprint(current),
    targetKind: 'member' as const,
    settings: nextSettings,
  };
}

function leadRequest(current: MemberSettingsTargetSnapshot, model = 'new-model') {
  return {
    commandId: 'lead-command-1',
    idempotencyKey: 'update-lead:team-a:1',
    teamName: 'team-a',
    memberName: current.name,
    expectedFingerprint: createMemberSettingsFingerprint(current),
    targetKind: 'lead' as const,
    leadRuntime: { model, effort: 'high' as const },
  };
}

describe('UpdateMemberSettingsUseCase', () => {
  it('returns no_changes without persistence or lifecycle work', async () => {
    const current = target();
    const test = harness(current);

    await expect(
      test.useCase.execute(request(current, settings({ role: ' Developer ' })))
    ).resolves.toMatchObject({ outcome: 'completed', effect: 'no_changes' });
    expect(test.repository.applyTarget).not.toHaveBeenCalled();
    expect(test.lifecycle.applyEffect).not.toHaveBeenCalled();
  });

  it('returns busy without reading or persisting when the team mutation lock is occupied', async () => {
    const current = target();
    const test = harness(current);
    vi.spyOn(test.mutationGate, 'runExclusive').mockRejectedValueOnce(
      new MemberSettingsMutationBusyError('team-a')
    );

    await expect(test.useCase.execute(request(current))).resolves.toEqual({
      outcome: 'busy',
      teamName: 'team-a',
      memberName: 'worker',
      replayed: false,
    });
    expect(test.repository.findTarget).not.toHaveBeenCalled();
  });

  it('reports a target conflict from the latest target read inside the gate', async () => {
    const latest = target({ settings: settings({ role: 'Changed elsewhere' }) });
    const stale = target();
    const test = harness(latest);

    await expect(test.useCase.execute(request(stale))).resolves.toEqual({
      outcome: 'target_conflict',
      memberName: 'Worker',
      expectedFingerprint: createMemberSettingsFingerprint(stale),
      actualFingerprint: createMemberSettingsFingerprint(latest),
      reason: 'target_changed',
      replayed: false,
    });
    expect(test.events).toEqual(['gate', 'read-target']);
  });

  it('rejects a pre-removal command after restore clears the incarnation timestamp', async () => {
    const removedIncarnation = target({ agentId: null, joinedAt: 123 });
    const restoredIncarnation = target({ agentId: null, joinedAt: null });
    const test = harness(restoredIncarnation);

    await expect(test.useCase.execute(request(removedIncarnation))).resolves.toMatchObject({
      outcome: 'target_conflict',
      expectedFingerprint: createMemberSettingsFingerprint(removedIncarnation),
      actualFingerprint: createMemberSettingsFingerprint(restoredIncarnation),
      reason: 'target_changed',
    });
    expect(test.repository.applyTarget).not.toHaveBeenCalled();
    expect(test.lifecycle.applyEffect).not.toHaveBeenCalled();
  });

  it.each(['member_not_found', 'team_not_found'] as const)(
    'returns the exact missing-target reason: %s',
    async (reason) => {
      const stale = target();
      const test = harness(null);
      vi.mocked(test.repository.classifyMissingTarget).mockResolvedValueOnce(reason);

      await expect(test.useCase.execute(request(stale))).resolves.toMatchObject({
        outcome: 'target_conflict',
        actualFingerprint: null,
        reason,
        replayed: false,
      });
    }
  );

  it('delegates the final compare-and-apply conflict to the repository', async () => {
    const current = target();
    const test = harness(current);
    vi.mocked(test.repository.applyTarget).mockResolvedValueOnce({
      outcome: 'target_conflict',
      current: target({ agentId: 'replacement@team-a' }),
    });

    await expect(test.useCase.execute(request(current))).resolves.toMatchObject({
      outcome: 'target_conflict',
      actualFingerprint: createMemberSettingsFingerprint(target({ agentId: 'replacement@team-a' })),
    });
    expect(test.lifecycle.applyEffect).not.toHaveBeenCalled();
  });

  it('persists an offline target without invoking lifecycle effects', async () => {
    const current = target({ teamIsAlive: false });
    const test = harness(current);

    await expect(test.useCase.execute(request(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'persisted_only',
    });
    expect(test.lifecycle.applyEffect).not.toHaveBeenCalled();
  });

  it.each([
    [
      'primary member',
      target(),
      settings({ role: 'Reviewer' }),
      'restart_member',
      'member_restart_started',
    ],
    [
      'OpenCode secondary lane',
      target({
        runtimeLane: 'opencode_secondary',
        settings: settings({ providerId: 'opencode' }),
      }),
      settings({ role: 'Reviewer', providerId: 'opencode' }),
      'restart_opencode_lane',
      'opencode_lane_restart_started',
    ],
  ] as const)(
    'returns the factual lifecycle effect for %s',
    async (_label, current, next, action, effect) => {
      const test = harness(current);

      await expect(test.useCase.execute(request(current, next))).resolves.toMatchObject({
        outcome: 'completed',
        effect,
      });
      expect(test.lifecycle.applyEffect).toHaveBeenCalledWith(
        expect.objectContaining({ teamName: 'team-a', action })
      );
    }
  );

  it.each([
    ['canonical lead', target({ agentType: 'team-lead' }), settings({ role: 'Reviewer' })],
    [
      'legacy team lead role',
      target({ agentType: null, settings: settings({ role: 'team lead' }) }),
      settings({ role: 'Reviewer' }),
    ],
    [
      'legacy team-lead role',
      target({ agentType: null, settings: settings({ role: 'team-lead' }) }),
      settings({ role: 'Reviewer' }),
    ],
    [
      'legacy orchestrator role',
      target({ agentType: null, settings: settings({ role: 'orchestrator' }) }),
      settings({ role: 'Reviewer' }),
    ],
    [
      'offline canonical lead',
      target({ agentType: 'team-lead', teamIsAlive: false }),
      settings({ role: 'Reviewer' }),
    ],
    [
      'attempted legacy lead promotion',
      target({ agentType: 'developer' }),
      settings({ role: 'Team Lead' }),
    ],
    ['OpenCode-led team', target({ leadProviderId: 'opencode' }), settings({ role: 'Reviewer' })],
    [
      'primary-owned member in a mixed team',
      target({ teamIsMixed: true }),
      settings({ role: 'Reviewer' }),
    ],
    ['primary to OpenCode ownership migration', target(), settings({ providerId: 'opencode' })],
    [
      'OpenCode to primary ownership migration',
      target({
        runtimeLane: 'opencode_secondary',
        settings: settings({ providerId: 'opencode' }),
      }),
      settings({ providerId: 'codex' }),
    ],
  ] as const)('reports relaunch before persistence for %s', async (_label, current, next) => {
    const test = harness(current);

    await expect(test.useCase.execute(request(current, next))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'team_relaunch_required',
      previousFingerprint: createMemberSettingsFingerprint(current),
      currentFingerprint: createMemberSettingsFingerprint(current),
    });
    expect(test.repository.applyTarget).not.toHaveBeenCalled();
    expect(test.lifecycle.applyEffect).not.toHaveBeenCalled();
  });

  it('restarts an exact live lead for model/effort-only intent', async () => {
    const current = target({
      agentType: 'team-lead',
      settings: settings({ providerId: 'anthropic', model: 'old-model' }),
    });
    const test = harness(current);
    vi.mocked(test.lifecycle.assess).mockResolvedValueOnce({
      outcome: 'ready',
      token: 'run-1',
    });
    vi.mocked(test.lifecycle.applyEffect).mockResolvedValueOnce('lead_restart_started');

    await expect(test.useCase.execute(leadRequest(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'lead_restart_started',
    });
    expect(test.lifecycle.applyEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'restart_lead',
        admission: { outcome: 'ready', token: 'run-1' },
      })
    );
  });

  it('persists an offline lead model/effort update without runtime work', async () => {
    const current = target({
      agentType: 'team-lead',
      teamIsAlive: false,
      settings: settings({ providerId: 'anthropic', model: 'old-model' }),
    });
    const test = harness(current);

    await expect(test.useCase.execute(leadRequest(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'persisted_only',
    });
    expect(test.lifecycle.assess).not.toHaveBeenCalled();
  });

  it('rejects a busy lead before persistence', async () => {
    const current = target({
      agentType: 'team-lead',
      settings: settings({ providerId: 'anthropic', model: 'old-model' }),
    });
    const test = harness(current);
    vi.mocked(test.lifecycle.assess).mockResolvedValueOnce({ outcome: 'busy' });

    await expect(test.useCase.execute(leadRequest(current))).resolves.toMatchObject({
      outcome: 'busy',
      teamName: 'team-a',
    });
    expect(test.repository.applyTarget).not.toHaveBeenCalled();
  });

  it('rejects lead intent targeting a member before persistence', async () => {
    const member = target();
    const memberTest = harness(member);
    await expect(memberTest.useCase.execute(leadRequest(member))).resolves.toMatchObject({
      outcome: 'target_conflict',
      reason: 'target_changed',
    });
    expect(memberTest.repository.applyTarget).not.toHaveBeenCalled();
  });

  it('distinguishes a fully rolled-back lead restart from recovery_required', async () => {
    const current = target({
      agentType: 'team-lead',
      settings: settings({ providerId: 'anthropic', model: 'old-model' }),
    });
    const test = harness(current);
    vi.mocked(test.lifecycle.assess).mockResolvedValueOnce({
      outcome: 'ready',
      token: 'run-1',
    });
    vi.mocked(test.lifecycle.applyEffect).mockRejectedValueOnce(
      new MemberSettingsLifecycleFailedError('replacement failed', true)
    );

    await expect(test.useCase.execute(leadRequest(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'lead_restart_rolled_back',
      recovery: { persistenceRestored: true, lifecycleRestored: true },
    });
    expect(test.getStored()).toEqual(current);
    expect(test.lifecycle.restore).not.toHaveBeenCalled();
  });

  it('keeps sibling-safe semantics by passing only the exact target to repository mutation', async () => {
    const current = target();
    const test = harness(current);

    await test.useCase.execute(request(current));

    expect(test.repository.findTarget).toHaveBeenCalledWith('team-a', 'worker');
    expect(test.repository.applyTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        memberName: 'worker',
        expectedFingerprint: createMemberSettingsFingerprint(current),
      })
    );
    expect(test.events.slice(0, 4)).toEqual([
      'gate',
      'read-target',
      'apply-target',
      'lifecycle:restart_member',
    ]);
  });

  it('rethrows the lifecycle failure after complete rollback', async () => {
    const current = target();
    const test = harness(current);
    vi.mocked(test.lifecycle.applyEffect).mockRejectedValueOnce(new Error('restart failed'));

    await expect(test.useCase.execute(request(current))).rejects.toThrow('restart failed');
    expect(test.getStored()).toEqual(current);
    expect(test.events).toContain('restore-target');
    expect(test.events).toContain('restore-lifecycle');
  });

  it('returns recovery_required when either rollback leg is incomplete', async () => {
    const current = target();
    const test = harness(current);
    vi.mocked(test.lifecycle.applyEffect).mockRejectedValueOnce(new Error('partial restart'));
    vi.mocked(test.lifecycle.restore).mockResolvedValueOnce(false);

    await expect(test.useCase.execute(request(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'recovery_required',
      recovery: {
        persistenceRestored: true,
        lifecycleRestored: false,
        cause: 'partial restart',
      },
    });
  });

  it('returns recovery_required without lifecycle work after incomplete persistence rollback', async () => {
    const current = target();
    const test = harness(current);
    vi.mocked(test.repository.applyTarget).mockRejectedValueOnce(
      new MemberSettingsPersistenceFailedError('partial persistence rollback', true)
    );

    await expect(test.useCase.execute(request(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'recovery_required',
      recovery: {
        persistenceRestored: false,
        lifecycleRestored: true,
        cause: 'partial persistence rollback',
      },
    });
    expect(test.lifecycle.applyEffect).not.toHaveBeenCalled();
  });

  it('does not restore the old runtime when persistence rollback is unproven', async () => {
    const current = target();
    const test = harness(current);
    vi.mocked(test.lifecycle.applyEffect).mockRejectedValueOnce(new Error('partial restart'));
    vi.mocked(test.repository.restoreTarget).mockResolvedValueOnce(false);

    await expect(test.useCase.execute(request(current))).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'recovery_required',
      recovery: {
        persistenceRestored: false,
        lifecycleRestored: false,
      },
    });
    expect(test.lifecycle.restore).not.toHaveBeenCalled();
  });
});

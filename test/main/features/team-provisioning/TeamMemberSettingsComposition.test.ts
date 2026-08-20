import { ApplicationCommandRunOutcome } from '@features/application-command-ledger';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import { createTeamMemberSettingsFeature } from '@features/team-provisioning/main/composition/createTeamMemberSettingsFeature';
import { describe, expect, it, vi } from 'vitest';

import type { ApplicationCommandRunner } from '@features/application-command-ledger';
import type { UpdateMemberSettingsRequest } from '@features/team-provisioning/contracts/memberSettings';
import type { MemberSettingsRepositoryPort } from '@features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import type { MemberSettingsTargetSnapshot } from '@features/team-provisioning/core/domain/memberSettingsPolicy';

function snapshot(role: string): MemberSettingsTargetSnapshot {
  return {
    name: 'Alice',
    agentType: 'worker',
    agentId: 'agent-a',
    joinedAt: 1,
    settings: {
      role,
      workflow: null,
      isolation: null,
      providerId: 'codex',
      providerBackendId: null,
      model: null,
      effort: null,
      fastMode: null,
      mcpPolicy: null,
    },
    teamIsAlive: true,
    leadProviderId: 'codex',
    teamIsMixed: false,
    runtimeLane: 'primary',
  };
}

describe('createTeamMemberSettingsFeature', () => {
  it('replays a ledger duplicate without applying or attaching a second time', async () => {
    let current = snapshot('old');
    const applyTarget = vi.fn<MemberSettingsRepositoryPort['applyTarget']>(async (input) => {
      current = { ...current, settings: input.settings };
      return { outcome: 'applied', snapshot: current, rollbackToken: null };
    });
    const repository: MemberSettingsRepositoryPort = {
      findTarget: async () => current,
      classifyMissingTarget: async () => 'member_not_found',
      applyTarget,
      restoreTarget: async () => true,
    };
    const stored = new Map<string, unknown>();
    const commandRunner = {
      run: vi.fn(async (input: { idempotencyKey: string }, execute: () => Promise<unknown>) => {
        if (stored.has(input.idempotencyKey)) {
          return {
            outcome: ApplicationCommandRunOutcome.Replayed,
            result: stored.get(input.idempotencyKey),
          };
        }
        const result = await execute();
        stored.set(input.idempotencyKey, result);
        return { outcome: ApplicationCommandRunOutcome.Executed, result };
      }),
    } as unknown as ApplicationCommandRunner;
    const attachLiveRosterMember = vi.fn(async () => undefined);
    const feature = createTeamMemberSettingsFeature({
      repository,
      commandRunner,
      mutationSource: {
        runLiveRosterMutation: async (_teamName, operation) => {
          await operation();
        },
      },
      lifecycleSource: { attachLiveRosterMember, isTeamAlive: () => true },
    });
    const request: UpdateMemberSettingsRequest = {
      commandId: 'command-1',
      idempotencyKey: 'idem-1',
      teamName: ' Team-A ',
      memberName: ' ALICE ',
      expectedFingerprint: createMemberSettingsFingerprint(current),
      settings: { ...current.settings, role: 'new' },
    };

    const first = await feature.updateMemberSettings(request);
    const replay = await feature.updateMemberSettings(request);

    expect(first).toMatchObject({ replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(applyTarget).toHaveBeenCalledTimes(1);
    expect(attachLiveRosterMember).toHaveBeenCalledTimes(1);
    expect(commandRunner.run).toHaveBeenCalledTimes(2);
  });

  it('marks a process-local duplicate as replayed without a second lifecycle effect', async () => {
    let current = snapshot('old');
    const applyTarget = vi.fn<MemberSettingsRepositoryPort['applyTarget']>(async (input) => {
      current = { ...current, settings: input.settings };
      return { outcome: 'applied', snapshot: current, rollbackToken: null };
    });
    const attachLiveRosterMember = vi.fn(async () => undefined);
    const feature = createTeamMemberSettingsFeature({
      repository: {
        findTarget: async () => current,
        classifyMissingTarget: async () => 'member_not_found',
        applyTarget,
        restoreTarget: async () => true,
      },
      mutationSource: { runLiveRosterMutation: async (_team, operation) => operation() },
      lifecycleSource: { attachLiveRosterMember, isTeamAlive: () => true },
    });
    const request: UpdateMemberSettingsRequest = {
      commandId: 'command-local',
      idempotencyKey: 'idem-local',
      teamName: 'team-a',
      memberName: 'alice',
      expectedFingerprint: createMemberSettingsFingerprint(current),
      settings: { ...current.settings, role: 'new' },
    };

    const first = await feature.updateMemberSettings(request);
    const replay = await feature.updateMemberSettings(request);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(applyTarget).toHaveBeenCalledOnce();
    expect(attachLiveRosterMember).toHaveBeenCalledOnce();
  });

  it('retains process-local identities after failure while allowing only the same payload to retry', async () => {
    let current = snapshot('old');
    let attempt = 0;
    const applyTarget = vi.fn<MemberSettingsRepositoryPort['applyTarget']>(async (input) => {
      attempt += 1;
      if (attempt === 1) throw new Error('temporary failure');
      current = { ...current, settings: input.settings };
      return { outcome: 'applied', snapshot: current, rollbackToken: null };
    });
    const feature = createTeamMemberSettingsFeature({
      repository: {
        findTarget: async () => current,
        classifyMissingTarget: async () => 'member_not_found',
        applyTarget,
        restoreTarget: async () => true,
      },
      mutationSource: { runLiveRosterMutation: async (_team, operation) => operation() },
      lifecycleSource: { attachLiveRosterMember: async () => undefined, isTeamAlive: () => true },
    });
    const request: UpdateMemberSettingsRequest = {
      commandId: 'command-retry',
      idempotencyKey: 'idem-retry',
      teamName: 'team-a',
      memberName: 'alice',
      expectedFingerprint: createMemberSettingsFingerprint(current),
      settings: { ...current.settings, role: 'new' },
    };

    await expect(feature.updateMemberSettings(request)).rejects.toThrow('temporary failure');
    await expect(
      feature.updateMemberSettings({ ...request, settings: { ...request.settings, role: 'other' } })
    ).rejects.toThrow('identity was reused');
    await expect(feature.updateMemberSettings(request)).resolves.toMatchObject({
      outcome: 'completed',
      replayed: false,
    });
    await expect(feature.updateMemberSettings(request)).resolves.toMatchObject({
      outcome: 'completed',
      replayed: true,
    });
    expect(applyTarget).toHaveBeenCalledTimes(2);
  });

  it('reconciles an unknown durable outcome as recovery required without another lifecycle effect', async () => {
    const previous = snapshot('old');
    let current = previous;
    const proposed = { ...previous, settings: { ...previous.settings, role: 'new' } };
    const attachLiveRosterMember = vi.fn(async () => undefined);
    const commandRunner = {
      run: vi.fn(async (input: { reconcile: () => Promise<{ result?: unknown }> }) => {
        current = proposed;
        const reconciliation = await input.reconcile();
        return {
          outcome: ApplicationCommandRunOutcome.Reconciled,
          result: reconciliation.result,
        };
      }),
    } as unknown as ApplicationCommandRunner;
    const feature = createTeamMemberSettingsFeature({
      repository: {
        findTarget: async () => current,
        classifyMissingTarget: async () => 'member_not_found',
        applyTarget: vi.fn(),
        restoreTarget: async () => true,
      },
      commandRunner,
      mutationSource: { runLiveRosterMutation: async (_team, operation) => operation() },
      lifecycleSource: { attachLiveRosterMember, isTeamAlive: () => true },
    });

    await expect(
      feature.updateMemberSettings({
        commandId: 'command-unknown',
        idempotencyKey: 'idem-unknown',
        teamName: 'team-a',
        memberName: 'alice',
        expectedFingerprint: createMemberSettingsFingerprint(previous),
        settings: proposed.settings,
      })
    ).resolves.toMatchObject({
      outcome: 'completed',
      effect: 'recovery_required',
      replayed: false,
    });
    expect(attachLiveRosterMember).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  applyCurrentOpenCodeMemberIdentities,
  createPureOpenCodeRestartIdentityCurrentGuard,
  resolvePureOpenCodeRestartIdentity,
} from '../TeamProvisioningOpenCodeRestartIdentity';

import type { PersistedTeamLaunchSnapshot, ProviderModelLaunchIdentity } from '@shared/types';

function identity(
  providerBackendId: 'adapter' | 'opencode-cli',
  model: string,
  effort: 'low' | 'high',
  selectedFastMode: 'on' | 'off'
): ProviderModelLaunchIdentity {
  return {
    providerId: 'opencode',
    providerBackendId,
    billingMode: 'api',
    selectedModel: model,
    selectedModelKind: 'explicit',
    resolvedLaunchModel: model,
    catalogId: model,
    catalogSource: 'runtime',
    catalogFetchedAt: '2026-08-25T00:00:00.000Z',
    selectedEffort: effort,
    resolvedEffort: effort,
    selectedFastMode,
    resolvedFastMode: selectedFastMode === 'on',
    fastResolutionReason: 'test',
  };
}

function snapshot(
  memberIdentity: ProviderModelLaunchIdentity,
  primaryLaneIdentity: ProviderModelLaunchIdentity = memberIdentity
): PersistedTeamLaunchSnapshot {
  return {
    version: 3,
    teamName: 'team',
    updatedAt: '2026-08-25T00:00:00.000Z',
    leadSessionId: 'run-current',
    runtimeRunId: 'run-current',
    primaryLaneIdentity,
    launchPhase: 'active',
    expectedMembers: ['Worker'],
    members: {
      Worker: {
        name: 'Worker',
        providerId: 'opencode',
        providerBackendId: memberIdentity.providerBackendId ?? undefined,
        model: memberIdentity.resolvedLaunchModel ?? undefined,
        effort: memberIdentity.resolvedEffort ?? undefined,
        launchIdentity: memberIdentity,
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        runtimeRunId: 'run-current',
        lastEvaluatedAt: '2026-08-25T00:00:00.000Z',
      },
    },
    summary: {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    teamLaunchState: 'clean_success',
  };
}

describe('pure OpenCode restart identity', () => {
  it('uses the explicit run-bound primary lane identity', () => {
    const memberIdentity = identity('opencode-cli', 'qwen/member', 'low', 'on');
    const result = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'worker',
      launchSnapshot: snapshot(memberIdentity),
    });

    expect(result).toMatchObject({
      providerBackendId: 'opencode-cli',
      model: 'qwen/member',
      effort: 'low',
      fastMode: 'on',
    });
  });

  it('keeps lane model A when the restarted member desired model is B', () => {
    const laneIdentity = identity('adapter', 'qwen/lane-a', 'high', 'on');
    const memberIdentity = identity('adapter', 'qwen/member-b', 'low', 'off');
    const result = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      launchSnapshot: snapshot(memberIdentity, laneIdentity),
    });

    expect(result).toMatchObject({
      providerBackendId: 'adapter',
      model: 'qwen/lane-a',
      effort: 'high',
      fastMode: 'on',
    });
    expect(result.membersByName.get('worker')?.launchIdentity?.resolvedLaunchModel).toBe(
      'qwen/member-b'
    );
  });

  it('fails closed when launch-state evidence belongs to an older adapter run', () => {
    expect(() =>
      resolvePureOpenCodeRestartIdentity({
        runtimeRunId: 'run-new',
        memberName: 'Worker',
        launchSnapshot: snapshot(identity('adapter', 'qwen/worker', 'low', 'off')),
      })
    ).toThrow('not bound to the active adapter run');
  });

  it('rejects a persisted member runtime-run change before restart side effects', async () => {
    const initialSnapshot = snapshot(identity('adapter', 'qwen/worker', 'low', 'off'));
    const changedSnapshot = snapshot(identity('adapter', 'qwen/worker', 'low', 'off'));
    changedSnapshot.members.Worker.runtimeRunId = 'run-replaced';
    const expectedIdentity = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      launchSnapshot: initialSnapshot,
    });
    const persist = vi.fn();
    const launch = vi.fn();
    const assertCurrentIdentity = createPureOpenCodeRestartIdentityCurrentGuard({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      expectedIdentity,
      readLaunchSnapshot: async () => changedSnapshot,
      assertRuntimeRunStillCurrent: vi.fn(),
    });

    await expect(assertCurrentIdentity()).rejects.toThrow(
      'launch-state identity changed during member restart'
    );
    expect(persist).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed when current launch-state evidence is missing or stopped', () => {
    expect(() =>
      resolvePureOpenCodeRestartIdentity({
        runtimeRunId: 'run-current',
        memberName: 'Worker',
        launchSnapshot: null,
      })
    ).toThrow('identity is unavailable');

    expect(() =>
      resolvePureOpenCodeRestartIdentity({
        runtimeRunId: 'run-current',
        memberName: 'Worker',
        launchSnapshot: {
          ...snapshot(identity('adapter', 'qwen/worker', 'low', 'off')),
          stoppedAt: '2026-08-25T01:00:00.000Z',
        },
      })
    ).toThrow('identity is unavailable');
  });

  it('fails closed when launch state belongs to a different member', () => {
    const wrongMemberSnapshot = snapshot(identity('adapter', 'qwen/other', 'low', 'off'));
    wrongMemberSnapshot.members = {
      Other: { ...wrongMemberSnapshot.members.Worker, name: 'Other' },
    };

    expect(() =>
      resolvePureOpenCodeRestartIdentity({
        runtimeRunId: 'run-current',
        memberName: 'Worker',
        launchSnapshot: wrongMemberSnapshot,
      })
    ).toThrow('identity for member "Worker" is missing');
  });

  it('fails closed when current member and primary lane backends conflict', () => {
    const laneIdentity = identity('opencode-cli', 'qwen/lane', 'high', 'on');
    const memberIdentity = identity('adapter', 'qwen/member', 'low', 'off');
    const restartIdentity = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      launchSnapshot: snapshot(memberIdentity, laneIdentity),
    });

    expect(() =>
      applyCurrentOpenCodeMemberIdentities(
        [{ name: 'Worker', providerId: 'opencode' }],
        restartIdentity
      )
    ).toThrow('lead and member launch identities disagree');
  });

  it('requires every relaunched member to carry exact current-run launch identity', () => {
    const launchSnapshot = snapshot(identity('adapter', 'qwen/worker', 'low', 'off'));
    launchSnapshot.members.Sibling = {
      ...launchSnapshot.members.Worker,
      name: 'Sibling',
      runtimeRunId: 'run-stale',
    };
    const restartIdentity = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      launchSnapshot,
    });

    expect(() =>
      applyCurrentOpenCodeMemberIdentities(
        [
          { name: 'Worker', providerId: 'opencode' },
          { name: 'Sibling', providerId: 'opencode' },
        ],
        restartIdentity
      )
    ).toThrow('member "Sibling" is not bound to the active adapter run');

    launchSnapshot.members.Sibling = {
      ...launchSnapshot.members.Worker,
      name: 'Sibling',
      launchIdentity: undefined,
    };
    const identityWithoutSiblingLaunchIdentity = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      launchSnapshot,
    });
    expect(() =>
      applyCurrentOpenCodeMemberIdentities(
        [
          { name: 'Worker', providerId: 'opencode' },
          { name: 'Sibling', providerId: 'opencode' },
        ],
        identityWithoutSiblingLaunchIdentity
      )
    ).toThrow('Member "Sibling" OpenCode launch identity is incomplete');
  });

  it('replaces stale configured fast mode with each exact member launch identity', () => {
    const restartIdentity = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: 'run-current',
      memberName: 'Worker',
      launchSnapshot: snapshot(identity('adapter', 'qwen/worker', 'low', 'on')),
    });

    expect(
      applyCurrentOpenCodeMemberIdentities(
        [{ name: 'Worker', providerId: 'opencode', fastMode: 'off' as const }],
        restartIdentity
      )
    ).toEqual([
      expect.objectContaining({
        name: 'Worker',
        fastMode: 'on',
      }),
    ]);
  });
});

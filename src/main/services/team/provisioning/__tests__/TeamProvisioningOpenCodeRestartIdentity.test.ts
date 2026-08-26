import { describe, expect, it } from 'vitest';

import { resolvePureOpenCodeRestartIdentity } from '../TeamProvisioningOpenCodeRestartIdentity';

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
});

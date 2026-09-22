import { describe, expect, it } from 'vitest';

import { resolvePersistedRuntimeMemberIdentity } from '../TeamProvisioningPersistedRuntimeMemberIdentity';

import type { PersistedTeamLaunchMemberState } from '@shared/types';

function createPersistedMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'builder',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TeamProvisioningPersistedRuntimeMemberIdentity', () => {
  it('preserves identity fields from an existing persisted member', () => {
    expect(
      resolvePersistedRuntimeMemberIdentity({
        memberName: 'builder',
        previousMember: createPersistedMember({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'xhigh',
          selectedFastMode: 'on',
          resolvedFastMode: true,
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchIdentity: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            selectedModel: 'gpt-5.4',
            selectedModelKind: 'explicit',
            resolvedLaunchModel: 'gpt-5.4',
            catalogId: 'gpt-5.4',
            catalogSource: 'runtime',
            catalogFetchedAt: null,
            selectedEffort: 'xhigh',
            resolvedEffort: 'xhigh',
          },
        }),
      })
    ).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'xhigh',
      selectedFastMode: 'on',
      resolvedFastMode: true,
      laneId: 'primary',
      laneKind: 'primary',
      laneOwnerProviderId: 'codex',
      launchIdentity: {
        providerId: 'codex',
        resolvedLaunchModel: 'gpt-5.4',
      },
    });
  });

  it('resolves identity from a tracked OpenCode secondary lane', () => {
    expect(
      resolvePersistedRuntimeMemberIdentity({
        memberName: 'reviewer',
        trackedRun: {
          request: { providerId: 'anthropic', fastMode: 'off' },
          mixedSecondaryLanes: [
            {
              laneId: 'secondary:opencode:reviewer',
              member: { name: 'reviewer', model: 'opencode-large', effort: 'medium' },
            },
          ],
          effectiveMembers: [],
        },
      })
    ).toEqual({
      providerId: 'opencode',
      model: 'opencode-large',
      effort: 'medium',
      laneId: 'secondary:opencode:reviewer',
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
    });
  });

  it('resolves identity from a tracked primary member', () => {
    expect(
      resolvePersistedRuntimeMemberIdentity({
        memberName: 'coder',
        trackedRun: {
          request: { providerId: 'anthropic', providerBackendId: 'api', fastMode: 'on' },
          mixedSecondaryLanes: [],
          effectiveMembers: [
            {
              name: 'coder',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.4',
              effort: 'high',
            },
          ],
        },
      })
    ).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'high',
      selectedFastMode: 'on',
      laneId: 'primary',
      laneKind: 'primary',
      laneOwnerProviderId: 'anthropic',
    });
  });

  it('returns no identity fields when no persisted or tracked member matches', () => {
    expect(
      resolvePersistedRuntimeMemberIdentity({
        memberName: 'missing',
        trackedRun: {
          request: { providerId: 'anthropic' },
          mixedSecondaryLanes: [],
          effectiveMembers: [],
        },
      })
    ).toEqual({});
  });
});

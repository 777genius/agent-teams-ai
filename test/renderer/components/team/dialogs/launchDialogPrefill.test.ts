import { describe, expect, it } from 'vitest';

import { resolveLaunchDialogPrefill } from '@renderer/components/team/dialogs/launchDialogPrefill';

import type { ResolvedTeamMember, TeamCreateRequest, TeamProviderId } from '@shared/types';

function createStoredModelGetter(models: Partial<Record<TeamProviderId, string>>) {
  return (providerId: TeamProviderId): string => models[providerId] ?? '';
}

describe('resolveLaunchDialogPrefill', () => {
  it('prefills from the current lead runtime before localStorage defaults', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
      {
        name: 'alice',
        agentType: 'reviewer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ] as ResolvedTeamMember[];

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toEqual({
      providerId: 'codex',
      model: 'gpt-5.4',
      effort: 'medium',
    });
  });

  it('prefers the current lead runtime over a stale saved request', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
    ] as ResolvedTeamMember[];

    const savedRequest = {
      teamName: 'vector-room-2',
      cwd: '/tmp/project',
      providerId: 'anthropic',
      model: 'haiku',
      effort: 'low',
      members: [],
    } as TeamCreateRequest;

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest,
      previousLaunchParams: undefined,
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toEqual({
      providerId: 'codex',
      model: 'gpt-5.4',
      effort: 'medium',
    });
  });

  it('falls back to previous launch params when the current team snapshot is unavailable', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'codex',
        model: 'gpt-5.3-codex',
        effort: 'high',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toEqual({
      providerId: 'codex',
      model: 'gpt-5.3-codex',
      effort: 'high',
    });
  });

  it('does not carry a frozen Gemini model into an Anthropic fallback', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'gemini',
        model: 'gemini-2.5-flash-lite',
        effort: 'medium',
      },
    ] as ResolvedTeamMember[];

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest: null,
      previousLaunchParams: undefined,
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toEqual({
      providerId: 'anthropic',
      model: 'haiku',
      effort: 'medium',
    });
  });
});

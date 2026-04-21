import { describe, expect, it } from 'vitest';

import {
  clearInheritedMemberModelsUnavailableForProvider,
  resolveProviderScopedMemberModel,
} from '@renderer/components/team/dialogs/memberModelScope';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

describe('memberModelScope', () => {
  it('drops stale inherited member models that are not in the selected provider catalog', () => {
    const scoped = resolveProviderScopedMemberModel({
      memberModel: 'gemini-3-pro-preview',
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', ['opencode/minimax-m2.5-free']),
      ]),
    });

    expect(scoped).toEqual({
      providerId: 'opencode',
      model: '',
    });
  });

  it('preserves exact OpenCode raw model ids from the runtime catalog', () => {
    const scoped = resolveProviderScopedMemberModel({
      memberModel: 'opencode/minimax-m2.5-free',
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', ['opencode/minimax-m2.5-free']),
      ]),
    });

    expect(scoped).toEqual({
      providerId: 'opencode',
      model: 'opencode/minimax-m2.5-free',
    });
  });

  it('clears only inherited stale models after the selected non-Anthropic provider status is loaded', () => {
    const inheritedStale = draft({ id: 'inherited', model: 'gemini-3-pro-preview' });
    const explicitGemini = draft({
      id: 'explicit',
      providerId: 'gemini',
      model: 'gemini-3-pro-preview',
    });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [inheritedStale, explicitGemini],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', ['opencode/minimax-m2.5-free']),
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.members).toMatchObject([
      { id: 'inherited', model: '' },
      { id: 'explicit', providerId: 'gemini', model: 'gemini-3-pro-preview' },
    ]);
  });

  it('waits for non-Anthropic runtime status before mutating inherited models', () => {
    const member = draft({ model: 'opencode/minimax-m2.5-free' });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [member],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([]),
    });

    expect(result.changed).toBe(false);
    expect(result.members[0]).toBe(member);
  });
});

function providerStatuses(
  statuses: CliProviderStatus[]
): ReadonlyMap<TeamProviderId, CliProviderStatus> {
  return new Map(statuses.map((status) => [status.providerId as TeamProviderId, status]));
}

function providerStatus(providerId: TeamProviderId, models: string[]): CliProviderStatus {
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated: true,
    authMethod: 'opencode_managed',
    verificationState: 'verified',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: {
        plugins: { status: 'read-only', ownership: 'provider-scoped' },
        mcp: { status: 'read-only', ownership: 'provider-scoped' },
        skills: { status: 'read-only', ownership: 'provider-scoped' },
        apiKeys: { status: 'read-only', ownership: 'provider-scoped' },
      },
    },
    statusMessage: null,
    detailMessage: null,
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models,
    modelAvailability: [],
  };
}

function draft(overrides: Partial<MemberDraft>): MemberDraft {
  return {
    id: 'member',
    name: 'member',
    roleSelection: '',
    customRole: '',
    model: '',
    ...overrides,
  };
}

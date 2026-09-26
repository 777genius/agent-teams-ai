import { describe, expect, it } from 'vitest';

import {
  clearInheritedMemberModelsUnavailableForProvider,
  getDialogTeamModelValidationError,
} from './memberModelScope';
import { materializeOpenCodeDefaultSelections } from './openCodeDefaultModel';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

const CATALOG_MODELS = ['opencode/big-pickle', 'opencode/space-bunny-free'];
const VANISHED_ROUTE = 'openrouter/moonshotai/kimi-k2';

function freshOpenCodeStatus(): CliProviderStatus {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: null,
    verificationState: 'verified',
    modelVerificationState: 'verified',
    modelCatalogRefreshState: 'ready',
    capabilities: { teamLaunch: true },
    models: CATALOG_MODELS,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-09-25T00:00:00.000Z',
      staleAt: '2099-01-01T00:00:00.000Z',
      defaultModelId: 'opencode/big-pickle',
      defaultLaunchModel: 'opencode/big-pickle',
      models: CATALOG_MODELS.map((id) => ({
        id,
        launchModel: id,
        displayName: id,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: id === 'opencode/big-pickle',
        upgrade: false,
        source: 'app-server',
      })),
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  } as unknown as CliProviderStatus;
}

describe('an inherited OpenCode route that a fresh catalog no longer offers', () => {
  it('stays selected and blocks the dialog instead of launching the Default route', () => {
    const teammate: MemberDraft = {
      id: 'm',
      name: 'bob',
      roleSelection: '',
      customRole: '',
      model: VANISHED_ROUTE,
    };
    const runtimeProviderStatusById = new Map<TeamProviderId, CliProviderStatus>([
      ['opencode', freshOpenCodeStatus()],
    ]);
    const scope = {
      openCodeLocalProviderIds: new Set<string>(),
      openCodeLocalProviderLookupAuthoritative: true,
      openCodeProviderScopedStatusBySourceId: new Map<string, CliProviderStatus>(),
    };

    const sanitized = clearInheritedMemberModelsUnavailableForProvider({
      members: [teammate],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById,
      ...scope,
    });
    expect(sanitized.members[0].model).toBe(VANISHED_ROUTE);

    const materialized = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'opencode',
      selectedModel: 'opencode/space-bunny-free',
      members: sanitized.members,
      syncModelsWithLead: false,
      projectDefault: { state: 'available', model: 'opencode/big-pickle' },
    });
    expect(materialized.members[0].model).toBe(VANISHED_ROUTE);

    const error = getDialogTeamModelValidationError({
      selectedProviderId: 'opencode',
      selectedModel: materialized.selectedModel,
      members: materialized.members,
      validateMembers: true,
      runtimeProviderStatusById,
      runtimeProviderLoadingById: new Map(),
      ...scope,
    });
    expect(error).toContain('bob');
    expect(error).toContain(VANISHED_ROUTE);
  });

  it('is still cleared when the lead switched to a provider it does not belong to', () => {
    const teammate: MemberDraft = {
      id: 'm',
      name: 'bob',
      roleSelection: '',
      customRole: '',
      model: 'gemini-3-pro-preview',
    };
    const sanitized = clearInheritedMemberModelsUnavailableForProvider({
      members: [teammate],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: new Map<TeamProviderId, CliProviderStatus>([
        ['opencode', freshOpenCodeStatus()],
      ]),
      openCodeLocalProviderIds: new Set<string>(),
      openCodeLocalProviderLookupAuthoritative: true,
      openCodeProviderScopedStatusBySourceId: new Map<string, CliProviderStatus>(),
    });
    expect(sanitized).toEqual({ members: [{ ...teammate, model: '' }], changed: true });
  });
});

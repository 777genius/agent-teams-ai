import { describe, expect, it } from 'vitest';

import { getDialogTeamModelValidationError } from './memberModelScope';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

function createOpenCodeProviderStatus(): CliProviderStatus {
  const model = {
    id: 'openrouter/auto',
    launchModel: 'openrouter/auto',
    displayName: 'OpenRouter Auto',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: true,
    upgrade: false,
    source: 'app-server' as const,
  };
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    models: [model.launchModel],
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-07-26T00:00:00.000Z',
      staleAt: '2026-07-26T00:10:00.000Z',
      defaultModelId: model.id,
      defaultLaunchModel: model.launchModel,
      models: [model],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    modelAvailability: [],
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'app-server' },
      reasoningEffort: { supported: false, values: [], configPassthrough: false },
    },
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
  };
}

function member(input: Partial<MemberDraft>): MemberDraft {
  return {
    id: input.id ?? 'member-1',
    name: input.name ?? 'bob',
    roleSelection: input.roleSelection ?? 'implementer',
    customRole: input.customRole ?? '',
    ...input,
  };
}

const providerStatusById = new Map<TeamProviderId, CliProviderStatus>([
  ['opencode', createOpenCodeProviderStatus()],
]);
const providerLoadingById = new Map<TeamProviderId, boolean>();

describe('getDialogTeamModelValidationError', () => {
  it('allows a built-in Ollama lead route outside the general OpenCode catalog', () => {
    expect(
      getDialogTeamModelValidationError({
        selectedProviderId: 'opencode',
        selectedModel: 'ollama/qwen3:8b',
        members: [],
        validateMembers: true,
        runtimeProviderStatusById: providerStatusById,
        runtimeProviderLoadingById: providerLoadingById,
        openCodeLocalProviderIds: new Set(),
        openCodeLocalProviderLookupAuthoritative: true,
      })
    ).toBeNull();
  });

  it('allows an authoritative custom local teammate route outside the general catalog', () => {
    expect(
      getDialogTeamModelValidationError({
        selectedProviderId: 'opencode',
        selectedModel: 'openrouter/auto',
        members: [member({ providerId: 'opencode', model: 'local-lab/team-model' })],
        validateMembers: true,
        runtimeProviderStatusById: providerStatusById,
        runtimeProviderLoadingById: providerLoadingById,
        openCodeLocalProviderIds: new Set(['local-lab']),
        openCodeLocalProviderLookupAuthoritative: true,
      })
    ).toBeNull();
  });

  it('defers a saved custom route when the local-provider lookup is not authoritative', () => {
    expect(
      getDialogTeamModelValidationError({
        selectedProviderId: 'opencode',
        selectedModel: 'openrouter/auto',
        members: [member({ providerId: 'opencode', model: 'local-lab/team-model' })],
        validateMembers: true,
        runtimeProviderStatusById: providerStatusById,
        runtimeProviderLoadingById: providerLoadingById,
        openCodeLocalProviderIds: new Set(),
        openCodeLocalProviderLookupAuthoritative: false,
      })
    ).toBeNull();
  });

  it('keeps an unproven custom route blocked by renderer validation', () => {
    expect(
      getDialogTeamModelValidationError({
        selectedProviderId: 'opencode',
        selectedModel: 'openrouter/auto',
        members: [member({ providerId: 'opencode', model: 'unknown-route/team-model' })],
        validateMembers: true,
        runtimeProviderStatusById: providerStatusById,
        runtimeProviderLoadingById: providerLoadingById,
        openCodeLocalProviderIds: new Set(['local-lab']),
        openCodeLocalProviderLookupAuthoritative: true,
      })
    ).toContain('bob: Model "unknown-route/team-model" is not available');
  });
});

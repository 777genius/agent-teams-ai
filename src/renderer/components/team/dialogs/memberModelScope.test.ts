import {
  hasSettledOpenCodeScopedPreparation,
  isTeamProviderRuntimeStatusLoading,
} from '@renderer/utils/teamProviderRuntimeStatusLoading';
import { describe, expect, it } from 'vitest';

import {
  clearInheritedMemberModelsUnavailableForProvider,
  getDialogTeamModelValidationError,
} from './memberModelScope';
import { createLaunchGuard } from './providerLaunchAuthority';

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

  it('preserves an inherited custom member route while project lookup is not authoritative', () => {
    const savedMember = member({ model: 'project-local/team-model' });

    expect(
      clearInheritedMemberModelsUnavailableForProvider({
        members: [savedMember],
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: providerStatusById,
        openCodeLocalProviderIds: new Set(),
        openCodeLocalProviderLookupAuthoritative: false,
      })
    ).toEqual({ members: [savedMember], changed: false });
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

  it('preserves an inherited OpenCode model until empty-catalog verification is terminal', () => {
    const savedMember = member({ model: 'openrouter/auto' });
    const pending = {
      ...createOpenCodeProviderStatus(),
      models: [],
      verificationState: 'unknown' as const,
      statusCheckOutcome: 'pending' as const,
      modelCatalogRefreshState: 'loading' as const,
      modelCatalog: {
        ...createOpenCodeProviderStatus().modelCatalog!,
        status: 'degraded' as const,
        models: [],
        defaultModelId: null,
        defaultLaunchModel: null,
      },
    };
    const authoritative = {
      ...pending,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      modelCatalogRefreshState: 'ready' as const,
      modelCatalog: {
        ...pending.modelCatalog,
        status: 'ready' as const,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        staleAt: '2099-01-01T00:10:00.000Z',
      },
    };

    expect(
      clearInheritedMemberModelsUnavailableForProvider({
        members: [savedMember],
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: new Map([['opencode', pending]]),
      })
    ).toEqual({ members: [savedMember], changed: false });

    const scoped = createOpenCodeProviderStatus();
    scoped.modelCatalogRefreshState = 'ready';
    scoped.modelCatalog = {
      ...scoped.modelCatalog!,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      staleAt: '2099-01-01T00:10:00.000Z',
    };
    expect(
      clearInheritedMemberModelsUnavailableForProvider({
        members: [savedMember],
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: new Map([['opencode', pending]]),
        openCodeProviderScopedStatusBySourceId: new Map([['openrouter', scoped]]),
      })
    ).toEqual({ members: [savedMember], changed: false });

    expect(
      clearInheritedMemberModelsUnavailableForProvider({
        members: [savedMember],
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: new Map([['opencode', authoritative]]),
      })
    ).toEqual({ members: [{ ...savedMember, model: '' }], changed: true });
  });

  it('settles model-only preparation only with every selected scoped catalog fresh', () => {
    const passive = {
      ...createOpenCodeProviderStatus(),
      models: [],
      statusCheckOutcome: 'model_only' as const,
      verificationState: 'unknown' as const,
      modelCatalogRefreshState: 'loading' as const,
      backend: { kind: 'opencode-cli', label: 'OpenCode' },
      statusMessage: 'Checking...',
      modelCatalog: {
        ...createOpenCodeProviderStatus().modelCatalog!,
        status: 'degraded' as const,
        models: [],
        defaultModelId: null,
        defaultLaunchModel: null,
      },
    };
    const scoped = createOpenCodeProviderStatus();
    scoped.modelCatalogRefreshState = 'ready';
    scoped.modelCatalog = {
      ...scoped.modelCatalog!,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      staleAt: '2099-01-01T00:10:00.000Z',
    };
    const evidence = {
      selectedModels: ['openrouter/auto'],
      scopedStatusBySourceId: new Map([['openrouter', scoped]]),
    };

    expect(hasSettledOpenCodeScopedPreparation(passive, evidence)).toBe(true);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...evidence,
        selectedModels: ['openrouter/auto', 'anthropic/claude-sonnet'],
      })
    ).toBe(false);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, evidence, Date.parse('2100-01-01T00:00:00.000Z'))
    ).toBe(false);
    expect(isTeamProviderRuntimeStatusLoading('opencode', passive, false, evidence)).toBe(false);
    expect(
      createLaunchGuard(['opencode'], new Map([['opencode', passive]]), evidence).blocked(true)
    ).toBe(false);

    const failedScoped = {
      ...scoped,
      modelCatalogRefreshState: 'error' as const,
      modelCatalog: {
        ...scoped.modelCatalog,
        status: 'stale' as const,
        diagnostics: {
          ...scoped.modelCatalog.diagnostics,
          message: 'Provider catalog refresh failed.',
        },
      },
    };
    const failedEvidence = {
      ...evidence,
      scopedStatusBySourceId: new Map([['openrouter', failedScoped]]),
    };
    expect(isTeamProviderRuntimeStatusLoading('opencode', passive, false, failedEvidence)).toBe(
      false
    );
    expect(
      createLaunchGuard(['opencode'], new Map([['opencode', passive]]), failedEvidence).blockers(
        true
      )
    ).toEqual([
      expect.objectContaining({
        providerId: 'opencode',
        providerStatus: failedScoped,
        detail: 'Provider catalog refresh failed.',
      }),
    ]);

    const missingEvidence = { ...evidence, scopedStatusBySourceId: new Map() };
    expect(isTeamProviderRuntimeStatusLoading('opencode', passive, false, missingEvidence)).toBe(
      true
    );
    expect(
      createLaunchGuard(['opencode'], new Map([['opencode', passive]]), missingEvidence).blocked(
        true
      )
    ).toBe(true);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...evidence,
        selectedModels: ['unqualified-model'],
      })
    ).toBe(false);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...evidence,
        selectedModels: [],
      })
    ).toBe(false);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...missingEvidence,
        selectedModels: ['ollama/local-model'],
      })
    ).toBe(true);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...missingEvidence,
        selectedModels: ['local-lab/model'],
        localSourceIds: new Set(['local-lab']),
        localProviderLookupAuthoritative: true,
      })
    ).toBe(true);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...missingEvidence,
        selectedModels: ['local-lab/model'],
        localSourceIds: new Set(['local-lab']),
        localProviderLookupAuthoritative: false,
      })
    ).toBe(true);
    expect(
      hasSettledOpenCodeScopedPreparation(passive, {
        ...missingEvidence,
        selectedModels: ['unknown-local/model'],
        localSourceIds: new Set(['local-lab']),
        localProviderLookupAuthoritative: true,
      })
    ).toBe(false);
  });
});

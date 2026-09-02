import {
  clearInheritedMemberModelsUnavailableForProvider,
  resolveProviderScopedMemberModel,
} from '@renderer/components/team/dialogs/memberModelScope';
import { describe, expect, it } from 'vitest';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

describe('memberModelScope', () => {
  it('preserves inherited Codex models while account availability is pending', () => {
    const member = draft({ name: 'researcher', model: 'gpt-5.4' });
    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [member],
      selectedProviderId: 'codex',
      runtimeProviderStatusById: providerStatuses([providerStatus('codex', [])]),
      deferredProviderIds: new Set(['codex']),
    });

    expect(result).toEqual({ members: [member], changed: false });
  });

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

  it('preserves a saved teammate model until cold-start provider status arrives', () => {
    const scoped = resolveProviderScopedMemberModel({
      memberProviderId: 'opencode',
      memberModel: 'ollama/qwen2.5-coder:0.5b',
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([]),
    });

    expect(scoped).toEqual({
      providerId: 'opencode',
      model: 'ollama/qwen2.5-coder:0.5b',
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

  it('preserves explicit OpenCode member models when the general runtime catalog is empty', () => {
    const explicitOpenCode = draft({
      id: 'explicit-opencode',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [explicitOpenCode],
      selectedProviderId: 'anthropic',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', [], {
          modelCatalogRefreshState: 'ready',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: null,
            defaultLaunchModel: null,
            models: [],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }),
      ]),
    });

    expect(result.changed).toBe(false);
    expect(result.members[0]).toBe(explicitOpenCode);
  });

  it('preserves inherited Ollama overlay routes when the general runtime catalog is empty', () => {
    const localModel = draft({
      id: 'local-opencode',
      model: 'ollama/qwen3-coder:30b',
    });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [localModel],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', [], {
          modelCatalogRefreshState: 'ready',
        }),
      ]),
    });

    expect(result.changed).toBe(false);
    expect(result.members[0]).toBe(localModel);
  });

  it('preserves a custom local route while provider lookup is not authoritative', () => {
    const customLocalModel = draft({ model: 'local-lab/team-model' });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [customLocalModel],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', ['opencode/minimax-m2.5-free']),
      ]),
      openCodeLocalProviderLookupAuthoritative: false,
    });

    expect(result).toEqual({ members: [customLocalModel], changed: false });
  });

  it('preserves a model owned by a configured custom local provider', () => {
    expect(
      resolveProviderScopedMemberModel({
        memberProviderId: 'opencode',
        memberModel: 'local-lab/team-model',
        selectedProviderId: 'anthropic',
        runtimeProviderStatusById: providerStatuses([
          providerStatus('opencode', ['opencode/minimax-m2.5-free']),
        ]),
        openCodeLocalProviderIds: new Set(['local-lab']),
        openCodeLocalProviderLookupAuthoritative: true,
      })
    ).toEqual({ providerId: 'opencode', model: 'local-lab/team-model' });
  });

  it('preserves explicit OpenCode member models while the catalog is still loading', () => {
    const explicitOpenCode = draft({
      id: 'explicit-opencode',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [explicitOpenCode],
      selectedProviderId: 'anthropic',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', [], {
          modelCatalogRefreshState: 'loading',
        }),
      ]),
    });

    expect(result.changed).toBe(false);
    expect(result.members[0]).toBe(explicitOpenCode);
  });

  it('preserves a teammate model when the project catalog refresh fails', () => {
    const scoped = resolveProviderScopedMemberModel({
      memberProviderId: 'opencode',
      memberModel: 'ollama/qwen2.5-coder:0.5b',
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', [], {
          verificationState: 'error',
          modelCatalogRefreshState: 'error',
        }),
      ]),
    });

    expect(scoped).toEqual({
      providerId: 'opencode',
      model: 'ollama/qwen2.5-coder:0.5b',
    });
  });

  it('does not clear inherited OpenCode models after a catalog refresh error', () => {
    const member = draft({ model: 'ollama/qwen2.5-coder:0.5b' });

    const result = clearInheritedMemberModelsUnavailableForProvider({
      members: [member],
      selectedProviderId: 'opencode',
      runtimeProviderStatusById: providerStatuses([
        providerStatus('opencode', [], {
          verificationState: 'error',
          modelCatalogRefreshState: 'error',
        }),
      ]),
    });

    expect(result.changed).toBe(false);
    expect(result.members[0]).toBe(member);
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
  it('preserves a passive model-only OpenCode selection while scoped verification loads', () => {
    const passiveStatus = providerStatus('opencode', [], {
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      modelCatalogRefreshState: 'loading',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    });
    const member = draft({ model: 'openrouter/provider-model-b' });

    expect(
      resolveProviderScopedMemberModel({
        memberModel: member.model,
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: providerStatuses([passiveStatus]),
      })
    ).toEqual({ providerId: 'opencode', model: 'openrouter/provider-model-b' });
    expect(
      clearInheritedMemberModelsUnavailableForProvider({
        members: [member],
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: providerStatuses([passiveStatus]),
      })
    ).toEqual({ members: [member], changed: false });
  });

  it('uses the selector scoped catalog instead of a narrower passive summary', () => {
    const scopedStatus = freshScopedProviderStatus([
      'openrouter/provider-model-a',
      'openrouter/provider-model-b',
    ]);

    expect(
      resolveProviderScopedMemberModel({
        memberModel: 'openrouter/provider-model-b',
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: providerStatuses([
          providerStatus('opencode', ['openrouter/provider-model-a']),
        ]),
        openCodeProviderScopedStatusBySourceId: new Map([['openrouter', scopedStatus]]),
      })
    ).toEqual({ providerId: 'opencode', model: 'openrouter/provider-model-b' });
  });

  it('rejects an absent model once the selector scoped catalog is authoritatively settled', () => {
    const scopedStatus = freshScopedProviderStatus(['openrouter/provider-model-a']);

    expect(
      resolveProviderScopedMemberModel({
        memberModel: 'openrouter/provider-model-b',
        selectedProviderId: 'opencode',
        runtimeProviderStatusById: providerStatuses([
          providerStatus('opencode', ['openrouter/provider-model-a']),
        ]),
        openCodeProviderScopedStatusBySourceId: new Map([['openrouter', scopedStatus]]),
      })
    ).toEqual({ providerId: 'opencode', model: '' });
  });
});

function freshScopedProviderStatus(models: string[]): CliProviderStatus {
  return providerStatus('opencode', models, {
    modelCatalogRefreshState: 'ready',
    modelAvailability: models.map((modelId) => ({
      modelId,
      status: 'available',
      reason: null,
      checkedAt: null,
    })),
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2099-01-01T00:00:00.000Z',
      staleAt: '2099-01-01T00:10:00.000Z',
      defaultModelId: models[0] ?? null,
      defaultLaunchModel: models[0] ?? null,
      models: models.map((model) => ({
        id: model,
        launchModel: model,
        displayName: model,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: model === models[0],
        upgrade: false,
        source: 'app-server',
      })),
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  });
}

function providerStatuses(
  statuses: CliProviderStatus[]
): ReadonlyMap<TeamProviderId, CliProviderStatus> {
  return new Map(statuses.map((status) => [status.providerId as TeamProviderId, status]));
}

function providerStatus(
  providerId: TeamProviderId,
  models: string[],
  overrides: Partial<CliProviderStatus> = {}
): CliProviderStatus {
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
    ...overrides,
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

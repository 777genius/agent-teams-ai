import { describe, expect, it } from 'vitest';

import {
  formatOpenCodeDefaultRouteLabel,
  formatOpenCodeDefaultRouteModelLabel,
  materializeOpenCodeDefaultSelections,
  type OpenCodeProjectDefaultModel,
  resolveOpenCodeProjectDefaultModel,
} from './openCodeDefaultModel';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus } from '@shared/types';

const DEFAULT_ROUTE = 'opencode/big-pickle';
const AVAILABLE: OpenCodeProjectDefaultModel = { state: 'available', model: DEFAULT_ROUTE };

function catalogStatus(
  overrides: {
    defaultLaunchModel?: string | null;
    status?: string;
    hidden?: boolean;
    accessKind?: string;
    proofState?: string;
    availability?: 'available' | 'unavailable';
    models?: string[];
  } = {}
): CliProviderStatus {
  const models = overrides.models ?? [DEFAULT_ROUTE, 'opencode/space-bunny-free'];
  return {
    providerId: 'opencode',
    models,
    modelAvailability: overrides.availability
      ? [{ modelId: DEFAULT_ROUTE, status: overrides.availability }]
      : undefined,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: overrides.status ?? 'ready',
      defaultModelId: null,
      defaultLaunchModel:
        overrides.defaultLaunchModel === undefined ? DEFAULT_ROUTE : overrides.defaultLaunchModel,
      models: models.map((id) => ({
        id,
        launchModel: id,
        displayName: id,
        hidden: id === DEFAULT_ROUTE ? overrides.hidden === true : false,
        metadata: {
          opencode: {
            accessKind:
              id === DEFAULT_ROUTE ? (overrides.accessKind ?? 'builtin_free') : 'builtin_free',
            routeKind: 'builtin_free',
            proofState:
              id === DEFAULT_ROUTE ? (overrides.proofState ?? 'needs_probe') : 'needs_probe',
          },
        },
      })),
    },
  } as unknown as CliProviderStatus;
}

function member(overrides: Partial<MemberDraft>): MemberDraft {
  return { id: 'm', name: 'alice', roleSelection: '', customRole: '', model: '', ...overrides };
}

describe('resolveOpenCodeProjectDefaultModel', () => {
  it('returns the catalog default route when it can launch', () => {
    expect(resolveOpenCodeProjectDefaultModel(catalogStatus())).toEqual(AVAILABLE);
  });

  it('accepts a default the runtime lists even when catalog metadata is partial', () => {
    const status = catalogStatus();
    status.modelCatalog!.models = [];
    expect(resolveOpenCodeProjectDefaultModel(status)).toEqual(AVAILABLE);
  });

  it('is unknown until the project catalog is loaded', () => {
    expect(resolveOpenCodeProjectDefaultModel(null)).toEqual({ state: 'unknown' });
    expect(resolveOpenCodeProjectDefaultModel(catalogStatus({ status: 'unavailable' }))).toEqual({
      state: 'unknown',
    });
  });

  it('resolves a bare default id through its catalog entry', () => {
    const status = catalogStatus({ defaultLaunchModel: null });
    status.modelCatalog!.defaultModelId = 'big-pickle';
    status.modelCatalog!.models[0] = { ...status.modelCatalog!.models[0], id: 'big-pickle' };
    expect(resolveOpenCodeProjectDefaultModel(status)).toEqual(AVAILABLE);
  });

  it('keeps naming the default while a stale catalog refreshes', () => {
    expect(resolveOpenCodeProjectDefaultModel(catalogStatus({ status: 'stale' }))).toEqual(
      AVAILABLE
    );
  });

  it.each([
    ['no default in the catalog', catalogStatus({ defaultLaunchModel: null })],
    ['an unqualified default id', catalogStatus({ defaultLaunchModel: 'big-pickle' })],
    ['a default missing from the catalog', catalogStatus({ models: ['opencode/other-free'] })],
    ['a hidden default', catalogStatus({ hidden: true })],
    ['a default that needs a connection', catalogStatus({ accessKind: 'not_authenticated' })],
    ['a default whose execution failed', catalogStatus({ accessKind: 'execution_failed' })],
    ['a default whose proof failed', catalogStatus({ proofState: 'failed' })],
    ['a default marked unavailable', catalogStatus({ availability: 'unavailable' })],
  ])('is unavailable for %s', (_label, status) => {
    expect(resolveOpenCodeProjectDefaultModel(status)).toEqual({ state: 'unavailable' });
  });
});

describe('materializeOpenCodeDefaultSelections', () => {
  it('turns an OpenCode lead left on Default into the concrete route', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'opencode',
      selectedModel: '',
      members: [],
      syncModelsWithLead: true,
      projectDefault: AVAILABLE,
    });
    expect(result.selectedModel).toBe(DEFAULT_ROUTE);
    expect(result.leadUnresolved).toBe(false);
  });

  it('keeps explicit selections untouched', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'opencode',
      selectedModel: 'opencode/space-bunny-free',
      members: [member({ providerId: 'opencode', model: 'openrouter/some/model' })],
      syncModelsWithLead: false,
      projectDefault: AVAILABLE,
    });
    expect(result.selectedModel).toBe('opencode/space-bunny-free');
    expect(result.members[0].model).toBe('openrouter/some/model');
  });

  it('materializes an OpenCode teammate under a non-OpenCode lead', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'anthropic',
      selectedModel: 'opus[1m]',
      members: [member({ providerId: 'opencode' })],
      syncModelsWithLead: true,
      projectDefault: AVAILABLE,
    });
    expect(result.selectedModel).toBe('opus[1m]');
    expect(result.members[0].model).toBe(DEFAULT_ROUTE);
  });

  it('leaves a synced teammate inheriting the explicit OpenCode lead model', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'opencode',
      selectedModel: 'opencode/space-bunny-free',
      members: [member({})],
      syncModelsWithLead: true,
      projectDefault: AVAILABLE,
    });
    expect(result.members[0].model).toBe('');
  });

  it('gives an unsynced teammate on the lead provider the default, like main does', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'opencode',
      selectedModel: 'opencode/space-bunny-free',
      members: [member({})],
      syncModelsWithLead: false,
      projectDefault: AVAILABLE,
    });
    expect(result.members[0].model).toBe(DEFAULT_ROUTE);
  });

  it('ignores removed and non-OpenCode teammates', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'anthropic',
      selectedModel: '',
      members: [
        member({ id: 'a', providerId: 'opencode', removedAt: 1 }),
        member({ id: 'b', providerId: 'codex' }),
        member({ id: 'c' }),
      ],
      syncModelsWithLead: false,
      projectDefault: AVAILABLE,
    });
    expect(result.selectedModel).toBe('');
    expect(result.members.map((m) => m.model)).toEqual(['', '', '']);
    expect(result.unresolvedMemberNames).toEqual([]);
  });

  it('reports Default selections it cannot materialize and never invents a route', () => {
    const result = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'opencode',
      selectedModel: '',
      members: [member({ name: 'bob', providerId: 'opencode' })],
      syncModelsWithLead: false,
      projectDefault: { state: 'unavailable' },
    });
    expect(result.selectedModel).toBe('');
    expect(result.leadUnresolved).toBe(true);
    expect(result.members[0].model).toBe('');
    expect(result.unresolvedMemberNames).toEqual(['bob']);
  });
});

describe('formatOpenCodeDefaultRouteLabel', () => {
  it('names the model and its source without repeating the source prefix', () => {
    expect(formatOpenCodeDefaultRouteLabel(DEFAULT_ROUTE)).toBe('big-pickle (OpenCode Zen)');
    expect(formatOpenCodeDefaultRouteLabel(DEFAULT_ROUTE, catalogStatus())).toBe(
      'big-pickle (OpenCode Zen)'
    );
  });

  it('names only the model for narrow triggers', () => {
    expect(formatOpenCodeDefaultRouteModelLabel(DEFAULT_ROUTE)).toBe('big-pickle');
    expect(formatOpenCodeDefaultRouteModelLabel(DEFAULT_ROUTE, catalogStatus())).toBe('big-pickle');
  });

  it('prefers a real catalog display name', () => {
    const status = catalogStatus();
    status.modelCatalog!.models[0].displayName = 'Big Pickle';
    expect(formatOpenCodeDefaultRouteLabel(DEFAULT_ROUTE, status)).toBe(
      'Big Pickle (OpenCode Zen)'
    );
  });
});

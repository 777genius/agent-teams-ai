import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
  reconcileCliStatus,
} from '@renderer/store/slices/cliInstallerSlice';
import {
  CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT,
  reconcileGlobalProviderLaunchProofs,
  reconcileScopedProviderLaunchProofs,
} from '@renderer/store/slices/scopedCliProviderLaunchProof';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { ScopedCliProviderLaunchProof } from '@renderer/store/slices/scopedCliProviderLaunchProof';
import type { ElectronAPI } from '@shared/types/api';
import type {
  CliProviderReasoningEffort,
  CliProviderStatus,
  CliProviderStatusIpcRequest,
  CliProviderStatusIpcResponse,
  OpenCodeRuntimeStatus,
} from '@shared/types/cliInstaller';
import type { StateCreator } from 'zustand';

function createCliInstallerStore() {
  return createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
}

function installElectronApi(openCodeRuntime: ElectronAPI['openCodeRuntime']): () => void {
  const previousApi = window.electronAPI;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { openCodeRuntime } as ElectronAPI,
  });
  return () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: previousApi,
    });
  };
}

function withProviderStatusEnvelope(
  implementation: (
    providerId: string,
    request: CliProviderStatusIpcRequest
  ) => CliProviderStatus | null | Promise<CliProviderStatus | null>
): ElectronAPI['cliInstaller']['getProviderStatus'] {
  return async (providerId, request): Promise<CliProviderStatusIpcResponse> => {
    const providerStatus = await implementation(providerId, request);
    return {
      providerStatus,
      purpose: request.purpose,
      requestNonce: request.requestNonce,
      observationGeneration: 1,
      observationNonce: `main-observation-${request.requestNonce}`,
      authorityScope:
        request.purpose === 'launch-proof' &&
        request.projectPath &&
        providerStatus?.statusCheckOutcome === 'authoritative'
          ? {
              schemaVersion: 1,
              providerId: providerStatus.providerId,
              projectPath: request.projectPath,
              globalGeneration: 1,
              profileGeneration: 1,
              catalogGeneration: 1,
            }
          : null,
    };
  };
}

describe('provider launch proof authority reconciliation', () => {
  const projectA = '/project/a';
  const projectB = '/project/b';
  const scopeA = getCliProviderStatusScopeKey('codex', projectA);
  const scopeB = getCliProviderStatusScopeKey('codex', projectB);
  const base = createLoadingMultimodelCliStatus();
  const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
  const ready: CliProviderStatus = {
    ...codex,
    supported: true,
    authenticated: true,
    authMethod: 'codex_chatgpt',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    capabilities: { ...codex.capabilities, teamLaunch: true },
    models: ['gpt-v1'],
  };
  const authorityScope = (
    projectPath: string,
    generations: { global?: number; profile?: number; catalog?: number } = {}
  ) => ({
    schemaVersion: 1 as const,
    providerId: 'codex' as const,
    projectPath,
    globalGeneration: generations.global ?? 1,
    profileGeneration: generations.profile ?? 1,
    catalogGeneration: generations.catalog ?? 1,
  });
  const proofs = {
    [scopeA]: {
      providerStatus: ready,
      requestId: 1,
      epoch: 1,
      fetchedAtMs: 1,
      authorityScope: authorityScope(projectA),
    },
    [scopeB]: {
      providerStatus: ready,
      requestId: 2,
      epoch: 1,
      fetchedAtMs: 1,
      authorityScope: authorityScope(projectB),
    },
  };

  const reconcileProject = (
    current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
    projectPath: string,
    providerStatus: CliProviderStatus,
    generations: { global?: number; profile?: number; catalog?: number } = {}
  ) =>
    reconcileScopedProviderLaunchProofs({
      current,
      scopeKey: getCliProviderStatusScopeKey('codex', projectPath),
      providerId: 'codex',
      projectPath,
      providerStatus,
      responseMatchesProvider: true,
      metadataMatchesRequest: true,
      authorityScope: authorityScope(projectPath, generations),
      requestIntent: 'launch-proof',
      requestId: 3,
      epoch: 1,
      fetchedAtMs: 2,
    });

  const reconcileProviderProject = (
    current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
    providerId: 'anthropic' | 'codex' | 'gemini' | 'opencode',
    projectPath: string,
    providerStatus: CliProviderStatus,
    generations: { global?: number; profile?: number; catalog?: number } = {}
  ) =>
    reconcileScopedProviderLaunchProofs({
      current,
      scopeKey: getCliProviderStatusScopeKey(providerId, projectPath),
      providerId,
      projectPath,
      providerStatus,
      responseMatchesProvider: true,
      metadataMatchesRequest: true,
      authorityScope: {
        ...authorityScope(projectPath, generations),
        providerId,
      },
      requestIntent: 'launch-proof',
      requestId: 3,
      epoch: 1,
      fetchedAtMs: 2,
    });

  const readyFor = (
    providerId: 'anthropic' | 'codex' | 'gemini' | 'opencode'
  ): CliProviderStatus => ({
    ...ready,
    providerId,
    authMethod:
      providerId === 'anthropic'
        ? 'claude.ai'
        : providerId === 'opencode'
          ? 'opencode_configured_local'
          : 'codex_chatgpt',
  });

  const watermarkProviders = (current: Readonly<Record<string, ScopedCliProviderLaunchProof>>) =>
    Object.values(current)
      .filter((proof) => proof.requestId === -1)
      .map((proof) => proof.authorityScope?.providerId)
      .sort();

  it.each([
    ['//Server/Share/Project', '\\\\server\\share\\project'],
    ['\\\\Server\\Share\\Project', '\\\\server\\share\\project'],
    ['/Server//Share///Project', '/Server/Share/Project'],
    ['///Server//Share///Project', '/Server/Share/Project'],
    ['/tmp/./parent/../project', '/tmp/project'],
    ['C:\\Work\\Project', 'c:/work/project'],
    ['\\\\Server\\Share\\folder\\..\\Project', '\\\\server\\share\\project'],
    ['\\\\Server\\Share\\..\\..\\Project', '\\\\server\\share\\project'],
  ])('derives the canonical renderer scope for %s', (input, expected) => {
    expect(getCliProviderStatusScopeKey('codex', input)).toBe(`codex\0${expected}`);
  });

  it('does not collapse a forward-slash UNC scope into a single-root POSIX scope', () => {
    expect(getCliProviderStatusScopeKey('codex', '//server/share/project')).not.toBe(
      getCliProviderStatusScopeKey('codex', '/server/share/project')
    );
  });

  it('revokes projects A and B when a scoped authoritative observation discovers logout', () => {
    const loggedOut = {
      ...ready,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown' as const,
    };
    const reconciled = reconcileScopedProviderLaunchProofs({
      current: proofs,
      scopeKey: scopeA,
      providerId: 'codex',
      projectPath: projectA,
      providerStatus: loggedOut,
      responseMatchesProvider: true,
      metadataMatchesRequest: true,
      authorityScope: authorityScope(projectA, { profile: 2 }),
      requestIntent: 'launch-proof',
      requestId: 3,
      epoch: 1,
      fetchedAtMs: 2,
    });

    expect(reconciled[scopeA]).toBeUndefined();
    expect(reconciled[scopeB]).toBeUndefined();
  });

  it('replaces only project A authority when only its catalog changes', () => {
    const reconciled = reconcileScopedProviderLaunchProofs({
      current: proofs,
      scopeKey: scopeA,
      providerId: 'codex',
      projectPath: projectA,
      providerStatus: { ...ready, models: ['gpt-v2'] },
      responseMatchesProvider: true,
      metadataMatchesRequest: true,
      authorityScope: {
        schemaVersion: 1,
        providerId: 'codex',
        projectPath: projectA,
        globalGeneration: 1,
        profileGeneration: 1,
        catalogGeneration: 2,
      },
      requestIntent: 'launch-proof',
      requestId: 3,
      epoch: 1,
      fetchedAtMs: 2,
    });

    expect(reconciled[scopeA]?.providerStatus.models).toEqual(['gpt-v2']);
    expect(reconciled[scopeB]).toBe(proofs[scopeB]);
  });

  it('revokes B when the first exact observation in A has a newer provider profile generation', () => {
    const onlyB = { [scopeB]: proofs[scopeB] };

    const reconciled = reconcileProject(
      onlyB,
      projectA,
      { ...ready, selectedBackendId: 'codex-native' },
      { profile: 2 }
    );

    expect(reconciled[scopeB]).toBeUndefined();
    expect(reconciled[scopeA]?.authorityScope?.profileGeneration).toBe(2);
  });

  it('revokes every provider proof when A observes a newer global generation', () => {
    const anthropicScope = getCliProviderStatusScopeKey('anthropic', projectB);
    const anthropic = {
      ...ready,
      providerId: 'anthropic' as const,
      authMethod: 'claude.ai' as const,
    };
    const current = {
      [scopeB]: proofs[scopeB],
      [anthropicScope]: {
        providerStatus: anthropic,
        requestId: 4,
        epoch: 1,
        fetchedAtMs: 1,
        authorityScope: {
          ...authorityScope(projectB),
          providerId: 'anthropic' as const,
        },
      },
    };

    const reconciled = reconcileProject(current, projectA, ready, { global: 2 });

    expect(reconciled[scopeB]).toBeUndefined();
    expect(reconciled[anthropicScope]).toBeUndefined();
    expect(reconciled[scopeA]?.authorityScope?.globalGeneration).toBe(2);
  });

  it('preserves B for project-local A differences at the same profile generation', () => {
    const projectLocalDifference = {
      ...ready,
      backend: {
        kind: 'api' as const,
        label: 'Project A',
        projectId: 'project-a',
      },
      models: ['gpt-project-a'],
    };

    const reconciled = reconcileProject(proofs, projectA, projectLocalDifference, { catalog: 2 });

    expect(reconciled[scopeB]).toBe(proofs[scopeB]);
    expect(reconciled[scopeA]?.providerStatus).toBe(projectLocalDifference);
  });

  it('does not let an older profile generation claim A or revoke a newer B proof', () => {
    const newerB = {
      ...proofs[scopeB],
      authorityScope: authorityScope(projectB, { profile: 3 }),
    };

    const reconciled = reconcileProject({ [scopeB]: newerB }, projectA, ready, { profile: 2 });

    expect(reconciled[scopeB]).toBe(newerB);
    expect(reconciled[scopeA]).toBeUndefined();
  });

  it('does not let an older global generation claim A or revoke newer proofs', () => {
    const newerB = {
      ...proofs[scopeB],
      authorityScope: authorityScope(projectB, { global: 3 }),
    };

    const reconciled = reconcileProject({ [scopeB]: newerB }, projectA, ready, { global: 2 });

    expect(reconciled[scopeB]).toBe(newerB);
    expect(reconciled[scopeA]).toBeUndefined();
  });

  it('does not resurrect authority behind a retained logout/profile watermark', () => {
    const reconciled = reconcileScopedProviderLaunchProofs({
      current: {},
      scopeKey: scopeA,
      providerId: 'codex',
      projectPath: projectA,
      providerStatus: ready,
      responseMatchesProvider: true,
      metadataMatchesRequest: true,
      authorityScope: authorityScope(projectA, { profile: 2 }),
      requestIntent: 'launch-proof',
      requestId: 5,
      epoch: 1,
      fetchedAtMs: 3,
      observedGlobalGeneration: 1,
      observedProfileGeneration: 3,
    });

    expect(reconciled).toEqual({});
  });

  it('does not replace an exact proof with an older catalog generation', () => {
    const newerA = {
      ...proofs[scopeA],
      authorityScope: authorityScope(projectA, { catalog: 3 }),
    };

    const reconciled = reconcileProject(
      { ...proofs, [scopeA]: newerA },
      projectA,
      { ...ready, models: ['stale-model'] },
      { catalog: 2 }
    );

    expect(reconciled[scopeA]).toBe(newerA);
    expect(reconciled[scopeB]).toBe(proofs[scopeB]);
  });

  it('accepts a reset catalog generation on the first response from a newer profile epoch', () => {
    const previousA = {
      ...proofs[scopeA],
      providerStatus: { ...ready, models: ['old-profile-model'] },
      authorityScope: authorityScope(projectA, { profile: 1, catalog: 128 }),
    };
    const nextProfileStatus = { ...ready, models: ['new-profile-model'] };

    const reconciled = reconcileProject(
      { ...proofs, [scopeA]: previousA },
      projectA,
      nextProfileStatus,
      { profile: 2, catalog: 1 }
    );

    expect(reconciled[scopeA]).toMatchObject({
      providerStatus: nextProfileStatus,
      requestId: 3,
      authorityScope: {
        profileGeneration: 2,
        catalogGeneration: 1,
      },
    });
    expect(reconciled[scopeB]).toBeUndefined();
  });

  it('protects A catalog watermark from enough B/C project churn to evict A exact proof', () => {
    const target = '/project/evicted';
    const targetScope = getCliProviderStatusScopeKey('codex', target);
    let current = reconcileProject({}, target, ready, { profile: 5, catalog: 5 });

    for (let index = 0; index < CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT * 2; index += 1) {
      const providerId = index % 2 === 0 ? 'anthropic' : 'gemini';
      current = reconcileProviderProject(
        current,
        providerId,
        `/project/${providerId}-churn-${index}`,
        readyFor(providerId),
        {
          profile: 5,
          catalog: 5,
        }
      );
      expect(Object.keys(current).length).toBeLessThanOrEqual(
        CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT
      );
    }
    expect(Object.keys(current)).toHaveLength(CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
    expect(current[targetScope]).toBeUndefined();
    expect(watermarkProviders(current)).toEqual(['anthropic', 'codex', 'gemini']);
    const codexWatermarkKey = Object.entries(current).find(
      ([, proof]) => proof.requestId === -1 && proof.authorityScope?.providerId === 'codex'
    )?.[0];
    expect(codexWatermarkKey).toBeDefined();
    expect(codexWatermarkKey).not.toBe(targetScope);
    expect(current[codexWatermarkKey!]).toMatchObject({
      requestId: -1,
      epoch: -1,
      authorityScope: { projectPath: null, catalogGeneration: 5 },
    });

    const stale = reconcileProject(
      current,
      target,
      { ...ready, models: ['stale'] },
      { profile: 5, catalog: 4 }
    );
    expect(stale[targetScope]).toBeUndefined();

    const equal = reconcileProject(
      stale,
      target,
      { ...ready, models: ['equal'] },
      {
        profile: 5,
        catalog: 5,
      }
    );
    expect(equal[targetScope]?.providerStatus.models).toEqual(['equal']);

    const newer = reconcileProject(
      equal,
      target,
      { ...ready, models: ['newer'] },
      {
        profile: 5,
        catalog: 6,
      }
    );
    expect(newer[targetScope]?.providerStatus.models).toEqual(['newer']);
  });

  it('does not expose a reserved watermark through any project proof scope key', () => {
    const current = reconcileProject({}, projectA, ready, { profile: 5, catalog: 5 });
    const reservedKey = Object.entries(current).find(([, proof]) => proof.requestId === -1)?.[0];

    expect(reservedKey).toBeDefined();
    for (const projectPath of [
      '/',
      '/renderer-catalog-watermark',
      '/\0renderer-catalog-watermark',
    ]) {
      const projectScopeKey = getCliProviderStatusScopeKey('codex', projectPath);
      expect(projectScopeKey).not.toBe(reservedKey);
      expect(current[projectScopeKey]).toBeUndefined();
    }
    expect(current[reservedKey!].authorityScope?.projectPath).toBeNull();
  });

  it('stays exactly bounded under 10,001 mixed-provider project proofs', () => {
    let current: Readonly<Record<string, ScopedCliProviderLaunchProof>> = {};
    const providerIds = ['codex', 'anthropic', 'gemini'] as const;

    for (let index = 0; index < 10_001; index += 1) {
      const providerId = providerIds[index % providerIds.length]!;
      current = reconcileProviderProject(
        current,
        providerId,
        `/project/mixed-churn-${index}`,
        readyFor(providerId),
        {
          profile: 5,
          catalog: index + 1,
        }
      );
      expect(Object.keys(current).length).toBeLessThanOrEqual(
        CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT
      );
    }

    expect(Object.keys(current)).toHaveLength(CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
    expect(watermarkProviders(current)).toEqual(['anthropic', 'codex', 'gemini']);
  });

  it('removes only the reset or logged-out provider watermark and isolates other providers', () => {
    const anthropicProject = '/project/reset-anthropic';
    const anthropicReady = readyFor('anthropic');
    let current = reconcileProject({}, projectA, ready, { profile: 5, catalog: 500 });
    current = reconcileProviderProject(current, 'anthropic', anthropicProject, anthropicReady, {
      profile: 5,
      catalog: 50,
    });

    const profileReset = reconcileProject(
      current,
      projectB,
      { ...ready, models: ['profile-reset'] },
      { profile: 6, catalog: 1 }
    );
    expect(watermarkProviders(profileReset)).toEqual(['anthropic', 'codex']);
    expect(
      Object.values(profileReset).find(
        (proof) => proof.requestId === -1 && proof.authorityScope?.providerId === 'codex'
      )?.authorityScope
    ).toMatchObject({ profileGeneration: 6, catalogGeneration: 1 });

    const loggedOut = reconcileProviderProject(
      profileReset,
      'codex',
      projectA,
      {
        ...ready,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
      },
      { profile: 7, catalog: 1 }
    );
    expect(watermarkProviders(loggedOut)).toEqual(['anthropic']);
    expect(loggedOut[getCliProviderStatusScopeKey('anthropic', anthropicProject)]).toBeDefined();

    const globalReset = reconcileProject(loggedOut, projectA, ready, {
      global: 2,
      profile: 7,
      catalog: 1,
    });
    expect(watermarkProviders(globalReset)).toEqual(['codex']);
    expect(
      globalReset[getCliProviderStatusScopeKey('anthropic', anthropicProject)]
    ).toBeUndefined();
  });

  it.each(['profile reset', 'logout'] as const)(
    'removes a provider watermark during projectless %s without disturbing another provider',
    (resetKind) => {
      const anthropicProject = '/project/provider-isolation';
      const anthropicReady = readyFor('anthropic');
      let current = reconcileProject({}, projectA, ready, { profile: 5, catalog: 500 });
      current = reconcileProviderProject(current, 'anthropic', anthropicProject, anthropicReady, {
        profile: 5,
        catalog: 50,
      });
      const currentStatus = { ...base, providers: [ready, anthropicReady] };
      const incomingCodex =
        resetKind === 'profile reset'
          ? { ...ready, selectedBackendId: 'codex-native' }
          : {
              ...ready,
              authenticated: false,
              authMethod: null,
              verificationState: 'unknown' as const,
            };
      const reconciled = reconcileGlobalProviderLaunchProofs(current, currentStatus, {
        ...currentStatus,
        providers: [incomingCodex, anthropicReady],
      });

      expect(watermarkProviders(reconciled)).toEqual(['anthropic']);
      expect(reconciled[getCliProviderStatusScopeKey('anthropic', anthropicProject)]).toBeDefined();
    }
  );

  it('keeps catalog resurrection fail-closed across profile generations', () => {
    const target = '/project/profile-reset';
    const targetScope = getCliProviderStatusScopeKey('codex', target);
    let current = reconcileProject({}, target, ready, { profile: 5, catalog: 5 });
    for (let index = 0; index < CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT; index += 1) {
      current = reconcileProject(current, `/project/churn-${index}`, ready, {
        profile: 5,
        catalog: 5,
      });
    }
    expect(current[targetScope]).toBeUndefined();
    const olderProfile = reconcileProject(
      current,
      target,
      { ...ready, models: ['old-profile'] },
      {
        profile: 4,
        catalog: 1_000,
      }
    );
    expect(olderProfile[targetScope]).toBeUndefined();

    const resetProfile = reconcileProject(
      olderProfile,
      target,
      { ...ready, models: ['reset-profile'] },
      { profile: 6, catalog: 1 }
    );
    expect(resetProfile[targetScope]).toMatchObject({
      providerStatus: { models: ['reset-profile'] },
      authorityScope: { profileGeneration: 6, catalogGeneration: 1 },
    });
    expect(Object.keys(resetProfile).length).toBeLessThanOrEqual(
      CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT
    );
  });

  it('does not authorize a projectless authority scope or disturb exact proofs', () => {
    const reconciled = reconcileScopedProviderLaunchProofs({
      current: proofs,
      scopeKey: scopeA,
      providerId: 'codex',
      projectPath: projectA,
      providerStatus: ready,
      responseMatchesProvider: true,
      metadataMatchesRequest: true,
      authorityScope: { ...authorityScope(projectA), projectPath: null },
      requestIntent: 'launch-proof',
      requestId: 3,
      epoch: 1,
      fetchedAtMs: 2,
    });

    expect(reconciled).toBe(proofs);
  });

  it('revokes project proofs for a projectless selected-profile change', () => {
    const currentStatus = { ...base, providers: [ready] };
    const incomingStatus = {
      ...currentStatus,
      providers: [{ ...ready, selectedBackendId: 'codex-native' }],
    };

    const reconciled = reconcileGlobalProviderLaunchProofs(proofs, currentStatus, incomingStatus);

    expect(reconciled[scopeA]).toBeUndefined();
    expect(reconciled[scopeB]).toBeUndefined();
  });

  it('does not revoke scoped proofs for a projectless catalog-only observation', () => {
    const currentStatus = { ...base, providers: [ready] };
    const incomingStatus = {
      ...currentStatus,
      providers: [{ ...ready, models: ['gpt-v2'] }],
    };

    expect(reconcileGlobalProviderLaunchProofs(proofs, currentStatus, incomingStatus)).toBe(proofs);
  });
});

describe('reconcileCliStatus', () => {
  it('retains a previous exact-scope catalog as stale while revoking launch authority', () => {
    const base = createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === 'opencode'
    )!;
    const current = {
      ...base,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      models: ['openai/gpt-test'],
      capabilities: { ...base.capabilities, teamLaunch: true },
      modelCatalogRefreshState: 'ready' as const,
      modelCatalog: {
        schemaVersion: 1 as const,
        providerId: 'opencode' as const,
        source: 'app-server' as const,
        status: 'ready' as const,
        fetchedAt: '2026-08-18T00:00:00.000Z',
        staleAt: '2026-08-18T00:10:00.000Z',
        defaultModelId: 'openai/gpt-test',
        defaultLaunchModel: 'openai/gpt-test',
        models: [],
        diagnostics: {
          configReadState: 'ready' as const,
          appServerState: 'healthy' as const,
          message: null,
          code: null,
        },
      },
    };
    const transient = {
      ...base,
      verificationState: 'error' as const,
      statusCheckOutcome: 'transient_error' as const,
      statusCheckErrorCode: 'timeout' as const,
      modelCatalogRefreshState: 'error' as const,
      statusMessage: 'OpenCode is still loading',
    };

    const merged = reconcileCliStatus(current, transient);

    expect(merged).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'transient_error',
      modelCatalogRefreshState: 'error',
      capabilities: { teamLaunch: false },
      modelCatalog: { providerId: 'opencode', status: 'stale' },
    });
    expect(merged.models).toEqual(['openai/gpt-test']);
  });

  it.each([
    ['anthropic', 'claude.ai'],
    ['codex', 'codex_chatgpt'],
  ] as const)(
    'retains same-scope %s display evidence during transient degradation',
    (providerId, authMethod) => {
      const base = createLoadingMultimodelCliStatus().providers.find(
        (provider) => provider.providerId === providerId
      )!;
      const current = {
        ...base,
        authenticated: true,
        authMethod,
        statusCheckOutcome: 'authoritative' as const,
        capabilities: { ...base.capabilities, teamLaunch: true },
        subscriptionRateLimits: {
          primary: {
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: 1_777_777_000,
          },
          secondary: null,
        },
        availableBackends: [
          {
            id: `${providerId}-native`,
            label: 'Native',
            description: 'Display-only backend evidence',
            selectable: true,
            recommended: true,
            available: true,
          },
        ],
      };
      const transient = {
        ...base,
        statusCheckOutcome: 'transient_error' as const,
        statusCheckErrorCode: 'timeout' as const,
      };

      const merged = reconcileCliStatus(current, transient);

      expect(merged.subscriptionRateLimits).toEqual(current.subscriptionRateLimits);
      expect(merged.availableBackends).toEqual(current.availableBackends);
      expect(merged.authenticated).toBe(false);
      expect(merged.authMethod).toBeNull();
      expect(merged.capabilities.teamLaunch).toBe(false);
    }
  );

  it('keeps a retained catalog stale and non-authoritative during authoritative hydration', () => {
    const base = createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === 'opencode'
    )!;
    const current: CliProviderStatus = {
      ...base,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...base.capabilities, teamLaunch: true },
      models: ['openai/project-model'],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-19T00:00:00.000Z',
        staleAt: '2099-08-19T00:05:00.000Z',
        defaultModelId: 'openai/project-model',
        defaultLaunchModel: 'openai/project-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    const summary: CliProviderStatus = {
      ...current,
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
    };

    expect(reconcileCliStatus(current, summary)).toMatchObject({
      authenticated: false,
      statusCheckOutcome: 'authoritative',
      modelCatalogRefreshState: 'loading',
      modelCatalog: { status: 'stale' },
      capabilities: { teamLaunch: false },
    });
  });

  it('does not authorize from model evidence retained across an authoritative empty response', () => {
    const base = createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === 'codex'
    )!;
    const current: CliProviderStatus = {
      ...base,
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...base.capabilities, teamLaunch: true },
      models: ['gpt-fresh-before-refresh'],
    };
    const incoming: CliProviderStatus = {
      ...current,
      models: [],
      modelAvailability: [],
    };

    expect(reconcileCliStatus(current, incoming)).toMatchObject({
      models: ['gpt-fresh-before-refresh'],
      authenticated: false,
      authMethod: null,
      capabilities: { teamLaunch: false },
    });
  });

  it('returns the previous status reference when a structurally identical clone arrives', () => {
    // This mirrors the real IPC path: `CliInstallerService.cloneCliInstallationStatus()`
    // (called from `publishStatusSnapshot()`) hands the renderer a fresh
    // `CliInstallationStatus` whose `providers` are also freshly-cloned
    // objects, even when nothing has actually changed. The merge function
    // must compare provider content (not just reference) so that no-op
    // progress ticks do not produce a new `cliStatus` identity and trigger
    // a re-render storm across every consumer.
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns the previous status reference when an authenticated clone arrives', () => {
    const base = createLoadingMultimodelCliStatus();
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'oauth' as const,
      providers: base.providers.map((provider, index) =>
        index === 0
          ? {
              ...provider,
              authenticated: true,
              authMethod: 'oauth' as const,
              supported: true,
              verificationState: 'verified' as const,
              statusCheckOutcome: 'authoritative' as const,
              statusMessage: null,
              models: ['model-a', 'model-b'],
            }
          : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns a new status when an incoming provider field actually differs', () => {
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);
    incoming.providers[0] = {
      ...incoming.providers[0],
      statusMessage: 'Verifying credentials...',
    };

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[0].statusMessage).toBe('Verifying credentials...');
  });

  it('returns current when a structurally identical populated provider clone arrives', () => {
    // Mirrors the real IPC flow with a fully-populated provider: ChatGPT-Codex
    // authenticated, with a model catalog, model availability records,
    // runtime capabilities, available backends, and a selected backend.
    // None of these fields are reference-stable across IPC clones, so the
    // equality guard must compare them by content, not reference.
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      statusMessage: null,
      models: ['gpt-5.2'],
      modelAvailability: [
        {
          modelId: 'gpt-5.2',
          status: 'available' as const,
          checkedAt: '2026-05-14T00:00:00.000Z',
        },
      ],
      runtimeCapabilities: {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'] as CliProviderReasoningEffort[],
        },
      },
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
      backend: { kind: 'codex-cli' as const, label: 'Codex CLI' },
    };
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'codex_chatgpt' as const,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).toBe(current);
    expect(merged.providers[1]).toBe(current.providers[1]);
  });

  it('produces a new status when a cloned populated field actually changed', () => {
    // Negative companion to the populated-clone test: confirms that when a
    // cloned DTO field really differs, the merge does NOT preserve the
    // previous reference (i.e. we never let stale data through).
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      models: ['gpt-5.2'],
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
    };
    const current = {
      ...base,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);
    // Flip a nested DTO field on the cloned snapshot.
    incoming.providers[1].availableBackends![0].available = false;

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[1]).not.toBe(current.providers[1]);
    expect(merged.providers[1].availableBackends?.[0].available).toBe(false);
  });

  it('retains an omitted provider for display only and revokes its previous readiness', () => {
    const base = createLoadingMultimodelCliStatus();
    const currentOpenCode: CliProviderStatus = {
      ...base.providers.find((provider) => provider.providerId === 'opencode')!,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: {
        ...base.providers.find((provider) => provider.providerId === 'opencode')!.capabilities,
        teamLaunch: true,
      },
      models: ['openai/project-model'],
    };
    const current = {
      ...base,
      providers: base.providers.map((provider) =>
        provider.providerId === 'opencode' ? currentOpenCode : provider
      ),
    };
    const incoming = {
      ...structuredClone(base),
      providers: base.providers.filter((provider) => provider.providerId !== 'opencode'),
    };

    const merged = reconcileCliStatus(current, incoming);
    const retained = merged.providers.find((provider) => provider.providerId === 'opencode');

    expect(retained).toMatchObject({
      supported: true,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
      models: ['openai/project-model'],
      capabilities: { teamLaunch: false },
    });
  });
});

describe('project-scoped provider loading', () => {
  it.each(['bootstrapCliStatus', 'fetchCliStatus'] as const)(
    'retains scoped launch proof while passive %s status refresh is pending',
    async (actionName) => {
      const previousApi = window.electronAPI;
      const base = createLoadingMultimodelCliStatus();
      let resolveStatus!: (status: typeof base) => void;
      const pendingStatus = new Promise<typeof base>((resolve) => {
        resolveStatus = resolve;
      });
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: {
          cliInstaller: {
            getStatus: () => pendingStatus,
          },
        } as unknown as ElectronAPI,
      });
      const store = createCliInstallerStore();
      const scopeKey = getCliProviderStatusScopeKey('opencode', '/project/generation');
      const providerStatus = base.providers.find((provider) => provider.providerId === 'opencode')!;
      store.setState({
        cliStatus: { ...base, installed: true },
        cliProviderLaunchProofByScope: {
          [scopeKey]: { providerStatus, requestId: 41, epoch: 7, fetchedAtMs: 123_456 },
        },
        cliProviderStatusScopeRevision: 3,
      });

      try {
        const refresh = store.getState()[actionName]();

        expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBeDefined();
        expect(store.getState().cliProviderStatusScopeRevision).toBe(4);

        resolveStatus({ ...base, installed: false });
        await refresh;
      } finally {
        Object.defineProperty(window, 'electronAPI', {
          configurable: true,
          writable: true,
          value: previousApi,
        });
      }
    }
  );

  it('rejects a cross-provider response instead of caching it under the requested scope', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
    const wrongProvider: CliProviderStatus = {
      ...openCode,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...openCode.capabilities, teamLaunch: true },
      models: ['openai/wrong-provider'],
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope(async () => wrongProvider),
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const scopeKey = getCliProviderStatusScopeKey('codex', '/project/cross-provider');
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      await expect(
        store.getState().fetchCliProviderStatus('codex', {
          silent: true,
          projectPath: '/project/cross-provider',
          intent: 'launch-proof',
        })
      ).resolves.toBe(false);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBeUndefined();
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toMatchObject({
        providerId: 'codex',
        authenticated: false,
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'partial_response',
        capabilities: { teamLaunch: false },
      });
      expect(store.getState().cliProviderStatusByScope[scopeKey]?.models).not.toContain(
        'openai/wrong-provider'
      );
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it.each(['passive-first', 'exact-first'] as const)(
    'does not deduplicate %s concurrent scoped requests across intent',
    async (order) => {
      const previousApi = window.electronAPI;
      const base = createLoadingMultimodelCliStatus();
      const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
      const ready: CliProviderStatus = {
        ...openCode,
        supported: true,
        authenticated: true,
        authMethod: 'opencode_configured_local',
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        capabilities: { ...openCode.capabilities, teamLaunch: true },
        models: ['openai/exact-model'],
        modelCatalogRefreshState: 'ready',
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'opencode',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-08-19T00:00:00.000Z',
          staleAt: '2099-08-19T00:05:00.000Z',
          defaultModelId: 'openai/exact-model',
          defaultLaunchModel: 'openai/exact-model',
          models: [],
          diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        },
      };
      const completions: Array<(status: CliProviderStatus) => void> = [];
      const getProviderStatus = vi.fn(
        () =>
          new Promise<CliProviderStatus>((resolve) => {
            completions.push(resolve);
          })
      );
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: {
          cliInstaller: { getProviderStatus: withProviderStatusEnvelope(getProviderStatus) },
        } as unknown as ElectronAPI,
      });
      const store = createCliInstallerStore();
      const projectPath = '/project/intent-isolation';
      const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
      store.setState({ cliStatus: { ...base, installed: true } });

      try {
        const firstIntent = order === 'passive-first' ? 'passive' : 'launch-proof';
        const secondIntent = order === 'passive-first' ? 'launch-proof' : 'passive';
        const first = store.getState().fetchCliProviderStatus('opencode', {
          silent: true,
          projectPath,
          intent: firstIntent,
        });
        const second = store.getState().fetchCliProviderStatus('opencode', {
          silent: true,
          projectPath,
          intent: secondIntent,
        });

        expect(getProviderStatus).toHaveBeenCalledTimes(2);
        completions[0]?.(ready);
        await first;
        const firstProof = store.getState().cliProviderLaunchProofByScope[scopeKey];
        if (firstIntent === 'passive') {
          expect(firstProof).toBeUndefined();
        } else {
          expect(firstProof?.providerStatus).toBe(ready);
        }
        completions[1]?.(ready);
        await second;
        const finalProof = store.getState().cliProviderLaunchProofByScope[scopeKey];
        expect(finalProof?.providerStatus).toBe(ready);
        if (firstIntent === 'launch-proof') {
          expect(finalProof).toBe(firstProof);
        }
      } finally {
        Object.defineProperty(window, 'electronAPI', {
          configurable: true,
          writable: true,
          value: previousApi,
        });
      }
    }
  );

  it('coalesces concurrent launch-proof intents for the same exact project scope', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
    const ready: CliProviderStatus = {
      ...openCode,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...openCode.capabilities, teamLaunch: true },
      models: ['openai/exact-model'],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-21T00:00:00.000Z',
        staleAt: '2099-08-21T00:00:00.000Z',
        defaultModelId: 'openai/exact-model',
        defaultLaunchModel: 'openai/exact-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    let complete!: (status: CliProviderStatus) => void;
    const getProviderStatus = vi.fn(
      () =>
        new Promise<CliProviderStatus>((resolve) => {
          complete = resolve;
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus: withProviderStatusEnvelope(getProviderStatus) },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/coalesced-intent';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      const first = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath,
        intent: 'launch-proof',
      });
      const second = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath,
        intent: 'launch-proof',
      });

      expect(getProviderStatus).toHaveBeenCalledTimes(1);
      complete(ready);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toMatchObject({
        providerStatus: ready,
        requestId: expect.any(Number),
        epoch: expect.any(Number),
        authorityScope: {
          schemaVersion: 1,
          providerId: 'opencode',
          projectPath,
          globalGeneration: 1,
          profileGeneration: 1,
          catalogGeneration: 1,
        },
      });
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('deduplicates within one request identity and fences overlapping identities out of order', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
    const ready: CliProviderStatus = {
      ...openCode,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...openCode.capabilities, teamLaunch: true },
      models: ['openai/recovery-model'],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-21T00:00:00.000Z',
        staleAt: '2099-08-21T00:00:00.000Z',
        defaultModelId: 'openai/recovery-model',
        defaultLaunchModel: 'openai/recovery-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    const completions: ((status: CliProviderStatus) => void)[] = [];
    const getProviderStatus = vi.fn(
      () =>
        new Promise<CliProviderStatus>((resolve) => {
          completions.push(resolve);
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus: withProviderStatusEnvelope(getProviderStatus) },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/recovery-epoch';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    const request = {
      silent: true,
      projectPath,
      intent: 'launch-proof' as const,
      requestIdentity: 41,
    };
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      const original = store.getState().fetchCliProviderStatus('opencode', request);
      const sameAttemptRerender = store.getState().fetchCliProviderStatus('opencode', {
        ...request,
      });
      expect(getProviderStatus).toHaveBeenCalledTimes(1);

      const recovery = store.getState().fetchCliProviderStatus('opencode', {
        ...request,
        requestIdentity: 42,
      });
      expect(getProviderStatus).toHaveBeenCalledTimes(2);

      completions[1](ready);
      await expect(recovery).resolves.toBe(true);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toMatchObject({
        providerStatus: ready,
        requestId: expect.any(Number),
      });
      const recoveryRequestId = store.getState().cliProviderLaunchProofByScope[scopeKey]?.requestId;

      const replacementAfterCleanup = store.getState().fetchCliProviderStatus('opencode', {
        ...request,
        requestIdentity: 42,
      });
      expect(getProviderStatus).toHaveBeenCalledTimes(3);

      completions[0](ready);
      await expect(Promise.all([original, sameAttemptRerender])).resolves.toEqual([false, false]);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBeUndefined();

      completions[2](ready);
      await expect(replacementAfterCleanup).resolves.toBe(true);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toMatchObject({
        providerStatus: ready,
      });
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]?.requestId).not.toBe(
        recoveryRequestId
      );
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('defaults old scoped callers to passive display state without publishing proof', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const ready = {
      ...base.providers.find((provider) => provider.providerId === 'opencode')!,
      statusCheckOutcome: 'authoritative' as const,
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus: withProviderStatusEnvelope(async () => ready) },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/legacy-passive';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      await store.getState().fetchCliProviderStatus('opencode', { projectPath, silent: true });
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toBeDefined();
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('does not publish launch proof when returned purpose metadata mismatches its exact request', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const ready = {
      ...base.providers.find((provider) => provider.providerId === 'opencode')!,
      authenticated: true,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: async (_providerId: string, request: CliProviderStatusIpcRequest) => ({
            providerStatus: ready,
            purpose: 'passive' as const,
            requestNonce: request.requestNonce,
            observationGeneration: 3,
            observationNonce: 'mismatched-purpose',
          }),
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/mismatched-purpose';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      await expect(
        store.getState().fetchCliProviderStatus('opencode', {
          projectPath,
          silent: true,
          intent: 'launch-proof',
        })
      ).resolves.toBe(false);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('keeps an authoritative proof while a passive scoped refresh starts and fails', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const ready = {
      ...base.providers.find((provider) => provider.providerId === 'opencode')!,
      authenticated: true,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      capabilities: {
        ...base.providers.find((provider) => provider.providerId === 'opencode')!.capabilities,
        teamLaunch: true,
      },
    };
    let rejectPassive!: (error: Error) => void;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope(
            () =>
              new Promise<CliProviderStatus>((_resolve, reject) => {
                rejectPassive = reject;
              })
          ),
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/passive-failure';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    const proof = { providerStatus: ready, requestId: 17, epoch: 4, fetchedAtMs: 50_000 };
    store.setState({
      cliStatus: { ...base, installed: true },
      cliProviderStatusByScope: { [scopeKey]: ready },
      cliProviderLaunchProofByScope: { [scopeKey]: proof },
    });

    try {
      const passive = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath,
        intent: 'passive',
      });

      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBe(proof);
      rejectPassive(new Error('passive catalog refresh failed'));
      await expect(passive).resolves.toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        '[Store:cliInstaller]',
        'Failed to fetch opencode CLI status:',
        expect.any(Error)
      );
      vi.mocked(console.error).mockClear();
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBe(proof);
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('does not let a late passive failure erase a newer exact proof generation', async () => {
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
    const ready: CliProviderStatus = {
      ...openCode,
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...openCode.capabilities, teamLaunch: true },
      models: ['openai/exact-model'],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-21T00:00:00.000Z',
        staleAt: '2099-08-21T00:00:00.000Z',
        defaultModelId: 'openai/exact-model',
        defaultLaunchModel: 'openai/exact-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    let rejectPassive!: (error: Error) => void;
    let resolveExact!: (status: CliProviderStatus) => void;
    const getProviderStatus = vi
      .fn<() => Promise<CliProviderStatus>>()
      .mockImplementationOnce(
        () =>
          new Promise<CliProviderStatus>((_resolve, reject) => {
            rejectPassive = reject;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<CliProviderStatus>((resolve) => {
            resolveExact = resolve;
          })
      );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus: withProviderStatusEnvelope(getProviderStatus) },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/late-passive';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      const passive = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath,
        intent: 'passive',
      });
      const exact = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath,
        intent: 'launch-proof',
      });
      resolveExact(ready);
      await expect(exact).resolves.toBe(true);
      const exactProof = store.getState().cliProviderLaunchProofByScope[scopeKey];
      expect(exactProof).toMatchObject({ providerStatus: ready });

      rejectPassive(new Error('late passive failure'));
      await expect(passive).resolves.toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        '[Store:cliInstaller]',
        'Failed to fetch opencode CLI status:',
        expect.any(Error)
      );
      vi.mocked(console.error).mockClear();
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBe(exactProof);
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('preserves an expired proof generation when passive completion lands before exact renewal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_001);
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
    const ready: CliProviderStatus = {
      ...codex,
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...codex.capabilities, teamLaunch: true },
      models: ['gpt-project'],
    };
    let resolvePassive!: (status: CliProviderStatus) => void;
    let resolveExact!: (status: CliProviderStatus) => void;
    const getProviderStatus = vi
      .fn<() => Promise<CliProviderStatus>>()
      .mockImplementationOnce(
        () =>
          new Promise<CliProviderStatus>((resolve) => {
            resolvePassive = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<CliProviderStatus>((resolve) => {
            resolveExact = resolve;
          })
      );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus: withProviderStatusEnvelope(getProviderStatus) },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/passive-between-expiry-renewal';
    const scopeKey = getCliProviderStatusScopeKey('codex', projectPath);
    const expiredProof = { providerStatus: ready, requestId: 31, epoch: 6, fetchedAtMs: 0 };
    store.setState({
      cliStatus: { ...base, installed: true },
      cliProviderStatusByScope: { [scopeKey]: ready },
      cliProviderLaunchProofByScope: { [scopeKey]: expiredProof },
    });

    try {
      const passive = store.getState().fetchCliProviderStatus('codex', {
        silent: true,
        projectPath,
        intent: 'passive',
      });
      resolvePassive(ready);
      await expect(passive).resolves.toBe(true);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBe(expiredProof);

      vi.setSystemTime(60_002);
      const renewal = store.getState().fetchCliProviderStatus('codex', {
        silent: true,
        projectPath,
        intent: 'launch-proof',
      });
      resolveExact(ready);
      await expect(renewal).resolves.toBe(true);
      const renewedProof = store.getState().cliProviderLaunchProofByScope[scopeKey];
      expect(renewedProof).toMatchObject({
        providerStatus: ready,
        fetchedAtMs: 60_002,
      });
      expect(`${renewedProof?.epoch}:${renewedProof?.requestId}`).not.toBe('6:31');
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('expires a current authoritative model-array proof from fetch time without a catalog', async () => {
    vi.useFakeTimers();
    const requestStartedAtMs = Date.parse('2026-08-20T12:00:00.000Z');
    vi.setSystemTime(requestStartedAtMs);
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
    const ready: CliProviderStatus = {
      ...codex,
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...codex.capabilities, teamLaunch: true },
      models: ['gpt-project'],
      modelCatalog: null,
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope(async () => ready),
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const scopeKey = getCliProviderStatusScopeKey('codex', '/project/model-array');
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      await expect(
        store.getState().fetchCliProviderStatus('codex', {
          silent: true,
          projectPath: '/project/model-array',
          intent: 'launch-proof',
        })
      ).resolves.toBe(true);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toMatchObject({
        providerStatus: ready,
        requestId: expect.any(Number),
        epoch: expect.any(Number),
        fetchedAtMs: requestStartedAtMs,
      });
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('timestamps a slow authoritative launch proof at completion rather than request start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
    const ready: CliProviderStatus = {
      ...codex,
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...codex.capabilities, teamLaunch: true },
      models: ['gpt-project'],
    };
    let complete!: (value: CliProviderStatus) => void;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope(
            () =>
              new Promise<CliProviderStatus>((resolve) => {
                complete = resolve;
              })
          ),
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/slow-proof';
    const scopeKey = getCliProviderStatusScopeKey('codex', projectPath);
    store.setState({ cliStatus: { ...base, installed: true } });
    try {
      const request = store.getState().fetchCliProviderStatus('codex', {
        silent: true,
        projectPath,
        intent: 'launch-proof',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      complete(ready);
      await expect(request).resolves.toBe(true);
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]?.fetchedAtMs).toBe(61_000);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('preserves display models without extending launch proof through transient refresh or logout', async () => {
    vi.useFakeTimers();
    const requestStartedAtMs = Date.parse('2026-08-20T12:00:00.000Z');
    vi.setSystemTime(requestStartedAtMs);
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
    const ready: CliProviderStatus = {
      ...codex,
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...codex.capabilities, teamLaunch: true },
      models: ['gpt-project'],
      modelCatalog: null,
    };
    const getProviderStatus = vi
      .fn<() => Promise<CliProviderStatus>>()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error('refresh timed out'));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope(getProviderStatus),
          invalidateStatus: async () => undefined,
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const projectPath = '/project/transient-model-array';
    const scopeKey = getCliProviderStatusScopeKey('codex', projectPath);
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      await expect(
        store.getState().fetchCliProviderStatus('codex', {
          silent: true,
          projectPath,
          intent: 'launch-proof',
        })
      ).resolves.toBe(true);
      const originalFetchTime =
        store.getState().cliProviderLaunchProofByScope[scopeKey]?.fetchedAtMs;
      expect(originalFetchTime).toBe(requestStartedAtMs);

      vi.setSystemTime(requestStartedAtMs + 10_000);
      await expect(
        store.getState().fetchCliProviderStatus('codex', {
          silent: true,
          projectPath,
        })
      ).resolves.toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        '[Store:cliInstaller]',
        'Failed to fetch codex CLI status:',
        expect.any(Error)
      );
      vi.mocked(console.error).mockClear();

      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toMatchObject({
        providerStatus: ready,
        fetchedAtMs: originalFetchTime,
      });
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toMatchObject({
        authenticated: false,
        statusCheckOutcome: 'transient_error',
        models: ['gpt-project'],
        capabilities: { teamLaunch: false },
      });

      await store.getState().invalidateCliStatus();
      expect(store.getState().cliProviderLaunchProofByScope).toEqual({});
      expect(store.getState().cliProviderStatusByScope).toEqual({});
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('is isolated by exact project and cannot be cleared by another project generation', async () => {
    let resolveProjectA!: (status: CliProviderStatus) => void;
    let resolveProjectB!: (status: CliProviderStatus) => void;
    const projectAResult = new Promise<CliProviderStatus>((resolve) => {
      resolveProjectA = resolve;
    });
    const projectBResult = new Promise<CliProviderStatus>((resolve) => {
      resolveProjectB = resolve;
    });
    const previousApi = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope((_providerId, request) =>
            request.projectPath === '/project/a' ? projectAResult : projectBResult
          ),
        },
      } as unknown as ElectronAPI,
    });

    const store = createCliInstallerStore();
    const base = createLoadingMultimodelCliStatus();
    const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
    const ready: CliProviderStatus = {
      ...openCode,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...openCode.capabilities, teamLaunch: true },
      models: ['openai/project-model'],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-19T00:00:00.000Z',
        staleAt: '2099-08-19T00:05:00.000Z',
        defaultModelId: 'openai/project-model',
        defaultLaunchModel: 'openai/project-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    const scopeA = getCliProviderStatusScopeKey('opencode', '/project/a');
    const scopeB = getCliProviderStatusScopeKey('opencode', '/project/b');
    store.setState({
      cliStatus: { ...base, installed: true },
      cliProviderStatusByScope: { [scopeA]: ready, [scopeB]: ready },
    });

    try {
      const requestA = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath: '/project/a',
        intent: 'launch-proof',
      });
      const requestB = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath: '/project/b',
        intent: 'launch-proof',
      });

      expect(store.getState().cliProviderStatusLoadingByScope).toMatchObject({
        [scopeA]: true,
        [scopeB]: true,
      });
      expect(store.getState().cliProviderLaunchProofByScope[scopeA]).toBeUndefined();
      expect(store.getState().cliProviderLaunchProofByScope[scopeB]).toBeUndefined();
      expect(store.getState().cliProviderStatusByScope[scopeA]).toMatchObject({
        authenticated: false,
        statusCheckOutcome: 'pending',
        modelCatalogRefreshState: 'loading',
        modelCatalog: { status: 'stale' },
        capabilities: { teamLaunch: false },
      });

      resolveProjectA({
        ...openCode,
        verificationState: 'error',
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'timeout',
      });
      await requestA;
      expect(store.getState().cliProviderStatusLoadingByScope[scopeA]).toBeUndefined();
      expect(store.getState().cliProviderStatusLoadingByScope[scopeB]).toBe(true);
      expect(store.getState().cliProviderLaunchProofByScope[scopeA]).toBeUndefined();

      resolveProjectB(ready);
      await expect(requestB).resolves.toBe(true);
      expect(store.getState().cliProviderStatusLoadingByScope[scopeA]).toBeUndefined();
      expect(store.getState().cliProviderStatusLoadingByScope[scopeB]).toBeUndefined();
      expect(store.getState().cliProviderLaunchProofByScope[scopeB]).toMatchObject({
        providerStatus: ready,
        requestId: expect.any(Number),
        epoch: expect.any(Number),
        fetchedAtMs: expect.any(Number),
      });
      expect(store.getState().cliProviderLaunchProofByScope[scopeA]?.requestId).not.toBe(
        store.getState().cliProviderLaunchProofByScope[scopeB]?.requestId
      );
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('drops a late project result after its status generation was invalidated', async () => {
    let resolveProvider!: (status: CliProviderStatus) => void;
    const providerResult = new Promise<CliProviderStatus>((resolve) => {
      resolveProvider = resolve;
    });
    const previousApi = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: withProviderStatusEnvelope(() => providerResult),
          invalidateStatus: async () => undefined,
        },
      } as unknown as ElectronAPI,
    });
    const store = createCliInstallerStore();
    const base = createLoadingMultimodelCliStatus();
    const openCode = base.providers.find((provider) => provider.providerId === 'opencode')!;
    const scopeKey = getCliProviderStatusScopeKey('opencode', '/project/late');
    store.setState({ cliStatus: { ...base, installed: true } });

    try {
      const request = store.getState().fetchCliProviderStatus('opencode', {
        silent: true,
        projectPath: '/project/late',
        intent: 'launch-proof',
      });
      await store.getState().invalidateCliStatus();
      resolveProvider({
        ...openCode,
        supported: true,
        authenticated: true,
        authMethod: 'opencode_configured_local',
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        capabilities: { ...openCode.capabilities, teamLaunch: true },
        models: ['openai/late-model'],
      });

      await expect(request).resolves.toBe(false);
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toBeUndefined();
      expect(store.getState().cliProviderLaunchProofByScope[scopeKey]).toBeUndefined();
      expect(store.getState().cliProviderStatusLoadingByScope[scopeKey]).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });
});

describe('OpenCode runtime rejection state', () => {
  it('surfaces a rejected status check as failed without discarding known runtime identity', async () => {
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('runtime status IPC unavailable');
      },
      install: async () => {
        throw new Error('not used');
      },
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();
    store.setState({
      openCodeRuntimeStatus: {
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.16.0',
        source: 'path',
        state: 'ready',
      },
    });

    try {
      await store.getState().fetchOpenCodeRuntimeStatus();

      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: 'runtime status IPC unavailable',
        openCodeRuntimeStatus: {
          installed: true,
          binaryPath: '/known/opencode',
          version: '1.16.0',
          source: 'path',
          state: 'failed',
          error: 'runtime status IPC unavailable',
          progress: {
            phase: 'failed',
            detail: 'runtime status IPC unavailable',
          },
        },
      });
    } finally {
      restoreApi();
      vi.mocked(console.error).mockClear();
    }
  });

  it('replaces the temporary checking state with failed when installation rejects', async () => {
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('not used');
      },
      install: async () => {
        throw new Error('download connection lost');
      },
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();

    try {
      await store.getState().installOpenCodeRuntime();

      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: 'download connection lost',
        openCodeRuntimeStatus: {
          installed: false,
          source: 'missing',
          state: 'failed',
          error: 'download connection lost',
          progress: {
            phase: 'failed',
            detail: 'download connection lost',
          },
        },
      });
    } finally {
      restoreApi();
      vi.mocked(console.error).mockClear();
    }
  });

  it('keeps a working runtime usable while its update request is checking and then fails', async () => {
    let resolveInstall!: (status: OpenCodeRuntimeStatus) => void;
    const installResult = new Promise<OpenCodeRuntimeStatus>((resolve) => {
      resolveInstall = resolve;
    });
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('not used');
      },
      install: () => installResult,
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();
    store.setState({
      openCodeRuntimeStatus: {
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.16.0',
        source: 'app-managed',
        state: 'ready',
      },
    });

    try {
      const request = store.getState().installOpenCodeRuntime();
      expect(store.getState().openCodeRuntimeStatus).toMatchObject({
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.16.0',
        source: 'app-managed',
        state: 'checking',
      });

      resolveInstall({
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.16.0',
        source: 'app-managed',
        state: 'failed',
        error: 'registry unavailable',
      });
      await request;

      expect(store.getState().openCodeRuntimeStatus).toMatchObject({
        installed: true,
        binaryPath: '/known/opencode',
        source: 'app-managed',
        state: 'failed',
        error: 'registry unavailable',
      });
    } finally {
      restoreApi();
    }
  });
});

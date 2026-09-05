import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';

import {
  parseStrictQualifiedModelRef,
  qualifyModelId,
} from '../../core/domain/openCodeModelIdentity';

import { loadOpenCodeScopedCatalog, MODEL_CATALOG_FRESHNESS_MS } from './loadOpenCodeScopedCatalog';
import {
  normalizePassiveCatalogModel,
  normalizePassiveProviderOverview,
  normalizeProviderIdentity,
} from './openCodePassiveCatalogNormalization';

import type { RuntimeProviderModelDto } from '../../contracts';
import type {
  CliProviderModelAvailability,
  CliProviderModelCatalog,
  CliProviderModelCatalogItem,
  CliProviderStatus,
  OpenCodeModelRouteMetadata,
} from '@shared/types';

let nextRequestGroupNumber = 0;

type CatalogRequestStatus = 'idle' | 'loading' | 'ready' | 'error';
type CatalogFreshness = 'fresh' | 'stale' | null;

interface ScopedCatalogState {
  scopeKey: string | null;
  refreshRevision: number | undefined;
  status: CatalogRequestStatus;
  models: readonly RuntimeProviderModelDto[] | null;
  defaultModelId: string | null;
  diagnostics: readonly string[];
  catalogState: CatalogFreshness;
  completedAt: string | null;
  freshUntil: string | null;
  error: string | null;
}

export interface OpenCodeProviderModelCatalogResult {
  sourceProviderId: string | null;
  providerStatus: CliProviderStatus | null | undefined;
  status: CatalogRequestStatus;
  catalogState: CatalogFreshness;
  freshModelCount: number | null;
  error: string | null;
  refresh: () => void;
}

export function resolveOpenCodeSelectionScopeDecision(input: {
  value: string;
  runtimeNormalizedValue: string;
  selectionScopeKey: string | null;
  catalogScopeKey: string | null;
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  catalogState: 'fresh' | 'stale' | null;
}): { normalizedValue: string; preserve: boolean } {
  if (!input.catalogScopeKey) {
    return { normalizedValue: input.runtimeNormalizedValue, preserve: false };
  }

  const sameScope = input.selectionScopeKey === input.catalogScopeKey;
  const freshAuthority = input.catalogStatus === 'ready' && input.catalogState === 'fresh';
  return {
    normalizedValue:
      sameScope || freshAuthority || !input.value.trim() ? input.runtimeNormalizedValue : '',
    preserve: sameScope && !freshAuthority,
  };
}

function normalizeSourceProviderId(sourceProviderId: string | null | undefined): string | null {
  const normalized = sourceProviderId?.trim().toLowerCase() ?? '';
  if (!normalized || isOpenCodeLocalProviderId(normalized)) {
    return null;
  }
  return normalized;
}

export function resolveOpenCodeCatalogSourceProviderId(input: {
  selectedSourceIds: ReadonlySet<string>;
  selectedModel: string | null | undefined;
  localModelsSelected?: boolean;
  knownLocalSourceIds: ReadonlySet<string>;
  localProviderLookupReady: boolean;
}): string | null {
  const resolveCandidate = (candidate: string | null | undefined): string | null => {
    const normalized = candidate?.trim().toLowerCase() ?? '';
    if (
      !normalized ||
      isOpenCodeLocalProviderId(normalized) ||
      Array.from(input.knownLocalSourceIds).some(
        (sourceId) => sourceId.trim().toLowerCase() === normalized
      )
    ) {
      return null;
    }
    return normalized;
  };

  if (input.localModelsSelected) {
    return null;
  }
  if (input.selectedSourceIds.size === 1) {
    // An explicit built-in/free or local tab is still an explicit selection. Do not
    // fall back to the previously selected qualified model and fetch that provider.
    for (const selectedSource of input.selectedSourceIds) {
      return resolveCandidate(selectedSource);
    }
  }
  if (input.selectedSourceIds.size > 1) {
    return null;
  }

  if (!input.localProviderLookupReady) {
    return null;
  }
  return resolveCandidate(parseStrictQualifiedModelRef(input.selectedModel)?.sourceId ?? null);
}

function mapAvailability(model: RuntimeProviderModelDto): CliProviderModelAvailability {
  const status =
    model.availability === 'available'
      ? 'available'
      : model.availability === 'unavailable' || model.availability === 'not-authenticated'
        ? 'unavailable'
        : 'unknown';
  return {
    modelId: qualifyModelId(model.providerId, model.modelId),
    status,
    reason: model.accessReason ?? null,
    checkedAt: null,
  };
}

function findPassiveCatalogModel(
  passiveProvider: CliProviderStatus | null | undefined,
  launchModel: string
): CliProviderModelCatalogItem | null {
  const sourceProviderId = parseStrictQualifiedModelRef(launchModel)?.sourceId;
  if (!sourceProviderId) return null;
  for (const model of passiveProvider?.modelCatalog?.models ?? []) {
    const normalized = normalizePassiveCatalogModel(model, sourceProviderId);
    if (normalized?.model.launchModel === launchModel) return normalized.model;
  }
  return null;
}
function resolvePassiveRouteModelIdentity(
  route: OpenCodeModelRouteMetadata | null | undefined
): string | null {
  if (!route) return null;
  const providerId = normalizeProviderIdentity(route.providerId);
  const modelId = route.modelId?.trim();
  if (!providerId || !modelId || modelId !== route.modelId) return null;
  const direct = parseStrictQualifiedModelRef(modelId);
  if (direct?.sourceId === providerId) {
    return direct.raw;
  }
  const parsed = parseStrictQualifiedModelRef(`${providerId}/${modelId}`);
  return parsed?.sourceId === providerId ? parsed.raw : null;
}
function matchingPassiveProofRoute(
  passiveModel: CliProviderModelCatalogItem | null,
  sourceProviderId: string,
  launchModel: string
) {
  const passiveRoute = passiveModel?.metadata?.opencode;
  return normalizeProviderIdentity(passiveRoute?.providerId) === sourceProviderId &&
    resolvePassiveRouteModelIdentity(passiveRoute) === launchModel
    ? passiveRoute
    : null;
}
export function mapCatalogModel(
  model: RuntimeProviderModelDto,
  passiveProvider: CliProviderStatus | null | undefined
): CliProviderModelCatalogItem | null {
  const launchModel = qualifyModelId(model.providerId, model.modelId);
  if (!launchModel) {
    return null;
  }
  const passiveModel = findPassiveCatalogModel(passiveProvider, launchModel);
  const sourceProviderId = parseStrictQualifiedModelRef(launchModel)?.sourceId ?? '';
  const passiveRoute = matchingPassiveProofRoute(passiveModel, sourceProviderId, launchModel);
  return {
    id: launchModel,
    launchModel,
    displayName:
      model.displayName.trim() || parseStrictQualifiedModelRef(launchModel)?.modelId || launchModel,
    hidden: false,
    supportedReasoningEfforts: passiveModel?.supportedReasoningEfforts ?? [],
    defaultReasoningEffort: passiveModel?.defaultReasoningEffort ?? null,
    supportsFastMode: passiveModel?.supportsFastMode,
    inputModalities: passiveModel?.inputModalities ?? ['text'],
    supportsPersonality: passiveModel?.supportsPersonality ?? false,
    isDefault: model.default,
    upgrade: passiveModel?.upgrade ?? false,
    source: 'app-server',
    badgeLabel: model.sourceLabel.trim() || passiveModel?.badgeLabel || model.providerId,
    statusMessage: model.accessReason ?? passiveModel?.statusMessage ?? null,
    metadata: {
      ...passiveModel?.metadata,
      context:
        model.managedContextTokens ??
        model.catalogContextTokens ??
        passiveModel?.metadata?.context ??
        null,
      free: model.free,
      opencode: {
        providerId: model.providerId,
        modelId: parseStrictQualifiedModelRef(launchModel)?.modelId ?? model.modelId,
        sourceLabel: model.sourceLabel.trim() || model.providerId,
        accessKind: model.accessKind ?? 'unknown_model',
        routeKind: model.routeKind ?? 'catalog_provider',
        // Provider-model catalogs describe routes, not execution proof. Preserve
        // proof already carried by the passive status record, but never mint it
        // from catalog-only metadata.
        proofState: passiveRoute?.proofState ?? 'needs_probe',
        requiresExecutionProof: passiveRoute?.requiresExecutionProof ?? true,
        reason: model.accessReason ?? null,
      },
    },
  };
}
function sourceIdForModelId(modelId: string): string | null {
  return normalizeSourceProviderId(parseStrictQualifiedModelRef(modelId)?.sourceId);
}

function filterPassiveProviderToSource(
  provider: CliProviderStatus,
  sourceProviderId: string,
  status: CatalogRequestStatus,
  error: string | null
): CliProviderStatus {
  const catalog = provider.modelCatalog;
  const catalogModels = (catalog?.models ?? []).flatMap((model) => {
    const normalized = normalizePassiveCatalogModel(model, sourceProviderId);
    return normalized ? [normalized.model] : [];
  });
  const catalogModelIds = new Set(catalogModels.flatMap((model) => [model.launchModel, model.id]));
  const models = Array.from(
    new Set(
      provider.models.flatMap((modelId) => {
        const normalizedModelId = qualifyModelId(sourceProviderId, modelId);
        return normalizedModelId &&
          (sourceIdForModelId(modelId) === sourceProviderId ||
            catalogModelIds.has(normalizedModelId))
          ? [normalizedModelId]
          : [];
      })
    )
  );
  const visibleModelIds = new Set([
    ...models,
    ...catalogModels.map((model) => model.launchModel),
    ...catalogModels.map((model) => model.id),
  ]);
  const defaultLaunchModel = catalog?.defaultLaunchModel;
  const defaultModelId = catalog?.defaultModelId;
  const catalogDiagnostics = catalog?.diagnostics;
  const normalizeVisibleModelId = (modelId: string | null | undefined): string | null => {
    if (!modelId) {
      return null;
    }
    const normalizedModelId = qualifyModelId(sourceProviderId, modelId);
    return normalizedModelId && visibleModelIds.has(normalizedModelId) ? normalizedModelId : null;
  };
  return {
    ...provider,
    models,
    modelAvailability: provider.modelAvailability?.flatMap((model) => {
      const modelId = normalizeVisibleModelId(model.modelId);
      return modelId ? [{ ...model, modelId }] : [];
    }),
    modelCatalog: catalog
      ? {
          ...catalog,
          status: status === 'error' ? 'stale' : catalog.status,
          defaultLaunchModel: normalizeVisibleModelId(defaultLaunchModel),
          defaultModelId: normalizeVisibleModelId(defaultModelId),
          models: catalogModels,
          diagnostics: {
            configReadState: catalogDiagnostics?.configReadState ?? 'failed',
            appServerState: catalogDiagnostics?.appServerState ?? 'degraded',
            ...catalogDiagnostics,
            message: error ?? catalogDiagnostics?.message ?? null,
          },
        }
      : null,
    modelCatalogRefreshState:
      status === 'loading'
        ? 'loading'
        : status === 'error'
          ? 'error'
          : provider.modelCatalogRefreshState,
  };
}

function buildScopedProviderStatus(input: {
  passiveProvider: CliProviderStatus | null | undefined;
  sourceProviderId: string;
  state: ScopedCatalogState;
}): CliProviderStatus | null | undefined {
  const { passiveProvider, sourceProviderId, state } = input;
  if (!passiveProvider) {
    return passiveProvider;
  }
  if (!state.models) {
    return filterPassiveProviderToSource(
      passiveProvider,
      sourceProviderId,
      state.status,
      state.error
    );
  }

  const catalogModels = state.models.flatMap((model) => {
    const mapped = mapCatalogModel(model, passiveProvider);
    return mapped ? [mapped] : [];
  });
  const availability = state.models.map(mapAvailability);
  const defaultModel = state.defaultModelId
    ? qualifyModelId(sourceProviderId, state.defaultModelId)
    : (catalogModels.find((model) => model.isDefault)?.launchModel ?? null);
  const catalogStatus =
    state.status === 'error' || state.catalogState === 'stale'
      ? 'stale'
      : state.catalogState === 'fresh'
        ? 'ready'
        : 'degraded';
  const completedAt = state.completedAt ?? new Date(0).toISOString();
  const fetchedAt = state.freshUntil
    ? completedAt
    : (passiveProvider.modelCatalog?.fetchedAt ?? new Date(0).toISOString());
  const staleAt = state.freshUntil ?? fetchedAt;
  const catalog: CliProviderModelCatalog = {
    schemaVersion: 1,
    providerId: 'opencode',
    source: 'app-server',
    status: catalogStatus,
    fetchedAt,
    staleAt,
    defaultModelId: defaultModel,
    defaultLaunchModel: defaultModel,
    models: catalogModels,
    diagnostics: {
      configReadState: 'ready',
      appServerState: catalogStatus === 'ready' ? 'healthy' : 'degraded',
      message: state.error ?? (state.diagnostics.length > 0 ? state.diagnostics.join(' - ') : null),
      code:
        state.status === 'error'
          ? 'provider_scoped_catalog_failed'
          : state.catalogState === null
            ? 'provider_scoped_catalog_freshness_unknown'
            : state.catalogState === 'stale'
              ? 'provider_scoped_catalog_stale'
              : null,
    },
  };
  return {
    ...passiveProvider,
    models: catalogModels.map((model) => model.launchModel),
    modelAvailability: availability,
    modelCatalog: catalog,
    modelCatalogRefreshState:
      state.status === 'loading' ? 'loading' : state.status === 'error' ? 'error' : 'ready',
  };
}

export { normalizeModelResponseDiagnostics } from './loadOpenCodeScopedCatalog';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'The provider-model catalog request failed.';
}

export function useOpenCodeProviderModelCatalog(input: {
  enabled: boolean;
  sourceProviderId: string | null;
  projectPath?: string | null;
  refreshRevision?: number;
  passiveProviderStatus: CliProviderStatus | null | undefined;
}): OpenCodeProviderModelCatalogResult {
  const sourceProviderId = normalizeSourceProviderId(input.sourceProviderId);
  const projectPath = input.projectPath?.trim() || null;
  const scopeKey = sourceProviderId ? JSON.stringify([projectPath, sourceProviderId]) : null;
  const requestSequenceRef = useRef(0);
  const requestGroupIdRef = useRef(`team-model-selector-catalog:${++nextRequestGroupNumber}`);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [state, setState] = useState<ScopedCatalogState>({
    scopeKey: null,
    refreshRevision: undefined,
    status: 'idle',
    models: null,
    defaultModelId: null,
    diagnostics: [],
    catalogState: null,
    completedAt: null,
    freshUntil: null,
    error: null,
  });

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    const requestGroupId = `${requestGroupIdRef.current}:${requestSequence}`;
    if (!input.enabled || !sourceProviderId || !scopeKey) {
      setState({
        scopeKey: null,
        refreshRevision: undefined,
        status: 'idle',
        models: null,
        defaultModelId: null,
        diagnostics: [],
        catalogState: null,
        completedAt: null,
        freshUntil: null,
        error: null,
      });
      return;
    }
    const cancelModelLoad = isElectronMode()
      ? api.runtimeProviderManagement?.cancelModelLoad?.bind(api.runtimeProviderManagement)
      : undefined;

    setState((current) =>
      current.scopeKey === scopeKey && current.refreshRevision === input.refreshRevision
        ? { ...current, status: 'loading', error: null }
        : {
            scopeKey,
            refreshRevision: input.refreshRevision,
            status: 'loading',
            models: null,
            defaultModelId: null,
            diagnostics: [],
            catalogState: null,
            completedAt: null,
            freshUntil: null,
            error: null,
          }
    );

    void (async () => {
      const isCurrentRequest = (): boolean => requestSequenceRef.current === requestSequence;
      const result = await loadOpenCodeScopedCatalog(
        sourceProviderId,
        projectPath,
        requestGroupId,
        isCurrentRequest
      );
      if (!isCurrentRequest()) return;
      setState({
        scopeKey,
        refreshRevision: input.refreshRevision,
        status: 'ready',
        ...result,
        error: null,
      });
    })().catch((error: unknown) => {
      if (requestSequenceRef.current !== requestSequence) {
        return;
      }
      setState((current) =>
        current.scopeKey === scopeKey && current.refreshRevision === input.refreshRevision
          ? { ...current, status: 'error', error: errorMessage(error) }
          : current
      );
    });

    return () => {
      if (requestSequenceRef.current === requestSequence) {
        requestSequenceRef.current += 1;
      }
      if (typeof cancelModelLoad === 'function') {
        void cancelModelLoad({ requestGroupId }).catch(() => undefined);
      }
    };
  }, [
    input.enabled,
    input.refreshRevision,
    projectPath,
    refreshSequence,
    scopeKey,
    sourceProviderId,
  ]);

  useEffect(() => {
    if (state.status !== 'ready' || state.catalogState !== 'fresh' || !state.freshUntil) {
      return;
    }
    const delay = Math.min(
      MODEL_CATALOG_FRESHNESS_MS,
      Math.max(0, Date.parse(state.freshUntil) - Date.now())
    );
    const timer = window.setTimeout(() => {
      setRefreshSequence((sequence) => sequence + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    state.catalogState,
    state.completedAt,
    state.freshUntil,
    state.refreshRevision,
    state.scopeKey,
    state.status,
  ]);

  const activeState = useMemo<ScopedCatalogState>(
    () =>
      scopeKey && state.scopeKey === scopeKey && state.refreshRevision === input.refreshRevision
        ? state
        : {
            scopeKey,
            refreshRevision: input.refreshRevision,
            status: input.enabled && sourceProviderId ? 'loading' : 'idle',
            models: null,
            defaultModelId: null,
            diagnostics: [],
            catalogState: null,
            completedAt: null,
            freshUntil: null,
            error: null,
          },
    [input.enabled, input.refreshRevision, scopeKey, sourceProviderId, state]
  );
  const providerStatus = useMemo(
    () =>
      sourceProviderId
        ? buildScopedProviderStatus({
            passiveProvider: input.passiveProviderStatus,
            sourceProviderId,
            state: activeState,
          })
        : normalizePassiveProviderOverview(input.passiveProviderStatus),
    [activeState, input.passiveProviderStatus, sourceProviderId]
  );
  const refresh = useCallback(() => setRefreshSequence((sequence) => sequence + 1), []);

  return {
    sourceProviderId,
    providerStatus,
    status: activeState.status,
    catalogState: activeState.catalogState,
    freshModelCount:
      activeState.status === 'ready' && activeState.catalogState === 'fresh'
        ? (activeState.models?.length ?? null)
        : null,
    error: activeState.error,
    refresh,
  };
}

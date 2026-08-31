import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';

import type {
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderModelDto,
} from '../../contracts';
import type {
  CliProviderModelAvailability,
  CliProviderModelCatalog,
  CliProviderModelCatalogItem,
  CliProviderStatus,
} from '@shared/types';

const MODEL_PAGE_SIZE = 250;
const MAX_MODEL_PAGES = 20;
let nextRequestGroupNumber = 0;

type CatalogRequestStatus = 'idle' | 'loading' | 'ready' | 'error';
type CatalogFreshness = 'fresh' | 'stale' | null;

interface ScopedCatalogState {
  scopeKey: string | null;
  status: CatalogRequestStatus;
  models: readonly RuntimeProviderModelDto[] | null;
  defaultModelId: string | null;
  diagnostics: readonly string[];
  catalogState: CatalogFreshness;
  completedAt: string | null;
  error: string | null;
}

export interface OpenCodeProviderModelCatalogResult {
  sourceProviderId: string | null;
  providerStatus: CliProviderStatus | null | undefined;
  status: CatalogRequestStatus;
  catalogState: CatalogFreshness;
  error: string | null;
  refresh: () => void;
}

function normalizeSourceProviderId(sourceProviderId: string | null | undefined): string | null {
  const normalized = sourceProviderId?.trim().toLowerCase() ?? '';
  if (!normalized || normalized === 'opencode' || isOpenCodeLocalProviderId(normalized)) {
    return null;
  }
  return normalized;
}

export function resolveOpenCodeCatalogSourceProviderId(input: {
  selectedSourceIds: ReadonlySet<string>;
  selectedModel: string | null | undefined;
  localModelsSelected?: boolean;
}): string | null {
  if (input.localModelsSelected) {
    return null;
  }
  if (input.selectedSourceIds.size === 1) {
    const selectedSource = input.selectedSourceIds.values().next().value as string | undefined;
    // An explicit built-in/free or local tab is still an explicit selection. Do not
    // fall back to the previously selected qualified model and fetch that provider.
    return normalizeSourceProviderId(selectedSource);
  }
  if (input.selectedSourceIds.size > 1) {
    return null;
  }

  return normalizeSourceProviderId(
    parseOpenCodeQualifiedModelRef(input.selectedModel)?.sourceId ?? null
  );
}

function qualifyModelId(providerId: string, modelId: string): string {
  const normalizedModelId = modelId.trim();
  const parsed = parseOpenCodeQualifiedModelRef(normalizedModelId);
  if (parsed) {
    return parsed.raw;
  }
  return normalizedModelId ? `${providerId}/${normalizedModelId}` : '';
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
  return (
    passiveProvider?.modelCatalog?.models.find(
      (model) => model.launchModel === launchModel || model.id === launchModel
    ) ?? null
  );
}

function mapCatalogModel(
  model: RuntimeProviderModelDto,
  passiveProvider: CliProviderStatus | null | undefined
): CliProviderModelCatalogItem | null {
  const launchModel = qualifyModelId(model.providerId, model.modelId);
  if (!launchModel) {
    return null;
  }
  const passiveModel = findPassiveCatalogModel(passiveProvider, launchModel);
  return {
    id: launchModel,
    launchModel,
    displayName:
      model.displayName.trim() ||
      parseOpenCodeQualifiedModelRef(launchModel)?.modelId ||
      launchModel,
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
      context: model.managedContextTokens ?? model.catalogContextTokens ?? passiveModel?.metadata?.context ?? null,
      free: model.free,
      opencode: {
        providerId: model.providerId,
        modelId: parseOpenCodeQualifiedModelRef(launchModel)?.modelId ?? model.modelId,
        sourceLabel: model.sourceLabel.trim() || model.providerId,
        accessKind: model.accessKind ?? 'unknown_model',
        routeKind: model.routeKind ?? 'catalog_provider',
        proofState: model.proofState ?? 'needs_probe',
        requiresExecutionProof: model.requiresExecutionProof ?? false,
        reason: model.accessReason ?? null,
      },
    },
  };
}

function sourceIdForCatalogModel(model: CliProviderModelCatalogItem): string | null {
  return (
    normalizeSourceProviderId(model.metadata?.opencode?.providerId) ??
    normalizeSourceProviderId(parseOpenCodeQualifiedModelRef(model.launchModel)?.sourceId)
  );
}

function sourceIdForModelId(modelId: string): string | null {
  return normalizeSourceProviderId(parseOpenCodeQualifiedModelRef(modelId)?.sourceId);
}

function filterPassiveProviderToSource(
  provider: CliProviderStatus,
  sourceProviderId: string,
  status: CatalogRequestStatus,
  error: string | null
): CliProviderStatus {
  const catalog = provider.modelCatalog;
  const models = provider.models.filter(
    (modelId) => sourceIdForModelId(modelId) === sourceProviderId
  );
  const catalogModels = (catalog?.models ?? []).filter(
    (model) => sourceIdForCatalogModel(model) === sourceProviderId
  );
  const visibleModelIds = new Set([
    ...models,
    ...catalogModels.map((model) => model.launchModel),
    ...catalogModels.map((model) => model.id),
  ]);
  const defaultLaunchModel = catalog?.defaultLaunchModel;
  const defaultModelId = catalog?.defaultModelId;
  return {
    ...provider,
    models,
    modelAvailability: provider.modelAvailability?.filter((model) =>
      visibleModelIds.has(model.modelId)
    ),
    modelCatalog: catalog
      ? {
          ...catalog,
          status: status === 'error' ? 'stale' : catalog.status,
          defaultLaunchModel:
            defaultLaunchModel && visibleModelIds.has(defaultLaunchModel)
              ? defaultLaunchModel
              : null,
          defaultModelId:
            defaultModelId && visibleModelIds.has(defaultModelId) ? defaultModelId : null,
          models: catalogModels,
          diagnostics: {
            ...catalog.diagnostics,
            message: error ?? catalog.diagnostics.message ?? null,
          },
        }
      : null,
    modelCatalogRefreshState:
      status === 'loading' ? 'loading' : status === 'error' ? 'error' : provider.modelCatalogRefreshState,
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
    return filterPassiveProviderToSource(passiveProvider, sourceProviderId, state.status, state.error);
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
  const fetchedAt =
    state.catalogState === 'fresh'
      ? completedAt
      : (passiveProvider.modelCatalog?.fetchedAt ?? new Date(0).toISOString());
  const staleAt =
    catalogStatus === 'ready'
      ? new Date(Date.parse(fetchedAt) + 2 * 60_000).toISOString()
      : fetchedAt;
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

function responseFailure(
  response: RuntimeProviderManagementModelsResponse,
  sourceProviderId: string
): string | null {
  if (response.schemaVersion !== 1 || response.runtimeId !== 'opencode') {
    return 'The runtime returned an unsupported provider-model catalog response.';
  }
  if (response.error) {
    return response.error.message || 'The provider-model catalog request failed.';
  }
  if (!response.models) {
    return 'The runtime did not return a provider-model catalog.';
  }
  if (response.models.providerId.trim().toLowerCase() !== sourceProviderId) {
    return `The runtime returned models for ${response.models.providerId}, not ${sourceProviderId}.`;
  }
  return null;
}

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
  const requestGroupIdRef = useRef(
    `team-model-selector-catalog:${++nextRequestGroupNumber}`
  );
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [state, setState] = useState<ScopedCatalogState>({
    scopeKey: null,
    status: 'idle',
    models: null,
    defaultModelId: null,
    diagnostics: [],
    catalogState: null,
    completedAt: null,
    error: null,
  });

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    if (!input.enabled || !sourceProviderId || !scopeKey) {
      setState({
        scopeKey: null,
        status: 'idle',
        models: null,
        defaultModelId: null,
        diagnostics: [],
        catalogState: null,
        completedAt: null,
        error: null,
      });
      return;
    }

    setState((current) =>
      current.scopeKey === scopeKey
        ? { ...current, status: 'loading', error: null }
        : {
            scopeKey,
            status: 'loading',
            models: null,
            defaultModelId: null,
            diagnostics: [],
            catalogState: null,
            completedAt: null,
            error: null,
          }
    );

    void (async () => {
      const modelById = new Map<string, RuntimeProviderModelDto>();
      let cursor: string | null = null;
      let defaultModelId: string | null = null;
      let diagnostics: readonly string[] = [];
      let sawStaleCatalog = false;
      let sawUnknownCatalogState = false;
      const seenCursors = new Set<string>();

      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        if (requestSequenceRef.current !== requestSequence) {
          return;
        }
        const response = await api.runtimeProviderManagement.loadModels({
          runtimeId: 'opencode',
          providerId: sourceProviderId,
          projectPath,
          query: null,
          limit: MODEL_PAGE_SIZE,
          cursor,
          requestGroupId: requestGroupIdRef.current,
        });
        if (requestSequenceRef.current !== requestSequence) {
          return;
        }
        const failure = responseFailure(response, sourceProviderId);
        if (failure) {
          throw new Error(failure);
        }
        const modelPage = response.models!;
        for (const model of modelPage.models) {
          const modelId = qualifyModelId(model.providerId, model.modelId);
          if (modelId) {
            modelById.set(modelId, model);
          }
        }
        defaultModelId = modelPage.defaultModelId ?? defaultModelId;
        diagnostics = modelPage.diagnostics;
        if (modelPage.catalogState === 'stale') {
          sawStaleCatalog = true;
        } else if (modelPage.catalogState !== 'fresh') {
          sawUnknownCatalogState = true;
        }
        const nextCursor = modelPage.nextCursor?.trim() || null;
        if (!nextCursor) {
          break;
        }
        if (seenCursors.has(nextCursor) || page === MAX_MODEL_PAGES - 1) {
          throw new Error('The runtime returned an invalid provider-model pagination cursor.');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (requestSequenceRef.current !== requestSequence) {
        return;
      }
      setState({
        scopeKey,
        status: 'ready',
        models: Array.from(modelById.values()),
        defaultModelId,
        diagnostics,
        catalogState: sawUnknownCatalogState ? null : sawStaleCatalog ? 'stale' : 'fresh',
        completedAt: new Date().toISOString(),
        error: null,
      });
    })().catch((error: unknown) => {
      if (requestSequenceRef.current !== requestSequence) {
        return;
      }
      setState((current) =>
        current.scopeKey === scopeKey
          ? { ...current, status: 'error', error: errorMessage(error) }
          : current
      );
    });

    return () => {
      if (requestSequenceRef.current === requestSequence) {
        requestSequenceRef.current += 1;
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

  const activeState =
    scopeKey && state.scopeKey === scopeKey
      ? state
      : {
          scopeKey,
          status: input.enabled && sourceProviderId ? ('loading' as const) : ('idle' as const),
          models: null,
          defaultModelId: null,
          diagnostics: [],
          catalogState: null,
          completedAt: null,
          error: null,
        };
  const providerStatus = useMemo(
    () =>
      sourceProviderId
        ? buildScopedProviderStatus({
            passiveProvider: input.passiveProviderStatus,
            sourceProviderId,
            state: activeState,
          })
        : input.passiveProviderStatus,
    [activeState, input.passiveProviderStatus, sourceProviderId]
  );
  const refresh = useCallback(() => setRefreshSequence((sequence) => sequence + 1), []);

  return {
    sourceProviderId,
    providerStatus,
    status: activeState.status,
    catalogState: activeState.catalogState,
    error: activeState.error,
    refresh,
  };
}

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
  OpenCodeModelRouteMetadata,
} from '@shared/types';

const MODEL_PAGE_SIZE = 250;
const MAX_MODEL_PAGES = 20;
const MODEL_CATALOG_FRESHNESS_MS = 2 * 60_000;
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

function parseStrictQualifiedModelRef(modelId: string | null | undefined) {
  const parsed = parseOpenCodeQualifiedModelRef(modelId);
  return parsed && parsed.raw.split('/').every((segment) => segment.length > 0) ? parsed : null;
}

function normalizeSourceProviderId(sourceProviderId: string | null | undefined): string | null {
  const normalized = sourceProviderId?.trim().toLowerCase() ?? '';
  if (!normalized || isOpenCodeLocalProviderId(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeProviderIdentity(providerId: string | null | undefined): string | null {
  const normalized = providerId?.trim().toLowerCase() ?? '';
  return normalized && parseStrictQualifiedModelRef(`${normalized}/model`)?.sourceId === normalized
    ? normalized
    : null;
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

function qualifyModelId(providerId: string, modelId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (
    !normalizedProviderId ||
    !normalizedModelId ||
    normalizedModelId !== modelId ||
    /\s/.test(normalizedModelId)
  ) {
    return '';
  }
  if (normalizedModelId.includes('/')) {
    const parsed = parseStrictQualifiedModelRef(normalizedModelId);
    if (!parsed) {
      return '';
    }
    return parsed.sourceId === normalizedProviderId ? parsed.raw : '';
  }
  const parsed = parseStrictQualifiedModelRef(`${normalizedProviderId}/${normalizedModelId}`);
  return parsed?.sourceId === normalizedProviderId ? parsed.raw : '';
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
function mapCatalogModel(
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
      model.displayName.trim() ||
      parseStrictQualifiedModelRef(launchModel)?.modelId ||
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
function normalizePassiveCatalogModel(
  model: CliProviderModelCatalogItem,
  expectedSourceProviderId?: string
): { model: CliProviderModelCatalogItem; aliases: readonly string[] } | null {
  const rawIds = [model.id, model.launchModel];
  const parsedIds = rawIds.map(parseStrictQualifiedModelRef);
  if (
    rawIds.some(
      (value, index) =>
        !value || value !== value.trim() || /\s/.test(value) || (value.includes('/') && !parsedIds[index])
    )
  ) {
    return null;
  }
  const qualifiedIds = new Set(
    parsedIds.flatMap((candidate) => (candidate ? [candidate.raw] : []))
  );
  const unqualifiedIds = new Set(rawIds.filter((_value, index) => !parsedIds[index]));
  if (qualifiedIds.size > 1 || unqualifiedIds.size > 1) return null;
  const route = model.metadata?.opencode;
  const routeProviderId = normalizeProviderIdentity(route?.providerId);
  const rawRouteModelId = route?.modelId;
  const routeModelRef =
    typeof rawRouteModelId === 'string' && rawRouteModelId === rawRouteModelId.trim()
      ? parseStrictQualifiedModelRef(`route/${rawRouteModelId}`)
      : null;
  const relativeRouteModelId = routeModelRef?.sourceId === 'route' ? routeModelRef.modelId : null;
  const directRouteModelRef = parseStrictQualifiedModelRef(rawRouteModelId);
  const routeModelIdentity =
    routeProviderId && relativeRouteModelId
      ? directRouteModelRef?.sourceId === routeProviderId
        ? directRouteModelRef.raw
        : parseStrictQualifiedModelRef(`${routeProviderId}/${relativeRouteModelId}`)?.raw ?? null
      : null;
  const routeModelId =
    parseStrictQualifiedModelRef(routeModelIdentity)?.modelId ?? relativeRouteModelId;
  const qualifiedIdentity = qualifiedIds.values().next().value as string | undefined;
  const qualifiedRef = parseStrictQualifiedModelRef(qualifiedIdentity);
  if (
    (route?.providerId != null && !routeProviderId) ||
    (route?.modelId != null && !routeModelId) ||
    (routeProviderId && qualifiedRef && routeProviderId !== qualifiedRef.sourceId) ||
    (routeModelId && qualifiedRef && routeModelId !== qualifiedRef.modelId) ||
    (routeModelIdentity && qualifiedIdentity && routeModelIdentity !== qualifiedIdentity)
  ) {
    return null;
  }
  const unqualifiedIdentity = unqualifiedIds.values().next().value as string | undefined;
  if (unqualifiedIdentity) {
    const routeModelId = parseStrictQualifiedModelRef(routeModelIdentity)?.modelId;
    if (!routeProviderId || !routeModelIdentity || routeModelId !== unqualifiedIdentity) {
      return null;
    }
  }
  const identity = qualifiedIdentity ?? routeModelIdentity;
  const sourceProviderId = parseStrictQualifiedModelRef(identity)?.sourceId ?? null;
  if (!identity || !sourceProviderId || (expectedSourceProviderId && sourceProviderId !== expectedSourceProviderId)) {
    return null;
  }
  return {
    model: { ...model, id: identity, launchModel: identity },
    aliases: Array.from(new Set([model.id, model.launchModel, identity])),
  };
}
function normalizePassiveProviderOverview(
  provider: CliProviderStatus | null | undefined
): CliProviderStatus | null | undefined {
  if (!provider) return provider;
  const catalog = provider.modelCatalog;
  const normalizedEntries = (catalog?.models ?? []).flatMap((model) => {
    const normalized = normalizePassiveCatalogModel(model);
    return normalized ? [normalized] : [];
  });
  const aliases = new Map<string, string | null>();
  for (const entry of normalizedEntries) {
    for (const alias of entry.aliases) {
      if (!aliases.has(alias)) {
        aliases.set(alias, entry.model.launchModel);
      } else if (aliases.get(alias) !== entry.model.launchModel) {
        aliases.set(alias, null);
      }
    }
  }
  const normalizeVisibleModelId = (modelId: string | null | undefined): string | null => {
    if (!modelId) return null;
    const parsed = parseStrictQualifiedModelRef(modelId);
    const qualified = parsed ? qualifyModelId(parsed.sourceId, modelId) : '';
    return qualified || aliases.get(modelId) || null;
  };
  const models = Array.from(
    new Set(provider.models.flatMap((modelId) => {
      const normalized = normalizeVisibleModelId(modelId);
      return normalized ? [normalized] : [];
    }))
  );
  const visibleModelIds = new Set(
    [...models, ...normalizedEntries.map((entry) => entry.model.launchModel)]
  );
  const availabilityByModelId = new Map<string, CliProviderModelAvailability>();
  for (const availability of provider.modelAvailability ?? []) {
    const modelId = normalizeVisibleModelId(availability.modelId);
    if (modelId && visibleModelIds.has(modelId)) {
      availabilityByModelId.set(modelId, { ...availability, modelId });
    }
  }
  const defaultModelId = normalizeVisibleModelId(catalog?.defaultModelId);
  const defaultLaunchModel = normalizeVisibleModelId(catalog?.defaultLaunchModel);
  const declaredDefaults = new Set(
    [defaultModelId, defaultLaunchModel].filter(
      (modelId): modelId is string => modelId !== null && visibleModelIds.has(modelId)
    )
  );
  const flaggedDefaults = new Set(
    normalizedEntries.filter((entry) => entry.model.isDefault).map((entry) => entry.model.launchModel)
  );
  const resolvedDefault =
    declaredDefaults.size === 1
      ? declaredDefaults.values().next().value ?? null
      : declaredDefaults.size === 0 && flaggedDefaults.size === 1
        ? flaggedDefaults.values().next().value ?? null
        : null;
  const catalogModels = normalizedEntries.map((entry) => ({
    ...entry.model,
    isDefault: entry.model.launchModel === resolvedDefault,
  }));

  return {
    ...provider,
    models,
    modelAvailability: provider.modelAvailability
      ? Array.from(availabilityByModelId.values())
      : provider.modelAvailability,
    modelCatalog: catalog
      ? {
          ...catalog,
          defaultModelId: resolvedDefault,
          defaultLaunchModel: resolvedDefault,
          models: catalogModels,
        }
      : catalog,
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
  const catalogModelIds = new Set(
    catalogModels.flatMap((model) => [model.launchModel, model.id])
  );
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
    return normalizedModelId && visibleModelIds.has(normalizedModelId)
      ? normalizedModelId
      : null;
  };
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
    state.freshUntil
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
  if (response.models.runtimeId !== 'opencode') {
    return 'The runtime returned an unsupported provider-model catalog response.';
  }
  if (response.models.providerId.trim().toLowerCase() !== sourceProviderId) {
    return `The runtime returned models for ${response.models.providerId}, not ${sourceProviderId}.`;
  }
  for (const model of response.models.models) {
    const modelProviderId = model.providerId.trim().toLowerCase();
    if (modelProviderId !== sourceProviderId) {
      return `The runtime returned a foreign ${model.providerId || 'unknown'} model in the ${sourceProviderId} catalog.`;
    }
    const qualifiedModel = parseStrictQualifiedModelRef(model.modelId);
    if (qualifiedModel && qualifiedModel.sourceId !== sourceProviderId) {
      return `The runtime returned foreign model ${qualifiedModel.raw} in the ${sourceProviderId} catalog.`;
    }
    if (!qualifyModelId(sourceProviderId, model.modelId)) {
      return `The runtime returned an invalid model identifier in the ${sourceProviderId} catalog.`;
    }
  }
  const qualifiedDefault = parseStrictQualifiedModelRef(response.models.defaultModelId);
  if (qualifiedDefault && qualifiedDefault.sourceId !== sourceProviderId) {
    return `The runtime returned foreign default model ${qualifiedDefault.raw} in the ${sourceProviderId} catalog.`;
  }
  if (
    response.models.defaultModelId != null &&
    !qualifyModelId(sourceProviderId, response.models.defaultModelId)
  ) {
    return `The runtime returned an invalid default model identifier in the ${sourceProviderId} catalog.`;
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
  const refreshTriggerRef = useRef<{ sequence: number; revision: number | undefined } | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [state, setState] = useState<ScopedCatalogState>({
    scopeKey: null,
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
    const previousRefreshTrigger = refreshTriggerRef.current;
    const refreshTrigger = { sequence: refreshSequence, revision: input.refreshRevision };
    const bypassCompletedCache =
      previousRefreshTrigger !== null &&
      (previousRefreshTrigger.sequence !== refreshTrigger.sequence ||
        previousRefreshTrigger.revision !== refreshTrigger.revision);
    refreshTriggerRef.current = refreshTrigger;
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
        freshUntil: null,
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
            freshUntil: null,
            error: null,
          }
    );

    void (async () => {
      const isCurrentRequest = (): boolean => requestSequenceRef.current === requestSequence;
      const modelById = new Map<string, RuntimeProviderModelDto>();
      let cursor: string | null = null;
      let defaultModelId: string | null = null;
      let diagnostics: readonly string[] = [];
      let sawStaleCatalog = false;
      let sawUnknownCatalogState = false;
      const seenCursors = new Set<string>();

      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        if (!isCurrentRequest()) {
          return;
        }
        const response = await api.runtimeProviderManagement.loadModels({
          runtimeId: 'opencode',
          providerId: sourceProviderId,
          projectPath,
          query: null,
          limit: MODEL_PAGE_SIZE,
          cursor,
          ...(page === 0 && bypassCompletedCache ? { refresh: true } : {}),
          requestGroupId: requestGroupIdRef.current,
        });
        if (!isCurrentRequest()) {
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
        if (!isCurrentRequest()) {
          return;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (!isCurrentRequest()) {
        return;
      }
      const completedAt = new Date().toISOString();
      const catalogState = sawUnknownCatalogState ? null : sawStaleCatalog ? 'stale' : 'fresh';
      setState({
        scopeKey,
        status: 'ready',
        models: Array.from(modelById.values()),
        defaultModelId,
        diagnostics,
        catalogState,
        completedAt,
        freshUntil:
          catalogState === 'fresh'
            ? new Date(Date.parse(completedAt) + MODEL_CATALOG_FRESHNESS_MS).toISOString()
            : null,
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

  useEffect(() => {
    if (state.status !== 'ready' || state.catalogState !== 'fresh' || !state.freshUntil) {
      return;
    }
    const delay = Math.min(
      MODEL_CATALOG_FRESHNESS_MS,
      Math.max(0, Date.parse(state.freshUntil) - Date.now())
    );
    const timer = window.setTimeout(() => {
      setState((current) =>
        current.scopeKey === state.scopeKey &&
        current.completedAt === state.completedAt &&
        current.catalogState === 'fresh'
          ? { ...current, catalogState: 'stale' }
          : current
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state.catalogState, state.completedAt, state.freshUntil, state.scopeKey, state.status]);

  const activeState = useMemo<ScopedCatalogState>(
    () =>
      scopeKey && state.scopeKey === scopeKey
        ? state
        : {
            scopeKey,
            status: input.enabled && sourceProviderId ? 'loading' : 'idle',
            models: null,
            defaultModelId: null,
            diagnostics: [],
            catalogState: null,
            completedAt: null,
            freshUntil: null,
            error: null,
          },
    [input.enabled, scopeKey, sourceProviderId, state]
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

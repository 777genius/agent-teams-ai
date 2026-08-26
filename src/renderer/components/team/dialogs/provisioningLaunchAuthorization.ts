import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeModelExplicitlyFree } from '@shared/utils/opencodeModelRoute';

import type {
  ProvisioningPrepareState,
  ProvisioningProviderCheck,
} from './provisioningProviderChecks';
import type {
  AuthoritativeModelExecutionProof,
  CliProviderModelCatalogItem,
  CliProviderStatus,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export const isAuthoritativeProvisioningReady = (state: unknown): state is 'ready' =>
  state === 'ready';

export interface ProviderLaunchSelectedModel {
  model: string;
  providerBackendId?: TeamProviderBackendId | null;
}

export type ProviderLaunchSelectedModelsById = ReadonlyMap<
  TeamProviderId,
  readonly ProviderLaunchSelectedModel[]
>;

function getExactAuthoritativeOpenCodeCatalogModel(
  provider: CliProviderStatus,
  model: string
): CliProviderModelCatalogItem | null {
  const exactMatches =
    provider.modelCatalog?.models.filter((item) => item.launchModel.trim() === model) ?? [];
  if (exactMatches.length !== 1) return null;
  const catalogModel = exactMatches[0];
  const route = catalogModel?.metadata?.opencode;
  const selectedRoute = parseOpenCodeQualifiedModelRef(model);
  if (
    !catalogModel ||
    catalogModel.hidden ||
    catalogModel.source === 'static-fallback' ||
    !route ||
    !selectedRoute ||
    route.providerId?.trim().toLowerCase() !== selectedRoute.sourceId ||
    route.modelId?.trim() !== selectedRoute.modelId
  ) {
    return null;
  }
  return catalogModel;
}

export function isAuthoritativeFreeOpenCodeLaunchRoute(
  provider: CliProviderStatus,
  model: string
): boolean {
  const catalogModel = getExactAuthoritativeOpenCodeCatalogModel(provider, model);
  const route = catalogModel?.metadata?.opencode;
  if (!catalogModel || !route) return false;
  const isBuiltinFree =
    route.routeKind === 'builtin_free' && route.accessKind === 'builtin_free';
  const isExactCatalogFreeModel = isOpenCodeModelExplicitlyFree({
    modelId: catalogModel.launchModel,
    catalogId: catalogModel.id,
    providerId: route.providerId,
    routeKind: route.routeKind,
    accessKind: route.accessKind,
    free: catalogModel.metadata?.free,
    badgeLabel: catalogModel.badgeLabel,
  });
  return (
    isBuiltinFree ||
    (isExactCatalogFreeModel && catalogModel.launchModel.toLowerCase().includes(':free'))
  );
}

function isAuthoritativeOpenCodeCatalogModel(
  provider: CliProviderStatus,
  model: string
): boolean {
  const catalogModel = getExactAuthoritativeOpenCodeCatalogModel(provider, model);
  const route = catalogModel?.metadata?.opencode;
  if (!catalogModel || !route) return false;
  return (
    isAuthoritativeFreeOpenCodeLaunchRoute(provider, model) ||
    (provider.authenticated === true &&
      (route.routeKind === 'connected_provider' || route.routeKind === 'configured_local') &&
      !isOpenCodeModelExplicitlyFree({
        modelId: catalogModel.launchModel,
        catalogId: catalogModel.id,
        providerId: route.providerId,
        routeKind: route.routeKind,
        accessKind: route.accessKind,
        free: catalogModel.metadata?.free,
        badgeLabel: catalogModel.badgeLabel,
      }))
  );
}

function hasAuthoritativeOpenCodeModelProof(
  provider: CliProviderStatus,
  selectedModels: readonly ProviderLaunchSelectedModel[],
  nowMs: number
): boolean {
  const catalog = provider.modelCatalog;
  const fetchedAtMs = Date.parse(catalog?.fetchedAt ?? '');
  if (
    catalog?.providerId !== 'opencode' ||
    !Number.isFinite(fetchedAtMs) ||
    fetchedAtMs > nowMs ||
    catalog.diagnostics?.configReadState !== 'ready' ||
    catalog.diagnostics?.appServerState !== 'healthy'
  ) {
    return false;
  }
  const normalizedSelectedModels = Array.from(
    new Set(selectedModels.map(({ model }) => model.trim()).filter(Boolean))
  );
  if (normalizedSelectedModels.length > 0) {
    return normalizedSelectedModels.every((model) =>
      isAuthoritativeOpenCodeCatalogModel(provider, model)
    );
  }
  const defaultModel = catalog.defaultLaunchModel?.trim() || catalog.defaultModelId?.trim() || '';
  return Boolean(defaultModel) && isAuthoritativeOpenCodeCatalogModel(provider, defaultModel);
}

export function isAuthoritativeProviderLaunchStatus(
  provider: CliProviderStatus | null | undefined,
  loading = false,
  nowMs = Date.now(),
  selectedModels: readonly ProviderLaunchSelectedModel[] = []
): boolean {
  const catalog = provider?.modelCatalog;
  const catalogIsFresh = Boolean(
    catalog &&
    catalog.providerId === provider?.providerId &&
    catalog.source !== 'static-fallback' &&
    catalog.status === 'ready' &&
    provider?.modelCatalogRefreshState === 'ready' &&
    Number.isFinite(Date.parse(catalog.staleAt)) &&
    Date.parse(catalog.staleAt) > nowMs &&
    Array.isArray(catalog.models) &&
    catalog.models.length > 0
  );
  const hasFreshModelProof =
    provider?.providerId === 'opencode'
      ? catalogIsFresh && hasAuthoritativeOpenCodeModelProof(provider, selectedModels, nowMs)
      : catalog
        ? catalogIsFresh
        : (provider?.modelAvailability?.length ?? 0) > 0 || (provider?.models.length ?? 0) > 0;
  const authenticationAllowsLaunch =
    provider?.authenticated === true ||
    (provider?.providerId === 'opencode' &&
      hasFreshModelProof &&
      (selectedModels.length > 0
        ? selectedModels.every(({ model }) =>
            isAuthoritativeFreeOpenCodeLaunchRoute(provider, model.trim())
          )
        : Boolean(
            (catalog?.defaultLaunchModel?.trim() || catalog?.defaultModelId?.trim()) &&
              isAuthoritativeFreeOpenCodeLaunchRoute(
                provider,
                catalog?.defaultLaunchModel?.trim() || catalog?.defaultModelId?.trim() || ''
              )
          )));
  return Boolean(
    !loading &&
    provider?.supported === true &&
    authenticationAllowsLaunch &&
    provider.verificationState === 'verified' &&
    provider.statusCheckOutcome === 'authoritative' &&
    provider.capabilities.teamLaunch === true &&
    hasFreshModelProof
  );
}

export function resolveProvisioningPreparationAuthorizationState(
  checks: readonly ProvisioningProviderCheck[],
  _warnings: readonly string[],
  options: boolean | { experimentalOverrideEnabled?: boolean } = {}
): Exclude<ProvisioningPrepareState, 'idle'> {
  if (checks.some((check) => check.status === 'pending' || check.status === 'checking')) {
    return 'loading';
  }
  if (checks.length === 0) {
    return 'failed';
  }
  const failedChecks = checks.filter((check) => check.status === 'failed');
  const experimentalOverrideEnabled =
    typeof options === 'boolean' ? options : options.experimentalOverrideEnabled === true;
  const experimentalFailuresAreExplicitlyEligible =
    experimentalOverrideEnabled &&
    failedChecks.length > 0 &&
    failedChecks.every((check) => check.experimentalOverrideAvailable === true);
  const statusesAllowLaunch = checks.every(
    (check) =>
      check.status === 'ready' ||
      check.status === 'notes' ||
      (experimentalFailuresAreExplicitlyEligible && check.status === 'failed')
  );
  const hasNonOverridableErrorDiagnostic = checks.some(
    (check) =>
      check.supportDiagnostics?.some((diagnostic) => diagnostic.severity === 'error') === true &&
      !(experimentalFailuresAreExplicitlyEligible && check.status === 'failed')
  );
  return statusesAllowLaunch && !hasNonOverridableErrorDiagnostic ? 'ready' : 'failed';
}

export function isProvisioningPreparationAuthorizationCandidate(
  checks: readonly ProvisioningProviderCheck[],
  warnings: readonly string[]
): boolean {
  return (
    resolveProvisioningPreparationAuthorizationState(checks, warnings, {
      experimentalOverrideEnabled: true,
    }) === 'ready'
  );
}

export function resolveProvisioningLaunchPreparationState(
  prepareState: ProvisioningPrepareState,
  checks: readonly ProvisioningProviderCheck[],
  warnings: readonly string[],
  experimentalLocalModelOverrideEnabled: boolean
): ProvisioningPrepareState {
  const authorizationState = resolveProvisioningPreparationAuthorizationState(checks, warnings, {
    experimentalOverrideEnabled: experimentalLocalModelOverrideEnabled,
  });
  if (authorizationState !== 'ready') {
    return authorizationState;
  }
  const usesEligibleOverride =
    prepareState === 'failed' &&
    experimentalLocalModelOverrideEnabled &&
    checks.some(
      (check) => check.status === 'failed' && check.experimentalOverrideAvailable === true
    );
  return usesEligibleOverride ? 'ready' : prepareState;
}

export function areProviderLaunchStatusesAuthoritative(
  providerIds: readonly TeamProviderId[],
  providerStatusById: ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>,
  providerLoadingById: ReadonlyMap<TeamProviderId, boolean | null | undefined>,
  selectedModelsByProvider?: ProviderLaunchSelectedModelsById
): boolean {
  return (
    providerIds.length > 0 &&
    Array.from(new Set(providerIds)).every((providerId) => {
      const provider = providerStatusById.get(providerId);
      const selectedModels = selectedModelsByProvider?.get(providerId) ?? [];
      return (
        (selectedModelsByProvider === undefined ||
          (selectedModels.length > 0 &&
            selectedModels.every(
              (selection) =>
                selection.model.trim().length > 0 &&
                Object.hasOwn(selection, 'providerBackendId') &&
                (providerId === 'anthropic' ||
                  (selection.providerBackendId !== null &&
                    selection.providerBackendId !== undefined &&
                    (selection.providerBackendId !== 'auto' || providerId === 'codex')))
            ))) &&
        provider?.providerId === providerId &&
        isAuthoritativeProviderLaunchStatus(
          provider,
          providerLoadingById.get(providerId) === true,
          Date.now(),
          selectedModels
        )
      );
    })
  );
}

export interface ScheduledProviderPrepareIdleHandle {
  kind: 'idle' | 'timeout';
  id: number;
}

export interface ProviderPrepareIdleScheduler {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (callback: () => void, timeout: number) => number;
  clearTimeout: (id: number) => void;
}

export function cancelScheduledProviderPrepareIdle(
  scheduler: ProviderPrepareIdleScheduler,
  handles: Set<ScheduledProviderPrepareIdleHandle>
): void {
  for (const handle of handles) {
    if (handle.kind === 'idle') {
      scheduler.cancelIdleCallback?.(handle.id);
    } else {
      scheduler.clearTimeout(handle.id);
    }
  }
  handles.clear();
}

export function scheduleGuardedProviderPrepareIdle({
  scheduler,
  handles,
  generation,
  requestSignature,
  getCurrentGeneration,
  getCurrentRequestSignature,
  run,
}: {
  scheduler: ProviderPrepareIdleScheduler;
  handles: Set<ScheduledProviderPrepareIdleHandle>;
  generation: number;
  requestSignature: string;
  getCurrentGeneration: () => number;
  getCurrentRequestSignature: () => string | null;
  run: () => void;
}): ScheduledProviderPrepareIdleHandle {
  const callback = (): void => {
    handles.delete(handle);
    if (
      getCurrentGeneration() !== generation ||
      getCurrentRequestSignature() !== requestSignature
    ) {
      return;
    }
    run();
  };
  const handle: ScheduledProviderPrepareIdleHandle =
    typeof scheduler.requestIdleCallback === 'function'
      ? {
          kind: 'idle',
          id: scheduler.requestIdleCallback(callback, { timeout: 2000 }),
        }
      : { kind: 'timeout', id: scheduler.setTimeout(callback, 0) };
  handles.add(handle);
  return handle;
}

export interface ProvisioningLaunchAuthorizationInput {
  prepareState: unknown;
  providerStatusesAuthoritative: boolean;
  preparedRequestSignature: string | null;
  currentRequestSignature: string;
  preparedGeneration: number | null;
  currentGeneration: number;
  providerProofExpiresAtMs: number | null;
  executionProof?: AuthoritativeModelExecutionProof | null;
}

export function isProvisioningLaunchAuthorized({
  prepareState,
  providerStatusesAuthoritative,
  preparedRequestSignature,
  currentRequestSignature,
  preparedGeneration,
  currentGeneration,
  providerProofExpiresAtMs,
  executionProof,
}: ProvisioningLaunchAuthorizationInput): boolean {
  return (
    isAuthoritativeProvisioningReady(prepareState) &&
    providerStatusesAuthoritative &&
    providerProofExpiresAtMs !== null &&
    providerProofExpiresAtMs > Date.now() &&
    executionProof != null &&
    Date.parse(executionProof.expiresAt) > Date.now() &&
    preparedRequestSignature === currentRequestSignature &&
    preparedGeneration === currentGeneration
  );
}

export async function executeAuthorizedProvisioningLaunch(
  authorization: ProvisioningLaunchAuthorizationInput,
  submit: (proof: AuthoritativeModelExecutionProof) => void | Promise<void>
): Promise<boolean> {
  if (!isProvisioningLaunchAuthorized(authorization)) {
    return false;
  }
  await submit(authorization.executionProof!);
  return true;
}

export const isCreateTeamLaunchAuthorized = isProvisioningLaunchAuthorized;
export const isLaunchTeamLaunchAuthorized = isProvisioningLaunchAuthorized;

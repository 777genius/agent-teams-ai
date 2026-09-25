import { isTeamProviderModelVerificationPending } from '@renderer/utils/teamModelAvailability';
import {
  isKnownOpenCodeAccessFreeModelId,
  isOpenCodeRouteAccessFreeWithoutKey,
} from '@shared/utils/opencodeModelRoute';

import type { TranslationNamespace } from '@features/localization';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';
import type { TFunction } from 'i18next';

export type OpenCodeRuntimeStatusUiState = 'checking' | 'missing' | 'retry' | 'ready';
type TeamTranslator = TFunction<TranslationNamespace, undefined>;

export function getOpenCodeDisabledPanelPresentation(
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState,
  reason: string,
  overrideReason: string | null,
  t: TeamTranslator,
  providerStatus?: CliProviderStatus | null,
  runtimeStatus?: OpenCodeRuntimeStatus | null
): {
  tone: 'info' | 'warning';
  title: string;
  reason: string | null;
  summary: string;
  message: string;
} {
  const pending = runtimeStatusUiState === 'checking' && !overrideReason;
  return {
    tone: pending ? 'info' : 'warning',
    title: t(
      pending
        ? 'modelSelector.openCodeStatus.loadingRuntime'
        : 'modelSelector.openCodeStatus.notReadyTitle'
    ),
    reason: pending ? null : reason,
    summary: getOpenCodeReadinessSummary(providerStatus, t, runtimeStatusUiState),
    message: getOpenCodeReadinessMessage(providerStatus, t, runtimeStatusUiState, runtimeStatus),
  };
}

export function getOpenCodeRuntimeStatusUiState({
  providerStatus,
  runtimeStatus,
  runtimeStatusLoading,
}: {
  providerStatus: CliProviderStatus | null | undefined;
  runtimeStatus: OpenCodeRuntimeStatus | null;
  runtimeStatusLoading: boolean;
}): OpenCodeRuntimeStatusUiState {
  if (
    runtimeStatusLoading ||
    runtimeStatus?.state === 'checking' ||
    runtimeStatus?.state === 'downloading' ||
    runtimeStatus?.state === 'installing'
  ) {
    return 'checking';
  }

  if (
    runtimeStatus?.installed === false &&
    runtimeStatus.source === 'missing' &&
    runtimeStatus.state !== 'failed'
  ) {
    return 'missing';
  }

  if (
    runtimeStatus?.state === 'failed' ||
    providerStatus?.statusCheckOutcome === 'transient_error'
  ) {
    return 'retry';
  }

  if (
    (runtimeStatus === null && !providerStatus) ||
    providerStatus?.statusCheckOutcome === 'pending' ||
    providerStatus?.statusCheckOutcome === 'model_only' ||
    // The renderer gates launch while catalog authority settles. That is not
    // a runtime failure, even when connection evidence is authoritative.
    (providerStatus?.supported === true &&
      providerStatus.authenticated === true &&
      providerStatus.verificationState === 'verified' &&
      providerStatus.statusCheckOutcome === 'authoritative' &&
      providerStatus.modelVerificationState === 'idle' &&
      providerStatus.modelCatalogRefreshState !== 'error' &&
      providerStatus.modelCatalog?.status !== 'degraded' &&
      providerStatus.modelCatalog?.status !== 'unavailable' &&
      !providerStatus.capabilities.teamLaunch) ||
    isTeamProviderModelVerificationPending('opencode', providerStatus)
  ) {
    return 'checking';
  }

  return 'ready';
}

export function isOpenCodeStatusCheckNonAuthoritative(
  providerStatus: CliProviderStatus | null | undefined
): boolean {
  return (
    providerStatus?.statusCheckOutcome === 'pending' ||
    providerStatus?.statusCheckOutcome === 'transient_error' ||
    providerStatus?.statusCheckOutcome === 'model_only'
  );
}

export function isOpenCodePassiveStatusReadyForCatalog(
  providerStatus: CliProviderStatus | null | undefined,
  runtimeStatus: OpenCodeRuntimeStatus | null
): boolean {
  const nonAuthoritative = isOpenCodeStatusCheckNonAuthoritative(providerStatus);
  if (providerStatus?.supported && !nonAuthoritative) {
    return true;
  }
  return Boolean(
    nonAuthoritative &&
    runtimeStatus?.source !== 'missing' &&
    (providerStatus?.models.length || providerStatus?.modelCatalog?.models.length)
  );
}

export function hasFreeOpenCodeModelRoute(
  providerStatus: CliProviderStatus | null | undefined
): boolean {
  if (providerStatus?.providerId !== 'opencode') return false;
  // This drives "usable without connecting a provider" messaging, which is an
  // access claim, not a price claim. A model id that merely looks free (e.g.
  // ends in "-free") is not enough, since OpenCode Go always requires a
  // subscription key even for its zero-priced models, so only the one known
  // access-free id is trusted, and only before the metadata-rich catalog has
  // loaded. Once the catalog is available it is the authoritative source (it
  // carries the live accessKind, which can override a stale route category),
  // so the name-based fallback never overrides it.
  if (providerStatus.modelCatalog) {
    return providerStatus.modelCatalog.models.some((model) => {
      const route = model.metadata?.opencode;
      return isOpenCodeRouteAccessFreeWithoutKey({
        routeKind: route?.routeKind,
        accessKind: route?.accessKind,
      });
    });
  }
  return providerStatus.models.some((modelId) => isKnownOpenCodeAccessFreeModelId(modelId));
}

export function canUseCachedOpenCodeModelsDuringTransientCheck(
  providerStatus: CliProviderStatus | null | undefined,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): boolean {
  return Boolean(
    providerStatus &&
    runtimeStatusUiState !== 'missing' &&
    (providerStatus.statusCheckOutcome === 'transient_error' ||
      providerStatus.statusCheckOutcome === 'model_only' ||
      providerStatus.statusCheckOutcome === 'pending' ||
      (providerStatus.supported &&
        providerStatus.statusCheckOutcome === 'authoritative' &&
        providerStatus.statusCheckErrorCode == null &&
        providerStatus.verificationState !== 'error' &&
        providerStatus.modelCatalog?.status !== 'degraded' &&
        providerStatus.modelCatalog?.status !== 'unavailable' &&
        providerStatus.modelCatalogRefreshState === 'loading')) &&
    (providerStatus.models.length > 0 || (providerStatus.modelCatalog?.models.length ?? 0) > 0)
  );
}

function canSelectLoadedOpenCodeScopedModels(
  providerStatus: CliProviderStatus | null | undefined,
  scopedStatus: CliProviderStatus | null | undefined,
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error',
  catalogState: 'fresh' | 'stale' | null,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): boolean {
  return Boolean(
    runtimeStatusUiState !== 'missing' &&
    runtimeStatusUiState !== 'retry' &&
    providerStatus?.supported &&
    providerStatus.statusCheckErrorCode == null &&
    providerStatus.verificationState !== 'error' &&
    scopedStatus?.providerId === 'opencode' &&
    catalogState === 'fresh' &&
    (catalogStatus === 'ready' || catalogStatus === 'loading') &&
    scopedStatus.modelCatalog?.status === 'ready' &&
    scopedStatus.modelCatalog.models.length > 0
  );
}

export function getOpenCodeProviderDisabledReason(input: {
  providerStatus: CliProviderStatus | null | undefined;
  scopedStatus: CliProviderStatus | null | undefined;
  scopedCatalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  scopedCatalogState: 'fresh' | 'stale' | null;
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState;
  runtimeStatus: OpenCodeRuntimeStatus | null;
  runtimeError: string | null;
  providerReady: boolean;
  loadingMessage: string;
}): string | null {
  const {
    providerStatus,
    scopedStatus,
    scopedCatalogStatus,
    scopedCatalogState,
    runtimeStatusUiState,
    runtimeStatus,
    runtimeError,
    providerReady,
    loadingMessage,
  } = input;
  if (runtimeStatusUiState === 'missing') {
    return (
      providerStatus?.detailMessage ??
      providerStatus?.statusMessage ??
      'OpenCode runtime is not installed.'
    );
  }
  if (runtimeStatus?.installed === false) {
    return runtimeStatusUiState === 'retry'
      ? (runtimeError ?? runtimeStatus.error ?? 'OpenCode runtime is not ready.')
      : loadingMessage;
  }
  if (canUseCachedOpenCodeModelsDuringTransientCheck(providerStatus, runtimeStatusUiState)) {
    return null;
  }
  if (
    canSelectLoadedOpenCodeScopedModels(
      providerStatus,
      scopedStatus,
      scopedCatalogStatus,
      scopedCatalogState,
      runtimeStatusUiState
    )
  ) {
    return null;
  }
  if (providerReady) return null;
  if (!providerStatus) {
    return shouldShowOpenCodeRuntimeLoading(null, runtimeStatusUiState)
      ? loadingMessage
      : (runtimeError ?? runtimeStatus?.error ?? 'OpenCode runtime status is unavailable.');
  }
  if (shouldShowOpenCodeRuntimeLoading(providerStatus, runtimeStatusUiState)) {
    return loadingMessage;
  }
  if (!providerStatus.supported) {
    return (
      (runtimeStatusUiState === 'retry' ? (runtimeError ?? runtimeStatus?.error) : null) ??
      providerStatus.detailMessage ??
      providerStatus.statusMessage ??
      'OpenCode runtime is not ready.'
    );
  }
  if (providerStatus.authenticated && !providerStatus.capabilities.teamLaunch) {
    return (
      providerStatus.detailMessage ??
      providerStatus.statusMessage ??
      'OpenCode team launch is not ready.'
    );
  }
  return null;
}

export function isOpenCodePassiveCatalogPendingForTabCount(
  readyForCatalog: boolean,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): boolean {
  return (
    !readyForCatalog && (runtimeStatusUiState === 'checking' || runtimeStatusUiState === 'retry')
  );
}

export function isOpenCodeSourceTabCountPending(input: {
  sourceModelCount: number;
  sourceScopedLoading: boolean;
  directoryExpectsModels: boolean;
  passiveCatalogPending: boolean;
}): boolean {
  if (input.sourceModelCount > 0) {
    return false;
  }
  return input.sourceScopedLoading || (input.directoryExpectsModels && input.passiveCatalogPending);
}

export function mergeOpenCodePassiveProviderStatus(
  providers: readonly CliProviderStatus[] | undefined,
  openCodePassiveProviderStatus: CliProviderStatus | null | undefined
): Map<string, CliProviderStatus> {
  const statuses = new Map((providers ?? []).map((provider) => [provider.providerId, provider]));
  if (openCodePassiveProviderStatus) {
    statuses.set('opencode', openCodePassiveProviderStatus);
  }
  return statuses;
}

export function shouldShowOpenCodeRuntimeLoading(
  providerStatus: CliProviderStatus | null | undefined,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): boolean {
  return Boolean(
    !providerStatus ||
    (!providerStatus.supported &&
      runtimeStatusUiState !== 'retry' &&
      (runtimeStatusUiState === 'checking' ||
        isOpenCodeStatusCheckNonAuthoritative(providerStatus)))
  );
}

export function getOpenCodeReadinessBadgeLabel(
  providerStatus: CliProviderStatus | null | undefined,
  t: TeamTranslator,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): string {
  if (runtimeStatusUiState === 'missing') {
    return t('modelSelector.openCodeStatus.badges.install');
  }
  if (runtimeStatusUiState === 'retry') {
    return t('modelSelector.openCodeStatus.badges.retry');
  }
  if (
    runtimeStatusUiState === 'checking' ||
    !providerStatus ||
    isOpenCodeStatusCheckNonAuthoritative(providerStatus)
  ) {
    return t('modelSelector.openCodeStatus.badges.check');
  }
  if (!providerStatus.supported) {
    return t('modelSelector.openCodeStatus.badges.setup');
  }
  if (!providerStatus.authenticated) {
    return t('modelSelector.openCodeStatus.badges.free');
  }
  return t('modelSelector.openCodeStatus.badges.setup');
}

export function getOpenCodeReadinessSummary(
  providerStatus: CliProviderStatus | null | undefined,
  t: TeamTranslator,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): string {
  if (runtimeStatusUiState === 'retry') {
    return t('modelSelector.openCodeStatus.summary.temporarilyUnavailable');
  }
  if (
    runtimeStatusUiState === 'checking' ||
    !providerStatus ||
    isOpenCodeStatusCheckNonAuthoritative(providerStatus)
  ) {
    return t('modelSelector.openCodeStatus.summary.checking');
  }

  const runtimeReady = runtimeStatusUiState !== 'missing' && providerStatus.supported;
  const hasFreeModelRoute = hasFreeOpenCodeModelRoute(providerStatus);
  let readinessSummary = t('modelSelector.openCodeStatus.summaryParts.teamLaunchBlocked');
  if (runtimeReady) {
    if (!providerStatus.authenticated) {
      readinessSummary = hasFreeModelRoute
        ? t('modelSelector.openCodeStatus.summaryParts.providerOptional')
        : t('modelSelector.openCodeStatus.summaryParts.providerModelsNeedSetup');
    } else if (providerStatus.capabilities.teamLaunch) {
      readinessSummary = t('modelSelector.openCodeStatus.summaryParts.teamLaunchReady');
    }
  }
  const parts = [
    runtimeReady
      ? t('modelSelector.openCodeStatus.summaryParts.runtimeDetected')
      : t('modelSelector.openCodeStatus.summaryParts.runtimeMissing'),
    runtimeReady && !providerStatus.authenticated && hasFreeModelRoute
      ? t('modelSelector.openCodeStatus.summaryParts.freeWithoutAuth')
      : providerStatus.authenticated
        ? t('modelSelector.openCodeStatus.summaryParts.providerConnected')
        : t('modelSelector.openCodeStatus.summaryParts.providerNotConnected'),
    readinessSummary,
  ];
  return t('modelSelector.openCodeStatus.summary.status', { parts: parts.join(' · ') });
}

export function getOpenCodeReadinessMessage(
  providerStatus: CliProviderStatus | null | undefined,
  t: TeamTranslator,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState,
  runtimeStatus?: OpenCodeRuntimeStatus | null
): string {
  if (runtimeStatusUiState === 'missing') {
    return t('modelSelector.openCodeStatus.messages.unsupported');
  }
  if (runtimeStatusUiState === 'retry') {
    return t('modelSelector.openCodeStatus.messages.temporarilyUnavailable');
  }
  if (
    runtimeStatusUiState === 'checking' &&
    runtimeStatus?.installed !== false &&
    providerStatus?.supported &&
    !providerStatus.authenticated &&
    hasFreeOpenCodeModelRoute(providerStatus)
  ) {
    return t('modelSelector.openCodeStatus.messages.freeAvailable');
  }
  if (
    runtimeStatusUiState === 'checking' ||
    !providerStatus ||
    isOpenCodeStatusCheckNonAuthoritative(providerStatus)
  ) {
    return t('modelSelector.openCodeStatus.messages.checking');
  }
  if (!providerStatus.supported) {
    return t('modelSelector.openCodeStatus.messages.unsupported');
  }
  if (!providerStatus.authenticated) {
    return hasFreeOpenCodeModelRoute(providerStatus)
      ? t('modelSelector.openCodeStatus.messages.freeAvailable')
      : t('modelSelector.openCodeStatus.messages.noFreeListed');
  }
  if (!providerStatus.capabilities.teamLaunch) {
    return t('modelSelector.openCodeStatus.messages.launchBlocked');
  }
  return t('modelSelector.openCodeStatus.messages.ready');
}

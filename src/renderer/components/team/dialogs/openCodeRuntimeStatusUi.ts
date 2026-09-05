import { isTeamProviderModelVerificationPending } from '@renderer/utils/teamModelAvailability';
import { isOpenCodeModelExplicitlyFree } from '@shared/utils/opencodeModelRoute';

import type { TranslationNamespace } from '@features/localization';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';
import type { TFunction } from 'i18next';

export type OpenCodeRuntimeStatusUiState = 'checking' | 'missing' | 'retry' | 'ready';
type TeamTranslator = TFunction<TranslationNamespace, undefined>;

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
  if (providerStatus?.supported && !isOpenCodeStatusCheckNonAuthoritative(providerStatus)) {
    return true;
  }
  return Boolean(
    runtimeStatus?.source !== 'missing' &&
    (providerStatus?.models.length || providerStatus?.modelCatalog?.models.length)
  );
}

export function hasFreeOpenCodeModelRoute(
  providerStatus: CliProviderStatus | null | undefined
): boolean {
  if (providerStatus?.providerId !== 'opencode') return false;
  if (providerStatus.models.some((modelId) => isOpenCodeModelExplicitlyFree({ modelId }))) {
    return true;
  }
  return (
    providerStatus.modelCatalog?.models.some((model) => {
      const route = model.metadata?.opencode;
      return isOpenCodeModelExplicitlyFree({
        modelId: model.launchModel,
        catalogId: model.id,
        providerId: route?.providerId,
        routeKind: route?.routeKind,
        accessKind: route?.accessKind,
        free: model.metadata?.free,
        badgeLabel: model.badgeLabel,
      });
    }) ?? false
  );
}

export function canUseCachedOpenCodeModelsDuringTransientCheck(
  providerStatus: CliProviderStatus | null | undefined,
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): boolean {
  return Boolean(
    providerStatus &&
    runtimeStatusUiState !== 'missing' &&
    (providerStatus?.statusCheckOutcome === 'transient_error' ||
      providerStatus?.statusCheckOutcome === 'model_only') &&
    (providerStatus.models.length > 0 || (providerStatus.modelCatalog?.models.length ?? 0) > 0)
  );
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
  runtimeStatusUiState: OpenCodeRuntimeStatusUiState
): string {
  if (runtimeStatusUiState === 'missing') {
    return t('modelSelector.openCodeStatus.messages.unsupported');
  }
  if (runtimeStatusUiState === 'retry') {
    return t('modelSelector.openCodeStatus.messages.temporarilyUnavailable');
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

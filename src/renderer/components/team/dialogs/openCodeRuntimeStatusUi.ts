import {
  getOpenCodeOpenAiRouteAuthUnavailableReason,
  isTeamProviderModelVerificationPending,
} from '@renderer/utils/teamModelAvailability';

import {
  isAuthoritativeFreeOpenCodeLaunchRoute,
  isAuthoritativeProviderLaunchStatus,
} from './provisioningLaunchAuthorization';

import type { TranslationNamespace } from '@features/localization';
import type { CliProviderStatus, OpenCodeRuntimeStatus, TeamProviderId } from '@shared/types';
import type { TFunction } from 'i18next';

export type OpenCodeRuntimeStatusUiState = 'checking' | 'missing' | 'retry' | 'ready';
type TeamTranslator = TFunction<TranslationNamespace, undefined>;

export const OPENCODE_AUTHORITATIVE_FREE_ROUTE_REQUIRED_REASON =
  'A current authoritative free OpenCode route is required without provider authentication.';

export function getUnauthenticatedOpenCodeRouteUnavailableReason(
  providerStatus: CliProviderStatus | null | undefined,
  model: string
): string | null {
  if (providerStatus?.providerId !== 'opencode' || providerStatus.authenticated !== false) {
    return null;
  }
  return isAuthoritativeProviderLaunchStatus(providerStatus, false, Date.now(), [
    { model, providerBackendId: 'opencode-cli' },
  ])
    ? null
    : OPENCODE_AUTHORITATIVE_FREE_ROUTE_REQUIRED_REASON;
}

export function getOpenCodeRouteUnavailableReasons(input: {
  providerStatus: CliProviderStatus | null | undefined;
  providerId: TeamProviderId;
  model: string;
  explicitReason: string | null;
  runtimeReason: string | null;
}): { unavailableReason: string | null; unauthenticatedReason: string | null } {
  if (!input.model) return { unavailableReason: null, unauthenticatedReason: null };
  const unauthenticatedReason = getUnauthenticatedOpenCodeRouteUnavailableReason(
    input.providerStatus,
    input.model
  );
  return {
    unavailableReason:
      input.explicitReason ??
      unauthenticatedReason ??
      getOpenCodeOpenAiRouteAuthUnavailableReason(
        input.providerId,
        input.model,
        input.providerStatus
      ) ??
      input.runtimeReason,
    unauthenticatedReason,
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

export function hasFreeOpenCodeModelRoute(
  providerStatus: CliProviderStatus | null | undefined
): boolean {
  if (providerStatus?.providerId !== 'opencode') return false;
  return (
    providerStatus.modelCatalog?.models.some(
      (model) =>
        isAuthoritativeFreeOpenCodeLaunchRoute(providerStatus, model.launchModel) &&
        isAuthoritativeProviderLaunchStatus(providerStatus, false, Date.now(), [
          { model: model.launchModel, providerBackendId: 'opencode-cli' },
        ])
    ) ?? false
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

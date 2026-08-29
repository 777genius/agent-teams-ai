import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { getDefaultProviderBackendId } from '@renderer/utils/providerBackendIdentity';
import { normalizeExplicitTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamLeadRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  ResolvedTeamMember,
  TeamCreateRequest,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

interface PreviousLaunchParamsLike {
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: 'inherit' | 'on' | 'off';
  limitContext?: boolean;
  leadRuntimeSelectionProvenance?: TeamCreateRequest['leadRuntimeSelectionProvenance'];
}

interface LaunchDialogPrefillInput {
  members: readonly ResolvedTeamMember[];
  savedRequest: TeamCreateRequest | null;
  previousLaunchParams?: PreviousLaunchParamsLike;
  multimodelEnabled: boolean;
  storedProviderId: TeamProviderId;
  storedEffort: string;
  storedFastMode: 'inherit' | 'on' | 'off';
  storedLimitContext: boolean;
  getStoredModel: (providerId: TeamProviderId) => string;
}

interface LaunchDialogPrefillResult {
  providerId: TeamProviderId;
  providerBackendId?: string;
  providerBackendIsDefault: boolean;
  model: string;
  effort: string;
  fastMode: 'inherit' | 'on' | 'off';
  limitContext: boolean;
}

function normalizeModelCandidate(
  model: string | undefined,
  providerId: TeamProviderId | undefined
): string {
  const trimmed = model?.trim() ?? '';
  if (!trimmed || trimmed === 'default' || trimmed === '__default__') {
    return '';
  }
  return extractProviderScopedBaseModel(trimmed, providerId) ?? '';
}

function canReuseModelForSelectedProvider(
  sourceProviderId: TeamProviderId | undefined,
  selectedProviderId: TeamProviderId
): boolean {
  if (!sourceProviderId || sourceProviderId === 'gemini') {
    return false;
  }
  return selectedProviderId === normalizeCreateLaunchProviderForUi(sourceProviderId, true);
}

export function resolveRelaunchProviderBackend(input: {
  selectedProviderId: TeamProviderId;
  hasAuthoritativeLaunchRecord: boolean;
  authoritativeProviderId?: TeamProviderId | null;
  authoritativeBackendId?: string | null;
  fallbackBackendId?: TeamProviderBackendId;
}): TeamProviderBackendId | undefined {
  if (
    input.hasAuthoritativeLaunchRecord &&
    input.authoritativeProviderId === input.selectedProviderId
  ) {
    return input.authoritativeBackendId
      ? migrateProviderBackendId(
          input.selectedProviderId,
          input.authoritativeBackendId,
          'explicit-selection'
        )
      : undefined;
  }
  return input.fallbackBackendId;
}

export function resolveLaunchDialogBackendState(input: {
  selectedProviderId: TeamProviderId;
  hasAuthoritativeLaunchRecord: boolean;
  authoritativeProviderId: TeamProviderId | null;
  authoritativeBackendId: string | null;
  authoritativeBackendIsDefault: boolean;
  previousProviderId?: TeamProviderId;
  previousBackendId?: string;
  runtimeFallbackBackendId?: TeamProviderBackendId;
}): {
  providerBackendId: TeamProviderBackendId | undefined;
  authoritativeUnavailable: boolean;
} {
  const preserveAuthoritativeBackend =
    input.hasAuthoritativeLaunchRecord && !input.authoritativeBackendIsDefault;
  const persistedBackendId = preserveAuthoritativeBackend
    ? input.authoritativeProviderId === input.selectedProviderId
      ? input.authoritativeBackendId
      : undefined
    : !input.hasAuthoritativeLaunchRecord && input.previousProviderId === input.selectedProviderId
      ? input.previousBackendId
      : undefined;
  const persistedSelection = persistedBackendId
    ? migrateProviderBackendId(input.selectedProviderId, persistedBackendId, 'explicit-selection')
    : undefined;
  const providerBackendId = resolveRelaunchProviderBackend({
    selectedProviderId: input.selectedProviderId,
    hasAuthoritativeLaunchRecord: preserveAuthoritativeBackend,
    authoritativeProviderId: input.authoritativeProviderId,
    authoritativeBackendId: input.authoritativeBackendId,
    fallbackBackendId: persistedSelection ?? input.runtimeFallbackBackendId,
  });
  return {
    providerBackendId,
    authoritativeUnavailable:
      input.hasAuthoritativeLaunchRecord &&
      input.authoritativeProviderId === input.selectedProviderId &&
      input.selectedProviderId !== 'anthropic' &&
      providerBackendId === undefined,
  };
}

export function resolveLaunchDialogPrefill({
  members,
  savedRequest,
  previousLaunchParams,
  multimodelEnabled,
  storedProviderId,
  storedEffort,
  storedFastMode,
  storedLimitContext,
  getStoredModel,
}: LaunchDialogPrefillInput): LaunchDialogPrefillResult {
  const currentLead = members.find((member) => isLeadMember(member));
  const currentLeadProviderId = normalizeOptionalTeamProviderId(currentLead?.providerId);
  const savedRequestProviderId = normalizeOptionalTeamProviderId(savedRequest?.providerId);
  const previousLaunchProviderId = normalizeOptionalTeamProviderId(
    previousLaunchParams?.providerId
  );

  const providerId = normalizeCreateLaunchProviderForUi(
    currentLeadProviderId ?? savedRequestProviderId ?? previousLaunchProviderId ?? storedProviderId,
    multimodelEnabled
  );
  const selectedProvenance =
    (currentLeadProviderId === providerId
      ? savedRequestProviderId === providerId
        ? normalizeTeamLeadRuntimeSelectionProvenance(savedRequest?.leadRuntimeSelectionProvenance)
        : previousLaunchProviderId === providerId
          ? normalizeTeamLeadRuntimeSelectionProvenance(
              previousLaunchParams?.leadRuntimeSelectionProvenance
            )
          : undefined
      : undefined) ??
    (savedRequestProviderId === providerId
      ? normalizeTeamLeadRuntimeSelectionProvenance(savedRequest?.leadRuntimeSelectionProvenance)
      : undefined) ??
    (previousLaunchProviderId === providerId
      ? normalizeTeamLeadRuntimeSelectionProvenance(
          previousLaunchParams?.leadRuntimeSelectionProvenance
        )
      : undefined);

  const modelCandidates = [
    {
      providerId: currentLeadProviderId,
      model:
        selectedProvenance?.model === 'default'
          ? ''
          : normalizeModelCandidate(currentLead?.model, currentLeadProviderId),
    },
    {
      providerId: savedRequestProviderId,
      model:
        normalizeTeamLeadRuntimeSelectionProvenance(savedRequest?.leadRuntimeSelectionProvenance)
          ?.model === 'default'
          ? ''
          : normalizeModelCandidate(savedRequest?.model, savedRequestProviderId),
    },
    {
      providerId: previousLaunchProviderId,
      model:
        normalizeTeamLeadRuntimeSelectionProvenance(
          previousLaunchParams?.leadRuntimeSelectionProvenance
        )?.model === 'default'
          ? ''
          : normalizeModelCandidate(previousLaunchParams?.model, previousLaunchProviderId),
    },
  ];

  const matchingModel = modelCandidates.find(
    (candidate) =>
      candidate.model && canReuseModelForSelectedProvider(candidate.providerId, providerId)
  )?.model;

  const effort =
    selectedProvenance?.effort === 'default'
      ? ''
      : (currentLead?.effort ??
        savedRequest?.effort ??
        previousLaunchParams?.effort ??
        storedEffort);
  const fastMode =
    currentLead?.selectedFastMode ??
    savedRequest?.fastMode ??
    previousLaunchParams?.fastMode ??
    storedFastMode ??
    'inherit';
  const limitContext =
    savedRequest?.limitContext ?? previousLaunchParams?.limitContext ?? storedLimitContext;
  const authoritativeRecord = currentLead ?? savedRequest;
  const authoritativeProviderId = normalizeOptionalTeamProviderId(authoritativeRecord?.providerId);
  const previousBackend =
    previousLaunchProviderId === providerId ? previousLaunchParams?.providerBackendId : undefined;
  const backendCandidate = authoritativeRecord
    ? authoritativeProviderId === providerId
      ? authoritativeRecord.providerBackendId
      : undefined
    : previousBackend;
  const providerBackendIsDefault =
    selectedProvenance?.providerBackendId === 'default' ||
    (!selectedProvenance && !backendCandidate);
  const providerBackendId = providerBackendIsDefault
    ? undefined
    : backendCandidate
      ? migrateProviderBackendId(providerId, backendCandidate, 'explicit-selection')
      : authoritativeRecord
        ? undefined
        : getDefaultProviderBackendId(providerId);

  return {
    providerId,
    providerBackendId,
    providerBackendIsDefault,
    model:
      selectedProvenance?.model === 'default'
        ? ''
        : matchingModel
          ? normalizeExplicitTeamModelForUi(providerId, matchingModel)
          : getStoredModel(providerId),
    effort,
    fastMode,
    limitContext,
  };
}

import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { getDefaultProviderBackendId } from '@renderer/utils/providerBackendIdentity';
import { normalizeExplicitTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { ResolvedTeamMember, TeamCreateRequest, TeamProviderId } from '@shared/types';

interface PreviousLaunchParamsLike {
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: 'inherit' | 'on' | 'off';
  limitContext?: boolean;
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
  model: string;
  effort: string;
  fastMode: 'inherit' | 'on' | 'off';
  limitContext: boolean;
}

/**
 * Persisted launch metadata is read back from disk and may be legacy or hand-edited,
 * so anything that is not a non-empty string must degrade to "no saved backend id"
 * instead of reaching a string method.
 */
export function normalizeSavedBackendId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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

  const modelCandidates = [
    {
      providerId: currentLeadProviderId,
      model: normalizeModelCandidate(currentLead?.model, currentLeadProviderId),
    },
    {
      providerId: savedRequestProviderId,
      model: normalizeModelCandidate(savedRequest?.model, savedRequestProviderId),
    },
    {
      providerId: previousLaunchProviderId,
      model: normalizeModelCandidate(previousLaunchParams?.model, previousLaunchProviderId),
    },
  ];

  const matchingModel = modelCandidates.find(
    (candidate) =>
      candidate.model && canReuseModelForSelectedProvider(candidate.providerId, providerId)
  )?.model;

  const effort =
    currentLead?.effort ?? savedRequest?.effort ?? previousLaunchParams?.effort ?? storedEffort;
  const fastMode =
    savedRequest?.fastMode ?? previousLaunchParams?.fastMode ?? storedFastMode ?? 'inherit';
  const limitContext =
    previousLaunchParams?.limitContext ?? savedRequest?.limitContext ?? storedLimitContext;
  const providerBackendId =
    migrateProviderBackendId(
      providerId,
      normalizeSavedBackendId(previousLaunchParams?.providerBackendId) ??
        normalizeSavedBackendId(savedRequest?.providerBackendId)
    ) ??
    getDefaultProviderBackendId(providerId) ??
    undefined;

  return {
    providerId,
    providerBackendId,
    model: matchingModel
      ? normalizeExplicitTeamModelForUi(providerId, matchingModel)
      : getStoredModel(providerId),
    effort,
    fastMode,
    limitContext,
  };
}

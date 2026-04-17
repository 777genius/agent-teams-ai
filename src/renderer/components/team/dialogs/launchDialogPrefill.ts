import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { normalizeTeamModelForUi as normalizeCatalogTeamModelForUi } from '@renderer/utils/teamModelCatalog';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { ResolvedTeamMember, TeamCreateRequest, TeamProviderId } from '@shared/types';

interface PreviousLaunchParamsLike {
  providerId?: TeamProviderId;
  model?: string;
  effort?: string;
  limitContext?: boolean;
}

interface LaunchDialogPrefillInput {
  members: readonly ResolvedTeamMember[];
  savedRequest: TeamCreateRequest | null;
  previousLaunchParams?: PreviousLaunchParamsLike;
  multimodelEnabled: boolean;
  storedProviderId: TeamProviderId;
  storedEffort: string;
  storedLimitContext: boolean;
  getStoredModel: (providerId: TeamProviderId) => string;
}

interface LaunchDialogPrefillResult {
  providerId: TeamProviderId;
  model: string;
  effort: string;
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

export function resolveLaunchDialogPrefill({
  members,
  savedRequest,
  previousLaunchParams,
  multimodelEnabled,
  storedProviderId,
  storedEffort,
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
  const limitContext =
    previousLaunchParams?.limitContext ?? savedRequest?.limitContext ?? storedLimitContext;

  return {
    providerId,
    model: matchingModel
      ? normalizeCatalogTeamModelForUi(providerId, matchingModel)
      : getStoredModel(providerId),
    effort,
    limitContext,
  };
}

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { filterMemberSettingsRelaunchInputs } from '@features/team-provisioning/renderer';
import {
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  normalizeMemberDraftForProviderMode,
} from '@renderer/components/team/members/MembersEditorSection';
import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import {
  getDefaultProviderBackendId,
  resolveUiOwnedProviderBackendId,
} from '@renderer/utils/providerBackendIdentity';
import { normalizeExplicitTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { resolveTeamRuntimeSelection } from '@shared/utils/teamRuntimeSelection';

import {
  buildWorktreePathByMemberName,
  deriveTeammateWorktreeDefault,
} from './launchTeamDialogHelpers';

import type {
  CliProviderStatus,
  ResolvedTeamMember,
  TeamCreateRequest,
  TeamProviderId,
} from '@shared/types';

/** Prefer current runtime authority; reuse configured backend identity only as a fallback. */
export function resolveLaunchProviderBackendId(
  providerId: TeamProviderId,
  status: CliProviderStatus | undefined,
  configuredBackendId: string | null | undefined
) {
  return (
    resolveUiOwnedProviderBackendId(providerId, status) ??
    migrateProviderBackendId(providerId, configuredBackendId) ??
    undefined
  );
}

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
  runtimeSelectionUnresolved?: boolean;
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

/** A captured owner's configured request is authoritative even for omitted overrides. */
export function isHostSavedRequest(value: TeamCreateRequest | null): boolean {
  return (
    !!value &&
    isHostTeamSelectionKey(value.teamName) &&
    /^[a-f0-9]{64}$/.test(value.savedSettingsFingerprint ?? '')
  );
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
  const fastMode =
    savedRequest?.fastMode ?? previousLaunchParams?.fastMode ?? storedFastMode ?? 'off';
  if (savedRequest && resolveTeamRuntimeSelection(savedRequest).status === 'unresolved') {
    return {
      runtimeSelectionUnresolved: true,
      providerId: storedProviderId,
      model: '',
      effort: '',
      fastMode,
      limitContext: false,
    };
  }
  if (savedRequest && isHostSavedRequest(savedRequest)) {
    const providerId = normalizeCreateLaunchProviderForUi(
      savedRequest.providerId ?? 'anthropic',
      multimodelEnabled
    );
    return {
      providerId,
      providerBackendId:
        migrateProviderBackendId(
          providerId,
          normalizeSavedBackendId(savedRequest.providerBackendId)
        ) ??
        getDefaultProviderBackendId(providerId) ??
        undefined,
      model: normalizeExplicitTeamModelForUi(
        providerId,
        normalizeModelCandidate(savedRequest.model, providerId)
      ),
      effort: savedRequest.effort ?? '',
      fastMode: savedRequest.fastMode ?? 'inherit',
      limitContext: savedRequest.limitContext ?? false,
    };
  }
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

  const savedModel = normalizeModelCandidate(savedRequest?.model, savedRequestProviderId);
  const modelCandidates =
    savedRequest?.runtimeSelectionVersion === 1 && !savedModel
      ? []
      : [
          {
            providerId: currentLeadProviderId,
            model: normalizeModelCandidate(currentLead?.model, currentLeadProviderId),
          },
          {
            providerId: savedRequestProviderId,
            model: savedModel,
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
      : savedRequest?.runtimeSelectionVersion === 1
        ? ''
        : getStoredModel(providerId),
    effort,
    fastMode,
    limitContext,
  };
}

/** Existing roster presentation and inherited-toggle defaults, separate from source query lifetime. */
export function resolveLaunchDialogRoster(options: {
  members: readonly ResolvedTeamMember[];
  memberSettingsDraft: boolean;
  savedMembers?: TeamCreateRequest['members'];
  savedSyncModelsWithLead?: boolean;
  multimodelEnabled: boolean;
}) {
  const { members, memberSettingsDraft, savedMembers, savedSyncModelsWithLead, multimodelEnabled } =
    options;
  const source = members.length > 0 ? members : (savedMembers ?? []);
  const inputs = memberSettingsDraft
    ? filterMemberSettingsRelaunchInputs(source)
    : filterEditableMemberInputs(source);
  return {
    inputs,
    drafts: createMemberDraftsFromInputs(inputs).map((member) =>
      normalizeMemberDraftForProviderMode(member, multimodelEnabled)
    ),
    worktreePaths: buildWorktreePathByMemberName(inputs),
    worktreeDefault: deriveTeammateWorktreeDefault(inputs),
    syncModelsWithLead:
      !memberSettingsDraft &&
      savedSyncModelsWithLead !== false &&
      !inputs.some(
        (member) =>
          member.providerId ||
          member.providerBackendId ||
          member.model ||
          member.effort ||
          ('fastMode' in member && member.fastMode)
      ),
  };
}

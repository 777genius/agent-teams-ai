import { normalizePersistedProviderBackendId } from '@shared/utils/providerBackend';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import type {
  EffortLevel,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

interface RuntimeIdentityRecord {
  providerId?: TeamProviderId | string;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean;
}

export function selectCurrentRuntimeIdentity(input: {
  activeRunMember?: RuntimeIdentityRecord;
  liveRuntimeMember?: RuntimeIdentityRecord;
  launchMember?: RuntimeIdentityRecord;
  runtimeAdapterMember?: RuntimeIdentityRecord;
  metadataMember?: RuntimeIdentityRecord;
  fallbackMember: RuntimeIdentityRecord;
  hasActiveRuntimeRun: boolean;
}): {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean;
} {
  const activeProviderId =
    normalizeOptionalTeamProviderId(input.activeRunMember?.providerId) ??
    inferTeamProviderIdFromModel(input.activeRunMember?.model);
  const explicitLiveProviderId = normalizeOptionalTeamProviderId(
    input.liveRuntimeMember?.providerId
  );
  const inferredLiveProviderId = inferTeamProviderIdFromModel(input.liveRuntimeMember?.model);
  const liveProviderId = explicitLiveProviderId ?? inferredLiveProviderId;
  const coherentLiveIdentity =
    !explicitLiveProviderId ||
    !inferredLiveProviderId ||
    explicitLiveProviderId === inferredLiveProviderId;
  const exactLiveRecord =
    input.liveRuntimeMember?.model?.trim() &&
    liveProviderId &&
    coherentLiveIdentity &&
    !input.activeRunMember?.providerBackendId &&
    (!activeProviderId || liveProviderId === activeProviderId)
      ? input.liveRuntimeMember
      : undefined;
  const record =
    exactLiveRecord ??
    input.activeRunMember ??
    input.launchMember ??
    input.runtimeAdapterMember ??
    (input.hasActiveRuntimeRun ? undefined : (input.metadataMember ?? input.fallbackMember));
  const providerId =
    normalizeOptionalTeamProviderId(record?.providerId) ??
    inferTeamProviderIdFromModel(record?.model);
  const providerBackendId = normalizePersistedProviderBackendId(
    providerId,
    record?.providerBackendId,
    exactLiveRecord || input.metadataMember || input.activeRunMember || input.launchMember
      ? 'current-version'
      : 'legacy-unversioned'
  );
  return {
    providerId,
    providerBackendId,
    model: record?.model?.trim() || undefined,
    effort: record?.effort,
    selectedFastMode: record?.selectedFastMode ?? record?.fastMode,
    resolvedFastMode: record?.resolvedFastMode,
  };
}

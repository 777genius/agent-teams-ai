import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import type { PersistedTeamLaunchMemberState, TeamCreateRequest } from '@shared/types';

export interface PersistedRuntimeMemberIdentityRunLike {
  request: Pick<TeamCreateRequest, 'providerId' | 'providerBackendId' | 'fastMode'>;
  effectiveMembers?: readonly TeamCreateRequest['members'][number][];
  mixedSecondaryLanes?: readonly {
    laneId: string;
    member: Pick<TeamCreateRequest['members'][number], 'name' | 'model' | 'effort'>;
  }[];
}

export function resolvePersistedRuntimeMemberIdentity(params: {
  memberName: string;
  previousMember?: PersistedTeamLaunchMemberState;
  trackedRun?: PersistedRuntimeMemberIdentityRunLike | null;
}): Partial<PersistedTeamLaunchMemberState> {
  if (params.previousMember) {
    return {
      providerId: params.previousMember.providerId,
      providerBackendId: params.previousMember.providerBackendId,
      model: params.previousMember.model,
      effort: params.previousMember.effort,
      selectedFastMode: params.previousMember.selectedFastMode,
      resolvedFastMode: params.previousMember.resolvedFastMode,
      laneId: params.previousMember.laneId,
      laneKind: params.previousMember.laneKind,
      laneOwnerProviderId: params.previousMember.laneOwnerProviderId,
      launchIdentity: params.previousMember.launchIdentity,
    };
  }

  const secondaryLane = params.trackedRun?.mixedSecondaryLanes?.find(
    (lane) => lane.member.name.trim() === params.memberName
  );
  if (secondaryLane) {
    return {
      providerId: 'opencode',
      model: secondaryLane.member.model,
      effort: secondaryLane.member.effort,
      laneId: secondaryLane.laneId,
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
    };
  }

  const primaryMember = params.trackedRun?.effectiveMembers?.find(
    (member) => member.name.trim() === params.memberName
  );
  if (!primaryMember) {
    return {};
  }

  const leadProviderId = resolveTeamProviderId(params.trackedRun?.request.providerId);
  const laneIdentity = buildPlannedMemberLaneIdentity({
    leadProviderId,
    member: {
      name: primaryMember.name,
      providerId: normalizeOptionalTeamProviderId(primaryMember.providerId),
    },
  });
  const providerId = normalizeOptionalTeamProviderId(primaryMember.providerId) ?? leadProviderId;

  return {
    providerId,
    providerBackendId: migrateProviderBackendId(
      providerId,
      primaryMember.providerBackendId ?? params.trackedRun?.request.providerBackendId
    ),
    model: primaryMember.model,
    effort: primaryMember.effort,
    selectedFastMode: primaryMember.fastMode ?? params.trackedRun?.request.fastMode,
    laneId: laneIdentity.laneId,
    laneKind: laneIdentity.laneKind,
    laneOwnerProviderId: laneIdentity.laneOwnerProviderId,
  };
}

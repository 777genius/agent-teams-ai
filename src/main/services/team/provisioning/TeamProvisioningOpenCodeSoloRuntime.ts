import {
  buildPlannedMemberLaneIdentity,
  OPEN_CODE_SOLO_MEMBER_NAME,
  OPEN_CODE_SOLO_MEMBER_ROLE,
} from '@features/team-runtime-lanes';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamConfig, TeamMember, TeamProviderId } from '@shared/types';

export interface OpenCodeSoloRuntimeRosterInput {
  config?: TeamConfig | null;
  teamMeta?: OpenCodeMemberDirectory['teamMeta'];
  metaMembers: readonly TeamMember[];
}

export function isOpenCodeSoloRuntimeRoster(input: OpenCodeSoloRuntimeRosterInput): boolean {
  const leadMember = input.config?.members?.find((member) => isLeadMember(member));
  const leadProviderId =
    normalizeOptionalTeamProviderId(input.teamMeta?.launchIdentity?.providerId) ??
    normalizeOptionalTeamProviderId(input.teamMeta?.providerId) ??
    normalizeOptionalTeamProviderId(leadMember?.providerId) ??
    inferTeamProviderIdFromModel(leadMember?.model);
  if (leadProviderId !== 'opencode') {
    return false;
  }

  const hasActiveConfigTeammate =
    input.config?.members?.some(
      (member) => !isLeadMember(member) && member.removedAt == null && member.name?.trim()
    ) ?? false;
  if (hasActiveConfigTeammate) {
    return false;
  }

  return !input.metaMembers.some(
    (member) => !isLeadMember(member) && member.removedAt == null && member.name?.trim()
  );
}

export function resolveOpenCodeSoloMemberIdentityFromDirectory(
  memberName: string,
  directory: OpenCodeMemberDirectory
): OpenCodeMemberIdentityResolution | null {
  if (memberName.trim().toLowerCase() !== OPEN_CODE_SOLO_MEMBER_NAME) {
    return null;
  }
  if (
    !isOpenCodeSoloRuntimeRoster({
      config: directory.config,
      teamMeta: directory.teamMeta,
      metaMembers: directory.metaMembers,
    })
  ) {
    return null;
  }

  const laneIdentity = buildPlannedMemberLaneIdentity({
    leadProviderId: 'opencode',
    member: {
      name: OPEN_CODE_SOLO_MEMBER_NAME,
      providerId: 'opencode',
    },
  });
  const memberRuntimeCwd = directory.config?.projectPath?.trim();
  return {
    ok: true,
    canonicalMemberName: OPEN_CODE_SOLO_MEMBER_NAME,
    laneId: laneIdentity.laneId,
    laneIdentity,
    metaMember: {
      name: OPEN_CODE_SOLO_MEMBER_NAME,
      role: OPEN_CODE_SOLO_MEMBER_ROLE,
      providerId: 'opencode',
      ...(memberRuntimeCwd ? { cwd: memberRuntimeCwd } : {}),
    },
    ...(memberRuntimeCwd ? { memberRuntimeCwd } : {}),
  };
}

export function resolveOpenCodeSoloRuntimeRecipientProviderId(input: {
  memberName: string;
  config?: TeamConfig | null;
  teamMeta?: OpenCodeMemberDirectory['teamMeta'];
  metaMembers: readonly TeamMember[];
}): TeamProviderId | undefined {
  if (input.memberName.trim().toLowerCase() !== OPEN_CODE_SOLO_MEMBER_NAME) {
    return undefined;
  }
  return isOpenCodeSoloRuntimeRoster(input) ? 'opencode' : undefined;
}

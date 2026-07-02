import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';
import { normalizeTeamProviderLike } from './TeamProvisioningMemberSpecs';
import { resolveOpenCodeSoloMemberIdentityFromDirectory } from './TeamProvisioningOpenCodeSoloRuntime';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamProviderId } from '@shared/types';

export interface OpenCodeSecondaryRuntimeRunIdentity {
  laneId: string;
  memberName: string;
  cwd?: string;
}

export interface ResolveOpenCodeMemberIdentityFromDirectoryInput {
  memberName: string;
  directory: OpenCodeMemberDirectory;
  secondaryRuntimeRuns?: readonly OpenCodeSecondaryRuntimeRunIdentity[];
  runtimeAdapterProviderId?: TeamProviderId | null;
}

export function resolveOpenCodeMemberIdentityFromDirectory(
  input: ResolveOpenCodeMemberIdentityFromDirectoryInput
): OpenCodeMemberIdentityResolution {
  const normalizedMemberName = input.memberName.trim();
  const configMember = input.directory.config?.members?.find(
    (member) => member.name?.trim().toLowerCase() === normalizedMemberName.toLowerCase()
  );
  const metaMember = input.directory.metaMembers.find(
    (member) => member.name?.trim().toLowerCase() === normalizedMemberName.toLowerCase()
  );
  if (!configMember && !metaMember) {
    const soloIdentity = resolveOpenCodeSoloMemberIdentityFromDirectory(
      normalizedMemberName,
      input.directory
    );
    if (soloIdentity) {
      return soloIdentity;
    }
    return { ok: false, reason: 'opencode_recipient_unavailable' };
  }

  const configProvider = (configMember as { provider?: unknown } | undefined)?.provider;
  const metaProvider = (metaMember as { provider?: unknown } | undefined)?.provider;
  const providerId =
    normalizeTeamProviderLike(metaMember?.providerId) ??
    normalizeTeamProviderLike(metaProvider) ??
    normalizeTeamProviderLike(configMember?.providerId) ??
    normalizeTeamProviderLike(configProvider) ??
    inferTeamProviderIdFromModel(metaMember?.model ?? configMember?.model);
  if (providerId !== 'opencode') {
    return { ok: false, reason: 'recipient_is_not_opencode' };
  }

  const removedAt =
    metaMember != null
      ? metaMember.removedAt
      : (configMember as { removedAt?: unknown } | undefined)?.removedAt;
  if (removedAt != null) {
    return { ok: false, reason: 'recipient_removed' };
  }

  const canonicalMemberName =
    metaMember?.name?.trim() || configMember?.name?.trim() || normalizedMemberName;
  const secondaryRuntimeRun = input.secondaryRuntimeRuns?.find((run) =>
    matchesTeamMemberIdentity(run.memberName, canonicalMemberName)
  );
  if (secondaryRuntimeRun) {
    const memberRuntimeCwd =
      secondaryRuntimeRun.cwd?.trim() || metaMember?.cwd?.trim() || configMember?.cwd?.trim();
    return {
      ok: true,
      canonicalMemberName,
      laneId: secondaryRuntimeRun.laneId,
      laneIdentity: {
        laneId: secondaryRuntimeRun.laneId,
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
      },
      ...(configMember ? { configMember } : {}),
      ...(metaMember ? { metaMember } : {}),
      ...(memberRuntimeCwd ? { memberRuntimeCwd } : {}),
    };
  }

  if (input.runtimeAdapterProviderId === 'opencode') {
    const laneIdentity = buildPlannedMemberLaneIdentity({
      leadProviderId: 'opencode',
      member: {
        name: canonicalMemberName,
        providerId: 'opencode',
      },
    });
    const memberRuntimeCwd = metaMember?.cwd?.trim() || configMember?.cwd?.trim();
    return {
      ok: true,
      canonicalMemberName,
      laneId: laneIdentity.laneId,
      laneIdentity,
      ...(configMember ? { configMember } : {}),
      ...(metaMember ? { metaMember } : {}),
      ...(memberRuntimeCwd ? { memberRuntimeCwd } : {}),
    };
  }

  const leadMember = input.directory.config?.members?.find((member) => isLeadMember(member));
  const leadProviderId =
    normalizeOptionalTeamProviderId(input.directory.teamMeta?.launchIdentity?.providerId) ??
    normalizeOptionalTeamProviderId(input.directory.teamMeta?.providerId) ??
    normalizeOptionalTeamProviderId(leadMember?.providerId);
  const laneIdentity = buildPlannedMemberLaneIdentity({
    leadProviderId,
    member: {
      name: canonicalMemberName,
      providerId,
    },
  });
  const memberRuntimeCwd = metaMember?.cwd?.trim() || configMember?.cwd?.trim();
  return {
    ok: true,
    canonicalMemberName,
    laneId: laneIdentity.laneId,
    laneIdentity,
    ...(configMember ? { configMember } : {}),
    ...(metaMember ? { metaMember } : {}),
    ...(memberRuntimeCwd ? { memberRuntimeCwd } : {}),
  };
}

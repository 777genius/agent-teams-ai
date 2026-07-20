import {
  buildOpenCodeSecondaryLaneId,
  buildPlannedMemberLaneIdentity,
} from '@features/team-runtime-lanes';
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

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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

  const leadMember = input.directory.config?.members?.find((member) => isLeadMember(member));
  const persistedLeadProviderId =
    normalizeOptionalTeamProviderId(input.directory.teamMeta?.launchIdentity?.providerId) ??
    normalizeOptionalTeamProviderId(input.directory.teamMeta?.providerId) ??
    normalizeOptionalTeamProviderId(leadMember?.providerId);
  const memberRuntimeCwd = metaMember?.cwd?.trim() || configMember?.cwd?.trim();
  if (input.runtimeAdapterProviderId === 'opencode' || persistedLeadProviderId === 'opencode') {
    const leadModel =
      normalizeOptionalString(input.directory.teamMeta?.launchIdentity?.resolvedLaunchModel) ??
      normalizeOptionalString(input.directory.teamMeta?.launchIdentity?.selectedModel) ??
      normalizeOptionalString(input.directory.teamMeta?.model) ??
      normalizeOptionalString(leadMember?.model);
    const memberModel = normalizeOptionalString(metaMember?.model ?? configMember?.model);
    const projectRoot =
      input.directory.config?.projectPath?.trim() ??
      normalizeOptionalString(input.directory.teamMeta?.cwd);
    const usesDistinctModel = Boolean(memberModel && leadModel && memberModel !== leadModel);
    const usesDistinctRoot = Boolean(
      memberRuntimeCwd && (!projectRoot || memberRuntimeCwd !== projectRoot)
    );
    const isConfiguredLead =
      isLeadMember({ name: canonicalMemberName }) ||
      Boolean(leadMember && matchesTeamMemberIdentity(leadMember.name, canonicalMemberName));
    const usesSecondaryLane = !isConfiguredLead && (usesDistinctModel || usesDistinctRoot);
    const laneIdentity = usesSecondaryLane
      ? {
          laneId: buildOpenCodeSecondaryLaneId({ name: canonicalMemberName }),
          laneKind: 'secondary' as const,
          laneOwnerProviderId: 'opencode' as const,
        }
      : buildPlannedMemberLaneIdentity({
          leadProviderId: 'opencode',
          member: {
            name: canonicalMemberName,
            providerId: 'opencode',
          },
        });
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

  const laneIdentity = buildPlannedMemberLaneIdentity({
    leadProviderId: persistedLeadProviderId,
    member: {
      name: canonicalMemberName,
      providerId,
    },
  });
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

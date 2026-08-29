import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamMetaFile } from './TeamMetaStore';
import type { ReplaceMembersRequest, TeamProviderBackendId, TeamProviderId } from '@shared/types';

export type PersistedLeadRuntimeRouteSource = Pick<
  TeamMetaFile,
  'providerId' | 'providerBackendId' | 'launchIdentity' | 'fastMode'
>;

export function resolvePersistedLeadRuntimeRoute(
  meta: PersistedLeadRuntimeRouteSource | null | undefined
): {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
} {
  const identity = meta?.launchIdentity;
  const providerId = normalizeOptionalTeamProviderId(
    identity ? identity.providerId : meta?.providerId
  );
  const backend = identity ? identity.providerBackendId : meta?.providerBackendId;
  return {
    providerId,
    providerBackendId: backend
      ? migrateProviderBackendId(providerId, backend, 'explicit-selection')
      : undefined,
  };
}

export function resolvePersistedLeadProviderId(meta: TeamMetaFile | null): TeamProviderId {
  return resolvePersistedLeadRuntimeRoute(meta).providerId ?? 'anthropic';
}

export function resolveRosterBackendPairs(
  request: ReplaceMembersRequest,
  inheritedProviderId?: TeamProviderId
): ReplaceMembersRequest {
  return {
    members: request.members.map((member) => {
      if (member.providerBackendId === undefined) return member;
      const providerId = normalizeOptionalTeamProviderId(member.providerId) ?? inheritedProviderId;
      const providerBackendId = migrateProviderBackendId(
        providerId,
        member.providerBackendId,
        'explicit-selection'
      );
      if (!providerId || providerBackendId !== member.providerBackendId) {
        throw new Error('providerBackendId is incompatible with the inherited providerId');
      }
      return { ...member, providerId, providerBackendId };
    }),
  };
}

export async function resolveRosterBackendPairsFromMeta(
  request: ReplaceMembersRequest,
  readMeta: () => Promise<TeamMetaFile | null>
): Promise<ReplaceMembersRequest> {
  const needsInherited = request.members.some(
    (member) => member.providerBackendId !== undefined && member.providerId === undefined
  );
  const inherited = needsInherited ? resolvePersistedLeadProviderId(await readMeta()) : undefined;
  return resolveRosterBackendPairs(request, inherited);
}

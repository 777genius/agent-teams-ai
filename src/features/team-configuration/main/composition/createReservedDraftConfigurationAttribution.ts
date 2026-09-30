import type {
  TeamDraftPublicationScope, TeamDraftPublicationStorageGateway, TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import type { WorkspaceId } from '@shared/contracts/hosted';

/** Deliberately carries neither a checksum nor a lifecycle grant/Owner binding. */
export type ReservedDraftConfigurationAttribution =
  | { readonly kind: 'found'; readonly runtimeWorkspaceId: WorkspaceId }
  | { readonly kind: 'not_found' | 'unavailable' };

/** Configuration-only exception for a durable create operation and its exact canonical reservation. */
export function createReservedDraftConfigurationAttribution(dependencies: {
  readonly publications: Pick<TeamDraftPublicationStorageGateway, 'readTeamDraftPublication'>;
  readonly identities: Pick<TeamIdentityReadGateway, 'getTeamIdentity'>;
}) {
  return async (
    scope: TeamDraftPublicationScope,
    /** Resolved from the current authenticated public workspace grant, never from an HTTP field. */
    grantedRuntimeWorkspaceId: WorkspaceId
  ): Promise<ReservedDraftConfigurationAttribution> => {
    try {
      const operation = await dependencies.publications.readTeamDraftPublication(scope);
      if (!operation || operation.state === 'tombstoned') return { kind: 'not_found' };
      if (operation.runtimeWorkspaceId !== grantedRuntimeWorkspaceId) return { kind: 'unavailable' };
      const identity = await dependencies.identities.getTeamIdentity(scope.teamId);
      if (!identity) return { kind: 'not_found' };
      if (identity.state === 'tombstoned' || identity.legacyKey !== operation.legacyKey ||
          identity.directoryFingerprint !== operation.directoryFingerprint ||
          identity.createdAt !== operation.createdAt ||
          identity.workspaceBinding?.workspaceId !== grantedRuntimeWorkspaceId ||
          identity.workspaceBinding.generation !== operation.bindingGeneration ||
          (identity.state !== 'reserved' && identity.adoptionIntentId !== operation.operationId)) {
        return { kind: 'unavailable' };
      }
      return { kind: 'found', runtimeWorkspaceId: grantedRuntimeWorkspaceId };
    } catch { return { kind: 'unavailable' }; }
  };
}

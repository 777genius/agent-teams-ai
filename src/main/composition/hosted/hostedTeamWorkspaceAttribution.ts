import { createHash } from 'node:crypto';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import { TEAM_LIFECYCLE_READ_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';

import type { TeamLifecycleReadHost } from './teamLifecycleReadComposition';
import type { Cursor, Revision, TeamId } from '@shared/contracts/hosted';

const MAXIMUM_PAGES = 16;

export type HostedTeamWorkspaceAttributionResult =
  | Readonly<{
      kind: 'found';
      runtimeWorkspaceId: string;
      attributionRevision: string;
      identityChecksum: string;
    }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Resolves team attribution through one bounded, revision-pinned canonical snapshot. */
export async function resolveHostedTeamWorkspaceId(
  host: TeamLifecycleReadHost,
  teamIdValue: TeamId,
  teamIdentities: Pick<TeamIdentityReadGateway, 'getTeamIdentity'>
): Promise<HostedTeamWorkspaceAttributionResult> {
  let cursor: Cursor | null = null;
  let expectedRevision: Revision | null = null;
  let resolvedWorkspaceId: string | null = null;
  let resolvedIdentityRevision: Revision | null = null;
  try {
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const result = await host.listTeamLifecycle({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor,
        expectedRevision,
      });
      if (result.kind !== 'success') return Object.freeze({ kind: 'unavailable' });
      if (expectedRevision !== null && result.snapshotRevision !== expectedRevision) {
        return Object.freeze({ kind: 'unavailable' });
      }
      for (const item of result.items) {
        if (item.teamId !== teamIdValue) continue;
        if (resolvedWorkspaceId !== null) return Object.freeze({ kind: 'unavailable' });
        resolvedWorkspaceId = item.workspaceId;
        resolvedIdentityRevision = item.revision;
      }
      if (result.nextCursor === null) {
        if (resolvedWorkspaceId === null) return Object.freeze({ kind: 'not_found' });
        const identityValue = await teamIdentities.getTeamIdentity(teamIdValue);
        if (identityValue === null) return Object.freeze({ kind: 'unavailable' });
        const identity = parseTeamIdentityRecord(identityValue);
        const binding = identity.workspaceBinding;
        if (
          identity.teamId !== teamIdValue ||
          identity.state !== 'active' ||
          binding === null ||
          binding.workspaceId !== resolvedWorkspaceId ||
          !/^[0-9a-f]{64}$/u.test(identity.identityChecksum ?? '')
        ) {
          return Object.freeze({ kind: 'unavailable' });
        }
        return Object.freeze({
          kind: 'found',
          runtimeWorkspaceId: resolvedWorkspaceId,
          attributionRevision: createHash('sha256')
            .update(
              `${result.snapshotRevision}\u0000${resolvedIdentityRevision}\u0000${resolvedWorkspaceId}`,
              'utf8'
            )
            .digest('hex'),
          identityChecksum: identity.identityChecksum!,
        });
      }
      cursor = result.nextCursor;
      expectedRevision = result.snapshotRevision;
    }
  } catch {
    return Object.freeze({ kind: 'unavailable' });
  }
  return Object.freeze({ kind: 'unavailable' });
}

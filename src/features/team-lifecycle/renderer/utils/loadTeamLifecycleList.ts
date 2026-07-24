import {
  type CanonicalListTeamLifecycleResult,
  type CanonicalTeamLifecycleListItem,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadTransportApi,
} from '../../contracts';

import type { Cursor, Revision, TeamId } from '@shared/contracts/hosted';

export const TEAM_LIFECYCLE_LIST_MAX_PAGES = 32;
export const TEAM_LIFECYCLE_LIST_MAX_ITEMS = 1_000;

type PaginationFailureReason =
  | 'duplicate_cursor'
  | 'duplicate_team_id'
  | 'item_limit_exceeded'
  | 'page_limit_exceeded'
  | 'snapshot_revision_changed'
  | 'cursor_cycle';

function failure(
  code: 'cancelled' | 'internal' | 'unavailable',
  reason: string,
  retryable = false
): TeamLifecycleReadFailure {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: Object.freeze({
      code,
      reason,
      ...(code === 'internal'
        ? { diagnosticId: 'team-lifecycle-renderer.pagination-invalid' }
        : {}),
    }),
    retryable,
  });
}

const cancelled = (): TeamLifecycleReadFailure => failure('cancelled', 'request_cancelled');
const paginationFailure = (reason: PaginationFailureReason): TeamLifecycleReadFailure =>
  failure('internal', reason);

/**
 * Loads one revision-pinned snapshot without interpreting an opaque cursor or identity.
 * Cancellation cannot change the legacy transport signature, so it fences every page boundary.
 */
export async function loadTeamLifecycleList(
  transport: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>,
  signal: AbortSignal
): Promise<CanonicalListTeamLifecycleResult> {
  const items: CanonicalTeamLifecycleListItem[] = [];
  const teamIds = new Set<TeamId>();
  const returnedCursors = new Set<Cursor>();
  let cursor: Cursor | null = null;
  let snapshotRevision: Revision | null = null;

  for (let page = 0; page < TEAM_LIFECYCLE_LIST_MAX_PAGES; page += 1) {
    if (signal.aborted) return cancelled();

    let result: CanonicalListTeamLifecycleResult;
    try {
      result = await transport.listTeamLifecycle({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor,
        expectedRevision: snapshotRevision,
      });
    } catch {
      return signal.aborted ? cancelled() : failure('unavailable', 'transport_unavailable', true);
    }
    if (signal.aborted) return cancelled();
    if (result.kind !== 'success') return result;

    if (snapshotRevision === null) {
      snapshotRevision = result.snapshotRevision;
    } else if (result.snapshotRevision !== snapshotRevision) {
      return paginationFailure('snapshot_revision_changed');
    }

    if (items.length + result.items.length > TEAM_LIFECYCLE_LIST_MAX_ITEMS) {
      return paginationFailure('item_limit_exceeded');
    }
    for (const item of result.items) {
      if (teamIds.has(item.teamId)) return paginationFailure('duplicate_team_id');
      teamIds.add(item.teamId);
      items.push(item);
    }

    const nextCursor = result.nextCursor;
    if (nextCursor === null) {
      return Object.freeze({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        kind: 'success',
        snapshotRevision,
        items: Object.freeze(items),
        nextCursor: null,
      });
    }
    if (nextCursor === cursor) return paginationFailure('cursor_cycle');
    if (returnedCursors.has(nextCursor)) return paginationFailure('duplicate_cursor');
    returnedCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return paginationFailure('page_limit_exceeded');
}

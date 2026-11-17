import { InternalStorageFallbackUnsafeError } from '@features/internal-storage/main';

import { MemberWorkSyncStatusConflictError } from '../../core/domain/MemberWorkSyncStatusRevision';

import { MemberWorkSyncStatusDecodeError } from './decodeMemberWorkSyncStoredStatus';

import type { MemberWorkSyncAuthorityFailureDetail } from '../../core/application/MemberWorkSyncConditionalStatusPort';

/** Where authority preparation was when it failed; reported in diagnostics only. */
export type MemberWorkSyncPreparationStage =
  | 'replica_wrapper'
  | 'replica'
  | 'primary'
  | 'preflight'
  | 'active'
  | 'archive'
  | 'merged'
  | 'status_read';

export const INCARNATION_MISMATCH_HINT =
  'Stored work-sync status was written under an earlier identity of this team (recreated or ' +
  'restored). Nothing was changed and preparation stays fail-closed. Permanent team deletion ' +
  'purges this state; there is no automatic cleanup yet.';

/** Present when the error means "stored state belongs to another lifecycle incarnation". */
export function readIncarnationMismatch(error: unknown): { foreignIncarnation?: string } | null {
  if (error instanceof MemberWorkSyncStatusDecodeError && error.reason === 'incarnation_mismatch')
    return { foreignIncarnation: error.foreignIncarnation };
  if (error instanceof MemberWorkSyncStatusConflictError && error.reason === 'incarnation_mismatch')
    return {};
  if (
    error instanceof InternalStorageFallbackUnsafeError &&
    error.meta?.code === 'incarnation_mismatch'
  )
    return { foreignIncarnation: error.meta.foreignIncarnation };
  return null;
}

export function readFailureDetail(
  error: unknown
): MemberWorkSyncAuthorityFailureDetail | undefined {
  return readIncarnationMismatch(error) ? 'incarnation_mismatch' : undefined;
}

/**
 * Logs why preparation failed when the coarse failure reason hides it (stored state from another
 * team incarnation). Never throws and never mutates state. Called once per preparation attempt;
 * repeats within the failure-cache window are not logged again.
 */
export function logIncarnationMismatch(
  logger: { warn(message: string, metadata?: Record<string, unknown>): void } | undefined,
  input: {
    teamName: string;
    incarnation: string;
    stage: MemberWorkSyncPreparationStage;
    error: unknown;
  }
): void {
  const mismatch = readIncarnationMismatch(input.error);
  if (!mismatch) return;
  logger?.warn('member-work-sync stored state belongs to another team identity', {
    teamName: input.teamName,
    incarnation: input.incarnation,
    ...(mismatch.foreignIncarnation ? { foreignIncarnation: mismatch.foreignIncarnation } : {}),
    source: input.stage,
    detail: 'incarnation_mismatch',
    hint: INCARNATION_MISMATCH_HINT,
  });
}

/** Bounded per-team memory of the last preparation failure (see BackendSelecting store). */
export function rememberPreparationFailure(
  failures: Map<string, { incarnation: string; at: number; error: unknown }>,
  teamKey: string,
  incarnation: string,
  error: unknown
): void {
  if (failures.size >= 128) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(teamKey, { incarnation, at: Date.now(), error });
}

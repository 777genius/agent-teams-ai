import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportReceiptDraft,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncStatusAuthoritySnapshot } from './MemberWorkSyncConditionalStatusPort';
import type { MemberWorkSyncUseCaseDeps } from './ports';

interface StatusRead {
  status: MemberWorkSyncStatus | null;
  snapshot?: MemberWorkSyncStatusAuthoritySnapshot;
}
export class MemberWorkSyncStatusMutationError extends Error {
  constructor(
    readonly reason: string,
    readonly mutationId?: string,
    readonly retryExhausted = false
  ) {
    super(`member work sync status mutation ${reason}`);
    this.name = 'MemberWorkSyncStatusMutationError';
  }
}

/** One full recomputation after a CAS conflict; unknown/committed outcomes are never retried here. */
export async function runMemberWorkSyncStatusMutation<T>(
  deps: MemberWorkSyncUseCaseDeps,
  operation: (mutationId: string | undefined) => Promise<T>
): Promise<T> {
  const mutationId = deps.statusMutations?.createMutationId();
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(mutationId);
    } catch (error) {
      if (
        !(error instanceof MemberWorkSyncStatusMutationError) ||
        error.reason !== 'conflict' ||
        error.retryExhausted
      )
        throw error;
      if (attempt >= 1)
        throw new MemberWorkSyncStatusMutationError(error.reason, error.mutationId, true);
    }
  }
}

export async function readMemberWorkSyncStatus(
  deps: MemberWorkSyncUseCaseDeps,
  input: { teamName: string; memberName: string }
): Promise<StatusRead> {
  if (!deps.statusMutations) return { status: await deps.statusStore.read(input) };
  const result = await deps.statusMutations.readSnapshot(input);
  if (!result.ok) throw new MemberWorkSyncStatusMutationError(result.reason);
  return { status: result.snapshot.status, snapshot: result.snapshot };
}

export async function commitMemberWorkSyncStatus(
  deps: MemberWorkSyncUseCaseDeps,
  read: StatusRead,
  status: MemberWorkSyncStatus,
  mutationId: string | undefined,
  reportReceipt?: MemberWorkSyncReportReceiptDraft,
  replacedReceipt?: MemberWorkSyncReportReceipt
): Promise<{ status: MemberWorkSyncStatus; canProject: boolean }> {
  // Transitional legacy owner remains until composition/restore activation is qualified together.
  if (!deps.statusMutations) {
    if (reportReceipt) throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
    await deps.statusStore.write(status);
    return { status, canProject: true };
  }
  if (!read.snapshot || !mutationId) throw new MemberWorkSyncStatusMutationError('invalid_token');
  const result = await deps.statusMutations.compareAndWrite({
    teamName: status.teamName,
    memberName: status.memberName,
    incarnation: read.snapshot.incarnation,
    expectedToken: read.snapshot.token,
    mutationId,
    nextStatus: status,
    ...(reportReceipt ? { reportReceipt } : {}),
    ...(replacedReceipt ? { replacedReceipt } : {}),
  });
  if (result.committed !== true)
    throw new MemberWorkSyncStatusMutationError(result.reason, mutationId);
  if (!result.snapshot.status)
    throw new MemberWorkSyncStatusMutationError('commit_unknown', mutationId);
  return { status: result.snapshot.status, canProject: result.projectionDegraded.length === 0 };
}

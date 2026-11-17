import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportReceiptDraft,
  MemberWorkSyncStatus,
} from '../../contracts';

export interface MemberWorkSyncStatusAuthoritySnapshot {
  status: MemberWorkSyncStatus | null;
  token: string;
  incarnation: string;
}
export type MemberWorkSyncAuthorityFailureReason =
  | 'inactive'
  | 'unavailable'
  | 'corrupt'
  | 'invalid_token';
/** Optional finer cause behind a coarse `reason`. Diagnostic only; never changes behaviour. */
export type MemberWorkSyncAuthorityFailureDetail = 'incarnation_mismatch';
export type MemberWorkSyncAuthorityReadResult =
  | { ok: true; snapshot: MemberWorkSyncStatusAuthoritySnapshot }
  | {
      ok: false;
      reason: MemberWorkSyncAuthorityFailureReason;
      detail?: MemberWorkSyncAuthorityFailureDetail;
    };
export type MemberWorkSyncAuthorityCommitResult =
  | {
      committed: true;
      snapshot: MemberWorkSyncStatusAuthoritySnapshot;
      projectionDegraded: string[];
    }
  | {
      committed: false;
      reason: MemberWorkSyncAuthorityFailureReason | 'write_failed';
      detail?: MemberWorkSyncAuthorityFailureDetail;
    }
  | { committed: false; reason: 'conflict'; current: MemberWorkSyncStatusAuthoritySnapshot }
  | { committed: 'unknown'; reason: 'commit_unknown'; mutationId: string };

/** Internal application port. Main owns admission, physical lifetime, backend and raw token bytes. */
export interface MemberWorkSyncConditionalStatusPort {
  createMutationId(): string;
  readSnapshot(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncAuthorityReadResult>;
  compareAndWrite(input: {
    teamName: string;
    memberName: string;
    incarnation: string;
    expectedToken: string;
    mutationId: string;
    nextStatus: MemberWorkSyncStatus;
    reportReceipt?: MemberWorkSyncReportReceiptDraft;
    /** Exact current checkpoint after a proven journal transfer; required to replace it. */
    replacedReceipt?: MemberWorkSyncReportReceipt;
  }): Promise<MemberWorkSyncAuthorityCommitResult>;
}

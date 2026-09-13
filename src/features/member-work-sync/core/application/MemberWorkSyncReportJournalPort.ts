import type {
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportRequest,
} from '../../contracts';

export interface MemberWorkSyncReportJournalIdentity {
  teamName: string;
  memberName: string;
  incarnation: string;
  intentId: string;
  requestDigest: string;
}
export interface MemberWorkSyncReportJournalInput extends MemberWorkSyncReportJournalIdentity {
  request: MemberWorkSyncReportRequest;
  receivedAt: string;
  origin: 'online' | 'fallback';
}
export type MemberWorkSyncReportJournalResult =
  | { state: 'present'; intent: MemberWorkSyncReportIntent; projectionDegraded: boolean }
  | {
      state: 'absent' | 'conflict' | 'corrupt' | 'unavailable' | 'write_failed' | 'commit_unknown';
    };

/** Strict durable request binding. Legacy unbound rows are never adopted. */
export interface MemberWorkSyncReportJournalPort {
  ensure(input: MemberWorkSyncReportJournalInput): Promise<MemberWorkSyncReportJournalResult>;
  /** Read does not inspect the pending index; projectionDegraded=false means unchecked. */
  read(input: MemberWorkSyncReportJournalIdentity): Promise<MemberWorkSyncReportJournalResult>;
  transfer(
    input: MemberWorkSyncReportJournalInput & { receipt: MemberWorkSyncReportReceipt }
  ): Promise<MemberWorkSyncReportJournalResult>;
}

import type { MemberWorkSyncReportReceipt } from '../../contracts';
import type {
  MemberWorkSyncReportJournalIdentity,
  MemberWorkSyncReportJournalInput,
  MemberWorkSyncReportJournalPort,
  MemberWorkSyncReportJournalResult,
} from '../../core/application/MemberWorkSyncReportJournalPort';
import type { InternalStorageBackendSelector } from '@features/internal-storage/main';

/** Routes report-journal mutations through the session-wide backend decision. */
export class BackendSelectingMemberWorkSyncReportJournal implements MemberWorkSyncReportJournalPort {
  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqlite: MemberWorkSyncReportJournalPort,
    private readonly json: MemberWorkSyncReportJournalPort
  ) {}

  read(input: MemberWorkSyncReportJournalIdentity): Promise<MemberWorkSyncReportJournalResult> {
    return this.choose().then((journal) => journal.read(input));
  }

  ensure(input: MemberWorkSyncReportJournalInput): Promise<MemberWorkSyncReportJournalResult> {
    return this.choose().then((journal) => journal.ensure(input));
  }

  transfer(
    input: MemberWorkSyncReportJournalInput & { receipt: MemberWorkSyncReportReceipt }
  ): Promise<MemberWorkSyncReportJournalResult> {
    return this.choose().then((journal) => journal.transfer(input));
  }

  private choose(): Promise<MemberWorkSyncReportJournalPort> {
    return this.selector.select(this.sqlite, this.json);
  }
}

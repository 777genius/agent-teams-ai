import type { MemberWorkSyncReportReceipt } from '../../contracts';
import type {
  MemberWorkSyncReportJournalIdentity,
  MemberWorkSyncReportJournalInput,
  MemberWorkSyncReportJournalPort,
  MemberWorkSyncReportJournalResult,
} from '../../core/application/MemberWorkSyncReportJournalPort';
import type { InternalStorageBackendSelector } from '@features/internal-storage/main';

export type MemberWorkSyncReportJournalReplicaFence = {
  runReplicaFenced<T>(
    teamName: string,
    mutation: boolean,
    sqliteAction: () => Promise<T>,
    jsonAction: () => Promise<T>
  ): Promise<T>;
};

/** Routes report-journal mutations through the session-wide backend decision. */
export class BackendSelectingMemberWorkSyncReportJournal implements MemberWorkSyncReportJournalPort {
  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqlite: MemberWorkSyncReportJournalPort,
    private readonly json: MemberWorkSyncReportJournalPort,
    private readonly replicaFence?: MemberWorkSyncReportJournalReplicaFence
  ) {}

  read(input: MemberWorkSyncReportJournalIdentity): Promise<MemberWorkSyncReportJournalResult> {
    return this.choose().then((journal) => journal.read(input));
  }

  ensure(input: MemberWorkSyncReportJournalInput): Promise<MemberWorkSyncReportJournalResult> {
    return this.mutate(
      input.teamName,
      () => this.sqlite.ensure(input),
      () => this.json.ensure(input)
    );
  }

  transfer(
    input: MemberWorkSyncReportJournalInput & { receipt: MemberWorkSyncReportReceipt }
  ): Promise<MemberWorkSyncReportJournalResult> {
    return this.mutate(
      input.teamName,
      () => this.sqlite.transfer(input),
      () => this.json.transfer(input)
    );
  }

  private mutate<T>(
    teamName: string,
    sqliteAction: () => Promise<T>,
    jsonAction: () => Promise<T>
  ): Promise<T> {
    return this.replicaFence
      ? this.replicaFence.runReplicaFenced(teamName, true, sqliteAction, jsonAction)
      : this.choose().then((journal) => (journal === this.sqlite ? sqliteAction() : jsonAction()));
  }

  private choose(): Promise<MemberWorkSyncReportJournalPort> {
    return this.selector.select(this.sqlite, this.json);
  }
}

import type {
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxCountDeliveredForAgendaInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';
import type {
  MemberWorkSyncOutboxStorePort,
  MemberWorkSyncReportStorePort,
  MemberWorkSyncStatusStorePort,
} from '../../core/application/ports';
import type { JsonMemberWorkSyncStore } from './JsonMemberWorkSyncStore';
import type { SqliteMemberWorkSyncStore } from './SqliteMemberWorkSyncStore';
import type { InternalStorageBackendSelector } from '@features/internal-storage/main';

type FullStore = Required<MemberWorkSyncStatusStorePort> &
  Required<MemberWorkSyncReportStorePort> &
  Required<MemberWorkSyncOutboxStorePort>;

/**
 * Routes member-work-sync persistence through the internal-storage session
 * backend decision: SQLite when the worker pinged successfully, the legacy
 * JSON store otherwise. The decision is made once per session, so delivery
 * state never splits between backends.
 */
export class BackendSelectingMemberWorkSyncStore
  implements
    MemberWorkSyncStatusStorePort,
    MemberWorkSyncReportStorePort,
    MemberWorkSyncOutboxStorePort
{
  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqliteStore: SqliteMemberWorkSyncStore,
    private readonly jsonStore: JsonMemberWorkSyncStore
  ) {}

  private backend(): Promise<FullStore> {
    return this.selector.select<FullStore>(this.sqliteStore, this.jsonStore);
  }

  async read(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncStatus | null> {
    return (await this.backend()).read(input);
  }

  async write(status: MemberWorkSyncStatus): Promise<void> {
    await (await this.backend()).write(status);
  }

  async readTeamMetrics(teamName: string): Promise<MemberWorkSyncTeamMetrics> {
    return (await this.backend()).readTeamMetrics(teamName);
  }

  async appendPendingReport(request: MemberWorkSyncReportRequest, reason: string): Promise<void> {
    await (await this.backend()).appendPendingReport(request, reason);
  }

  async listPendingReports(teamName: string): Promise<MemberWorkSyncReportIntent[]> {
    return (await this.backend()).listPendingReports(teamName);
  }

  async markPendingReportProcessed(
    teamName: string,
    id: string,
    result: { status: MemberWorkSyncReportIntentStatus; resultCode: string; processedAt: string }
  ): Promise<void> {
    await (await this.backend()).markPendingReportProcessed(teamName, id, result);
  }

  async ensurePending(
    input: MemberWorkSyncOutboxEnsureInput
  ): Promise<MemberWorkSyncOutboxEnsureResult> {
    return (await this.backend()).ensurePending(input);
  }

  async claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]> {
    return (await this.backend()).claimDue(input);
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    await (await this.backend()).markDelivered(input);
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    await (await this.backend()).markSuperseded(input);
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    await (await this.backend()).markFailed(input);
  }

  async countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<number> {
    return (await this.backend()).countRecentDelivered(input);
  }

  async countDeliveredForAgenda(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number> {
    return (await this.backend()).countDeliveredForAgenda(input);
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    return (await this.backend()).findDeliveredReviewPickupRequestEventIds(input);
  }

  async findRecentRecoveryByIntent(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<{
    id: string;
    status: MemberWorkSyncOutboxItem['status'];
    deliveredMessageId?: string;
    payloadHash: string;
    updatedAt: string;
  } | null> {
    return (await this.backend()).findRecentRecoveryByIntent(input);
  }
}

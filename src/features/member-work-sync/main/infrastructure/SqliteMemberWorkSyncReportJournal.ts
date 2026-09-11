import { decodeMemberWorkSyncReportJournalMetadata } from '../../core/domain/MemberWorkSyncReportJournalMetadata';

import { recordToReportIntent, reportIntentToRecord } from './memberWorkSyncSqliteMappers';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type { MemberWorkSyncReportReceipt } from '../../contracts';
import type {
  MemberWorkSyncReportJournalIdentity,
  MemberWorkSyncReportJournalInput,
  MemberWorkSyncReportJournalPort,
  MemberWorkSyncReportJournalResult,
} from '../../core/application/MemberWorkSyncReportJournalPort';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';

function toResult(
  result: Awaited<ReturnType<MemberWorkSyncStorageGateway['reportsJournalEnsure']>>
): MemberWorkSyncReportJournalResult {
  if (result.state !== 'present') return result;
  try {
    return {
      state: 'present',
      intent: recordToReportIntent(result.record),
      projectionDegraded: result.projectionDegraded,
    };
  } catch {
    return { state: 'corrupt' };
  }
}

function mutation(input: MemberWorkSyncReportJournalInput, receipt?: MemberWorkSyncReportReceipt) {
  const metadata = decodeMemberWorkSyncReportJournalMetadata(
    {
      incarnation: input.incarnation,
      requestDigest: input.requestDigest,
      firstRecordedAt: input.receivedAt,
      origin: input.origin,
      ...(receipt ? { receipt } : {}),
    },
    input.intentId
  );
  const record = reportIntentToRecord({
    id: input.intentId,
    teamName: input.teamName,
    memberName: input.memberName,
    request: input.request,
    reason: input.origin,
    status: receipt ? 'accepted' : 'pending',
    recordedAt: input.receivedAt,
    ...(receipt ? { resultCode: 'accepted', processedAt: receipt.acceptedAt } : {}),
    journal: metadata,
  });
  return {
    teamName: record.teamName,
    memberKey: record.memberKey,
    memberName: record.memberName,
    id: record.id,
    requestJson: record.requestJson,
    journalJson: record.journalJson ?? JSON.stringify(metadata),
    ...(receipt ? { receiptJson: JSON.stringify(receipt) } : {}),
  };
}

export class SqliteMemberWorkSyncReportJournal implements MemberWorkSyncReportJournalPort {
  constructor(
    private readonly gateway: MemberWorkSyncStorageGateway,
    private readonly ready: (teamName: string) => Promise<void>
  ) {}

  async read(
    input: MemberWorkSyncReportJournalIdentity
  ): Promise<MemberWorkSyncReportJournalResult> {
    try {
      const metadata = decodeMemberWorkSyncReportJournalMetadata(
        {
          incarnation: input.incarnation,
          requestDigest: input.requestDigest,
          firstRecordedAt: '1970-01-01T00:00:00.000Z',
          origin: 'online',
        },
        input.intentId
      );
      await this.ready(input.teamName);
      return toResult(
        await this.gateway.reportsJournalRead({
          teamName: input.teamName,
          memberKey: normalizeMemberKey(input.memberName),
          id: input.intentId,
          journalJson: JSON.stringify(metadata),
          requestJson: '{}',
        })
      );
    } catch {
      return { state: 'conflict' };
    }
  }

  async ensure(
    input: MemberWorkSyncReportJournalInput
  ): Promise<MemberWorkSyncReportJournalResult> {
    try {
      await this.ready(input.teamName);
      return toResult(await this.gateway.reportsJournalEnsure(mutation(input)));
    } catch {
      return { state: 'conflict' };
    }
  }

  async transfer(
    input: MemberWorkSyncReportJournalInput & { receipt: MemberWorkSyncReportReceipt }
  ): Promise<MemberWorkSyncReportJournalResult> {
    try {
      await this.ready(input.teamName);
      return toResult(await this.gateway.reportsJournalTransfer(mutation(input, input.receipt)));
    } catch {
      return { state: 'conflict' };
    }
  }
}

import { randomUUID } from 'node:crypto';

import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportReceiptDraft,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
} from '../../contracts';
import type {
  MemberWorkSyncReportJournalInput,
  MemberWorkSyncReportJournalPort,
} from './MemberWorkSyncReportJournalPort';
import type { MemberWorkSyncHashPort } from './ports';

export interface MemberWorkSyncReportJournalReplay {
  intentId: string;
  incarnation: string;
  requestDigest: string;
  receivedAt: string;
  origin: 'online' | 'fallback';
}

export function buildMemberWorkSyncReportRequestDigest(
  hash: MemberWorkSyncHashPort,
  request: MemberWorkSyncReportRequest
): string {
  return hash.sha256Hex(
    JSON.stringify({
      teamName: request.teamName,
      memberName: request.memberName.trim().toLowerCase(),
      state: request.state,
      agendaFingerprint: request.agendaFingerprint,
      reportToken: request.reportToken ?? '',
      taskIds: [...new Set(request.taskIds ?? [])].sort(),
      note: request.note ?? '',
      leaseTtlMs: request.leaseTtlMs ?? 0,
      source: request.source ?? '',
    })
  );
}

export function createMemberWorkSyncReportJournalInput(input: {
  request: MemberWorkSyncReportRequest;
  incarnation: string;
  receivedAt: string;
  hash: MemberWorkSyncHashPort;
  replay?: MemberWorkSyncReportJournalReplay;
}): MemberWorkSyncReportJournalInput {
  const requestDigest =
    input.replay?.requestDigest ??
    buildMemberWorkSyncReportRequestDigest(input.hash, input.request);
  return {
    teamName: input.request.teamName,
    memberName: input.request.memberName,
    incarnation: input.replay?.incarnation ?? input.incarnation,
    intentId: input.replay?.intentId ?? randomUUID(),
    requestDigest,
    receivedAt: input.replay?.receivedAt ?? input.receivedAt,
    origin: input.replay?.origin ?? 'online',
    request: input.request,
  };
}

export async function transferPreviousReportCheckpoint(
  journal: MemberWorkSyncReportJournalPort,
  status: MemberWorkSyncStatus,
  nextIntentId: string
): Promise<'ok' | 'degraded' | 'skip'> {
  const checkpoint = status.pendingReportReceipt;
  if (!checkpoint || checkpoint.intentId === nextIntentId) return 'skip';
  const identity = {
    teamName: status.teamName,
    memberName: status.memberName,
    incarnation: checkpoint.incarnation,
    intentId: checkpoint.intentId,
    requestDigest: checkpoint.requestDigest,
  };
  const current = await journal.read(identity);
  if (current.state === 'present' && current.intent.journal) {
    const result = await journal.transfer({
      ...identity,
      receivedAt: current.intent.journal.firstRecordedAt,
      origin: current.intent.journal.origin,
      request: current.intent.request,
      receipt: checkpoint,
    });
    return result.state === 'present' ? 'ok' : 'degraded';
  }
  return 'degraded';
}

export function reportReceiptDraftFromJournal(
  input: MemberWorkSyncReportJournalInput,
  expiresAt?: string
): MemberWorkSyncReportReceiptDraft {
  return {
    intentId: input.intentId,
    incarnation: input.incarnation,
    requestDigest: input.requestDigest,
    acceptedAt: input.receivedAt,
    ...(expiresAt ? { originalExpiresAt: expiresAt } : {}),
  };
}

export async function transferAcceptedReportReceipt(
  journal: MemberWorkSyncReportJournalPort,
  input: MemberWorkSyncReportJournalInput,
  receipt: MemberWorkSyncReportReceipt
): Promise<boolean> {
  const result = await journal.transfer({ ...input, receipt });
  return result.state === 'present';
}

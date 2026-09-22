import { randomUUID } from 'node:crypto';

import { normalizeMemberName } from '../../core/domain/memberName';
import {
  MemberWorkSyncReportReceiptError,
  readMemberWorkSyncReportReceipt,
  readMemberWorkSyncReportReceiptDraft,
} from '../../core/domain/MemberWorkSyncReportReceipt';
import {
  MemberWorkSyncStatusConflictError,
  readMemberWorkSyncStatusRevision,
} from '../../core/domain/MemberWorkSyncStatusRevision';

import { decodeMemberWorkSyncStoredStatus } from './decodeMemberWorkSyncStoredStatus';

import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportReceiptDraft,
  MemberWorkSyncStatus,
} from '../../contracts';

export interface MemberWorkSyncStatusBinding {
  teamName: string;
  memberName: string;
  incarnation: string;
  backend: 'json' | 'sqlite';
}

function tokenBinding(binding: MemberWorkSyncStatusBinding) {
  const teamKey = normalizeMemberName(binding.teamName);
  const memberKey = normalizeMemberName(binding.memberName);
  if (
    !teamKey ||
    !memberKey ||
    !binding.incarnation ||
    binding.incarnation.trim() !== binding.incarnation
  ) {
    throw new MemberWorkSyncStatusConflictError('incarnation_mismatch');
  }
  return {
    formatVersion: 1,
    teamKey,
    memberKey,
    incarnation: binding.incarnation,
    backend: binding.backend,
  };
}

/** Internal codec only: never expose this token through renderer/MCP/report input. */
export function createMemberWorkSyncStatusToken(
  binding: MemberWorkSyncStatusBinding,
  raw: string | null
): string {
  return JSON.stringify({ ...tokenBinding(binding), raw });
}

export function readMemberWorkSyncStatusToken(
  token: string,
  binding: MemberWorkSyncStatusBinding
): { ok: true; raw: string | null } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(token);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    const value = parsed as Record<string, unknown>;
    if (value.raw !== null && typeof value.raw !== 'string') return { ok: false };
    if (
      !Object.entries(tokenBinding(binding)).every(([key, expected]) => value[key] === expected)
    ) {
      return { ok: false };
    }
    return { ok: true, raw: value.raw };
  } catch {
    return { ok: false };
  }
}

/** Called inside authority admission after validating the expected raw snapshot. */
export function createMemberWorkSyncStatusVersion(
  current: MemberWorkSyncStatus | null,
  next: MemberWorkSyncStatus,
  binding: MemberWorkSyncStatusBinding,
  uuid: () => string = randomUUID,
  receiptDraft?: MemberWorkSyncReportReceiptDraft,
  replacedReceipt?: MemberWorkSyncReportReceipt
): MemberWorkSyncStatus {
  tokenBinding(binding);
  if (current) decodeMemberWorkSyncStoredStatus(current, binding);
  const previous = current ? readMemberWorkSyncStatusRevision(current) : null;
  if (previous?.sequence === Number.MAX_SAFE_INTEGER) {
    throw new MemberWorkSyncStatusConflictError('invalid_revision');
  }
  // A caller may pass an old domain snapshot, but never assigns storage metadata.
  const prepared = JSON.parse(JSON.stringify(next)) as MemberWorkSyncStatus;
  const existingReceipt = current?.pendingReportReceipt;
  if (prepared.pendingReportReceipt !== undefined) {
    const supplied = readMemberWorkSyncReportReceipt(prepared.pendingReportReceipt, previous);
    if (
      !existingReceipt ||
      JSON.stringify(supplied) !==
        JSON.stringify(readMemberWorkSyncReportReceipt(existingReceipt, previous))
    ) {
      throw new MemberWorkSyncReportReceiptError();
    }
  }
  delete prepared.statusRevision;
  delete prepared.pendingReportReceipt;
  decodeMemberWorkSyncStoredStatus(prepared, binding);
  prepared.statusRevision = {
    incarnation: binding.incarnation,
    lineageId: previous?.lineageId ?? uuid(),
    sequence: (previous?.sequence ?? 0) + 1,
    nonce: uuid(),
  };
  if (existingReceipt) {
    prepared.pendingReportReceipt = JSON.parse(JSON.stringify(existingReceipt));
  }
  if (receiptDraft !== undefined) {
    const draft = readMemberWorkSyncReportReceiptDraft(receiptDraft, binding.incarnation);
    const acceptedReport = prepared.lastAcceptedReport ?? prepared.report;
    if (
      !acceptedReport?.accepted ||
      acceptedReport.reportedAt !== draft.acceptedAt ||
      normalizeMemberName(acceptedReport.teamName) !== normalizeMemberName(binding.teamName) ||
      normalizeMemberName(acceptedReport.memberName) !== normalizeMemberName(binding.memberName)
    ) {
      throw new MemberWorkSyncReportReceiptError();
    }
    if (existingReceipt) {
      const existingDraft = readMemberWorkSyncReportReceiptDraft(
        existingReceipt,
        binding.incarnation
      );
      if (JSON.stringify(draft) === JSON.stringify(existingDraft)) {
        prepared.pendingReportReceipt = JSON.parse(JSON.stringify(existingReceipt));
      } else {
        if (!replacedReceipt || !previous) throw new MemberWorkSyncReportReceiptError();
        const proven = readMemberWorkSyncReportReceipt(replacedReceipt, previous);
        if (
          JSON.stringify(proven) !==
          JSON.stringify(readMemberWorkSyncReportReceipt(existingReceipt, previous))
        ) {
          throw new MemberWorkSyncReportReceiptError();
        }
        prepared.pendingReportReceipt = {
          ...draft,
          appliedStatusRevision: prepared.statusRevision,
        };
      }
    } else {
      prepared.pendingReportReceipt = { ...draft, appliedStatusRevision: prepared.statusRevision };
    }
  }
  decodeMemberWorkSyncStoredStatus(prepared, binding);
  return prepared;
}

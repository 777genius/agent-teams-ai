import { normalizeMemberName } from '../../core/domain/memberName';
import { readMemberWorkSyncRecoveryHealth } from '../../core/domain/MemberWorkSyncRecoveryHealth';
import { readMemberWorkSyncReportReceipt } from '../../core/domain/MemberWorkSyncReportReceipt';
import { readMemberWorkSyncStatusRevision } from '../../core/domain/MemberWorkSyncStatusRevision';

import type { MemberWorkSyncStatus } from '../../contracts';

type RecordValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;

export class MemberWorkSyncStatusDecodeError extends Error {
  constructor(readonly reason: 'invalid_status' | 'identity_mismatch' | 'incarnation_mismatch') {
    super(`Invalid stored member work sync status: ${reason}`);
    this.name = 'MemberWorkSyncStatusDecodeError';
  }
}

const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text: Check = (value) => typeof value === 'string';
const id: Check = (value) => typeof value === 'string' && value.trim().length > 0;
const boolean: Check = (value) => typeof value === 'boolean';
const strings: Check = (value) => Array.isArray(value) && value.every(text);
const ids: Check = (value) => Array.isArray(value) && value.every(id);
const timestamp: Check = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);
const optional = (value: RecordValue, key: string, check: Check): boolean =>
  value[key] === undefined || check(value[key]);

function fields(
  value: RecordValue,
  required: Record<string, Check>,
  optionalFields: Record<string, Check> = {}
): boolean {
  return (
    Object.entries(required).every(([key, check]) => check(value[key])) &&
    Object.entries(optionalFields).every(([key, check]) => optional(value, key, check))
  );
}

function item(value: unknown): boolean {
  if (!object(value) || !object(value.evidence)) return false;
  return (
    fields(
      value,
      {
        taskId: id,
        subject: text,
        kind: oneOf('work', 'review', 'clarification', 'blocked_dependency'),
        assignee: id,
        priority: oneOf('normal', 'review_requested', 'blocked', 'needs_clarification'),
        reason: id,
      },
      { displayId: text }
    ) &&
    fields(
      value.evidence,
      { status: id },
      {
        owner: text,
        reviewer: text,
        reviewState: text,
        reviewCycleId: text,
        reviewRequestEventId: text,
        reviewRequestedAt: timestamp,
        reviewStartedEventId: text,
        reviewStartedAt: timestamp,
        reviewStartedBy: text,
        reviewObligation: oneOf('review_pickup_required', 'review_in_progress'),
        canBypassPhase2: boolean,
        reviewDiagnostics: strings,
        needsClarification: oneOf('lead', 'user'),
        blockerTaskIds: ids,
        blockedByTaskIds: ids,
        historyEventIds: ids,
      }
    )
  );
}

function report(value: unknown): boolean {
  return (
    object(value) &&
    fields(
      value,
      {
        teamName: id,
        memberName: id,
        state: oneOf('still_working', 'blocked', 'caught_up'),
        agendaFingerprint: text,
        reportedAt: timestamp,
        accepted: boolean,
      },
      {
        expiresAt: timestamp,
        taskIds: value.accepted === false ? strings : ids,
        note: text,
        source: oneOf('mcp', 'app', 'test'),
        rejectionCode: text,
      }
    )
  );
}

function shadow(value: unknown): boolean {
  if (
    !object(value) ||
    !fields(
      value,
      {
        reconciledBy: oneOf('request', 'queue', 'report'),
        wouldNudge: boolean,
        fingerprintChanged: boolean,
      },
      { previousFingerprint: text, triggerReasons: strings, nudgeSuppressionResetAt: timestamp }
    )
  )
    return false;
  if (value.nudgeSuppression !== undefined) {
    const suppression = value.nudgeSuppression;
    if (
      !object(suppression) ||
      !fields(
        suppression,
        {
          reason: oneOf('no_accepted_report'),
          agendaFingerprint: id,
          suppressedAt: timestamp,
          deliveredCount: (count) =>
            typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
        },
        { resetAt: timestamp }
      )
    )
      return false;
  }
  if (value.recovery !== undefined) {
    if (
      !object(value.recovery) ||
      !fields(value.recovery, {
        kind: oneOf('proof_missing'),
        intentKey: id,
        originalMessageId: id,
        taskIds: ids,
      })
    )
      return false;
  }
  return true;
}

/** Structural import validation only; this does not establish lifecycle incarnation or admission. */
export function decodeMemberWorkSyncImportStatus(
  value: unknown,
  identity: { teamName: string; memberName: string }
): MemberWorkSyncStatus {
  if (
    !object(value) ||
    !fields(
      value,
      {
        teamName: id,
        memberName: id,
        state: oneOf('caught_up', 'needs_sync', 'still_working', 'blocked', 'inactive', 'unknown'),
        evaluatedAt: timestamp,
        diagnostics: strings,
      },
      {
        report,
        lastAcceptedReport: (value) => report(value) && object(value) && value.accepted === true,
        shadow,
        reportToken: text,
        reportTokenExpiresAt: timestamp,
        providerId: oneOf('anthropic', 'codex', 'gemini', 'opencode'),
        recoveryHealth: (value) => {
          try {
            return readMemberWorkSyncRecoveryHealth(value) !== undefined;
          } catch {
            return false;
          }
        },
      }
    ) ||
    !object(value.agenda) ||
    !fields(
      value.agenda,
      {
        teamName: id,
        memberName: id,
        generatedAt: timestamp,
        fingerprint: id,
        items: (items) => Array.isArray(items) && items.every(item),
        diagnostics: strings,
      },
      { sourceRevision: text }
    )
  )
    throw new MemberWorkSyncStatusDecodeError('invalid_status');

  const matches = (owner: RecordValue): boolean =>
    normalizeMemberName(owner.teamName) === normalizeMemberName(identity.teamName) &&
    normalizeMemberName(owner.memberName) === normalizeMemberName(identity.memberName);
  if (
    !id(identity.teamName) ||
    !id(identity.memberName) ||
    !matches(value) ||
    !matches(value.agenda) ||
    (object(value.report) && !matches(value.report)) ||
    (object(value.lastAcceptedReport) && !matches(value.lastAcceptedReport))
  ) {
    throw new MemberWorkSyncStatusDecodeError('identity_mismatch');
  }
  const revision = readMemberWorkSyncStatusRevision(value);
  if (value.pendingReportReceipt !== undefined) {
    const receipt = readMemberWorkSyncReportReceipt(value.pendingReportReceipt, revision);
    if (receipt.appliedStatusRevision.sequence === revision?.sequence) {
      const accepted = value.lastAcceptedReport ?? value.report;
      if (
        !object(accepted) ||
        accepted.accepted !== true ||
        accepted.reportedAt !== receipt.acceptedAt
      )
        throw new MemberWorkSyncStatusDecodeError('invalid_status');
    }
  }
  return value as unknown as MemberWorkSyncStatus;
}

/** Authority validation additionally requires a trusted lifecycle incarnation. */
export function decodeMemberWorkSyncStoredStatus(
  value: unknown,
  identity: { teamName: string; memberName: string; incarnation: string }
): MemberWorkSyncStatus {
  const status = decodeMemberWorkSyncImportStatus(value, identity);
  if (!id(identity.incarnation)) throw new MemberWorkSyncStatusDecodeError('identity_mismatch');
  const revision = readMemberWorkSyncStatusRevision(status);
  if (revision && revision.incarnation !== identity.incarnation) {
    throw new MemberWorkSyncStatusDecodeError('incarnation_mismatch');
  }
  return status;
}

import { isReservedMemberName, normalizeMemberName, sameMemberName } from './memberName';

import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncReportRequest,
  MemberWorkSyncReportState,
} from '../../contracts';

export interface MemberWorkSyncReportValidation {
  ok: boolean;
  code: string;
  message: string;
  expiresAt?: string;
}

export type MemberWorkSyncReportTokenValidation =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' };

const DEFAULT_STILL_WORKING_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_REVIEW_PICKUP_STILL_WORKING_LEASE_MS = 3 * 60 * 1000;
const DEFAULT_BLOCKED_LEASE_MS = 30 * 60 * 1000;
const MIN_LEASE_MS = 60_000;
const MAX_LEASE_MS = 60 * 60 * 1000;
const MAX_REVIEW_PICKUP_STILL_WORKING_LEASE_MS = 10 * 60 * 1000;

function agendaIsReviewPickupRequired(agenda: MemberWorkSyncAgenda): boolean {
  return (
    agenda.items.length > 0 &&
    agenda.items.every(
      (item) =>
        item.kind === 'review' &&
        item.evidence.reviewObligation === 'review_pickup_required' &&
        item.evidence.canBypassDeliveryReadiness === true
    )
  );
}

function clampLeaseTtlMs(
  value: number | undefined,
  state: MemberWorkSyncReportState,
  agenda: MemberWorkSyncAgenda
): number | undefined {
  if (state === 'caught_up') {
    return undefined;
  }
  const isReviewPickupStillWorking =
    state === 'still_working' && agendaIsReviewPickupRequired(agenda);
  const fallback =
    state === 'blocked'
      ? DEFAULT_BLOCKED_LEASE_MS
      : isReviewPickupStillWorking
        ? DEFAULT_REVIEW_PICKUP_STILL_WORKING_LEASE_MS
        : DEFAULT_STILL_WORKING_LEASE_MS;
  const maxLease = isReviewPickupStillWorking
    ? MAX_REVIEW_PICKUP_STILL_WORKING_LEASE_MS
    : MAX_LEASE_MS;
  const numeric = Number.isFinite(value) ? Math.floor(Number(value)) : fallback;
  return Math.min(maxLease, Math.max(MIN_LEASE_MS, numeric));
}

function agendaHasBlockedEvidence(
  agenda: MemberWorkSyncAgenda,
  taskIds: string[] | undefined
): boolean {
  const targetIds = new Set((taskIds ?? []).flatMap(taskReferenceKeys));
  return agenda.items.some((item) => {
    if (
      targetIds.size > 0 &&
      !taskReferenceKeys(item).some((reference) => targetIds.has(reference))
    ) {
      return false;
    }
    return item.kind === 'blocked_dependency' || item.priority === 'blocked';
  });
}

function taskReferenceKeys(
  task: Pick<MemberWorkSyncAgenda['items'][number], 'taskId' | 'displayId'> | string
): string[] {
  const values = typeof task === 'string' ? [task] : [task.taskId, task.displayId];
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => [value, value.replace(/^#/, '')])
    ),
  ];
}

export function validateMemberWorkSyncReport(input: {
  request: MemberWorkSyncReportRequest;
  agenda: MemberWorkSyncAgenda;
  nowIso: string;
  activeMemberNames: string[];
  tokenValidation: MemberWorkSyncReportTokenValidation;
}): MemberWorkSyncReportValidation {
  const memberName = normalizeMemberName(input.request.memberName);
  const activeMemberNames = new Set(input.activeMemberNames.map(normalizeMemberName));

  if (!memberName || isReservedMemberName(memberName)) {
    return { ok: false, code: 'reserved_or_invalid_member', message: 'Invalid member identity.' };
  }
  if (!sameMemberName(memberName, input.agenda.memberName)) {
    return {
      ok: false,
      code: 'identity_mismatch',
      message: 'Report member does not match agenda.',
    };
  }
  if (!activeMemberNames.has(memberName)) {
    return { ok: false, code: 'member_inactive', message: 'Member is not active in this team.' };
  }
  if (input.request.agendaFingerprint !== input.agenda.fingerprint) {
    return {
      ok: false,
      code: 'stale_fingerprint',
      message: 'Report fingerprint is stale. Read current member work sync status and retry.',
    };
  }
  if (!input.tokenValidation.ok) {
    return input.tokenValidation.reason === 'missing'
      ? {
          ok: false,
          code: 'identity_untrusted',
          message: 'Report token is required. Read current member work sync status and retry.',
        }
      : {
          ok: false,
          code: 'invalid_report_token',
          message:
            'Report token is invalid or expired. Read current member work sync status and retry.',
        };
  }

  const agendaTaskIds = new Set(input.agenda.items.flatMap(taskReferenceKeys));
  for (const taskId of input.request.taskIds ?? []) {
    if (!taskReferenceKeys(taskId).some((reference) => agendaTaskIds.has(reference))) {
      return {
        ok: false,
        code: 'foreign_task_id',
        message: `Task ${taskId} is not in the current actionable agenda.`,
      };
    }
  }

  if (input.request.state === 'caught_up' && input.agenda.items.length > 0) {
    return {
      ok: false,
      code: 'caught_up_rejected_actionable_items_exist',
      message: 'Cannot report caught_up while actionable work remains.',
    };
  }

  if (input.request.state === 'still_working' && input.agenda.items.length === 0) {
    return {
      ok: false,
      code: 'still_working_rejected_agenda_empty',
      message: 'Cannot report still_working when no actionable work remains.',
    };
  }

  if (
    input.request.state === 'blocked' &&
    !agendaHasBlockedEvidence(input.agenda, input.request.taskIds)
  ) {
    return {
      ok: false,
      code: 'blocked_without_evidence',
      message: 'Blocked report requires current blocker evidence in the task board.',
    };
  }

  const leaseTtlMs = clampLeaseTtlMs(input.request.leaseTtlMs, input.request.state, input.agenda);
  return {
    ok: true,
    code: 'accepted',
    message: 'Member work sync report accepted.',
    ...(leaseTtlMs
      ? { expiresAt: new Date(Date.parse(input.nowIso) + leaseTtlMs).toISOString() }
      : {}),
  };
}

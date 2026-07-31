import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncNudgeDispatchSummary } from './MemberWorkSyncNudgeDispatcher';

const MEMBER_WORK_SYNC_RETRY_BASE_MINUTES = 10;
const MEMBER_WORK_SYNC_RETRY_MAX_MINUTES = 60;
export const AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX = 'agenda-sync-still-stuck:';

export function emptyNudgeDispatchSummary(): MemberWorkSyncNudgeDispatchSummary {
  return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
}

export function addNudgeDispatchSummary(
  left: MemberWorkSyncNudgeDispatchSummary,
  right: MemberWorkSyncNudgeDispatchSummary
): MemberWorkSyncNudgeDispatchSummary {
  return {
    claimed: left.claimed + right.claimed,
    delivered: left.delivered + right.delivered,
    superseded: left.superseded + right.superseded,
    retryable: left.retryable + right.retryable,
    terminal: left.terminal + right.terminal,
  };
}

export function unrefNudgeDispatchTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export function addNudgeDispatchMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function subtractNudgeDispatchMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

export function preserveCurrentRuntimeStallDiagnostics(input: {
  previous: MemberWorkSyncStatus;
  agenda: MemberWorkSyncAgenda;
  state: MemberWorkSyncStatus['state'];
  diagnostics: string[];
}): string[] {
  const diagnostics = new Set(input.diagnostics);
  if (
    input.state !== 'needs_sync' ||
    input.previous.agenda.fingerprint !== input.agenda.fingerprint
  ) {
    return [...diagnostics];
  }
  for (const diagnostic of input.previous.diagnostics) {
    if (diagnostic.startsWith('runtime_stall:')) {
      diagnostics.add(diagnostic);
    }
  }
  return [...diagnostics];
}

function stableJitterMinutes(id: string, attemptGeneration: number): number {
  const seed = `${id}:${attemptGeneration}`;
  let value = 0;
  for (const char of seed) {
    value = (value * 31 + char.charCodeAt(0)) % 997;
  }
  return value % 5;
}

export function nextNudgeRetryAt(item: MemberWorkSyncOutboxItem, nowIso: string): string {
  const exponentialMinutes =
    MEMBER_WORK_SYNC_RETRY_BASE_MINUTES * 2 ** Math.max(0, item.attemptGeneration - 1);
  const cappedMinutes = Math.min(MEMBER_WORK_SYNC_RETRY_MAX_MINUTES, exponentialMinutes);
  return addNudgeDispatchMinutes(
    nowIso,
    cappedMinutes + stableJitterMinutes(item.id, item.attemptGeneration)
  );
}

export function isReviewPickupOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return item.payload.workSyncIntent === 'review_pickup';
}

export function getProofMissingRecoveryOriginalMessageId(
  item: MemberWorkSyncOutboxItem
): string | null {
  const prefix = 'proof-missing:';
  const intentKey = item.payload.workSyncIntentKey?.trim();
  if (!intentKey?.startsWith(prefix)) {
    return null;
  }

  const originalMessageId = intentKey.slice(prefix.length).trim();
  return originalMessageId.length > 0 ? originalMessageId : null;
}

export function isStatusOnlyRecoveryOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return item.payload.workSyncIntentKey?.startsWith('status-only:') === true;
}

export function isAgendaSyncStillStuckRecoveryOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return (
    item.payload.workSyncIntentKey?.startsWith(AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX) ===
    true
  );
}

export function getPayloadReviewRequestEventIds(item: MemberWorkSyncOutboxItem): string[] {
  return [...new Set(item.payload.workSyncReviewRequestEventIds ?? [])]
    .filter((id) => id.length > 0)
    .sort();
}

function getAgendaReviewPickupRequestEventIds(agenda: MemberWorkSyncAgenda): string[] {
  return [
    ...new Set(
      agenda.items
        .filter(
          (item) =>
            item.kind === 'review' &&
            item.evidence.reviewObligation === 'review_pickup_required' &&
            item.evidence.canBypassPhase2 === true &&
            (item.evidence.reviewDiagnostics?.length ?? 0) === 0
        )
        .map((item) => item.evidence.reviewRequestEventId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ].sort();
}

export function reviewPickupRequestIdsStillMatch(
  item: MemberWorkSyncOutboxItem,
  agenda: MemberWorkSyncAgenda
): boolean {
  const payloadIds = getPayloadReviewRequestEventIds(item);
  const agendaIds = getAgendaReviewPickupRequestEventIds(agenda);
  return payloadIds.length > 0 && payloadIds.every((id) => agendaIds.includes(id));
}

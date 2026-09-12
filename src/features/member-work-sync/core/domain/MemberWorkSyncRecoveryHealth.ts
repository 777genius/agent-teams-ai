import type {
  MemberWorkSyncAutoResumeStopLatch,
  MemberWorkSyncRecoveryEpisode,
  MemberWorkSyncRecoveryHealth,
  MemberWorkSyncRecoveryPhase,
  MemberWorkSyncRecoveryReservation,
} from '../../contracts';

export const MEMBER_WORK_SYNC_RECOVERY_ATTENTION_MS = 20 * 60_000;
export const MEMBER_WORK_SYNC_MAX_AUTOMATIC_CONTINUATIONS = 2;

export function recoveryWorkKey(input: {
  taskId: string;
  assignee: string;
  reviewCycleId?: string;
}): string {
  const cycle = input.reviewCycleId?.trim();
  return cycle
    ? `${input.taskId.trim()}:${input.assignee.trim().toLowerCase()}:${cycle}`
    : `${input.taskId.trim()}:${input.assignee.trim().toLowerCase()}`;
}

export class MemberWorkSyncRecoveryHealthError extends Error {
  constructor() {
    super('Invalid member work sync recovery health');
    this.name = 'MemberWorkSyncRecoveryHealthError';
  }
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const phases: MemberWorkSyncRecoveryPhase[] = [
  'observing',
  'continuation_pending',
  'awaiting_outcome',
  'attention',
  'expected_wait',
];

function readEpisode(value: unknown): MemberWorkSyncRecoveryEpisode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const episode = value as Record<string, unknown>;
  if (
    !identifier(episode.episodeId) ||
    !identifier(episode.workKey) ||
    !identifier(episode.taskId) ||
    !timestamp(episode.firstObservedAt) ||
    !timestamp(episode.dueAt) ||
    typeof episode.reason !== 'string' ||
    !phases.includes(episode.phase as MemberWorkSyncRecoveryPhase) ||
    (episode.lastProgressAt !== undefined && !timestamp(episode.lastProgressAt)) ||
    (episode.lastEvidenceId !== undefined && !identifier(episode.lastEvidenceId))
  ) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  return {
    episodeId: episode.episodeId,
    workKey: episode.workKey,
    taskId: episode.taskId,
    firstObservedAt: episode.firstObservedAt,
    dueAt: episode.dueAt,
    phase: episode.phase as MemberWorkSyncRecoveryPhase,
    reason: episode.reason,
    ...(episode.lastProgressAt ? { lastProgressAt: episode.lastProgressAt } : {}),
    ...(episode.lastEvidenceId ? { lastEvidenceId: episode.lastEvidenceId } : {}),
  };
}

function readControlRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) return Number(value);
  throw new MemberWorkSyncRecoveryHealthError();
}

function readReservation(value: unknown): MemberWorkSyncRecoveryReservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const reservation = value as Record<string, unknown>;
  const controlRevision = readControlRevision(reservation.controlRevision);
  if (
    !identifier(reservation.intentId) ||
    !identifier(reservation.episodeId) ||
    (reservation.trigger !== 'automatic' && reservation.trigger !== 'manual') ||
    !timestamp(reservation.reservedAt) ||
    (reservation.state !== 'reserved' &&
      reservation.state !== 'awaiting_outcome' &&
      reservation.state !== 'resolved' &&
      reservation.state !== 'cancelled' &&
      reservation.state !== 'uncertain') ||
    !identifier(reservation.payloadHash) ||
    controlRevision == null
  ) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const terminalOutcome = reservation.terminalOutcome;
  if (
    terminalOutcome !== undefined &&
    terminalOutcome !== 'retryable_refusal' &&
    terminalOutcome !== 'terminal_refusal' &&
    terminalOutcome !== 'settled' &&
    terminalOutcome !== 'unknown'
  ) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  if (reservation.terminalReceiptId !== undefined && !identifier(reservation.terminalReceiptId)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  if (reservation.ackIdentity !== undefined && !identifier(reservation.ackIdentity)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  if (reservation.pendingAck !== undefined && typeof reservation.pendingAck !== 'boolean') {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  if (reservation.compactWitness !== undefined && typeof reservation.compactWitness !== 'boolean') {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  return {
    intentId: reservation.intentId,
    episodeId: reservation.episodeId,
    trigger: reservation.trigger,
    reservedAt: reservation.reservedAt,
    state: reservation.state,
    payloadHash: reservation.payloadHash,
    controlRevision,
    ...(terminalOutcome ? { terminalOutcome } : {}),
    ...(reservation.terminalReceiptId ? { terminalReceiptId: reservation.terminalReceiptId } : {}),
    ...(reservation.pendingAck ? { pendingAck: true } : {}),
    ...(reservation.ackIdentity ? { ackIdentity: reservation.ackIdentity } : {}),
    ...(reservation.compactWitness ? { compactWitness: true } : {}),
  };
}

function readStopLatch(value: unknown): MemberWorkSyncAutoResumeStopLatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const latch = value as Record<string, unknown>;
  if (
    !timestamp(latch.stoppedAt) ||
    typeof latch.reason !== 'string' ||
    latch.reason.trim() === ''
  ) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  return {
    stoppedAt: latch.stoppedAt,
    reason: latch.reason,
    controlRevision: readControlRevision(latch.controlRevision) ?? 1,
  };
}

export function readMemberWorkSyncRecoveryHealth(
  value: unknown
): MemberWorkSyncRecoveryHealth | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const health = value as Record<string, unknown>;
  if (health.schemaVersion !== 1 || !Array.isArray(health.episodes)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const episodes = health.episodes.map(readEpisode);
  if (
    (health.unresolvedIntentId !== undefined && !identifier(health.unresolvedIntentId)) ||
    (health.attentionAt !== undefined && !timestamp(health.attentionAt)) ||
    (health.attentionAcknowledgedAt !== undefined && !timestamp(health.attentionAcknowledgedAt))
  ) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  const autoResumeStopLatch =
    health.autoResumeStopLatch === undefined
      ? undefined
      : readStopLatch(health.autoResumeStopLatch);
  const controlRevision = readControlRevision(health.controlRevision);
  const reservations = Array.isArray(health.reservations)
    ? health.reservations.map(readReservation)
    : undefined;
  if (health.reservations !== undefined && !Array.isArray(health.reservations)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
  return {
    schemaVersion: 1,
    episodes,
    ...(health.unresolvedIntentId ? { unresolvedIntentId: health.unresolvedIntentId } : {}),
    ...(health.attentionAt ? { attentionAt: health.attentionAt } : {}),
    ...(health.attentionAcknowledgedAt
      ? { attentionAcknowledgedAt: health.attentionAcknowledgedAt }
      : {}),
    ...(autoResumeStopLatch ? { autoResumeStopLatch } : {}),
    ...(controlRevision != null ? { controlRevision } : {}),
    ...(reservations ? { reservations } : {}),
  };
}

export function observeMemberWorkSyncRecoveryHealth(input: {
  previous?: MemberWorkSyncRecoveryHealth;
  nowIso: string;
  nowMs: number;
  items: {
    taskId: string;
    assignee: string;
    kind: string;
    reason: string;
    evidenceStatus?: string;
    reviewCycleId?: string;
  }[];
  expectedWaiting: boolean;
  memberBusy?: boolean | 'unknown';
  instrumentationKnown?: boolean;
}): MemberWorkSyncRecoveryHealth | undefined {
  const runnable = input.items.filter(
    (item) =>
      item.kind === 'work' ||
      item.kind === 'review' ||
      item.kind === 'clarification' ||
      item.kind === 'blocked_dependency'
  );
  if (runnable.length === 0 && !input.previous) return undefined;
  const previousByKey = new Map(
    (input.previous?.episodes ?? []).map((episode) => [episode.workKey, episode])
  );
  const inProgressAssignees = new Set(
    runnable.filter((item) => item.evidenceStatus === 'in_progress').map((item) => item.assignee)
  );
  const episodes: MemberWorkSyncRecoveryEpisode[] = runnable.map((item) => {
    const workKey = recoveryWorkKey(item);
    const existing = previousByKey.get(workKey);
    const evidenceId = item.evidenceStatus;
    const lastTaskEvidenceId = existing?.lastEvidenceId?.startsWith('stall:')
      ? undefined
      : existing?.lastEvidenceId;
    const progressedToActiveWork =
      Boolean(existing) && evidenceId === 'in_progress' && lastTaskEvidenceId !== 'in_progress';
    const remainingExpectedWait =
      input.expectedWaiting ||
      (item.evidenceStatus === 'pending' &&
        (input.memberBusy === true || inProgressAssignees.has(item.assignee)));
    const leavingExpectedWait = existing?.phase === 'expected_wait' && !remainingExpectedWait;
    const existingObservedMs = existing ? Date.parse(existing.firstObservedAt) : Number.NaN;
    const clockRolledBack = Number.isFinite(existingObservedMs) && existingObservedMs > input.nowMs;
    let firstObservedAt =
      progressedToActiveWork || !existing || clockRolledBack
        ? input.nowIso
        : existing.firstObservedAt;
    const firstObservedMs = Date.parse(firstObservedAt);
    if (!Number.isFinite(firstObservedMs) || firstObservedMs > input.nowMs) {
      firstObservedAt = input.nowIso;
    }
    const existingDueMs = existing ? Date.parse(existing.dueAt) : Number.NaN;
    const rebaseDeadline =
      !existing || progressedToActiveWork || leavingExpectedWait || clockRolledBack;
    const dueAtMs =
      rebaseDeadline || !Number.isFinite(existingDueMs)
        ? input.nowMs + MEMBER_WORK_SYNC_RECOVERY_ATTENTION_MS
        : existingDueMs;
    const dueAt = new Date(dueAtMs).toISOString();
    const overdue = input.nowMs >= dueAtMs;
    const classified = classifyRecoveryObservation({
      item,
      expectedWaiting: input.expectedWaiting,
      overdue,
      memberBusy: input.memberBusy,
      hasInProgressSibling: inProgressAssignees.has(item.assignee),
      instrumentationKnown: input.instrumentationKnown !== false,
    });
    const phase: MemberWorkSyncRecoveryPhase = classified.queued
      ? 'expected_wait'
      : input.expectedWaiting
        ? 'expected_wait'
        : overdue
          ? 'attention'
          : progressedToActiveWork
            ? 'observing'
            : existing?.phase === 'attention'
              ? 'attention'
              : 'observing';
    const lastProgressAt = progressedToActiveWork ? input.nowIso : existing?.lastProgressAt;
    const lastEvidenceId = evidenceId ?? existing?.lastEvidenceId;
    return {
      episodeId:
        progressedToActiveWork || !existing || clockRolledBack
          ? `episode:${workKey}:${firstObservedAt}`
          : existing.episodeId,
      workKey,
      taskId: item.taskId,
      firstObservedAt,
      dueAt,
      phase,
      reason: classified.reason,
      ...(lastProgressAt ? { lastProgressAt } : {}),
      ...(lastEvidenceId ? { lastEvidenceId } : {}),
    };
  });
  const attentionAt = episodes.some((episode) => episode.phase === 'attention')
    ? (input.previous?.attentionAt ?? input.nowIso)
    : undefined;
  if (
    episodes.length === 0 &&
    !input.previous?.unresolvedIntentId &&
    !input.previous?.autoResumeStopLatch
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    episodes,
    ...(input.previous?.unresolvedIntentId
      ? { unresolvedIntentId: input.previous.unresolvedIntentId }
      : {}),
    ...(attentionAt ? { attentionAt } : {}),
    ...(input.previous?.attentionAcknowledgedAt
      ? { attentionAcknowledgedAt: input.previous.attentionAcknowledgedAt }
      : {}),
    ...(input.previous?.autoResumeStopLatch
      ? { autoResumeStopLatch: input.previous.autoResumeStopLatch }
      : {}),
    ...(typeof input.previous?.controlRevision === 'number'
      ? { controlRevision: input.previous.controlRevision }
      : {}),
    ...(input.previous?.reservations ? { reservations: input.previous.reservations } : {}),
  };
}

function classifyRecoveryObservation(input: {
  item: { kind: string; reason: string; evidenceStatus?: string };
  expectedWaiting: boolean;
  overdue: boolean;
  memberBusy?: boolean | 'unknown';
  hasInProgressSibling: boolean;
  instrumentationKnown: boolean;
}): { reason: string; queued: boolean } {
  if (input.expectedWaiting) {
    return { reason: 'expected_waiting', queued: false };
  }
  if (
    input.item.evidenceStatus === 'pending' &&
    (input.memberBusy === true || input.hasInProgressSibling)
  ) {
    return { reason: 'queued', queued: true };
  }
  if (input.overdue) {
    return { reason: 'no_progress_deadline', queued: false };
  }
  if (input.item.evidenceStatus === 'pending') {
    if (input.memberBusy === 'unknown' || !input.instrumentationKnown) {
      return { reason: 'no_start_unconfirmed', queued: false };
    }
    return { reason: 'no_start', queued: false };
  }
  if (input.item.evidenceStatus === 'in_progress' && !input.instrumentationKnown) {
    return { reason: 'no_start_unconfirmed', queued: false };
  }
  return { reason: input.item.reason, queued: false };
}

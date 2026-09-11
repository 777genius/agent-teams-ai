import type {
  MemberWorkSyncRecoveryHealth,
  MemberWorkSyncRecoveryReservation,
} from '../../contracts';

export function nextMemberWorkSyncControlRevision(
  health: MemberWorkSyncRecoveryHealth | undefined
): number {
  const current = health?.controlRevision ?? health?.autoResumeStopLatch?.controlRevision ?? 0;
  return current + 1;
}

export function applyMemberWorkSyncStopLatch(input: {
  previous?: MemberWorkSyncRecoveryHealth;
  nowIso: string;
  reason: string;
}): MemberWorkSyncRecoveryHealth {
  const controlRevision = nextMemberWorkSyncControlRevision(input.previous);
  return {
    schemaVersion: 1,
    episodes: input.previous?.episodes ?? [],
    ...(input.previous?.unresolvedIntentId
      ? { unresolvedIntentId: input.previous.unresolvedIntentId }
      : {}),
    ...(input.previous?.attentionAt ? { attentionAt: input.previous.attentionAt } : {}),
    ...(input.previous?.attentionAcknowledgedAt
      ? { attentionAcknowledgedAt: input.previous.attentionAcknowledgedAt }
      : {}),
    ...(input.previous?.reservations ? { reservations: input.previous.reservations } : {}),
    controlRevision,
    autoResumeStopLatch: {
      stoppedAt: input.nowIso,
      reason: input.reason,
      controlRevision,
    },
  };
}

export function clearMemberWorkSyncStopLatch(input: {
  previous?: MemberWorkSyncRecoveryHealth;
}): MemberWorkSyncRecoveryHealth | undefined {
  if (!input.previous) {
    return undefined;
  }
  const controlRevision = nextMemberWorkSyncControlRevision(input.previous);
  const { autoResumeStopLatch: _stopped, ...rest } = input.previous;
  return {
    ...rest,
    schemaVersion: 1,
    episodes: input.previous.episodes,
    controlRevision,
  };
}

export function attachMemberWorkSyncRecoveryReservation(input: {
  previous?: MemberWorkSyncRecoveryHealth;
  reservation: MemberWorkSyncRecoveryReservation;
}): MemberWorkSyncRecoveryHealth {
  const previousReservations = input.previous?.reservations ?? [];
  const reservations = [
    ...previousReservations.filter(
      (reservation) => reservation.intentId !== input.reservation.intentId
    ),
    input.reservation,
  ];
  return {
    schemaVersion: 1,
    episodes: input.previous?.episodes ?? [],
    unresolvedIntentId: input.reservation.intentId,
    ...(input.previous?.attentionAt ? { attentionAt: input.previous.attentionAt } : {}),
    ...(input.previous?.attentionAcknowledgedAt
      ? { attentionAcknowledgedAt: input.previous.attentionAcknowledgedAt }
      : {}),
    ...(input.previous?.autoResumeStopLatch
      ? { autoResumeStopLatch: input.previous.autoResumeStopLatch }
      : {}),
    ...(typeof input.previous?.controlRevision === 'number'
      ? { controlRevision: input.previous.controlRevision }
      : { controlRevision: input.reservation.controlRevision }),
    reservations,
  };
}

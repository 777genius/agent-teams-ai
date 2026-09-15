import { MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT } from './MemberWorkSyncRecoveryHealth';

import type {
  MemberWorkSyncDurableStopReceipt,
  MemberWorkSyncRecoveryHealth,
  MemberWorkSyncRecoveryReservation,
} from '../../contracts';

export function findMemberWorkSyncDurableStopReceipt(
  health: MemberWorkSyncRecoveryHealth | undefined,
  scope: Pick<
    MemberWorkSyncDurableStopReceipt,
    'teamName' | 'memberName' | 'incarnation' | 'runtimeInstanceId' | 'localStopId'
  >
): MemberWorkSyncDurableStopReceipt | undefined {
  return health?.durableStopReceipts?.find(
    (receipt) =>
      receipt.teamName === scope.teamName &&
      receipt.memberName === scope.memberName &&
      receipt.incarnation === scope.incarnation &&
      receipt.runtimeInstanceId === scope.runtimeInstanceId &&
      receipt.localStopId === scope.localStopId
  );
}

export function nextMemberWorkSyncControlRevision(
  health: MemberWorkSyncRecoveryHealth | undefined
): number {
  const current = health?.controlRevision ?? health?.autoResumeStopLatch?.controlRevision ?? 0;
  return current + 1;
}

export function isStaleMemberWorkSyncRecoveryControlRevision(input: {
  health?: MemberWorkSyncRecoveryHealth;
  intentId: string;
}): boolean {
  const currentRevision = input.health?.controlRevision;
  if (currentRevision == null) {
    return false;
  }
  const reservation = input.health?.reservations?.find(
    (candidate) => candidate.intentId === input.intentId
  );
  return reservation != null && reservation.controlRevision < currentRevision;
}

export function applyMemberWorkSyncStopLatch(input: {
  previous?: MemberWorkSyncRecoveryHealth;
  nowIso: string;
  reason: string;
  durableReceipt?: Omit<MemberWorkSyncDurableStopReceipt, 'controlRevision'>;
}): MemberWorkSyncRecoveryHealth {
  const controlRevision = nextMemberWorkSyncControlRevision(input.previous);
  const durableReceipt = input.durableReceipt;
  const durableStopReceipts = durableReceipt
    ? [
        ...(input.previous?.durableStopReceipts ?? []).filter(
          (receipt) =>
            !(
              receipt.teamName === durableReceipt.teamName &&
              receipt.memberName === durableReceipt.memberName &&
              receipt.incarnation === durableReceipt.incarnation &&
              receipt.runtimeInstanceId === durableReceipt.runtimeInstanceId &&
              receipt.localStopId === durableReceipt.localStopId
            )
        ),
        { ...durableReceipt, controlRevision },
      ].slice(-MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT)
    : input.previous?.durableStopReceipts;
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
    ...(durableStopReceipts ? { durableStopReceipts } : {}),
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
    ...(input.previous?.durableStopReceipts
      ? { durableStopReceipts: input.previous.durableStopReceipts }
      : {}),
    ...(typeof input.previous?.controlRevision === 'number'
      ? { controlRevision: input.previous.controlRevision }
      : { controlRevision: input.reservation.controlRevision }),
    reservations,
  };
}

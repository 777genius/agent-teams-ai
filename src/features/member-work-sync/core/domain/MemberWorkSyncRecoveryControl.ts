import { isValidMemberWorkSyncRuntimeControlReason } from '../../contracts';

import {
  MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT,
  MemberWorkSyncRecoveryHealthError,
} from './MemberWorkSyncRecoveryHealth';

import type {
  MemberWorkSyncDurableStopReceipt,
  MemberWorkSyncPendingRuntimeControl,
  MemberWorkSyncRecoveryHealth,
  MemberWorkSyncRecoveryReservation,
  MemberWorkSyncRetiredStopFilter,
} from '../../contracts';

const RETIRED_STOP_FILTER_BITS = 2048;
const RETIRED_STOP_FILTER_HEX_LENGTH = RETIRED_STOP_FILTER_BITS / 4;

type DurableStopScope = Pick<
  MemberWorkSyncDurableStopReceipt,
  'teamName' | 'memberName' | 'incarnation' | 'runtimeInstanceId' | 'localStopId'
>;

function durableStopScopeKey(scope: DurableStopScope): string {
  return JSON.stringify([
    scope.teamName,
    scope.memberName,
    scope.incarnation,
    scope.runtimeInstanceId,
    scope.localStopId,
  ]);
}

function retiredStopIndexes(scope: DurableStopScope): number[] {
  const value = durableStopScopeKey(scope);
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % RETIRED_STOP_FILTER_BITS;
  });
}

function addRetiredStop(
  previous: MemberWorkSyncRetiredStopFilter | undefined,
  scope: DurableStopScope
): MemberWorkSyncRetiredStopFilter {
  const nibbles = [...(previous?.bits ?? '0'.repeat(RETIRED_STOP_FILTER_HEX_LENGTH))];
  for (const index of retiredStopIndexes(scope)) {
    const nibbleIndex = index >>> 2;
    const value = Number.parseInt(nibbles[nibbleIndex] ?? '0', 16) | (1 << (index & 3));
    nibbles[nibbleIndex] = value.toString(16);
  }
  return {
    algorithm: 'fnv1a-2048-v1',
    bits: nibbles.join(''),
    retiredCount: Math.min(Number.MAX_SAFE_INTEGER, (previous?.retiredCount ?? 0) + 1),
  };
}

export function isMemberWorkSyncStopRetired(
  health: MemberWorkSyncRecoveryHealth | undefined,
  scope: DurableStopScope
): boolean {
  const filter = health?.retiredStopFilter;
  if (!filter) return false;
  return retiredStopIndexes(scope).every((index) => {
    const value = Number.parseInt(filter.bits[index >>> 2] ?? '0', 16);
    return (value & (1 << (index & 3))) !== 0;
  });
}

export function isMatchingMemberWorkSyncPendingStop(
  pending: MemberWorkSyncPendingRuntimeControl | undefined,
  scope: DurableStopScope
): pending is MemberWorkSyncPendingRuntimeControl & { localStopId: string; stopped: true } {
  return Boolean(
    pending?.stopped &&
      pending.teamName === scope.teamName &&
      pending.memberName === scope.memberName &&
      pending.incarnation === scope.incarnation &&
      pending.runtimeInstanceId === scope.runtimeInstanceId &&
      pending.localStopId === scope.localStopId
  );
}

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
  assertValidMemberWorkSyncRuntimeControlReason(input.reason);
  const controlRevision = nextMemberWorkSyncControlRevision(input.previous);
  const durableReceipt = input.durableReceipt;
  const receiptsWithNew = durableReceipt
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
      ]
    : input.previous?.durableStopReceipts;
  const retired = receiptsWithNew?.slice(
    0,
    Math.max(0, receiptsWithNew.length - MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT)
  );
  const durableStopReceipts = receiptsWithNew?.slice(-MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT);
  const supersededPendingStop = input.previous?.pendingRuntimeControl;
  const previousRetiredStopFilter =
    supersededPendingStop?.stopped && supersededPendingStop.localStopId
      ? addRetiredStop(input.previous?.retiredStopFilter, {
          teamName: supersededPendingStop.teamName,
          memberName: supersededPendingStop.memberName,
          incarnation: supersededPendingStop.incarnation,
          runtimeInstanceId: supersededPendingStop.runtimeInstanceId,
          localStopId: supersededPendingStop.localStopId,
        })
      : input.previous?.retiredStopFilter;
  const retiredStopFilter =
    retired?.reduce(
      (filter, receipt) => addRetiredStop(filter, receipt),
      previousRetiredStopFilter
    ) ?? previousRetiredStopFilter;
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
    // A newer ordinary Stop supersedes any in-flight runtime control. In particular,
    // a delayed Resume must not remain eligible to clear this newer stop latch.
    ...(retiredStopFilter ? { retiredStopFilter } : {}),
    controlRevision,
    autoResumeStopLatch: {
      stoppedAt: input.nowIso,
      reason: input.reason,
      controlRevision,
    },
  };
}

export function prepareMemberWorkSyncPendingStop(input: {
  previous?: MemberWorkSyncRecoveryHealth;
  checkpoint: Omit<
    MemberWorkSyncPendingRuntimeControl,
    'controlRevision' | 'stopped' | 'previousStopLatch'
  >;
}): MemberWorkSyncRecoveryHealth {
  assertValidMemberWorkSyncRuntimeControlReason(input.checkpoint.reason);
  const controlRevision = nextMemberWorkSyncControlRevision(input.previous);
  const pendingRuntimeControl: MemberWorkSyncPendingRuntimeControl = {
    ...input.checkpoint,
    controlRevision,
    stopped: true,
    ...(input.previous?.autoResumeStopLatch
      ? { previousStopLatch: input.previous.autoResumeStopLatch }
      : {}),
  };
  return {
    ...(input.previous ?? { schemaVersion: 1 as const, episodes: [] }),
    schemaVersion: 1,
    episodes: input.previous?.episodes ?? [],
    controlRevision,
    pendingRuntimeControl,
    autoResumeStopLatch: {
      stoppedAt: pendingRuntimeControl.issuedAt,
      reason: pendingRuntimeControl.reason,
      controlRevision,
    },
  };
}

export function assertValidMemberWorkSyncRuntimeControlReason(
  reason: unknown
): asserts reason is string {
  if (!isValidMemberWorkSyncRuntimeControlReason(reason)) {
    throw new MemberWorkSyncRecoveryHealthError();
  }
}

export function completeMemberWorkSyncPendingStop(input: {
  previous: MemberWorkSyncRecoveryHealth;
  checkpoint: MemberWorkSyncPendingRuntimeControl & { localStopId: string; stopped: true };
  appliedAt: string;
}): MemberWorkSyncRecoveryHealth {
  const receipt: MemberWorkSyncDurableStopReceipt = {
    teamName: input.checkpoint.teamName,
    memberName: input.checkpoint.memberName,
    incarnation: input.checkpoint.incarnation,
    runtimeInstanceId: input.checkpoint.runtimeInstanceId,
    localStopId: input.checkpoint.localStopId,
    appliedAt: input.appliedAt,
    controlRevision: input.checkpoint.controlRevision,
  };
  const receipts = [
    ...(input.previous.durableStopReceipts ?? []).filter(
      (candidate) => durableStopScopeKey(candidate) !== durableStopScopeKey(receipt)
    ),
    receipt,
  ];
  const retired = receipts.slice(
    0,
    Math.max(0, receipts.length - MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT)
  );
  const retiredStopFilter = retired.reduce(
    (filter, candidate) => addRetiredStop(filter, candidate),
    input.previous.retiredStopFilter
  );
  const { pendingRuntimeControl: _pending, ...rest } = input.previous;
  return {
    ...rest,
    durableStopReceipts: receipts.slice(-MEMBER_WORK_SYNC_DURABLE_STOP_RECEIPT_LIMIT),
    ...(retiredStopFilter ? { retiredStopFilter } : {}),
    controlRevision: input.checkpoint.controlRevision,
    autoResumeStopLatch: {
      stoppedAt: input.checkpoint.issuedAt,
      reason: input.checkpoint.reason,
      controlRevision: input.checkpoint.controlRevision,
    },
  };
}

export function abandonMemberWorkSyncPendingStop(input: {
  previous: MemberWorkSyncRecoveryHealth;
  checkpoint: MemberWorkSyncPendingRuntimeControl;
  retire: boolean;
}): MemberWorkSyncRecoveryHealth {
  const { pendingRuntimeControl: _pending, autoResumeStopLatch: _latch, ...rest } = input.previous;
  const retiredStopFilter =
    input.retire && input.checkpoint.localStopId
      ? addRetiredStop(input.previous.retiredStopFilter, {
          teamName: input.checkpoint.teamName,
          memberName: input.checkpoint.memberName,
          incarnation: input.checkpoint.incarnation,
          runtimeInstanceId: input.checkpoint.runtimeInstanceId,
          localStopId: input.checkpoint.localStopId,
        })
      : input.previous.retiredStopFilter;
  return {
    ...rest,
    ...(input.checkpoint.previousStopLatch
      ? { autoResumeStopLatch: input.checkpoint.previousStopLatch }
      : {}),
    ...(retiredStopFilter ? { retiredStopFilter } : {}),
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
    ...(input.previous?.pendingRuntimeControl
      ? { pendingRuntimeControl: input.previous.pendingRuntimeControl }
      : {}),
    ...(input.previous?.retiredStopFilter
      ? { retiredStopFilter: input.previous.retiredStopFilter }
      : {}),
    ...(typeof input.previous?.controlRevision === 'number'
      ? { controlRevision: input.previous.controlRevision }
      : { controlRevision: input.reservation.controlRevision }),
    reservations,
  };
}

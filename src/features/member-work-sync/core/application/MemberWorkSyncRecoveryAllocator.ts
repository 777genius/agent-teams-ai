import { attachMemberWorkSyncRecoveryReservation } from '../domain/MemberWorkSyncRecoveryControl';
import { MEMBER_WORK_SYNC_MAX_AUTOMATIC_CONTINUATIONS } from '../domain/MemberWorkSyncRecoveryHealth';
import { findMemberWorkSyncCompactWitness } from '../domain/MemberWorkSyncRecoveryTerminal';

import {
  commitMemberWorkSyncStatus,
  readMemberWorkSyncStatus,
  runMemberWorkSyncStatusMutation,
} from './MemberWorkSyncStatusMutation';

import type { MemberWorkSyncOutboxEnsureInput, MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export async function reserveMemberWorkSyncRecoveryIntent(input: {
  deps: MemberWorkSyncUseCaseDeps;
  status: MemberWorkSyncStatus;
  recoveryInput: MemberWorkSyncOutboxEnsureInput;
  trigger: 'automatic' | 'manual';
  mutationId?: string;
}): Promise<
  | { ok: true; status: MemberWorkSyncStatus }
  | { ok: false; code: 'member_stopped' | 'slot_occupied' | 'status_missing' }
> {
  return runMemberWorkSyncStatusMutation(input.deps, async (mutationId) => {
    const read = await readMemberWorkSyncStatus(input.deps, {
      teamName: input.status.teamName,
      memberName: input.status.memberName,
    });
    const current = read.status ?? input.status;
    if (current.recoveryHealth?.autoResumeStopLatch) {
      return { ok: false, code: 'member_stopped' };
    }
    const unresolved = current.recoveryHealth?.unresolvedIntentId;
    if (unresolved && unresolved !== input.recoveryInput.id) {
      return { ok: false, code: 'slot_occupied' };
    }
    const witness = findMemberWorkSyncCompactWitness(
      current.recoveryHealth,
      input.recoveryInput.id
    );
    if (witness) {
      return witness.payloadHash === input.recoveryInput.payloadHash
        ? { ok: true, status: current }
        : { ok: false, code: 'slot_occupied' };
    }
    if (unresolved === input.recoveryInput.id) {
      return { ok: true, status: current };
    }
    const blocking = current.recoveryHealth?.reservations?.some(
      (reservation) =>
        reservation.intentId !== input.recoveryInput.id &&
        (reservation.state === 'reserved' ||
          reservation.state === 'awaiting_outcome' ||
          reservation.state === 'uncertain' ||
          reservation.pendingAck === true)
    );
    if (blocking) {
      return { ok: false, code: 'slot_occupied' };
    }
    const nowIso = input.deps.clock.now().toISOString();
    const episodes = current.recoveryHealth?.episodes ?? [];
    const episodeId = episodes[0]?.episodeId ?? `recovery:${nowIso}`;
    if (input.trigger === 'automatic') {
      const coverageStart = [...episodes.map((episode) => episode.firstObservedAt)].sort()[0];
      const automaticAttempts = (current.recoveryHealth?.reservations ?? []).filter(
        (reservation) =>
          reservation.trigger === 'automatic' &&
          (coverageStart === undefined || reservation.reservedAt >= coverageStart)
      ).length;
      if (automaticAttempts >= MEMBER_WORK_SYNC_MAX_AUTOMATIC_CONTINUATIONS) {
        return { ok: false, code: 'slot_occupied' };
      }
    }
    const controlRevision =
      current.recoveryHealth?.controlRevision ??
      current.recoveryHealth?.autoResumeStopLatch?.controlRevision ??
      1;
    const reserved: MemberWorkSyncStatus = {
      ...current,
      recoveryHealth: attachMemberWorkSyncRecoveryReservation({
        previous: current.recoveryHealth,
        reservation: {
          intentId: input.recoveryInput.id,
          episodeId,
          trigger: input.trigger,
          reservedAt: nowIso,
          state: 'reserved',
          payloadHash: input.recoveryInput.payloadHash,
          controlRevision,
        },
      }),
      evaluatedAt: nowIso,
    };
    const committed = await commitMemberWorkSyncStatus(
      input.deps,
      read.status ? read : { status: current },
      reserved,
      mutationId ?? input.mutationId
    );
    return { ok: true, status: committed.status };
  });
}

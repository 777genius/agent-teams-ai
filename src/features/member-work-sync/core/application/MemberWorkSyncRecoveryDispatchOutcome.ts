import {
  applyMemberWorkSyncDeliveredDispatch,
  applyMemberWorkSyncRetryableDispatch,
  applyMemberWorkSyncTerminalAck,
  applyMemberWorkSyncTerminalRetirement,
  findMemberWorkSyncCompactWitness,
} from '../domain/MemberWorkSyncRecoveryTerminal';

import {
  commitMemberWorkSyncStatus,
  readMemberWorkSyncStatus,
  runMemberWorkSyncStatusMutation,
} from './MemberWorkSyncStatusMutation';

import type { MemberWorkSyncOutboxItem, MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export type MemberWorkSyncRecoveryDispatchKind =
  | 'retryable'
  | 'terminal'
  | 'delivered'
  | 'superseded';

async function mutateOwnedReservation(
  deps: MemberWorkSyncUseCaseDeps,
  input: {
    teamName: string;
    memberName: string;
    intentId: string;
    requireCurrentPointer?: boolean;
  },
  next: (status: MemberWorkSyncStatus) => MemberWorkSyncStatus | undefined
): Promise<MemberWorkSyncStatus | undefined> {
  return runMemberWorkSyncStatusMutation(deps, async (mutationId) => {
    const read = await readMemberWorkSyncStatus(deps, input);
    if (!read.status) {
      return undefined;
    }
    const unresolved = read.status.recoveryHealth?.unresolvedIntentId;
    if (input.requireCurrentPointer !== false && unresolved && unresolved !== input.intentId) {
      return read.status;
    }
    const updated = next(read.status);
    if (!updated) {
      return read.status;
    }
    const committed = await commitMemberWorkSyncStatus(deps, read, updated, mutationId);
    return committed.status;
  });
}

export async function recordMemberWorkSyncDispatchOutcome(input: {
  deps: MemberWorkSyncUseCaseDeps;
  item: Pick<MemberWorkSyncOutboxItem, 'teamName' | 'memberName' | 'id' | 'payload'>;
  outcome: MemberWorkSyncRecoveryDispatchKind;
}): Promise<void> {
  if (!input.item.payload.workSyncIntentKey) {
    return;
  }
  await mutateOwnedReservation(
    input.deps,
    {
      teamName: input.item.teamName,
      memberName: input.item.memberName,
      intentId: input.item.id,
    },
    (status) => {
      const health =
        input.outcome === 'delivered'
          ? applyMemberWorkSyncDeliveredDispatch({
              health: status.recoveryHealth,
              intentId: input.item.id,
            })
          : input.outcome === 'terminal' || input.outcome === 'superseded'
            ? applyMemberWorkSyncTerminalRetirement({
                health: status.recoveryHealth,
                intentId: input.item.id,
                receiptId: `dispatch-${input.outcome}:${input.item.id}`,
              })
            : applyMemberWorkSyncRetryableDispatch({
                health: status.recoveryHealth,
                intentId: input.item.id,
              });
      if (!health) {
        return undefined;
      }
      return {
        ...status,
        recoveryHealth: health,
        evaluatedAt: input.deps.clock.now().toISOString(),
      };
    }
  );
}

export async function retireMemberWorkSyncRecoveryIntent(input: {
  deps: MemberWorkSyncUseCaseDeps;
  teamName: string;
  memberName: string;
  intentId: string;
  receiptId: string;
}): Promise<MemberWorkSyncStatus | undefined> {
  return mutateOwnedReservation(input.deps, input, (status) => {
    const health = applyMemberWorkSyncTerminalRetirement({
      health: status.recoveryHealth,
      intentId: input.intentId,
      receiptId: input.receiptId,
    });
    if (!health) {
      return undefined;
    }
    return {
      ...status,
      recoveryHealth: health,
      evaluatedAt: input.deps.clock.now().toISOString(),
    };
  });
}

export async function acknowledgeMemberWorkSyncRecoveryIntent(input: {
  deps: MemberWorkSyncUseCaseDeps;
  teamName: string;
  memberName: string;
  intentId: string;
  ackIdentity: string;
}): Promise<MemberWorkSyncStatus | undefined> {
  return mutateOwnedReservation(
    input.deps,
    {
      teamName: input.teamName,
      memberName: input.memberName,
      intentId: input.intentId,
      requireCurrentPointer: false,
    },
    (status) => {
      const health = applyMemberWorkSyncTerminalAck({
        health: status.recoveryHealth,
        intentId: input.intentId,
        ackIdentity: input.ackIdentity,
      });
      if (!health) {
        return undefined;
      }
      return {
        ...status,
        recoveryHealth: health,
        evaluatedAt: input.deps.clock.now().toISOString(),
      };
    }
  );
}

export function replayMemberWorkSyncCompactWitness(input: {
  status: MemberWorkSyncStatus;
  intentId: string;
  payloadHash: string;
}): 'absent' | 'terminal' | 'conflict' {
  const witness = findMemberWorkSyncCompactWitness(input.status.recoveryHealth, input.intentId);
  if (!witness) {
    return 'absent';
  }
  return witness.payloadHash === input.payloadHash ? 'terminal' : 'conflict';
}

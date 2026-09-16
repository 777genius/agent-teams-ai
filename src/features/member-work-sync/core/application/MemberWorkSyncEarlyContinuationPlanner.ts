import {
  buildMemberWorkSyncAdmissionPayloadHash,
  buildMemberWorkSyncEarlyOutboxEnsureInput,
  buildMemberWorkSyncNudgeId,
  buildMemberWorkSyncNudgePayloadHash,
  isMemberWorkSyncEarlyContinuationEnabled,
} from '../domain';

import {
  EARLY_CONTINUATION_INTENT_PREFIX,
  isOutboxItemAwaitingDelivery,
} from './MemberWorkSyncNudgeOutboxPlanHelpers';
import { hasActiveAcceptedWorkLease } from './MemberWorkSyncNudgeRecoveryPolicy';
import { reserveMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryAllocator';
import { retireMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryDispatchOutcome';
import {
  bindMemberWorkSyncLastSettlementIntent,
  peekMemberWorkSyncLastSettlementBinding,
} from './memberWorkSyncSettlementReplay';

import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncSettlementTrigger } from './MemberWorkSyncReconciler';
import type {
  MemberWorkSyncRuntimeTicket,
  MemberWorkSyncRuntimeTicketAdmissionPort,
  MemberWorkSyncUseCaseDeps,
} from './ports';

interface EarlyContinuationPlanResult {
  planned: boolean;
  code:
    | 'outbox_unavailable'
    | 'status_not_nudgeable'
    | 'member_busy'
    | 'member_stopped'
    | 'early_continuation_disabled'
    | 'early_continuation_rejected'
    | 'slot_occupied'
    | 'payload_conflict'
    | 'created'
    | 'existing';
}

export function buildMemberWorkSyncEarlyContinuationIntentKey(input: {
  agendaFingerprint: string;
  teamIncarnation: string;
  runtimeInstanceId: string;
  completedGeneration: number;
}): string {
  return [
    EARLY_CONTINUATION_INTENT_PREFIX,
    input.teamIncarnation,
    input.agendaFingerprint,
    input.runtimeInstanceId,
    String(input.completedGeneration),
  ].join(':');
}

function resolveTeamIncarnation(status: MemberWorkSyncStatus): string {
  return status.statusRevision?.incarnation ?? 'legacy';
}

function buildEarlyContinuationInput(
  status: MemberWorkSyncStatus,
  baseInput: MemberWorkSyncOutboxEnsureInput,
  hash: MemberWorkSyncUseCaseDeps['hash'],
  settlement: MemberWorkSyncSettlementTrigger
): MemberWorkSyncOutboxEnsureInput {
  const intentKey = buildMemberWorkSyncEarlyContinuationIntentKey({
    agendaFingerprint: status.agenda.fingerprint,
    teamIncarnation: resolveTeamIncarnation(status),
    runtimeInstanceId: settlement.runtimeInstanceId!,
    completedGeneration: settlement.completedGeneration!,
  });
  const payload = {
    ...baseInput.payload,
    workSyncIntentKey: intentKey,
    text: [
      'Early continuation: continue remaining assigned work before the ordinary idle wait.',
      'Call member_work_sync_status, then member_work_sync_report with the returned agendaFingerprint/reportToken.',
      'Do not start a parallel turn if the user, an approval, or an active tool already occupies the runtime.',
      baseInput.payload.text,
    ].join('\n'),
  };
  return {
    ...baseInput,
    id: buildMemberWorkSyncNudgeId({
      teamName: status.teamName,
      memberName: status.memberName,
      agendaFingerprint: status.agenda.fingerprint,
      intentKey,
    }),
    payload,
    payloadHash: buildMemberWorkSyncNudgePayloadHash(hash, payload),
  };
}

function attachRuntimeTicket(
  input: MemberWorkSyncOutboxEnsureInput,
  ticket: MemberWorkSyncRuntimeTicket,
  hash: MemberWorkSyncUseCaseDeps['hash']
): MemberWorkSyncOutboxEnsureInput {
  const payload = {
    ...input.payload,
    workSyncRuntimeTicketId: ticket.ticketId,
    workSyncRuntimeGeneration: ticket.expectedGeneration,
    workSyncRuntimeInstanceId: ticket.runtimeInstanceId,
    workSyncAdmissionPayloadHash: ticket.admissionPayloadHash,
    workSyncTeamIncarnation: ticket.teamIncarnation,
    workSyncControlRevision: ticket.controlRevision,
  };
  return {
    ...input,
    payload,
    payloadHash: buildMemberWorkSyncNudgePayloadHash(hash, payload),
  };
}

function refusalCode(
  code:
    | 'busy'
    | 'user_input'
    | 'approval'
    | 'stopped'
    | 'instance_mismatch'
    | 'conflict'
    | 'unknown'
): Extract<EarlyContinuationPlanResult['code'], string> {
  if (code === 'stopped') {
    return 'member_stopped';
  }
  if (code === 'busy' || code === 'user_input' || code === 'approval') {
    return 'member_busy';
  }
  return 'early_continuation_rejected';
}

async function cancelAdmittedTicket(
  admission: MemberWorkSyncRuntimeTicketAdmissionPort,
  ticket: MemberWorkSyncRuntimeTicket
): Promise<void> {
  await admission.cancel(ticket);
}

export function readMemberWorkSyncRuntimeTicket(
  item: MemberWorkSyncOutboxItem
): MemberWorkSyncRuntimeTicket | null {
  const ticketId = item.payload.workSyncRuntimeTicketId?.trim();
  const generation = item.payload.workSyncRuntimeGeneration;
  const runtimeInstanceId = item.payload.workSyncRuntimeInstanceId?.trim();
  const admissionPayloadHash = item.payload.workSyncAdmissionPayloadHash?.trim();
  if (!ticketId || generation == null || !Number.isInteger(generation) || !runtimeInstanceId) {
    return null;
  }
  return {
    teamName: item.teamName,
    teamIncarnation: item.payload.workSyncTeamIncarnation?.trim() || 'legacy',
    memberName: item.memberName,
    runtimeInstanceId,
    expectedGeneration: generation,
    ticketId,
    intentId: item.id,
    controlRevision: item.payload.workSyncControlRevision ?? 0,
    admissionPayloadHash: admissionPayloadHash ?? item.payloadHash,
  };
}

export { isEarlyContinuationOutboxItem } from './MemberWorkSyncNudgeDispatchPolicy';

export async function insertMemberWorkSyncInboxAfterRuntimeTicket(input: {
  admission?: MemberWorkSyncRuntimeTicketAdmissionPort;
  inbox: MemberWorkSyncUseCaseDeps['inboxNudge'];
  item: MemberWorkSyncOutboxItem;
  nowIso: string;
  shouldAbort: () => boolean | Promise<boolean>;
}): Promise<
  | { status: 'ready'; inserted: boolean; messageId: string }
  | { status: 'busy' }
  | { status: 'stale' }
  | { status: 'stopped' }
  | { status: 'aborted' }
  | { status: 'conflict' }
> {
  if (!input.inbox) {
    return { status: 'stale' };
  }
  if (await input.shouldAbort()) {
    await cancelAdmittedTicketIfPresent(input.admission, input.item);
    return { status: 'aborted' };
  }
  const ticket = readMemberWorkSyncRuntimeTicket(input.item);
  if (ticket && input.admission?.confirmReserved) {
    const confirmed = await input.admission.confirmReserved(ticket);
    if (!confirmed.ok) {
      if (confirmed.code === 'stale') {
        await cancelAdmittedTicketIfPresent(input.admission, input.item);
        return { status: 'stale' };
      }
      return { status: 'busy' };
    }
  }
  const inserted = await input.inbox.insertIfAbsent({
    teamName: input.item.teamName,
    memberName: input.item.memberName,
    messageId: input.item.id,
    payloadHash: input.item.payloadHash,
    payload: input.item.payload,
    timestamp: input.nowIso,
    shouldAbort: input.shouldAbort,
  });
  if (inserted.aborted) {
    await cancelAdmittedTicketIfPresent(input.admission, input.item);
    return { status: 'aborted' };
  }
  if (inserted.conflict) {
    await cancelAdmittedTicketIfPresent(input.admission, input.item);
    return { status: 'conflict' };
  }
  return {
    status: 'ready',
    inserted: inserted.inserted,
    messageId: inserted.messageId,
  };
}

async function cancelAdmittedTicketIfPresent(
  admission: MemberWorkSyncRuntimeTicketAdmissionPort | undefined,
  item: MemberWorkSyncOutboxItem
): Promise<void> {
  const ticket = readMemberWorkSyncRuntimeTicket(item);
  if (!ticket || !admission) {
    return;
  }
  await admission.cancel(ticket);
}

export function hasMemberWorkSyncEarlyContinuationIdentity(
  settlement?: MemberWorkSyncSettlementTrigger
): settlement is MemberWorkSyncSettlementTrigger & {
  runtimeInstanceId: string;
  completedGeneration: number;
} {
  return (
    typeof settlement?.runtimeInstanceId === 'string' &&
    settlement.runtimeInstanceId.trim().length > 0 &&
    typeof settlement.completedGeneration === 'number' &&
    Number.isInteger(settlement.completedGeneration)
  );
}

/** Protocol-2 early continuation. No-ops unless version >= 2 and a ticket port exists. */
export async function planMemberWorkSyncEarlyContinuation(
  deps: MemberWorkSyncUseCaseDeps,
  status: MemberWorkSyncStatus,
  settlement?: MemberWorkSyncSettlementTrigger
): Promise<EarlyContinuationPlanResult> {
  if (!isMemberWorkSyncEarlyContinuationEnabled(deps)) {
    return { planned: false, code: 'early_continuation_disabled' };
  }
  if (!hasMemberWorkSyncEarlyContinuationIdentity(settlement)) {
    return { planned: false, code: 'early_continuation_disabled' };
  }
  if (settlement.outcome && settlement.outcome !== 'success') {
    return { planned: false, code: 'early_continuation_disabled' };
  }
  if (!deps.outboxStore) {
    return { planned: false, code: 'outbox_unavailable' };
  }
  if (status.recoveryHealth?.autoResumeStopLatch) {
    return { planned: false, code: 'member_stopped' };
  }
  if (!hasActiveAcceptedWorkLease(status)) {
    return { planned: false, code: 'early_continuation_disabled' };
  }
  const baseInput = buildMemberWorkSyncEarlyOutboxEnsureInput({
    status,
    hash: deps.hash,
    nowIso: status.evaluatedAt,
  });
  if (!baseInput) {
    return { planned: false, code: 'status_not_nudgeable' };
  }
  const recoveryInput = buildEarlyContinuationInput(status, baseInput, deps.hash, settlement);
  const binding = peekMemberWorkSyncLastSettlementBinding({
    teamName: status.teamName,
    memberName: status.memberName,
  });
  if (
    binding?.boundIntentId &&
    binding.settlement.sourceId === settlement.sourceId &&
    binding.boundIntentId !== recoveryInput.id
  ) {
    return { planned: false, code: 'early_continuation_rejected' };
  }
  const admission = deps.runtimeTicketAdmission!;
  if (admission.readLiveControl) {
    const live = await admission.readLiveControl({
      teamName: status.teamName,
      memberName: status.memberName,
    });
    if (live?.stopped) {
      return { planned: false, code: 'member_stopped' };
    }
  }
  if (admission.syncControl) {
    const handshake = await admission.syncControl({
      teamName: status.teamName,
      memberName: status.memberName,
      teamIncarnation: resolveTeamIncarnation(status),
      runtimeInstanceId: settlement.runtimeInstanceId,
      controlRevision: status.recoveryHealth?.controlRevision ?? 1,
      stopped: false,
    });
    if (!handshake.ok || handshake.code !== 'open') {
      return {
        planned: false,
        code: refusalCode(
          handshake.ok
            ? 'stopped'
            : handshake.code === 'conflict'
              ? 'conflict'
              : handshake.code === 'unknown'
                ? 'unknown'
                : 'instance_mismatch'
        ),
      };
    }
  }
  const admissionPayloadHash = buildMemberWorkSyncAdmissionPayloadHash(
    deps.hash,
    recoveryInput.payload
  );
  const ticket = await admission.admit({
    teamName: status.teamName,
    memberName: status.memberName,
    teamIncarnation: resolveTeamIncarnation(status),
    intentId: recoveryInput.id,
    admissionPayloadHash,
    expectedGeneration: settlement.completedGeneration,
    runtimeInstanceId: settlement.runtimeInstanceId,
    controlRevision: status.recoveryHealth?.controlRevision ?? 1,
    providerId: status.providerId,
  });
  if (!ticket.admitted) {
    if (ticket.code === 'not_early') {
      return { planned: false, code: 'early_continuation_disabled' };
    }
    return { planned: false, code: refusalCode(ticket.code) };
  }
  let persistOutcome: 'none' | 'written' | 'unknown' = 'none';
  try {
    const busy = await deps.busySignal?.isBusy({
      teamName: status.teamName,
      memberName: status.memberName,
      nowIso: status.evaluatedAt,
      workSyncIntent: recoveryInput.payload.workSyncIntent,
      workSyncIntentKey: recoveryInput.payload.workSyncIntentKey,
      taskRefs: recoveryInput.payload.taskRefs,
      exactRuntimeTicket: ticket.ticket,
    });
    if (busy?.busy) {
      await cancelAdmittedTicket(admission, ticket.ticket);
      return { planned: false, code: 'member_busy' };
    }
    const ticketedInput = attachRuntimeTicket(recoveryInput, ticket.ticket, deps.hash);
    const reserved = await reserveMemberWorkSyncRecoveryIntent({
      deps,
      status,
      recoveryInput: ticketedInput,
      trigger: 'automatic',
    });
    if (!reserved.ok) {
      await cancelAdmittedTicket(admission, ticket.ticket);
      return {
        planned: false,
        code: reserved.code === 'member_stopped' ? 'member_stopped' : 'slot_occupied',
      };
    }
    persistOutcome = 'unknown';
    const ensured = await deps.outboxStore.ensurePending(ticketedInput);
    persistOutcome = ensured.ok ? 'written' : 'none';
    if (!ensured.ok) {
      await cancelAdmittedTicket(admission, ticket.ticket);
      await retireMemberWorkSyncRecoveryIntent({
        deps,
        teamName: status.teamName,
        memberName: status.memberName,
        intentId: ticketedInput.id,
        receiptId: `payload-conflict:${ticketedInput.id}`,
      });
      return { planned: false, code: 'payload_conflict' };
    }
    bindMemberWorkSyncLastSettlementIntent({
      teamName: status.teamName,
      memberName: status.memberName,
      intentId: ticketedInput.id,
      settlement,
    });
    return {
      planned: isOutboxItemAwaitingDelivery(ensured.item),
      code: ensured.outcome,
    };
  } catch (error) {
    if (persistOutcome === 'none') {
      await cancelAdmittedTicket(admission, ticket.ticket);
    }
    throw error;
  }
}

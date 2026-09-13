import {
  buildMemberWorkSyncNudgeId,
  buildMemberWorkSyncNudgePayloadHash,
  buildMemberWorkSyncOutboxEnsureInput,
  isMemberWorkSyncEarlyContinuationEnabled,
} from '../domain';

import {
  EARLY_CONTINUATION_INTENT_PREFIX,
  isOutboxItemAwaitingDelivery,
} from './MemberWorkSyncNudgeOutboxPlanHelpers';
import { reserveMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryAllocator';
import { retireMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryDispatchOutcome';

import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';
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

function buildEarlyContinuationInput(
  status: MemberWorkSyncStatus,
  baseInput: MemberWorkSyncOutboxEnsureInput,
  hash: MemberWorkSyncUseCaseDeps['hash']
): MemberWorkSyncOutboxEnsureInput {
  const intentKey = `${EARLY_CONTINUATION_INTENT_PREFIX}:${status.agenda.fingerprint}`;
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
  ticket: { ticketId: string; generation: number },
  hash: MemberWorkSyncUseCaseDeps['hash']
): MemberWorkSyncOutboxEnsureInput {
  const payload = {
    ...input.payload,
    workSyncRuntimeTicketId: ticket.ticketId,
    workSyncRuntimeGeneration: ticket.generation,
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
  ticket: { ticketId: string; generation: number },
  intentId: string
): Promise<void> {
  await admission.cancel({
    ticketId: ticket.ticketId,
    generation: ticket.generation,
    intentId,
  });
}

export function readMemberWorkSyncRuntimeTicket(
  item: MemberWorkSyncOutboxItem
): MemberWorkSyncRuntimeTicket | null {
  const ticketId = item.payload.workSyncRuntimeTicketId?.trim();
  const generation = item.payload.workSyncRuntimeGeneration;
  if (!ticketId || generation == null || !Number.isInteger(generation)) {
    return null;
  }
  return { ticketId, generation, intentId: item.id };
}

export function isEarlyContinuationOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return (
    item.payload.workSyncIntentKey?.startsWith(`${EARLY_CONTINUATION_INTENT_PREFIX}:`) === true
  );
}

export async function startMemberWorkSyncRuntimeTicketForOutboxItem(
  admission: MemberWorkSyncRuntimeTicketAdmissionPort | undefined,
  item: MemberWorkSyncOutboxItem
): Promise<{ ok: true } | { ok: false; code: 'stale' | 'busy' | 'stopped' }> {
  const ticket = readMemberWorkSyncRuntimeTicket(item);
  if (!ticket) {
    return isEarlyContinuationOutboxItem(item) ? { ok: false, code: 'stale' } : { ok: true };
  }
  if (!admission) {
    return { ok: false, code: 'stale' };
  }
  return admission.start(ticket);
}

async function cancelStartedRuntimeTicket(
  admission: MemberWorkSyncRuntimeTicketAdmissionPort | undefined,
  item: MemberWorkSyncOutboxItem
): Promise<void> {
  const ticket = readMemberWorkSyncRuntimeTicket(item);
  if (!ticket || !admission) {
    return;
  }
  await admission.cancel(ticket);
}

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
  const started = await startMemberWorkSyncRuntimeTicketForOutboxItem(input.admission, input.item);
  if (!started.ok) {
    return { status: started.code };
  }
  if (await input.shouldAbort()) {
    await cancelStartedRuntimeTicket(input.admission, input.item);
    return { status: 'aborted' };
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
    await cancelStartedRuntimeTicket(input.admission, input.item);
    return { status: 'aborted' };
  }
  if (inserted.conflict) {
    await cancelStartedRuntimeTicket(input.admission, input.item);
    return { status: 'conflict' };
  }
  return {
    status: 'ready',
    inserted: inserted.inserted,
    messageId: inserted.messageId,
  };
}

/** Protocol-2 early continuation. No-ops unless version >= 2 and a ticket port exists. */
export async function planMemberWorkSyncEarlyContinuation(
  deps: MemberWorkSyncUseCaseDeps,
  status: MemberWorkSyncStatus
): Promise<EarlyContinuationPlanResult> {
  if (!isMemberWorkSyncEarlyContinuationEnabled(deps)) {
    return { planned: false, code: 'early_continuation_disabled' };
  }
  if (!deps.outboxStore) {
    return { planned: false, code: 'outbox_unavailable' };
  }
  if (status.recoveryHealth?.autoResumeStopLatch) {
    return { planned: false, code: 'member_stopped' };
  }
  const baseInput = buildMemberWorkSyncOutboxEnsureInput({
    status,
    hash: deps.hash,
    nowIso: status.evaluatedAt,
  });
  if (!baseInput) {
    return { planned: false, code: 'status_not_nudgeable' };
  }
  const recoveryInput = buildEarlyContinuationInput(status, baseInput, deps.hash);
  const admission = deps.runtimeTicketAdmission!;
  const ticket = await admission.admit({
    teamName: status.teamName,
    memberName: status.memberName,
    intentId: recoveryInput.id,
    payloadHash: recoveryInput.payloadHash,
    controlRevision: status.recoveryHealth?.controlRevision ?? 1,
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
    });
    if (busy?.busy) {
      await cancelAdmittedTicket(admission, ticket, recoveryInput.id);
      return { planned: false, code: 'member_busy' };
    }
    const ticketedInput = attachRuntimeTicket(recoveryInput, ticket, deps.hash);
    const reserved = await reserveMemberWorkSyncRecoveryIntent({
      deps,
      status,
      recoveryInput: ticketedInput,
      trigger: 'automatic',
    });
    if (!reserved.ok) {
      await cancelAdmittedTicket(admission, ticket, ticketedInput.id);
      return {
        planned: false,
        code: reserved.code === 'member_stopped' ? 'member_stopped' : 'slot_occupied',
      };
    }
    persistOutcome = 'unknown';
    const ensured = await deps.outboxStore.ensurePending(ticketedInput);
    persistOutcome = ensured.ok ? 'written' : 'none';
    if (!ensured.ok) {
      await cancelAdmittedTicket(admission, ticket, ticketedInput.id);
      await retireMemberWorkSyncRecoveryIntent({
        deps,
        teamName: status.teamName,
        memberName: status.memberName,
        intentId: ticketedInput.id,
        receiptId: `payload-conflict:${ticketedInput.id}`,
      });
      return { planned: false, code: 'payload_conflict' };
    }
    return {
      planned: isOutboxItemAwaitingDelivery(ensured.item),
      code: ensured.outcome,
    };
  } catch (error) {
    if (persistOutcome === 'none') {
      await cancelAdmittedTicket(admission, ticket, recoveryInput.id);
    }
    throw error;
  }
}

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

import type { MemberWorkSyncOutboxEnsureInput, MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

type EarlyContinuationPlanResult = {
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
};

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
  const busy = await deps.busySignal?.isBusy({
    teamName: status.teamName,
    memberName: status.memberName,
    nowIso: status.evaluatedAt,
    workSyncIntent: baseInput.payload.workSyncIntent,
    workSyncIntentKey: baseInput.payload.workSyncIntentKey,
    taskRefs: baseInput.payload.taskRefs,
  });
  if (busy?.busy) {
    return { planned: false, code: 'member_busy' };
  }
  const recoveryInput = buildEarlyContinuationInput(status, baseInput, deps.hash);
  const ticket = await deps.runtimeTicketAdmission!.admit({
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
  const reserved = await reserveMemberWorkSyncRecoveryIntent({
    deps,
    status,
    recoveryInput,
    trigger: 'automatic',
  });
  if (!reserved.ok) {
    return {
      planned: false,
      code: reserved.code === 'member_stopped' ? 'member_stopped' : 'slot_occupied',
    };
  }
  const ensured = await deps.outboxStore.ensurePending(recoveryInput);
  if (!ensured.ok) {
    return { planned: false, code: 'payload_conflict' };
  }
  return {
    planned: isOutboxItemAwaitingDelivery(ensured.item),
    code: ensured.outcome,
  };
}

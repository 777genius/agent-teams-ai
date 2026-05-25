import { classifyRuntimeDiagnostic } from '../../runtime/RuntimeDiagnosticClassifier';

import {
  isActionRequiredOpenCodeRuntimeDeliveryReason,
  selectOpenCodeRuntimeDeliveryReason,
} from './OpenCodeRuntimeDeliveryDiagnostics';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';
import type {
  MemberRuntimeAdvisory,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
} from '@shared/types';

export const OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS = 120_000;
const OPENCODE_RUNTIME_DELIVERY_PROOF_TIMESTAMP_SKEW_MS = 5_000;

export interface OpenCodeRuntimeDeliveryProofSnapshot {
  latestSuccessAt?: number;
  visibleReplyAt?: number;
  visibleReplyMessageId?: string;
  visibleReplyInbox?: string;
  taskProgressAt?: number;
}

export type OpenCodeRuntimeDeliveryAdvisoryAction = 'suppress' | 'defer' | 'surface';
export type OpenCodeRuntimeDeliveryAdvisorySeverity = 'warning' | 'error';

export interface OpenCodeRuntimeDeliveryAdvisoryDecision {
  action: OpenCodeRuntimeDeliveryAdvisoryAction;
  reason?: string;
  reasonCode?: MemberRuntimeAdvisory['reasonCode'];
  severity?: OpenCodeRuntimeDeliveryAdvisorySeverity;
  observedAt?: string;
  nextReviewAt?: string;
}

const HARD_RUNTIME_RESPONSE_STATES = new Set([
  'session_error',
  'tool_error',
  'permission_blocked',
  'reconcile_failed',
]);

export function classifyOpenCodeRuntimeDeliveryReasonCode(
  message: string | undefined
): MemberRuntimeAdvisory['reasonCode'] {
  return classifyRuntimeDiagnostic(message).reasonCode;
}

export function getOpenCodeRuntimeDeliveryRecordTimeMs(
  record: OpenCodePromptDeliveryLedgerRecord
): number {
  const candidates = [
    record.failedAt,
    record.respondedAt,
    record.lastObservedAt,
    record.updatedAt,
    record.createdAt,
  ];
  for (const candidate of candidates) {
    const time = Date.parse(candidate ?? '');
    if (Number.isFinite(time)) {
      return time;
    }
  }
  return 0;
}

export function getOpenCodeRuntimeDeliveryPromptTimeMs(
  record: OpenCodePromptDeliveryLedgerRecord
): number {
  const candidates = [record.inboxTimestamp, record.acceptedAt, record.createdAt, record.updatedAt];
  for (const candidate of candidates) {
    const time = Date.parse(candidate ?? '');
    if (Number.isFinite(time)) {
      return time;
    }
  }
  return getOpenCodeRuntimeDeliveryRecordTimeMs(record);
}

export function isTerminalSuccessfulOpenCodeDeliveryRecord(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  return (
    record.status === 'responded' &&
    Boolean(record.inboxReadCommittedAt || record.visibleReplyMessageId)
  );
}

export function isPotentialOpenCodeRuntimeDeliveryError(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  const terminalSuccess =
    record.status === 'responded' &&
    Boolean(record.inboxReadCommittedAt || record.visibleReplyMessageId);
  if (
    !terminalSuccess &&
    isActionRequiredOpenCodeRuntimeDeliveryReason(selectOpenCodeRuntimeDeliveryReason(record))
  ) {
    return true;
  }
  if (record.status === 'failed_terminal') {
    return true;
  }
  return (
    record.status !== 'responded' &&
    (record.responseState === 'session_error' ||
      record.responseState === 'tool_error' ||
      record.responseState === 'permission_blocked' ||
      record.responseState === 'reconcile_failed')
  );
}

export function isProofOnlyOpenCodeRuntimeDeliveryReason(
  reason: string | null | undefined
): boolean {
  return (
    classifyOpenCodeRuntimeDeliveryReasonCode(reason ?? undefined) === 'protocol_proof_missing'
  );
}

export function isDeferredGenericOpenCodeRuntimeDeliveryReason(
  reason: string | null | undefined
): boolean {
  const classification = classifyRuntimeDiagnostic(reason);
  return Boolean(classification.normalizedMessage) && classification.generic;
}

export function isHardOpenCodeRuntimeDeliveryReason(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  reason: string | null | undefined;
}): boolean {
  if (isActionRequiredOpenCodeRuntimeDeliveryReason(input.reason)) {
    return true;
  }
  if (input.record.status !== 'failed_terminal') {
    return input.record.responseState === 'permission_blocked';
  }
  if (isDeferredGenericOpenCodeRuntimeDeliveryReason(input.reason)) {
    return false;
  }
  if (input.record.responseState && HARD_RUNTIME_RESPONSE_STATES.has(input.record.responseState)) {
    return true;
  }
  return (
    classifyOpenCodeRuntimeDeliveryReasonCode(input.reason ?? undefined) !==
    'protocol_proof_missing'
  );
}

export function hasSupersedingOpenCodeRuntimeDeliveryProof(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  proof?: OpenCodeRuntimeDeliveryProofSnapshot | null;
}): boolean {
  const proof = input.proof;
  if (!proof) {
    return false;
  }
  const promptTime = getOpenCodeRuntimeDeliveryPromptTimeMs(input.record);
  const isPromptTimeEligible = (proofAt: number): boolean => {
    if (!Number.isFinite(proofAt) || proofAt <= 0) {
      return false;
    }
    if (!Number.isFinite(promptTime) || promptTime <= 0) {
      return true;
    }
    return proofAt + OPENCODE_RUNTIME_DELIVERY_PROOF_TIMESTAMP_SKEW_MS >= promptTime;
  };
  if (typeof proof.visibleReplyAt === 'number' && isPromptTimeEligible(proof.visibleReplyAt)) {
    return true;
  }
  if (typeof proof.taskProgressAt === 'number' && isPromptTimeEligible(proof.taskProgressAt)) {
    return true;
  }
  return false;
}

export function decideOpenCodeRuntimeDeliveryAdvisory(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  proof?: OpenCodeRuntimeDeliveryProofSnapshot | null;
  now?: number;
  graceMs?: number;
}): OpenCodeRuntimeDeliveryAdvisoryDecision {
  const reason = selectOpenCodeRuntimeDeliveryReason(input.record);
  if (!reason) {
    return { action: 'suppress' };
  }
  if (hasSupersedingOpenCodeRuntimeDeliveryProof(input)) {
    return { action: 'suppress' };
  }

  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS;
  const recordTime = getOpenCodeRuntimeDeliveryRecordTimeMs(input.record);
  const observedAt = new Date(
    Number.isFinite(recordTime) && recordTime > 0 ? recordTime : now
  ).toISOString();
  const reasonCode = classifyOpenCodeRuntimeDeliveryReasonCode(reason);

  if (isHardOpenCodeRuntimeDeliveryReason({ record: input.record, reason })) {
    return {
      action: 'surface',
      severity: 'error',
      reason,
      reasonCode,
      observedAt,
    };
  }

  if (input.record.status !== 'failed_terminal') {
    return { action: 'suppress' };
  }

  if (
    reasonCode === 'protocol_proof_missing' ||
    isDeferredGenericOpenCodeRuntimeDeliveryReason(reason)
  ) {
    const terminalAt = getOpenCodeRuntimeDeliveryRecordTimeMs(input.record);
    const nextReviewAtMs =
      Number.isFinite(terminalAt) && terminalAt > 0 ? terminalAt + graceMs : now + graceMs;
    if (now < nextReviewAtMs) {
      return {
        action: 'defer',
        reason,
        reasonCode,
        observedAt,
        nextReviewAt: new Date(nextReviewAtMs).toISOString(),
      };
    }
    return {
      action: 'surface',
      severity: reasonCode === 'protocol_proof_missing' ? 'warning' : 'error',
      reason,
      reasonCode,
      observedAt,
    };
  }

  return {
    action: 'surface',
    severity: 'error',
    reason,
    reasonCode,
    observedAt,
  };
}

export function toOpenCodeRuntimeDeliveryUserVisibleImpact(
  decision: OpenCodeRuntimeDeliveryAdvisoryDecision
): OpenCodeRuntimeDeliveryUserVisibleImpact {
  if (decision.action === 'suppress') {
    return { state: 'none' };
  }
  if (decision.action === 'defer') {
    return {
      state: 'checking',
      reasonCode: decision.reasonCode,
      message: decision.reason,
      observedAt: decision.observedAt,
      nextReviewAt: decision.nextReviewAt,
    };
  }
  return {
    state: decision.severity === 'warning' ? 'warning' : 'error',
    reasonCode: decision.reasonCode,
    message: decision.reason,
    observedAt: decision.observedAt,
    nextReviewAt: decision.nextReviewAt,
  };
}

import { classifyRuntimeDiagnostic } from '../../runtime/RuntimeDiagnosticClassifier';

import {
  isActionRequiredOpenCodeRuntimeDeliveryReason,
  selectOpenCodeRuntimeDeliveryReason,
} from './OpenCodeRuntimeDeliveryDiagnostics';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';
import type {
  MemberRuntimeAdvisory,
  OpenCodeRuntimeDeliveryStatus,
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

export function isOpenCodeAttachmentDeliveryFailureReason(reason: string | undefined): boolean {
  return (
    reason === 'opencode_attachment_delivery_prepare_failed' ||
    reason?.startsWith('attachment_') === true
  );
}

export function selectOpenCodeAttachmentDeliveryUserVisibleMessage(input: {
  reason?: string;
  diagnostics?: string[];
}): string | undefined {
  const reason = input.reason?.trim();
  const diagnosticReasons =
    input.diagnostics
      ?.map((diagnostic) => diagnostic.trim())
      .filter((diagnostic) => diagnostic.startsWith('opencode_attachment_delivery_prepare_failed:'))
      .map((diagnostic) =>
        diagnostic.slice('opencode_attachment_delivery_prepare_failed:'.length).trim()
      )
      .filter(Boolean) ?? [];
  const isAttachmentFailure =
    isOpenCodeAttachmentDeliveryFailureReason(reason) || diagnosticReasons.length > 0;
  if (!isAttachmentFailure) {
    return undefined;
  }

  const reasonCandidates = [reason, ...diagnosticReasons];
  if (reasonCandidates.includes('attachment_model_unsupported')) {
    return 'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.';
  }
  if (reasonCandidates.includes('attachment_type_unsupported')) {
    return 'This OpenCode model cannot receive this attachment type. Remove the attachment or choose a supported image model.';
  }
  if (reasonCandidates.includes('attachment_too_large')) {
    return 'The attachment is too large for live OpenCode delivery. Reduce the image size or remove the attachment.';
  }
  if (
    reasonCandidates.includes('attachment_artifact_missing') ||
    reasonCandidates.includes('attachment_artifact_path_unsafe')
  ) {
    return 'The attachment file is not available for live OpenCode delivery. Reattach the file and try again.';
  }
  if (reasonCandidates.includes('attachment_optimization_failed')) {
    return 'The attachment could not be optimized for live OpenCode delivery. Try a smaller image or remove the attachment.';
  }
  if (reasonCandidates.includes('attachment_provider_rejected')) {
    return 'The OpenCode provider rejected the attachment. Choose a different model or remove the attachment.';
  }
  if (reasonCandidates.includes('attachment_runtime_transport_failed')) {
    return 'OpenCode could not transport the attachment to the runtime. Try again or remove the attachment.';
  }
  return 'OpenCode could not prepare the attachment for live delivery. Remove the attachment or try again.';
}

export function selectOpenCodeRuntimeDeliveryUserVisibleMessage(input: {
  reason?: string;
  diagnostics?: string[];
}): string | undefined {
  return selectOpenCodeAttachmentDeliveryUserVisibleMessage(input) ?? input.reason;
}

export function buildOpenCodeRuntimeDeliveryUserVisibleImpact(input: {
  delivered?: boolean;
  responsePending?: boolean;
  acceptanceUnknown?: boolean;
  responseState?: OpenCodePromptDeliveryLedgerRecord['responseState'];
  ledgerStatus?: OpenCodePromptDeliveryLedgerRecord['status'];
  reason?: string;
  diagnostics?: string[];
  queuedBehindMessageId?: string;
  policyImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
}): OpenCodeRuntimeDeliveryUserVisibleImpact {
  if (input.policyImpact) {
    return input.policyImpact;
  }
  if (
    input.responsePending === true ||
    input.acceptanceUnknown === true ||
    Boolean(input.queuedBehindMessageId)
  ) {
    return {
      state: 'checking',
      reasonCode: input.reason
        ? classifyOpenCodeRuntimeDeliveryReasonCode(input.reason)
        : undefined,
      message: selectOpenCodeRuntimeDeliveryUserVisibleMessage(input),
    };
  }
  if (input.delivered === false) {
    const reason = input.reason ?? input.diagnostics?.find((diagnostic) => diagnostic.trim());
    if (
      input.ledgerStatus === 'failed_terminal' &&
      isDeferredGenericOpenCodeRuntimeDeliveryReason(reason)
    ) {
      return {
        state: 'checking',
        reasonCode: classifyOpenCodeRuntimeDeliveryReasonCode(reason),
        message: selectOpenCodeRuntimeDeliveryUserVisibleMessage(input),
      };
    }
    return {
      state: 'error',
      reasonCode: classifyOpenCodeRuntimeDeliveryReasonCode(reason),
      message: selectOpenCodeRuntimeDeliveryUserVisibleMessage(input),
    };
  }
  return input.policyImpact ?? { state: 'none' };
}

export function toOpenCodeRuntimeDeliveryStatus(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  decision?: OpenCodeRuntimeDeliveryAdvisoryDecision;
}): OpenCodeRuntimeDeliveryStatus {
  const failed = input.record.status === 'failed_terminal';
  const accepted = hasOpenCodeRuntimeDeliveryAcceptanceProof(input.record);
  const responded =
    input.record.status === 'responded' &&
    Boolean(input.record.inboxReadCommittedAt || input.record.visibleReplyMessageId);
  const policyImpact = input.decision
    ? toOpenCodeRuntimeDeliveryUserVisibleImpact(input.decision)
    : undefined;
  const userVisibleImpact = buildOpenCodeRuntimeDeliveryUserVisibleImpact({
    delivered: !failed,
    responsePending: !failed && !responded,
    acceptanceUnknown: input.record.acceptanceUnknown,
    responseState: input.record.responseState,
    ledgerStatus: input.record.status,
    reason: input.record.lastReason ?? undefined,
    diagnostics: input.record.diagnostics,
    policyImpact,
  });
  return {
    messageId: input.record.inboxMessageId,
    providerId: 'opencode',
    attempted: true,
    delivered: !failed,
    accepted,
    responsePending: !failed && !responded,
    responseState: input.record.responseState,
    ledgerStatus: input.record.status,
    visibleReplyMessageId: input.record.visibleReplyMessageId ?? undefined,
    visibleReplyCorrelation: input.record.visibleReplyCorrelation ?? undefined,
    ledgerRecordId: input.record.id,
    laneId: input.record.laneId,
    acceptanceUnknown: input.record.acceptanceUnknown,
    reason: input.record.lastReason ?? undefined,
    diagnostics: input.record.diagnostics,
    userVisibleImpact,
  };
}

function hasOpenCodeRuntimeDeliveryAcceptanceProof(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  return Boolean(
    record.status === 'accepted' ||
    record.status === 'responded' ||
    record.status === 'unanswered' ||
    record.acceptedAt ||
    record.deliveredUserMessageId?.trim() ||
    record.runtimePromptMessageId?.trim() ||
    record.lastRuntimePromptMessageId?.trim() ||
    record.visibleReplyMessageId?.trim() ||
    record.runtimePromptMessageIds?.some((messageId) => messageId.trim())
  );
}

export function getOpenCodeRuntimeDeliveryAdvisoryReasonKey(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  decision?: OpenCodeRuntimeDeliveryAdvisoryDecision;
}): string {
  const reason =
    input.decision?.reason ??
    selectOpenCodeRuntimeDeliveryReason(input.record) ??
    input.record.responseState ??
    input.record.status;
  const action = input.decision
    ? `${input.decision.action}:${input.decision.severity ?? 'none'}`
    : 'record:none';
  const normalized = reason
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `${action}:${normalized || 'unknown'}`;
}

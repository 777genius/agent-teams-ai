import {
  isOpenCodeVisibleReplySemanticallySufficient,
  type OpenCodeVisibleReplyProof,
} from './OpenCodePromptDeliveryWatchdog';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';
import type { InboxMessage, TaskRef } from '@shared/types';

export function normalizeOpenCodeRuntimeDeliveryToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function isOpenCodeLeadReplyRecipientAlias(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return (
    normalized === 'lead' ||
    normalized === 'team-lead' ||
    normalized === 'teamlead' ||
    normalized === 'team-leader'
  );
}

export function getOpenCodeVisibleReplyInboxCandidates(input: {
  replyRecipient?: string | null;
  configuredLeadName?: string | null;
  includeUserFallbackForLeadRecipient?: boolean;
}): string[] {
  const explicitRecipient = input.replyRecipient?.trim() || 'user';
  const candidates = [explicitRecipient];
  const configuredLeadName = input.configuredLeadName?.trim() || null;
  const isConfiguredLeadRecipient =
    Boolean(configuredLeadName) &&
    configuredLeadName?.toLowerCase() === explicitRecipient.toLowerCase();

  if (isOpenCodeLeadReplyRecipientAlias(explicitRecipient) || isConfiguredLeadRecipient) {
    if (configuredLeadName) {
      candidates.push(configuredLeadName);
    }
    candidates.push('lead');
    candidates.push('team-lead');
    if (input.includeUserFallbackForLeadRecipient) {
      candidates.push('user');
    }
  }

  return candidates
    .filter((value): value is string => Boolean(value?.trim()))
    .filter(
      (value, index, list) =>
        list.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index
    );
}

export function isOpenCodeVisibleReplyTimestampEligible(input: {
  message: Pick<InboxMessage, 'timestamp'>;
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
}): boolean {
  const messageMs = Date.parse(input.message.timestamp);
  const inboxMs = Date.parse(input.ledgerRecord.inboxTimestamp);
  if (!Number.isFinite(messageMs) || !Number.isFinite(inboxMs)) {
    return true;
  }
  return messageMs + 5_000 >= inboxMs;
}

export function normalizeOpenCodeTaskRefsForComparison(
  taskRefs: readonly TaskRef[] | undefined
): TaskRef[] {
  if (!Array.isArray(taskRefs)) {
    return [];
  }
  const normalized: TaskRef[] = [];
  for (const rawTaskRef of taskRefs as readonly unknown[]) {
    if (!rawTaskRef || typeof rawTaskRef !== 'object') {
      continue;
    }
    const taskRef = rawTaskRef as Record<string, unknown>;
    const teamName = typeof taskRef.teamName === 'string' ? taskRef.teamName.trim() : '';
    const taskId = typeof taskRef.taskId === 'string' ? taskRef.taskId.trim() : '';
    const displayId = typeof taskRef.displayId === 'string' ? taskRef.displayId.trim() : '';
    if (teamName && taskId && displayId) {
      normalized.push({ teamName, taskId, displayId });
    }
  }
  return normalized;
}

export function openCodeTaskRefKey(taskRef: TaskRef): string {
  return `${taskRef.teamName.trim()}\u0000${taskRef.taskId.trim()}\u0000${taskRef.displayId.trim()}`;
}

export function openCodeTaskRefsIncludeAll(
  actual: readonly TaskRef[] | undefined,
  expected: readonly TaskRef[] | undefined
): boolean {
  const normalizedExpected = normalizeOpenCodeTaskRefsForComparison(expected);
  if (normalizedExpected.length === 0) {
    return true;
  }
  const actualKeys = new Set(
    normalizeOpenCodeTaskRefsForComparison(actual).map((taskRef) => openCodeTaskRefKey(taskRef))
  );
  return normalizedExpected.every((taskRef) => actualKeys.has(openCodeTaskRefKey(taskRef)));
}

export function isOpenCodeRecoveredVisibleReplyCandidate(input: {
  message: InboxMessage & { messageId: string };
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  from: string;
  requireTaskRefs: boolean;
}): boolean {
  const expectedFrom = normalizeOpenCodeRuntimeDeliveryToken(input.from);
  if (!expectedFrom || normalizeOpenCodeRuntimeDeliveryToken(input.message.from) !== expectedFrom) {
    return false;
  }
  if (input.message.source !== undefined && input.message.source !== 'runtime_delivery') {
    return false;
  }
  if (
    input.requireTaskRefs &&
    !openCodeTaskRefsIncludeAll(input.message.taskRefs, input.ledgerRecord.taskRefs)
  ) {
    return false;
  }
  if (
    !isOpenCodeVisibleReplyTimestampEligible({
      message: input.message,
      ledgerRecord: input.ledgerRecord,
    })
  ) {
    return false;
  }
  return isOpenCodeVisibleReplySemanticallySufficient({
    actionMode: input.ledgerRecord.actionMode,
    taskRefs: input.ledgerRecord.taskRefs,
    text: input.message.text,
    summary: input.message.summary,
  }).sufficient;
}

export function getOpenCodeRuntimeDeliveryMessageTimeMs(
  message: Pick<InboxMessage, 'timestamp'>
): number {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : 0;
}

export function isOpenCodeVisibleReplyProofSufficient(input: {
  proof: OpenCodeVisibleReplyProof;
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
}): boolean {
  return (
    isOpenCodeRecoveredVisibleReplyCandidate({
      message: input.proof.message,
      ledgerRecord: input.ledgerRecord,
      from: input.ledgerRecord.memberName,
      requireTaskRefs: false,
    }) && openCodeTaskRefsIncludeAll(input.proof.message.taskRefs, input.ledgerRecord.taskRefs)
  );
}

import type { OpenCodeMemberInboxDelivery } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { OpenCodePromptDeliveryLedgerRecord } from '../opencode/delivery/OpenCodePromptDeliveryLedger';

export interface OpenCodeMemberInboxRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: OpenCodeMemberInboxDelivery;
  diagnostics?: string[];
}

export function createOpenCodeMemberInboxRelayResult(
  overrides: Partial<OpenCodeMemberInboxRelayResult> = {}
): OpenCodeMemberInboxRelayResult {
  return {
    relayed: 0,
    attempted: 0,
    delivered: 0,
    failed: 0,
    ...overrides,
  };
}

export function dedupeOpenCodeMemberInboxRelayDiagnostics(
  result: OpenCodeMemberInboxRelayResult
): OpenCodeMemberInboxRelayResult {
  if (!result.diagnostics?.length) {
    return result;
  }
  return {
    ...result,
    diagnostics: [...new Set(result.diagnostics)],
  };
}

export function buildOpenCodeMemberInboxRelayTimeoutResult(input: {
  diagnostic: string;
  attempted: number;
}): OpenCodeMemberInboxRelayResult {
  return createOpenCodeMemberInboxRelayResult({
    attempted: input.attempted,
    failed: 1,
    lastDelivery: {
      delivered: false,
      accepted: false,
      responsePending: false,
      reason: 'opencode_member_inbox_relay_timed_out',
      diagnostics: [input.diagnostic],
    },
    diagnostics: [input.diagnostic],
  });
}

export function buildOpenCodeMemberInboxRelaySupersededResult(
  relayKey: string
): OpenCodeMemberInboxRelayResult {
  const diagnostic = `opencode_member_inbox_relay_superseded: ${relayKey}`;
  return createOpenCodeMemberInboxRelayResult({
    lastDelivery: {
      delivered: false,
      accepted: false,
      responsePending: false,
      reason: 'opencode_member_inbox_relay_superseded',
      diagnostics: [diagnostic],
    },
    diagnostics: [diagnostic],
  });
}

export function buildOpenCodeMemberInboxAlreadyReadResult(
  record?: OpenCodePromptDeliveryLedgerRecord | null
): OpenCodeMemberInboxRelayResult {
  const committed = Boolean(record?.inboxReadCommittedAt);
  const diagnostics = [
    committed ? 'opencode_inbox_read_already_committed' : 'opencode_inbox_message_already_read',
  ];
  return createOpenCodeMemberInboxRelayResult({
    attempted: 1,
    delivered: 1,
    lastDelivery: {
      delivered: true,
      ...(committed ? { accepted: true, responsePending: false } : {}),
      ...(record?.responseState ? { responseState: record.responseState } : {}),
      ...(record?.status ? { ledgerStatus: record.status } : {}),
      ...(record?.id ? { ledgerRecordId: record.id } : {}),
      ...(record?.laneId ? { laneId: record.laneId } : {}),
      ...(record?.visibleReplyMessageId
        ? { visibleReplyMessageId: record.visibleReplyMessageId }
        : {}),
      ...(record?.visibleReplyCorrelation
        ? { visibleReplyCorrelation: record.visibleReplyCorrelation }
        : {}),
      reason: diagnostics[0],
      diagnostics,
    },
    diagnostics,
  });
}

export function buildOpenCodeMemberInboxMessageMissingResult(input: {
  messageId: string;
  reason: 'opencode_inbox_message_missing' | 'opencode_inbox_message_missing_after_inflight_relay';
}): OpenCodeMemberInboxRelayResult {
  const diagnostic = `${input.reason}: ${input.messageId}`;
  return createOpenCodeMemberInboxRelayResult({
    attempted: 1,
    failed: 1,
    lastDelivery: {
      delivered: false,
      reason: input.reason,
      diagnostics: [diagnostic],
    },
    diagnostics: [diagnostic],
  });
}

export function buildOpenCodeMemberWorkSyncReadWaitingResult(
  messageId: string
): OpenCodeMemberInboxRelayResult {
  const diagnostic = `opencode_work_sync_read_commit_waiting_for_active_relay: ${messageId}`;
  return createOpenCodeMemberInboxRelayResult({
    attempted: 1,
    lastDelivery: {
      delivered: true,
      accepted: false,
      responsePending: true,
      reason: 'opencode_work_sync_read_commit_waiting_for_active_relay',
      diagnostics: [diagnostic],
    },
    diagnostics: [diagnostic],
  });
}

export function buildOpenCodeMemberInboxQueuedBehindResult(input: {
  relayKey: string;
  messageId: string;
}): OpenCodeMemberInboxRelayResult {
  const diagnostic = `opencode_inbox_relay_queued_behind_active_relay: ${input.relayKey}/${input.messageId}`;
  return createOpenCodeMemberInboxRelayResult({
    attempted: 1,
    lastDelivery: {
      delivered: true,
      accepted: false,
      responsePending: true,
      queuedBehindMessageId: input.messageId,
      reason: 'opencode_inbox_relay_queued_behind_active_relay',
      diagnostics: [diagnostic],
    },
    diagnostics: [diagnostic],
  });
}

export function buildOpenCodeInboxReadFailedResult(
  diagnostic: string
): OpenCodeMemberInboxRelayResult {
  return createOpenCodeMemberInboxRelayResult({
    lastDelivery: {
      delivered: false,
      reason: 'opencode_inbox_read_failed',
      diagnostics: [diagnostic],
    },
    diagnostics: [diagnostic],
  });
}

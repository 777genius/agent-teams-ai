import {
  hashOpenCodePromptDeliveryPayload,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import { isOpenCodeAttachmentDeliveryFailureReason } from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import {
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  hasStableInboxMessageId,
  type RelayInboxMessage,
  selectOpenCodeInboxRelayBatch,
} from './TeamProvisioningInboxRelayPolicy';
import { type OpenCodeInboxAttachmentPayloadsResult } from './TeamProvisioningOpenCodeAttachmentPayloads';

import type {
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliverySource,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { AgentActionMode, InboxMessage, TaskRef } from '@shared/types';

export interface OpenCodeMemberInboxRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: OpenCodeMemberInboxDelivery;
  diagnostics?: string[];
}

export interface OpenCodeMemberInboxRelayOptions {
  onlyMessageId?: string;
  source?: OpenCodeMemberMessageDeliverySource;
  deliveryMetadata?: {
    replyRecipient?: string;
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
  };
}

export interface OpenCodeMemberInboxRelayDeliveryDecision {
  replyRecipient: string;
  actionMode: AgentActionMode | null;
  taskRefs: TaskRef[];
  source: OpenCodeMemberMessageDeliverySource;
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

export function buildOpenCodeMemberInboxAlreadyReadResult(): OpenCodeMemberInboxRelayResult {
  return createOpenCodeMemberInboxRelayResult({
    attempted: 1,
    delivered: 1,
    lastDelivery: { delivered: true },
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

export function selectOpenCodeMemberInboxRelayUnreadMessages(input: {
  inboxMessages: readonly InboxMessage[];
  onlyMessageId?: string;
  maxRelay?: number;
}): RelayInboxMessage[] {
  const onlyMessageId = input.onlyMessageId?.trim();
  return selectOpenCodeInboxRelayBatch(
    input.inboxMessages.filter((message): message is RelayInboxMessage => {
      if (onlyMessageId && message.messageId !== onlyMessageId) return false;
      if (message.read && (!onlyMessageId || message.messageKind !== 'member_work_sync_nudge')) {
        return false;
      }
      if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
      return hasStableInboxMessageId(message);
    }),
    input.maxRelay ?? DEFAULT_INBOX_RELAY_BATCH_SIZE
  );
}

export function resolveOpenCodeMemberInboxDeliveryDecision(input: {
  memberName: string;
  message: RelayInboxMessage;
  existingRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  deliveryMetadata?: OpenCodeMemberInboxRelayOptions['deliveryMetadata'];
  inferredTaskRefs: TaskRef[];
  source?: OpenCodeMemberMessageDeliverySource;
}): OpenCodeMemberInboxRelayDeliveryDecision {
  const fallbackReplyRecipient =
    typeof input.message.from === 'string' &&
    input.message.from.trim() &&
    input.message.from.trim().toLowerCase() !== input.memberName.trim().toLowerCase()
      ? input.message.from.trim()
      : 'user';
  const existingTaskRefs = input.existingRecord?.taskRefs?.length
    ? input.existingRecord.taskRefs
    : undefined;
  const metadataTaskRefs = input.deliveryMetadata?.taskRefs?.length
    ? input.deliveryMetadata.taskRefs
    : undefined;
  const messageTaskRefs = input.message.taskRefs?.length ? input.message.taskRefs : undefined;

  return {
    replyRecipient:
      input.existingRecord?.replyRecipient ??
      input.deliveryMetadata?.replyRecipient ??
      fallbackReplyRecipient,
    actionMode:
      input.existingRecord?.actionMode ??
      input.deliveryMetadata?.actionMode ??
      input.message.actionMode ??
      null,
    taskRefs: existingTaskRefs ?? metadataTaskRefs ?? messageTaskRefs ?? input.inferredTaskRefs,
    source: input.existingRecord?.source ?? input.source ?? 'watcher',
  };
}

export async function handleOpenCodeInboxAttachmentFailure(input: {
  teamName: string;
  canonicalMemberName: string;
  laneId: string;
  message: RelayInboxMessage;
  existingRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  decision: OpenCodeMemberInboxRelayDeliveryDecision;
  attachmentPayloads: Extract<OpenCodeInboxAttachmentPayloadsResult, { ok: false }>;
  ports: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
    markFailedTerminal(input: {
      ledger: OpenCodePromptDeliveryLedgerStore;
      id: string;
      reason: string;
      diagnostics?: string[];
      failedAt: string;
      eventContext?: Record<string, unknown>;
    }): Promise<OpenCodePromptDeliveryLedgerRecord>;
    logPromptDeliveryEvent(
      event: string,
      record: OpenCodePromptDeliveryLedgerRecord,
      extra?: Record<string, unknown>
    ): void;
    nowIso(): string;
    getErrorMessage(error: unknown): string;
  };
}): Promise<OpenCodeMemberInboxRelayResult> {
  let failedRecord: OpenCodePromptDeliveryLedgerRecord | null = null;
  const diagnostics: string[] = [];
  try {
    const markedAt = input.ports.nowIso();
    const pendingRecord =
      input.existingRecord ??
      (await input.ports.ledger.ensurePending({
        teamName: input.teamName,
        memberName: input.canonicalMemberName,
        laneId: input.laneId,
        runId: await input.ports.resolveCurrentOpenCodeRuntimeRunId(input.teamName, input.laneId),
        inboxMessageId: input.message.messageId,
        inboxTimestamp: input.message.timestamp,
        source: input.decision.source,
        replyRecipient: input.decision.replyRecipient,
        actionMode: input.decision.actionMode ?? null,
        messageKind: input.message.messageKind ?? null,
        workSyncIntent: input.message.workSyncIntent ?? null,
        taskRefs: input.decision.taskRefs,
        payloadHash: hashOpenCodePromptDeliveryPayload({
          text: input.message.text,
          replyRecipient: input.decision.replyRecipient,
          actionMode: input.decision.actionMode ?? null,
          taskRefs: input.decision.taskRefs,
          attachments: input.message.attachments,
          source: input.decision.source,
        }),
        now: markedAt,
      }));
    if (pendingRecord.createdAt === markedAt) {
      input.ports.logPromptDeliveryEvent('opencode_prompt_delivery_ledger_created', pendingRecord);
    }
    failedRecord = await input.ports.markFailedTerminal({
      ledger: input.ports.ledger,
      id: pendingRecord.id,
      reason: input.attachmentPayloads.reason,
      diagnostics: input.attachmentPayloads.diagnostics,
      failedAt: input.ports.nowIso(),
      eventContext: { attachmentPayloadUnavailable: true },
    });
  } catch (error) {
    diagnostics.push(
      `opencode_inbox_attachment_terminal_ledger_failed: ${input.ports.getErrorMessage(error)}`
    );
  }

  return createOpenCodeMemberInboxRelayResult({
    failed: 1,
    diagnostics: [...diagnostics, ...input.attachmentPayloads.diagnostics],
    lastDelivery: {
      delivered: false,
      reason: input.attachmentPayloads.reason,
      accepted: false,
      ledgerStatus: failedRecord?.status,
      ledgerRecordId: failedRecord?.id,
      laneId: input.laneId,
      diagnostics: input.attachmentPayloads.diagnostics,
    },
  });
}

export function projectOpenCodeInboxDeliveryFailure(input: {
  delivery: OpenCodeMemberInboxDelivery;
  suppressRuntimeInactiveWarning: boolean;
}): {
  result: OpenCodeMemberInboxRelayResult;
  shouldLogWarning: boolean;
} {
  if (input.delivery.accepted === true) {
    const diagnostics = input.delivery.diagnostics ?? [
      input.delivery.reason ?? 'opencode_delivery_response_pending',
    ];
    return {
      result: createOpenCodeMemberInboxRelayResult({
        diagnostics,
        lastDelivery: {
          ...input.delivery,
          diagnostics,
        },
      }),
      shouldLogWarning: false,
    };
  }

  const diagnostics = input.delivery.diagnostics ?? [
    input.delivery.reason ?? 'opencode_message_delivery_failed',
  ];
  return {
    result: createOpenCodeMemberInboxRelayResult({
      failed: 1,
      diagnostics,
      lastDelivery: input.delivery,
    }),
    shouldLogWarning:
      !isOpenCodeAttachmentDeliveryFailureReason(input.delivery.reason) &&
      (input.delivery.reason !== 'opencode_runtime_not_active' ||
        !input.suppressRuntimeInactiveWarning),
  };
}

export async function commitOpenCodeInboxRelayReadAfterDelivery(input: {
  teamName: string;
  memberName: string;
  message: RelayInboxMessage;
  delivery: OpenCodeMemberInboxDelivery;
  ports: {
    markInboxMessagesRead(
      teamName: string,
      memberName: string,
      messages: RelayInboxMessage[]
    ): Promise<void>;
    createOpenCodePromptDeliveryLedger(
      teamName: string,
      laneId: string
    ): OpenCodePromptDeliveryLedgerStore;
    logPromptDeliveryEvent(
      event: string,
      record: OpenCodePromptDeliveryLedgerRecord,
      extra?: Record<string, unknown>
    ): void;
    nowIso(): string;
    getErrorMessage(error: unknown): string;
  };
}): Promise<
  { ok: true } | { ok: false; result: OpenCodeMemberInboxRelayResult; diagnostic: string }
> {
  try {
    await input.ports.markInboxMessagesRead(input.teamName, input.memberName, [input.message]);
    if (input.delivery.ledgerRecordId && input.delivery.laneId) {
      const committed = await input.ports
        .createOpenCodePromptDeliveryLedger(input.teamName, input.delivery.laneId)
        .markInboxReadCommitted({
          id: input.delivery.ledgerRecordId,
          committedAt: input.ports.nowIso(),
        });
      input.ports.logPromptDeliveryEvent(
        'opencode_prompt_delivery_inbox_committed_read',
        committed
      );
    }
    return { ok: true };
  } catch (error) {
    const diagnostic = `opencode_inbox_mark_read_failed_after_delivery: ${input.ports.getErrorMessage(
      error
    )}`;
    if (input.delivery.ledgerRecordId && input.delivery.laneId) {
      const failedCommit = await input.ports
        .createOpenCodePromptDeliveryLedger(input.teamName, input.delivery.laneId)
        .markInboxReadCommitFailed({
          id: input.delivery.ledgerRecordId,
          error: diagnostic,
          failedAt: input.ports.nowIso(),
        });
      input.ports.logPromptDeliveryEvent(
        'opencode_prompt_delivery_response_observed',
        failedCommit,
        { inboxReadCommitError: diagnostic }
      );
    }
    return {
      ok: false,
      diagnostic,
      result: createOpenCodeMemberInboxRelayResult({
        failed: 1,
        lastDelivery: {
          delivered: false,
          reason: 'opencode_inbox_mark_read_failed_after_delivery',
          diagnostics: [diagnostic],
        },
        diagnostics: [diagnostic],
      }),
    };
  }
}

import { stableHash } from '../bridge/OpenCodeBridgeCommandContract';
import { VersionedJsonStore, VersionedJsonStoreError } from '../store/VersionedJsonStore';

import type {
  OpenCodeDeliveryResponseObservation,
  OpenCodeDeliveryResponseState,
  OpenCodeDeliveryVisibleReplyCorrelation,
} from '../bridge/OpenCodeBridgeCommandContract';
import type { AgentActionMode, InboxMessage, InboxMessageKind, TaskRef } from '@shared/types/team';

export const OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION = 1;
export const OPENCODE_PROMPT_DELIVERY_RESPONDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OPENCODE_PROMPT_DELIVERY_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS = 5;

export type OpenCodePromptDeliveryStatus =
  | 'pending'
  | 'accepted'
  | 'responded'
  | 'unanswered'
  | 'retry_scheduled'
  | 'retried'
  | 'failed_retryable'
  | 'failed_terminal';

export interface OpenCodePromptDeliveryLedgerRecord {
  id: string;
  teamName: string;
  memberName: string;
  laneId: string;
  runId: string | null;
  runtimeSessionId: string | null;
  runtimePromptMessageId?: string | null;
  runtimePromptMessageIds?: string[];
  lastRuntimePromptMessageId?: string | null;
  lastDeliveryAttemptIdWithAcceptedPrompt?: string | null;
  inboxMessageId: string;
  inboxTimestamp: string;
  source: 'watcher' | 'ui-send' | 'manual' | 'watchdog' | 'member-work-sync-review-pickup';
  messageKind: InboxMessageKind | null;
  workSyncIntent?: InboxMessage['workSyncIntent'] | null;
  replyRecipient: string;
  actionMode: AgentActionMode | null;
  taskRefs: TaskRef[];
  payloadHash: string;
  status: OpenCodePromptDeliveryStatus;
  responseState: OpenCodeDeliveryResponseState;
  attempts: number;
  maxAttempts: number;
  sessionRefreshAttempts?: number;
  maxSessionRefreshAttempts?: number;
  lastSessionRefreshReason?: string | null;
  acceptanceUnknown: boolean;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastObservedAt: string | null;
  acceptedAt: string | null;
  respondedAt: string | null;
  failedAt: string | null;
  inboxReadCommittedAt: string | null;
  inboxReadCommitError: string | null;
  prePromptCursor: string | null;
  postPromptCursor: string | null;
  deliveredUserMessageId: string | null;
  observedAssistantMessageId: string | null;
  observedAssistantPreview: string | null;
  observedToolCallNames: string[];
  observedVisibleMessageId: string | null;
  visibleReplyMessageId: string | null;
  visibleReplyInbox: string | null;
  visibleReplyCorrelation: OpenCodeDeliveryVisibleReplyCorrelation | null;
  lastReason: string | null;
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
}

const OPENCODE_PROMPT_DELIVERY_STATUSES = new Set<OpenCodePromptDeliveryStatus>([
  'pending',
  'accepted',
  'responded',
  'unanswered',
  'retry_scheduled',
  'retried',
  'failed_retryable',
  'failed_terminal',
]);

const OPENCODE_DELIVERY_RESPONSE_STATES = new Set<OpenCodeDeliveryResponseState>([
  'not_observed',
  'pending',
  'prompt_not_indexed',
  'responded_tool_call',
  'responded_visible_message',
  'responded_non_visible_tool',
  'responded_plain_text',
  'permission_blocked',
  'tool_error',
  'empty_assistant_turn',
  'prompt_delivered_no_assistant_message',
  'session_stale',
  'session_error',
  'reconcile_failed',
]);

const OPENCODE_PROMPT_DELIVERY_SOURCES = new Set<OpenCodePromptDeliveryLedgerRecord['source']>([
  'watcher',
  'ui-send',
  'manual',
  'watchdog',
  'member-work-sync-review-pickup',
]);

const OPENCODE_DELIVERY_VISIBLE_REPLY_CORRELATIONS =
  new Set<OpenCodeDeliveryVisibleReplyCorrelation>([
    'relayOfMessageId',
    'direct_child_message_send',
    'plain_assistant_text',
  ]);

const AGENT_ACTION_MODES = new Set<AgentActionMode>(['do', 'ask', 'delegate']);

export interface EnsureOpenCodePromptDeliveryInput {
  teamName: string;
  memberName: string;
  laneId: string;
  runId?: string | null;
  inboxMessageId: string;
  inboxTimestamp: string;
  source: OpenCodePromptDeliveryLedgerRecord['source'];
  messageKind?: InboxMessageKind | null;
  workSyncIntent?: InboxMessage['workSyncIntent'] | null;
  replyRecipient: string;
  actionMode?: AgentActionMode | null;
  taskRefs?: TaskRef[];
  payloadHash: string;
  maxAttempts?: number;
  now: string;
}

export interface ApplyOpenCodePromptDeliveryResultInput {
  id: string;
  accepted: boolean;
  attempted?: boolean;
  responseObservation?: OpenCodeDeliveryResponseObservation;
  sessionId?: string | null;
  runtimePromptMessageId?: string | null;
  deliveryAttemptId?: string | null;
  runtimePid?: number;
  prePromptCursor?: string | null;
  diagnostics?: string[];
  reason?: string | null;
  now: string;
}

export interface ApplyOpenCodePromptDestinationProofInput {
  id: string;
  visibleReplyInbox: string;
  visibleReplyMessageId: string;
  visibleReplyCorrelation: OpenCodeDeliveryVisibleReplyCorrelation;
  semanticallySufficient: boolean;
  diagnostics?: string[];
  observedAt: string;
}

export class OpenCodePromptDeliveryLedgerStore {
  constructor(private readonly store: VersionedJsonStore<OpenCodePromptDeliveryLedgerRecord[]>) {}

  async ensurePending(
    input: EnsureOpenCodePromptDeliveryInput
  ): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const id = buildOpenCodePromptDeliveryRecordId(input);
    let result: OpenCodePromptDeliveryLedgerRecord | null = null;
    await this.store.updateLocked((records) => {
      const existing = records.find((record) => record.id === id);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          const reason = 'opencode_prompt_delivery_payload_mismatch';
          const updated: OpenCodePromptDeliveryLedgerRecord = {
            ...existing,
            status: 'failed_terminal',
            failedAt: input.now,
            nextAttemptAt: null,
            lastReason: reason,
            diagnostics: mergeDiagnostics(existing.diagnostics, [
              `${reason}: existing payload hash does not match current inbox row payload`,
            ]),
            updatedAt: input.now,
          };
          result = updated;
          return records.map((record) => (record.id === existing.id ? updated : record));
        }
        if (existing.messageKind == null && input.messageKind) {
          const updated: OpenCodePromptDeliveryLedgerRecord = {
            ...existing,
            messageKind: input.messageKind,
            ...(input.workSyncIntent ? { workSyncIntent: input.workSyncIntent } : {}),
            updatedAt: input.now,
          };
          result = updated;
          return records.map((record) => (record.id === existing.id ? updated : record));
        }
        if (existing.workSyncIntent == null && input.workSyncIntent) {
          const updated: OpenCodePromptDeliveryLedgerRecord = {
            ...existing,
            workSyncIntent: input.workSyncIntent,
            updatedAt: input.now,
          };
          result = updated;
          return records.map((record) => (record.id === existing.id ? updated : record));
        }
        result = existing;
        return records;
      }

      const created: OpenCodePromptDeliveryLedgerRecord = {
        id,
        teamName: input.teamName,
        memberName: input.memberName,
        laneId: input.laneId,
        runId: input.runId ?? null,
        runtimeSessionId: null,
        runtimePromptMessageId: null,
        runtimePromptMessageIds: [],
        lastRuntimePromptMessageId: null,
        lastDeliveryAttemptIdWithAcceptedPrompt: null,
        inboxMessageId: input.inboxMessageId,
        inboxTimestamp: input.inboxTimestamp,
        source: input.source,
        messageKind: input.messageKind ?? null,
        workSyncIntent: input.workSyncIntent ?? null,
        replyRecipient: input.replyRecipient,
        actionMode: input.actionMode ?? null,
        taskRefs: input.taskRefs ?? [],
        payloadHash: input.payloadHash,
        status: 'pending',
        responseState: 'not_observed',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        sessionRefreshAttempts: 0,
        maxSessionRefreshAttempts: OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS,
        lastSessionRefreshReason: null,
        acceptanceUnknown: false,
        nextAttemptAt: null,
        lastAttemptAt: null,
        lastObservedAt: null,
        acceptedAt: null,
        respondedAt: null,
        failedAt: null,
        inboxReadCommittedAt: null,
        inboxReadCommitError: null,
        prePromptCursor: null,
        postPromptCursor: null,
        deliveredUserMessageId: null,
        observedAssistantMessageId: null,
        observedAssistantPreview: null,
        observedToolCallNames: [],
        observedVisibleMessageId: null,
        visibleReplyMessageId: null,
        visibleReplyInbox: null,
        visibleReplyCorrelation: null,
        lastReason: null,
        diagnostics: [],
        createdAt: input.now,
        updatedAt: input.now,
      };
      result = created;
      return [...records, created];
    });
    if (!result) {
      throw new Error('OpenCode prompt delivery ensurePending failed');
    }
    return result;
  }

  async getByInboxMessage(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    inboxMessageId: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    const records = await this.readRequired();
    return (
      records.find(
        (record) =>
          record.teamName === input.teamName &&
          record.memberName.toLowerCase() === input.memberName.toLowerCase() &&
          record.laneId === input.laneId &&
          record.inboxMessageId === input.inboxMessageId
      ) ?? null
    );
  }

  async getActiveForMember(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    const records = await this.readRequired();
    return (
      records
        .filter(
          (record) =>
            record.teamName === input.teamName &&
            record.memberName.toLowerCase() === input.memberName.toLowerCase() &&
            record.laneId === input.laneId &&
            !isTerminalForAutomaticSelection(record)
        )
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0] ?? null
    );
  }

  async applyDeliveryResult(
    input: ApplyOpenCodePromptDeliveryResultInput
  ): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => {
      const observation = input.responseObservation;
      const responseState =
        observation?.state ?? (input.accepted ? record.responseState : 'not_observed');
      const sessionRefreshState = isOpenCodeSessionRefreshResponseState({
        responseState,
        reason: input.reason ?? observation?.reason ?? record.lastReason,
        diagnostics: input.diagnostics,
      });
      const responded = isOpenCodePromptResponseStateResponded(responseState);
      const unanswered = isOpenCodePromptDeliveryUnansweredResponseState(responseState);
      const acceptedRuntimePromptMessageId =
        input.accepted && input.runtimePromptMessageId?.trim()
          ? input.runtimePromptMessageId.trim()
          : null;
      const previousRuntimePromptMessageIds = getOpenCodeRuntimePromptMessageIds(record);
      const runtimePromptMessageIds =
        acceptedRuntimePromptMessageId &&
        !previousRuntimePromptMessageIds.includes(acceptedRuntimePromptMessageId)
          ? [...previousRuntimePromptMessageIds, acceptedRuntimePromptMessageId]
          : previousRuntimePromptMessageIds;
      const acceptedDeliveryAttemptId = input.deliveryAttemptId?.trim() || null;
      const acceptedAttemptAlreadyRecorded = Boolean(
        input.accepted &&
        acceptedDeliveryAttemptId &&
        record.lastDeliveryAttemptIdWithAcceptedPrompt === acceptedDeliveryAttemptId
      );
      const acceptedPromptAlreadyRecorded = Boolean(
        input.accepted &&
        acceptedRuntimePromptMessageId &&
        previousRuntimePromptMessageIds.includes(acceptedRuntimePromptMessageId)
      );
      const shouldIncrementAttempts =
        (input.accepted || input.attempted === true) &&
        !acceptedAttemptAlreadyRecorded &&
        !acceptedPromptAlreadyRecorded &&
        !sessionRefreshState;
      const lastRuntimePromptMessageId =
        acceptedRuntimePromptMessageId ??
        record.lastRuntimePromptMessageId ??
        record.runtimePromptMessageId ??
        runtimePromptMessageIds[runtimePromptMessageIds.length - 1] ??
        null;
      return {
        ...record,
        status: input.accepted
          ? responded
            ? 'responded'
            : unanswered
              ? 'unanswered'
              : 'accepted'
          : 'failed_retryable',
        responseState,
        attempts: shouldIncrementAttempts ? record.attempts + 1 : record.attempts,
        runtimeSessionId: input.sessionId ?? record.runtimeSessionId,
        runtimePromptMessageId: lastRuntimePromptMessageId,
        runtimePromptMessageIds,
        lastRuntimePromptMessageId,
        lastDeliveryAttemptIdWithAcceptedPrompt:
          input.accepted && acceptedDeliveryAttemptId
            ? acceptedDeliveryAttemptId
            : (record.lastDeliveryAttemptIdWithAcceptedPrompt ?? null),
        acceptanceUnknown: input.accepted ? false : record.acceptanceUnknown,
        lastAttemptAt: input.now,
        lastObservedAt: observation ? input.now : record.lastObservedAt,
        acceptedAt: input.accepted ? (record.acceptedAt ?? input.now) : record.acceptedAt,
        respondedAt: responded ? (record.respondedAt ?? input.now) : record.respondedAt,
        prePromptCursor: input.prePromptCursor ?? record.prePromptCursor,
        deliveredUserMessageId:
          observation?.deliveredUserMessageId ?? record.deliveredUserMessageId,
        observedAssistantMessageId:
          observation?.assistantMessageId ?? record.observedAssistantMessageId,
        observedAssistantPreview:
          observation?.latestAssistantPreview ?? record.observedAssistantPreview,
        observedToolCallNames: observation?.toolCallNames ?? record.observedToolCallNames,
        observedVisibleMessageId:
          observation?.visibleMessageToolCallId ?? record.observedVisibleMessageId,
        visibleReplyMessageId: observation?.visibleReplyMessageId ?? record.visibleReplyMessageId,
        visibleReplyCorrelation:
          observation?.visibleReplyCorrelation ?? record.visibleReplyCorrelation,
        lastReason: input.reason ?? observation?.reason ?? record.lastReason,
        lastSessionRefreshReason: sessionRefreshState
          ? (input.reason ?? observation?.reason ?? record.lastSessionRefreshReason ?? null)
          : (record.lastSessionRefreshReason ?? null),
        diagnostics: mergeDiagnostics(record.diagnostics, input.diagnostics ?? []),
        updatedAt: input.now,
      };
    });
  }

  async applyObservation(input: {
    id: string;
    responseObservation: OpenCodeDeliveryResponseObservation;
    sessionId?: string | null;
    runtimePromptMessageId?: string | null;
    diagnostics?: string[];
    observedAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => {
      const responded = isOpenCodePromptResponseStateResponded(input.responseObservation.state);
      const unanswered = isOpenCodePromptDeliveryUnansweredResponseState(
        input.responseObservation.state
      );
      const sessionRefreshState = isOpenCodeSessionRefreshResponseState({
        responseState: input.responseObservation.state,
        reason: input.responseObservation.reason ?? record.lastReason,
        diagnostics: input.diagnostics,
      });
      const previousRuntimePromptMessageIds = getOpenCodeRuntimePromptMessageIds(record);
      const deliveredRuntimePromptMessageId =
        input.responseObservation.deliveredUserMessageId?.trim() || null;
      const requestedRuntimePromptMessageId = input.runtimePromptMessageId?.trim() || null;
      const requestedRuntimePromptMessageIdIsKnown = Boolean(
        requestedRuntimePromptMessageId &&
        previousRuntimePromptMessageIds.includes(requestedRuntimePromptMessageId)
      );
      const observedRuntimePromptMessageId =
        deliveredRuntimePromptMessageId ||
        (requestedRuntimePromptMessageIdIsKnown ? requestedRuntimePromptMessageId : null);
      const runtimePromptMessageIds =
        observedRuntimePromptMessageId &&
        !previousRuntimePromptMessageIds.includes(observedRuntimePromptMessageId)
          ? [...previousRuntimePromptMessageIds, observedRuntimePromptMessageId]
          : previousRuntimePromptMessageIds;
      const promptAcceptedByObservation = Boolean(deliveredRuntimePromptMessageId);
      const lastRuntimePromptMessageId =
        observedRuntimePromptMessageId ??
        record.lastRuntimePromptMessageId ??
        record.runtimePromptMessageId ??
        runtimePromptMessageIds[runtimePromptMessageIds.length - 1] ??
        null;
      return {
        ...record,
        status: responded
          ? 'responded'
          : unanswered
            ? 'unanswered'
            : record.status === 'pending' || promptAcceptedByObservation
              ? 'accepted'
              : record.status,
        responseState: input.responseObservation.state,
        runtimeSessionId: input.sessionId ?? record.runtimeSessionId,
        runtimePromptMessageId: lastRuntimePromptMessageId,
        runtimePromptMessageIds,
        lastRuntimePromptMessageId,
        acceptanceUnknown: promptAcceptedByObservation ? false : record.acceptanceUnknown,
        lastObservedAt: input.observedAt,
        acceptedAt: promptAcceptedByObservation
          ? (record.acceptedAt ?? input.observedAt)
          : record.acceptedAt,
        respondedAt: responded ? (record.respondedAt ?? input.observedAt) : record.respondedAt,
        deliveredUserMessageId:
          input.responseObservation.deliveredUserMessageId ?? record.deliveredUserMessageId,
        observedAssistantMessageId:
          input.responseObservation.assistantMessageId ?? record.observedAssistantMessageId,
        observedAssistantPreview:
          input.responseObservation.latestAssistantPreview ?? record.observedAssistantPreview,
        observedToolCallNames: input.responseObservation.toolCallNames,
        observedVisibleMessageId:
          input.responseObservation.visibleMessageToolCallId ?? record.observedVisibleMessageId,
        visibleReplyMessageId:
          input.responseObservation.visibleReplyMessageId ?? record.visibleReplyMessageId,
        visibleReplyCorrelation:
          input.responseObservation.visibleReplyCorrelation ?? record.visibleReplyCorrelation,
        lastReason: input.responseObservation.reason ?? record.lastReason,
        lastSessionRefreshReason: sessionRefreshState
          ? (input.responseObservation.reason ?? record.lastSessionRefreshReason ?? null)
          : (record.lastSessionRefreshReason ?? null),
        diagnostics: mergeDiagnostics(record.diagnostics, input.diagnostics ?? []),
        updatedAt: input.observedAt,
      };
    });
  }

  async applyDestinationProof(
    input: ApplyOpenCodePromptDestinationProofInput
  ): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const responseState =
      input.visibleReplyCorrelation === 'plain_assistant_text'
        ? 'responded_plain_text'
        : 'responded_visible_message';
    return await this.updateExisting(input.id, (record) => {
      const diagnostics = input.semanticallySufficient
        ? mergeDiagnostics(record.diagnostics, [
            ...(record.lastReason ? [record.lastReason] : []),
            ...(input.diagnostics ?? []),
          ])
        : mergeDiagnostics(record.diagnostics, input.diagnostics ?? []);
      return {
        ...record,
        status: input.semanticallySufficient ? 'responded' : record.status,
        responseState,
        acceptanceUnknown: input.semanticallySufficient ? false : record.acceptanceUnknown,
        nextAttemptAt: input.semanticallySufficient ? null : record.nextAttemptAt,
        lastObservedAt: input.observedAt,
        respondedAt: input.semanticallySufficient
          ? (record.respondedAt ?? input.observedAt)
          : record.respondedAt,
        failedAt: input.semanticallySufficient ? null : record.failedAt,
        visibleReplyInbox: input.visibleReplyInbox,
        visibleReplyMessageId: input.visibleReplyMessageId,
        visibleReplyCorrelation: input.visibleReplyCorrelation,
        lastReason: input.semanticallySufficient
          ? null
          : selectOpenCodeDestinationProofInsufficientReason(input.diagnostics),
        diagnostics,
        updatedAt: input.observedAt,
      };
    });
  }

  async markAcceptanceUnknown(input: {
    id: string;
    reason: string;
    nextAttemptAt: string;
    diagnostics?: string[];
    markedAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      status: 'failed_retryable',
      responseState: 'not_observed',
      acceptanceUnknown: true,
      nextAttemptAt: input.nextAttemptAt,
      lastReason: input.reason,
      diagnostics: mergeDiagnostics(record.diagnostics, [
        input.reason,
        ...(input.diagnostics ?? []),
      ]),
      updatedAt: input.markedAt,
    }));
  }

  async markNextAttemptScheduled(input: {
    id: string;
    status: Extract<OpenCodePromptDeliveryStatus, 'accepted' | 'retry_scheduled'>;
    nextAttemptAt: string;
    reason: string;
    scheduledAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      status: input.status,
      nextAttemptAt: input.nextAttemptAt,
      lastReason: input.reason,
      updatedAt: input.scheduledAt,
    }));
  }

  async markSessionRefreshScheduled(input: {
    id: string;
    nextAttemptAt: string;
    reason: string;
    scheduledAt: string;
    maxSessionRefreshAttempts?: number;
    diagnostics?: string[];
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => {
      const maxSessionRefreshAttempts =
        record.maxSessionRefreshAttempts ??
        input.maxSessionRefreshAttempts ??
        OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS;
      const sessionRefreshAttempts = (record.sessionRefreshAttempts ?? 0) + 1;
      return {
        ...record,
        status: 'retry_scheduled',
        responseState: 'session_stale',
        nextAttemptAt: input.nextAttemptAt,
        sessionRefreshAttempts,
        maxSessionRefreshAttempts,
        lastSessionRefreshReason: input.reason,
        lastReason: input.reason,
        diagnostics: mergeDiagnostics(record.diagnostics, [
          input.reason,
          ...(input.diagnostics ?? []),
        ]),
        updatedAt: input.scheduledAt,
      };
    });
  }

  async markSessionStaleObservationScheduled(input: {
    id: string;
    nextAttemptAt: string;
    reason: string;
    scheduledAt: string;
    maxSessionRefreshAttempts?: number;
    diagnostics?: string[];
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => {
      const maxSessionRefreshAttempts =
        record.maxSessionRefreshAttempts ??
        input.maxSessionRefreshAttempts ??
        OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS;
      const sessionRefreshAttempts = (record.sessionRefreshAttempts ?? 0) + 1;
      return {
        ...record,
        status: 'accepted',
        responseState: 'session_stale',
        nextAttemptAt: input.nextAttemptAt,
        sessionRefreshAttempts,
        maxSessionRefreshAttempts,
        lastSessionRefreshReason: input.reason,
        lastReason: input.reason,
        diagnostics: mergeDiagnostics(record.diagnostics, [
          input.reason,
          ...(input.diagnostics ?? []),
        ]),
        updatedAt: input.scheduledAt,
      };
    });
  }

  async markRetryAttempted(input: {
    id: string;
    attemptedAt: string;
    reason?: string | null;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      status: 'retried',
      attempts: record.attempts + 1,
      lastAttemptAt: input.attemptedAt,
      nextAttemptAt: null,
      lastReason: input.reason ?? record.lastReason,
      updatedAt: input.attemptedAt,
    }));
  }

  async markFailedTerminal(input: {
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      status: 'failed_terminal',
      failedAt: input.failedAt,
      nextAttemptAt: null,
      lastReason: input.reason,
      diagnostics: mergeDiagnostics(record.diagnostics, [
        input.reason,
        ...(input.diagnostics ?? []),
      ]),
      updatedAt: input.failedAt,
    }));
  }

  async markInboxReadCommitted(input: {
    id: string;
    committedAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      inboxReadCommittedAt: input.committedAt,
      inboxReadCommitError: null,
      updatedAt: input.committedAt,
    }));
  }

  async markInboxReadCommitFailed(input: {
    id: string;
    error: string;
    failedAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      inboxReadCommitError: input.error,
      diagnostics: mergeDiagnostics(record.diagnostics, [input.error]),
      updatedAt: input.failedAt,
    }));
  }

  async list(): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
    return await this.readRequired();
  }

  async listDue(input: {
    teamName?: string;
    now: Date;
    limit: number;
  }): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
    const nowMs = input.now.getTime();
    const limit = Math.max(0, input.limit);
    if (limit === 0) {
      return [];
    }
    const teamName = input.teamName?.trim().toLowerCase() ?? null;
    const records = await this.readRequired();
    return records
      .filter((record) => {
        if (teamName && record.teamName.trim().toLowerCase() !== teamName) {
          return false;
        }
        if (isTerminalForAutomaticSelection(record)) {
          return false;
        }
        return isOpenCodePromptDeliveryAttemptDue(record, nowMs);
      })
      .sort(compareOpenCodePromptDeliveryDueOrder)
      .slice(0, limit);
  }

  async pruneTerminalRecords(input: {
    now: Date;
    respondedRetentionMs?: number;
    failedRetentionMs?: number;
  }): Promise<{ pruned: number; remaining: number }> {
    const nowMs = input.now.getTime();
    const respondedRetentionMs =
      input.respondedRetentionMs ?? OPENCODE_PROMPT_DELIVERY_RESPONDED_RETENTION_MS;
    const failedRetentionMs =
      input.failedRetentionMs ?? OPENCODE_PROMPT_DELIVERY_FAILED_RETENTION_MS;
    let pruned = 0;
    let remaining = 0;
    await this.store.updateLocked((records) => {
      const kept = records.filter((record) => {
        if (
          shouldPruneOpenCodePromptDeliveryRecord(
            record,
            nowMs,
            respondedRetentionMs,
            failedRetentionMs
          )
        ) {
          pruned += 1;
          return false;
        }
        return true;
      });
      remaining = kept.length;
      return kept;
    });
    return { pruned, remaining };
  }

  private async updateExisting(
    id: string,
    updater: (record: OpenCodePromptDeliveryLedgerRecord) => OpenCodePromptDeliveryLedgerRecord
  ): Promise<OpenCodePromptDeliveryLedgerRecord> {
    let updated: OpenCodePromptDeliveryLedgerRecord | null = null;
    await this.store.updateLocked((records) =>
      records.map((record) => {
        if (record.id !== id) {
          return record;
        }
        updated = updater(record);
        return updated;
      })
    );
    if (!updated) {
      throw new Error(`OpenCode prompt delivery record not found: ${id}`);
    }
    return updated;
  }

  private async readRequired(): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }
    return result.data;
  }
}

export function createOpenCodePromptDeliveryLedgerStore(options: {
  filePath: string;
  clock?: () => Date;
}): OpenCodePromptDeliveryLedgerStore {
  const clock = options.clock ?? (() => new Date());
  return new OpenCodePromptDeliveryLedgerStore(
    new VersionedJsonStore<OpenCodePromptDeliveryLedgerRecord[]>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateOpenCodePromptDeliveryLedgerRecords,
      clock,
    })
  );
}

export function buildOpenCodePromptDeliveryRecordId(input: {
  teamName: string;
  memberName: string;
  laneId: string;
  inboxMessageId: string;
}): string {
  return `opencode-prompt:${stableHash({
    version: 1,
    teamName: input.teamName,
    memberName: input.memberName.toLowerCase(),
    laneId: input.laneId,
    inboxMessageId: input.inboxMessageId,
  })}`;
}

export function hashOpenCodePromptDeliveryPayload(input: {
  text: string;
  replyRecipient: string;
  actionMode?: AgentActionMode | null;
  taskRefs?: TaskRef[];
  attachments?: { id?: string; filename?: string; mimeType?: string; size?: number }[];
  source?: string;
}): string {
  return `sha256:${stableHash({
    text: input.text,
    replyRecipient: input.replyRecipient,
    actionMode: input.actionMode ?? null,
    taskRefs: input.taskRefs ?? [],
    attachments:
      input.attachments?.map((attachment) => ({
        id: attachment.id ?? null,
        filename: attachment.filename ?? null,
        mimeType: attachment.mimeType ?? null,
        size: attachment.size ?? null,
      })) ?? [],
    source: input.source ?? null,
  })}`;
}

export function getOpenCodeRuntimePromptMessageIds(
  record: Pick<
    OpenCodePromptDeliveryLedgerRecord,
    'runtimePromptMessageId' | 'runtimePromptMessageIds' | 'lastRuntimePromptMessageId'
  >
): string[] {
  const ids: string[] = [];
  for (const value of [
    ...(Array.isArray(record.runtimePromptMessageIds) ? record.runtimePromptMessageIds : []),
    record.runtimePromptMessageId,
    record.lastRuntimePromptMessageId,
  ]) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function getLatestOpenCodeRuntimePromptMessageId(
  record: Pick<
    OpenCodePromptDeliveryLedgerRecord,
    'runtimePromptMessageId' | 'runtimePromptMessageIds' | 'lastRuntimePromptMessageId'
  >
): string | null {
  const explicit =
    record.lastRuntimePromptMessageId?.trim() || record.runtimePromptMessageId?.trim();
  if (explicit) {
    return explicit;
  }
  const ids = getOpenCodeRuntimePromptMessageIds(record);
  return ids[ids.length - 1] ?? null;
}

export function buildOpenCodePromptDeliveryAttemptId(
  record: Pick<
    OpenCodePromptDeliveryLedgerRecord,
    'id' | 'attempts' | 'payloadHash' | 'sessionRefreshAttempts'
  >
): string {
  const base = [record.id, record.attempts + 1, record.payloadHash.slice(0, 12)];
  const sessionRefreshAttempts = record.sessionRefreshAttempts ?? 0;
  if (sessionRefreshAttempts > 0) {
    base.push(`refresh${sessionRefreshAttempts}`);
  }
  return base.join(':');
}

export function isOpenCodePromptResponseStateResponded(
  state: OpenCodeDeliveryResponseState
): boolean {
  return (
    state === 'responded_visible_message' ||
    state === 'responded_non_visible_tool' ||
    state === 'responded_tool_call' ||
    state === 'responded_plain_text'
  );
}

function isOpenCodePromptDeliveryUnansweredResponseState(
  state: OpenCodeDeliveryResponseState
): boolean {
  return state === 'empty_assistant_turn' || state === 'prompt_delivered_no_assistant_message';
}

export function isOpenCodeResolvedBehaviorChangedReason(
  reason: string | null | undefined
): boolean {
  return isCleanOpenCodeSessionRefreshReason(
    reason,
    /\bresolved_behavior_changed:[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/i
  );
}

export function isOpenCodeSessionTransportChangedReason(
  reason: string | null | undefined
): boolean {
  return isCleanOpenCodeSessionRefreshReason(
    reason,
    /\bopencode_app_mcp_transport_changed:[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/i
  );
}

const OPENCODE_SESSION_REFRESH_FAILURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- Keyword taxonomy is kept literal to preserve diagnostic behavior.
  /(?:^|[_\s:;.\/()-])(?:permission[_\s-]?denied|permission[_\s-]?blocked|access[_\s-]?denied|auth[_\s-]?unavailable|authentication[_\s-]?failed|unauthorized|forbidden|401|403|login[_\s-]?required|not\s+logged\s+in|missing\s+credentials?|invalid\s+credentials?|credentials?[_\s-]?required|credentials?[_\s-]?unavailable|no auth available|authorization|auth(?:entication)?(?:[_\s-]?(?:failed|unavailable))?|invalid api[_\s-]?key|api[_\s-]?key|does not have access|quota|rate[_\s-]?(?:limit|limited)|too many requests|429|model cooldown|cooling down|enospc|no space left|disk is full|capacity exceeded|quota exhausted|usage exceeded|free usage exceeded|key limit exceeded|total limit|insufficient credits|subscribe to go|error|failed|failure|timeout|timed\s+out|network|connection|unable\s+to\s+connect|connect\s+failed|econn[a-z_]*|enotfound|fetch[_\s-]?failed|connection[_\s-]?(?:refused|reset)|aborted|cancel(?:ed|led)|interrupted|service[_\s-]?unavailable|temporarily\s+unavailable|overloaded|visible[_\s-]?reply(?:[_\s-][a-z0-9]+)*|task[_\s-]?refs|relayofmessageid|relay[_\s-]?of[_\s-]?message[_\s-]?id|message[_\s-]?send|non[_\s-]?visible[_\s-]?tool(?:[_\s-][a-z0-9]+)*|protocol[_\s-]?proof)(?=$|[_\s:;.\/(),-])/i;
const OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN =
  /\b(?:resolved_behavior_changed|opencode_app_mcp_transport_changed):[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/gi;
const OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN =
  /\b(?:not_observed|pending|prompt_not_indexed|responded_tool_call|responded_visible_message|responded_non_visible_tool|responded_plain_text|permission_blocked|tool_error|empty_assistant_turn|prompt_delivered_no_assistant_message|session_stale|session_error|reconcile_failed)\b/g;

function isCleanOpenCodeSessionRefreshReason(
  reason: string | null | undefined,
  pattern: RegExp
): boolean {
  const normalized = reason?.trim().toLowerCase() ?? '';
  if (!pattern.test(normalized)) {
    return false;
  }
  const markerText = stripOpenCodeGenericApiErrorPrefix(normalized);
  if (hasOpenCodeSessionRefreshFailureConflict(markerText)) {
    return false;
  }
  const rawRemainder = markerText.replace(OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN, '');
  const remainder = rawRemainder.replace(/[().,;:\s-]+/g, '');
  if (remainder.length === 0) {
    return true;
  }
  const staleLogProjectionContext =
    normalized.includes('session is stale') ||
    normalized.includes('stored session is stale') ||
    normalized.includes('session reconcile skipped');
  if (!staleLogProjectionContext) {
    return false;
  }
  return isBenignOpenCodeSessionRefreshRemainder(rawRemainder);
}

function isBenignOpenCodeSessionRefreshRemainder(rawRemainder: string): boolean {
  if (OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(rawRemainder)) {
    return false;
  }
  const normalized = rawRemainder.replace(/[().,;:\s-]+/g, ' ').trim();
  return (
    normalized === 'opencode session is stale' ||
    normalized ===
      'opencode session is stale reading historical messages for log projection only' ||
    normalized === 'opencode session reconcile skipped because the stored session is stale' ||
    normalized === 'stored session is stale'
  );
}

function isOpenCodeSessionRefreshScheduledReason(message: string | null | undefined): boolean {
  const normalized = stripOpenCodeGenericApiErrorPrefix(
    message?.trim().toLowerCase() ?? ''
  ).replace(/[.:\s-]+$/, '');
  return (
    normalized === 'opencode prompt delivery session refresh scheduled' ||
    normalized === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    normalized === 'opencode session refresh scheduled after resolved behavior changed' ||
    normalized === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed' ||
    normalized === 'opencode_session_stale_observe_scheduled_after_accepted_prompt' ||
    normalized === 'opencode session changed; refreshing the session before retry'
  );
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
}

function hasOpenCodeSessionRefreshFailureConflict(value: string): boolean {
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(
    value.replace(OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN, 'state')
  );
}

export function isOpenCodeSessionRefreshResponseState(input: {
  responseState?: OpenCodeDeliveryResponseState;
  reason?: string | null;
  diagnostics?: readonly string[];
}): boolean {
  const candidates = [input.reason, ...(input.diagnostics ?? [])];
  const hasActionRequiredConflict = candidates.some(isOpenCodeSessionRefreshActionRequiredConflict);
  if (input.responseState === 'session_stale') {
    return !hasActionRequiredConflict;
  }
  return (
    !hasActionRequiredConflict &&
    candidates.some(
      (candidate) =>
        isOpenCodeResolvedBehaviorChangedReason(candidate) ||
        isOpenCodeSessionTransportChangedReason(candidate) ||
        isOpenCodeSessionRefreshScheduledReason(candidate)
    )
  );
}

function isOpenCodeSessionRefreshActionRequiredConflict(
  message: string | null | undefined
): boolean {
  const normalized = message?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return false;
  }
  if (normalized.replace(/[.:\s-]+$/, '') === 'opencode api error') {
    return false;
  }
  if (
    isOpenCodeResolvedBehaviorChangedReason(normalized) ||
    isOpenCodeSessionTransportChangedReason(normalized) ||
    isOpenCodeSessionRefreshScheduledReason(normalized)
  ) {
    return false;
  }
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(normalized);
}

export function isOpenCodePromptDeliveryAttemptDue(
  record: OpenCodePromptDeliveryLedgerRecord,
  nowMs: number = Date.now()
): boolean {
  if (!record.nextAttemptAt) {
    return true;
  }
  const dueMs = Date.parse(record.nextAttemptAt);
  return !Number.isFinite(dueMs) || dueMs <= nowMs;
}

export function validateOpenCodePromptDeliveryLedgerRecords(
  value: unknown
): OpenCodePromptDeliveryLedgerRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('OpenCode prompt delivery ledger must be an array');
  }
  const seen = new Set<string>();
  return value.map((record, index) => {
    if (!isOpenCodePromptDeliveryLedgerRecord(record)) {
      throw new Error(`Invalid OpenCode prompt delivery ledger record at index ${index}`);
    }
    if (seen.has(record.id)) {
      throw new Error(`Duplicate OpenCode prompt delivery ledger id: ${record.id}`);
    }
    seen.add(record.id);
    return record;
  });
}

function isOpenCodePromptDeliveryLedgerRecord(
  value: unknown
): value is OpenCodePromptDeliveryLedgerRecord {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  return Boolean(
    record &&
    typeof record.id === 'string' &&
    typeof record.teamName === 'string' &&
    typeof record.memberName === 'string' &&
    typeof record.laneId === 'string' &&
    isOptionalNullableString(record.runId) &&
    isOptionalNullableString(record.runtimeSessionId) &&
    isOptionalNullableString(record.runtimePromptMessageId) &&
    isOptionalStringArray(record.runtimePromptMessageIds) &&
    isOptionalNullableString(record.lastRuntimePromptMessageId) &&
    isOptionalNullableString(record.lastDeliveryAttemptIdWithAcceptedPrompt) &&
    typeof record.inboxMessageId === 'string' &&
    typeof record.inboxTimestamp === 'string' &&
    isOpenCodePromptDeliverySource(record.source) &&
    isOptionalNullableInboxMessageKind(record.messageKind) &&
    typeof record.replyRecipient === 'string' &&
    isOptionalNullableActionMode(record.actionMode) &&
    isTaskRefArray(record.taskRefs) &&
    typeof record.payloadHash === 'string' &&
    isOpenCodePromptDeliveryStatus(record.status) &&
    isOpenCodeDeliveryResponseState(record.responseState) &&
    isNonNegativeInteger(record.attempts) &&
    isNonNegativeInteger(record.maxAttempts) &&
    isOptionalNonNegativeInteger(record.sessionRefreshAttempts) &&
    isOptionalNonNegativeInteger(record.maxSessionRefreshAttempts) &&
    isOptionalNullableString(record.lastSessionRefreshReason) &&
    typeof record.acceptanceUnknown === 'boolean' &&
    isOptionalNullableString(record.nextAttemptAt) &&
    isOptionalNullableString(record.lastAttemptAt) &&
    isOptionalNullableString(record.lastObservedAt) &&
    isOptionalNullableString(record.acceptedAt) &&
    isOptionalNullableString(record.respondedAt) &&
    isOptionalNullableString(record.failedAt) &&
    isOptionalNullableString(record.inboxReadCommittedAt) &&
    isOptionalNullableString(record.inboxReadCommitError) &&
    isOptionalNullableString(record.prePromptCursor) &&
    isOptionalNullableString(record.postPromptCursor) &&
    isOptionalNullableString(record.deliveredUserMessageId) &&
    isOptionalNullableString(record.observedAssistantMessageId) &&
    isOptionalNullableString(record.observedAssistantPreview) &&
    isStringArray(record.observedToolCallNames) &&
    isOptionalNullableString(record.observedVisibleMessageId) &&
    isOptionalNullableString(record.visibleReplyMessageId) &&
    isOptionalNullableString(record.visibleReplyInbox) &&
    isOptionalNullableVisibleReplyCorrelation(record.visibleReplyCorrelation) &&
    isOptionalNullableString(record.lastReason) &&
    isStringArray(record.diagnostics) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isOpenCodePromptDeliveryStatus(value: unknown): value is OpenCodePromptDeliveryStatus {
  return (
    typeof value === 'string' &&
    OPENCODE_PROMPT_DELIVERY_STATUSES.has(value as OpenCodePromptDeliveryStatus)
  );
}

function isOpenCodeDeliveryResponseState(value: unknown): value is OpenCodeDeliveryResponseState {
  return (
    typeof value === 'string' &&
    OPENCODE_DELIVERY_RESPONSE_STATES.has(value as OpenCodeDeliveryResponseState)
  );
}

function isOpenCodePromptDeliverySource(
  value: unknown
): value is OpenCodePromptDeliveryLedgerRecord['source'] {
  return (
    typeof value === 'string' &&
    OPENCODE_PROMPT_DELIVERY_SOURCES.has(value as OpenCodePromptDeliveryLedgerRecord['source'])
  );
}

function isOptionalNullableVisibleReplyCorrelation(
  value: unknown
): value is OpenCodeDeliveryVisibleReplyCorrelation | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' &&
      OPENCODE_DELIVERY_VISIBLE_REPLY_CORRELATIONS.has(
        value as OpenCodeDeliveryVisibleReplyCorrelation
      ))
  );
}

function isOptionalNullableActionMode(value: unknown): value is AgentActionMode | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && AGENT_ACTION_MODES.has(value as AgentActionMode))
  );
}

function isOptionalNullableInboxMessageKind(
  value: unknown
): value is InboxMessageKind | null | undefined {
  return (
    value === undefined ||
    value === null ||
    value === 'default' ||
    value === 'slash_command' ||
    value === 'slash_command_result' ||
    value === 'task_comment_notification' ||
    value === 'task_stall_remediation' ||
    value === 'member_work_sync_nudge' ||
    value === 'runtime_recovery_nudge' ||
    value === 'agent_error'
  );
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value);
}

function isTaskRefArray(value: unknown): value is TaskRef[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false;
      }
      const taskRef = item as Record<string, unknown>;
      return (
        typeof taskRef.taskId === 'string' &&
        typeof taskRef.displayId === 'string' &&
        typeof taskRef.teamName === 'string'
      );
    })
  );
}

function isTerminalForAutomaticSelection(record: OpenCodePromptDeliveryLedgerRecord): boolean {
  if (
    record.status === 'responded' &&
    record.responseState === 'responded_plain_text' &&
    !record.visibleReplyMessageId &&
    !record.inboxReadCommittedAt
  ) {
    return false;
  }
  return record.status === 'failed_terminal' || record.status === 'responded';
}

function compareOpenCodePromptDeliveryDueOrder(
  left: OpenCodePromptDeliveryLedgerRecord,
  right: OpenCodePromptDeliveryLedgerRecord
): number {
  const leftDue = left.nextAttemptAt ? Date.parse(left.nextAttemptAt) : Date.parse(left.createdAt);
  const rightDue = right.nextAttemptAt
    ? Date.parse(right.nextAttemptAt)
    : Date.parse(right.createdAt);
  const dueDelta = safeSortableTime(leftDue) - safeSortableTime(rightDue);
  if (dueDelta !== 0) {
    return dueDelta;
  }
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function safeSortableTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function shouldPruneOpenCodePromptDeliveryRecord(
  record: OpenCodePromptDeliveryLedgerRecord,
  nowMs: number,
  respondedRetentionMs: number,
  failedRetentionMs: number
): boolean {
  if (record.status === 'responded' && record.inboxReadCommittedAt) {
    const committedMs = Date.parse(record.inboxReadCommittedAt);
    return Number.isFinite(committedMs) && nowMs - committedMs >= respondedRetentionMs;
  }
  if (record.status === 'failed_terminal') {
    const failedMs = Date.parse(record.failedAt ?? record.updatedAt);
    return Number.isFinite(failedMs) && nowMs - failedMs >= failedRetentionMs;
  }
  return false;
}

function selectOpenCodeDestinationProofInsufficientReason(
  diagnostics: readonly string[] | undefined
): string {
  const normalizedDiagnostics = (diagnostics ?? []).map((diagnostic) =>
    diagnostic.trim().toLowerCase()
  );
  if (
    normalizedDiagnostics.includes('visible_reply_missing_task_refs') ||
    normalizedDiagnostics.includes('visible_reply_missing_task_refs_after_merge') ||
    normalizedDiagnostics.includes('visible_reply_task_refs_merge_failed')
  ) {
    return 'visible_reply_missing_task_refs';
  }
  return 'visible_reply_ack_only_still_requires_answer';
}

function mergeDiagnostics(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next].filter((item) => item.trim()))];
}

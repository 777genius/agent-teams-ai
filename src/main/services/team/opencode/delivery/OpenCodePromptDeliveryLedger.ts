import { stableHash } from '../bridge/OpenCodeBridgeCommandContract';
import { VersionedJsonStore, VersionedJsonStoreError } from '../store/VersionedJsonStore';

import type { AgentActionMode, TaskRef } from '@shared/types/team';
import type {
  OpenCodeDeliveryResponseObservation,
  OpenCodeDeliveryResponseState,
  OpenCodeDeliveryVisibleReplyCorrelation,
} from '../bridge/OpenCodeBridgeCommandContract';

export const OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION = 1;
export const OPENCODE_PROMPT_DELIVERY_RESPONDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OPENCODE_PROMPT_DELIVERY_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  inboxMessageId: string;
  inboxTimestamp: string;
  source: 'watcher' | 'ui-send' | 'manual' | 'watchdog';
  replyRecipient: string;
  actionMode: AgentActionMode | null;
  taskRefs: TaskRef[];
  payloadHash: string;
  status: OpenCodePromptDeliveryStatus;
  responseState: OpenCodeDeliveryResponseState;
  attempts: number;
  maxAttempts: number;
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
  'session_stale',
  'session_error',
  'reconcile_failed',
]);

const OPENCODE_PROMPT_DELIVERY_SOURCES = new Set<OpenCodePromptDeliveryLedgerRecord['source']>([
  'watcher',
  'ui-send',
  'manual',
  'watchdog',
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
  visibleReplyCorrelation: 'relayOfMessageId';
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
        inboxMessageId: input.inboxMessageId,
        inboxTimestamp: input.inboxTimestamp,
        source: input.source,
        replyRecipient: input.replyRecipient,
        actionMode: input.actionMode ?? null,
        taskRefs: input.taskRefs ?? [],
        payloadHash: input.payloadHash,
        status: 'pending',
        responseState: 'not_observed',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
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
      const responded = isOpenCodePromptResponseStateResponded(responseState);
      const unanswered = responseState === 'empty_assistant_turn';
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
        attempts:
          input.accepted || input.attempted === true ? record.attempts + 1 : record.attempts,
        runtimeSessionId: input.sessionId ?? record.runtimeSessionId,
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
        diagnostics: mergeDiagnostics(record.diagnostics, input.diagnostics ?? []),
        updatedAt: input.now,
      };
    });
  }

  async applyObservation(input: {
    id: string;
    responseObservation: OpenCodeDeliveryResponseObservation;
    diagnostics?: string[];
    observedAt: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => {
      const responded = isOpenCodePromptResponseStateResponded(input.responseObservation.state);
      const unanswered = input.responseObservation.state === 'empty_assistant_turn';
      return {
        ...record,
        status: responded
          ? 'responded'
          : unanswered
            ? 'unanswered'
            : record.status === 'pending'
              ? 'accepted'
              : record.status,
        responseState: input.responseObservation.state,
        lastObservedAt: input.observedAt,
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
        diagnostics: mergeDiagnostics(record.diagnostics, input.diagnostics ?? []),
        updatedAt: input.observedAt,
      };
    });
  }

  async applyDestinationProof(
    input: ApplyOpenCodePromptDestinationProofInput
  ): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return await this.updateExisting(input.id, (record) => ({
      ...record,
      status: input.semanticallySufficient ? 'responded' : record.status,
      responseState: 'responded_visible_message',
      lastObservedAt: input.observedAt,
      respondedAt: input.semanticallySufficient
        ? (record.respondedAt ?? input.observedAt)
        : record.respondedAt,
      visibleReplyInbox: input.visibleReplyInbox,
      visibleReplyMessageId: input.visibleReplyMessageId,
      visibleReplyCorrelation: input.visibleReplyCorrelation,
      lastReason: input.semanticallySufficient
        ? record.lastReason
        : 'visible_reply_ack_only_still_requires_answer',
      diagnostics: mergeDiagnostics(record.diagnostics, input.diagnostics ?? []),
      updatedAt: input.observedAt,
    }));
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
  attachments?: Array<{ id?: string; filename?: string; mimeType?: string; size?: number }>;
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
    typeof record.inboxMessageId === 'string' &&
    typeof record.inboxTimestamp === 'string' &&
    isOpenCodePromptDeliverySource(record.source) &&
    typeof record.replyRecipient === 'string' &&
    isOptionalNullableActionMode(record.actionMode) &&
    isTaskRefArray(record.taskRefs) &&
    typeof record.payloadHash === 'string' &&
    isOpenCodePromptDeliveryStatus(record.status) &&
    isOpenCodeDeliveryResponseState(record.responseState) &&
    isNonNegativeInteger(record.attempts) &&
    isNonNegativeInteger(record.maxAttempts) &&
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

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
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

function mergeDiagnostics(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next].filter((item) => item.trim()))];
}

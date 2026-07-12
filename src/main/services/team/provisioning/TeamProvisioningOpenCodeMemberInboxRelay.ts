import {
  hashOpenCodePromptDeliveryPayload,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import { isOpenCodeAttachmentDeliveryFailureReason } from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import {
  INBOX_RELAY_IN_FLIGHT_LEASE_MS,
  isInboxRelayInFlightTimeoutError,
  waitForInboxRelayInFlight,
} from './TeamProvisioningInboxRelayCandidates';
import {
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  hasStableInboxMessageId,
  inferOpenCodeInboxMessageTaskRefs,
  type RelayInboxMessage,
  selectOpenCodeInboxRelayBatch,
} from './TeamProvisioningInboxRelayPolicy';
import { type OpenCodeInboxAttachmentPayloadsResult } from './TeamProvisioningOpenCodeAttachmentPayloads';

import type {
  OpenCodeMemberIdentityResolution,
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliverySource,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { OpenCodeVisibleReplyProof } from '../opencode/delivery/OpenCodePromptDeliveryWatchdog';
import type { AgentActionMode, InboxMessage, TaskRef, TeamTask } from '@shared/types';

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

export interface RelayOpenCodeMemberInboxMessagesInput {
  teamName: string;
  memberName: string;
  relayKey: string;
  options?: OpenCodeMemberInboxRelayOptions;
}

export interface RelayOpenCodeMemberInboxMessagesPorts {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  readInboxMessages(teamName: string, memberName: string): Promise<readonly InboxMessage[]>;
  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs: number;
  }): void;
  isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean>;
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution>;
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
  requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  applyDestinationProof(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    replyRecipient: string;
    memberName: string;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }>;
  isOpenCodeDeliveryResponseReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    responseState?: OpenCodePromptDeliveryLedgerRecord['responseState'];
    actionMode?: AgentActionMode;
    taskRefs: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<boolean>;
  markInboxMessagesRead(
    teamName: string,
    memberName: string,
    messages: RelayInboxMessage[]
  ): Promise<void>;
  logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  readTaskRefInferenceTasks(teamName: string): Promise<readonly TeamTask[]>;
  resolveOpenCodeInboxAttachmentPayloads(input: {
    teamName: string;
    message: RelayInboxMessage;
  }): Promise<OpenCodeInboxAttachmentPayloadsResult>;
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  markOpenCodePromptLedgerFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery>;
  suppressRuntimeInactiveWarning(teamName: string): boolean;
  logWarning(message: string): void;
  nowIso(): string;
  getErrorMessage(error: unknown): string;
}

export interface OpenCodeMemberInboxDeliveryWakeInput {
  teamName: string;
  memberName: string;
  messageId: string;
  delayMs?: number;
}

export interface OpenCodeMemberInboxDeliveryWakePorts {
  watchdogScheduler: {
    isEnabled(): boolean;
  };
  scheduleWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs: number;
  }): void;
}

interface OpenCodeMemberInboxRelayLease {
  generation: number;
  work: Promise<OpenCodeMemberInboxRelayResult>;
  expiresAtMs: number;
  expiryHandle: ReturnType<typeof setTimeout> | null;
}

const openCodeMemberInboxRelayLeases = new WeakMap<
  Map<string, Promise<OpenCodeMemberInboxRelayResult>>,
  Map<string, OpenCodeMemberInboxRelayLease>
>();
let nextOpenCodeMemberInboxRelayGeneration = 0;

function getOpenCodeMemberInboxRelayLeaseStore(
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>
): Map<string, OpenCodeMemberInboxRelayLease> {
  let leases = openCodeMemberInboxRelayLeases.get(inFlight);
  if (!leases) {
    leases = new Map();
    openCodeMemberInboxRelayLeases.set(inFlight, leases);
  }
  return leases;
}

function releaseOpenCodeMemberInboxRelayLease(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  lease: OpenCodeMemberInboxRelayLease;
}): void {
  const leases = getOpenCodeMemberInboxRelayLeaseStore(input.inFlight);
  if (leases.get(input.relayKey)?.generation !== input.lease.generation) {
    return;
  }
  if (input.inFlight.get(input.relayKey) === input.lease.work) {
    input.inFlight.delete(input.relayKey);
  }
  if (input.lease.expiryHandle) {
    clearTimeout(input.lease.expiryHandle);
  }
  leases.delete(input.relayKey);
}

function claimOpenCodeMemberInboxRelayLease(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  work: Promise<OpenCodeMemberInboxRelayResult>;
  nowMs?: number;
}): OpenCodeMemberInboxRelayLease {
  const leases = getOpenCodeMemberInboxRelayLeaseStore(input.inFlight);
  const existingLease = leases.get(input.relayKey);
  if (existingLease?.work === input.work) {
    return existingLease;
  }

  const lease: OpenCodeMemberInboxRelayLease = {
    generation: ++nextOpenCodeMemberInboxRelayGeneration,
    work: input.work,
    expiresAtMs: (input.nowMs ?? Date.now()) + INBOX_RELAY_IN_FLIGHT_LEASE_MS,
    expiryHandle: null,
  };
  leases.set(input.relayKey, lease);
  lease.expiryHandle = setTimeout(
    () => releaseOpenCodeMemberInboxRelayLease({ ...input, lease }),
    INBOX_RELAY_IN_FLIGHT_LEASE_MS
  );
  lease.expiryHandle.unref?.();
  void input.work.then(
    () => releaseOpenCodeMemberInboxRelayLease({ ...input, lease }),
    () => releaseOpenCodeMemberInboxRelayLease({ ...input, lease })
  );
  return lease;
}

function getActiveOpenCodeMemberInboxRelayWork(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  nowMs?: number;
}): Promise<OpenCodeMemberInboxRelayResult> | undefined {
  const work = input.inFlight.get(input.relayKey);
  if (!work) {
    return undefined;
  }
  const nowMs = input.nowMs ?? Date.now();
  const lease = claimOpenCodeMemberInboxRelayLease({ ...input, work, nowMs });
  if (nowMs < lease.expiresAtMs) {
    return work;
  }
  releaseOpenCodeMemberInboxRelayLease({ ...input, lease });
  return undefined;
}

function registerOpenCodeMemberInboxRelayWork(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  work: Promise<OpenCodeMemberInboxRelayResult>;
}): void {
  input.inFlight.set(input.relayKey, input.work);
  claimOpenCodeMemberInboxRelayLease(input);
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

export function scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
  input: OpenCodeMemberInboxDeliveryWakeInput,
  ports: OpenCodeMemberInboxDeliveryWakePorts
): boolean {
  const teamName = input.teamName.trim();
  const memberName = input.memberName.trim();
  const messageId = input.messageId.trim();
  if (!teamName || !memberName || !messageId || !ports.watchdogScheduler.isEnabled()) {
    return false;
  }

  ports.scheduleWake({
    teamName,
    memberName,
    messageId,
    delayMs: Math.max(0, input.delayMs ?? 500),
  });
  return true;
}

export async function relayOpenCodeMemberInboxMessagesWithPorts(
  input: RelayOpenCodeMemberInboxMessagesInput,
  ports: RelayOpenCodeMemberInboxMessagesPorts
): Promise<OpenCodeMemberInboxRelayResult> {
  const { teamName, memberName, relayKey } = input;
  const options = input.options ?? {};
  const existing = getActiveOpenCodeMemberInboxRelayWork({
    inFlight: ports.inFlight,
    relayKey,
  });
  if (existing) {
    const onlyMessageId = options.onlyMessageId?.trim();
    if (!onlyMessageId) {
      try {
        return await waitForInboxRelayInFlight({
          promise: existing,
          relayName: 'opencode_member_inbox_relay',
          relayKey,
        });
      } catch (error) {
        if (!isInboxRelayInFlightTimeoutError(error)) {
          throw error;
        }
        const diagnostic = `opencode_member_inbox_relay_timed_out: ${ports.getErrorMessage(error)}`;
        ports.logWarning(`[${teamName}] ${diagnostic}`);
        return buildOpenCodeMemberInboxRelayTimeoutResult({ diagnostic, attempted: 0 });
      }
    }
    const inboxMessages = await ports.readInboxMessages(teamName, memberName).catch(() => []);
    const targetMessage = inboxMessages.find((message) => message.messageId === onlyMessageId);
    if (targetMessage?.read) {
      if (targetMessage.messageKind === 'member_work_sync_nudge') {
        ports.scheduleOpenCodeMemberInboxDeliveryWake({
          teamName,
          memberName,
          messageId: onlyMessageId,
          delayMs: 500,
        });
        return buildOpenCodeMemberWorkSyncReadWaitingResult(onlyMessageId);
      }
      const alreadyReadRecord = await readOpenCodeAlreadyReadProofRecord({
        teamName,
        memberName,
        messageId: onlyMessageId,
        ports,
      });
      return buildOpenCodeMemberInboxAlreadyReadResult(alreadyReadRecord);
    }
    if (!targetMessage) {
      return buildOpenCodeMemberInboxMessageMissingResult({
        messageId: onlyMessageId,
        reason: 'opencode_inbox_message_missing_after_inflight_relay',
      });
    }

    ports.scheduleOpenCodeMemberInboxDeliveryWake({
      teamName,
      memberName,
      messageId: onlyMessageId,
      delayMs: 500,
    });
    return buildOpenCodeMemberInboxQueuedBehindResult({ relayKey, messageId: onlyMessageId });
  }

  const generation: { work?: Promise<OpenCodeMemberInboxRelayResult> } = {};
  const isCurrentGeneration = (): boolean => ports.inFlight.get(relayKey) === generation.work;
  const work = runOpenCodeMemberInboxRelayWork(input, ports, isCurrentGeneration);
  generation.work = work;

  registerOpenCodeMemberInboxRelayWork({ inFlight: ports.inFlight, relayKey, work });
  try {
    return await waitForInboxRelayInFlight({
      promise: work,
      relayName: 'opencode_member_inbox_relay',
      relayKey,
    });
  } catch (error) {
    if (!isInboxRelayInFlightTimeoutError(error)) {
      throw error;
    }
    const diagnostic = `opencode_member_inbox_relay_timed_out: ${ports.getErrorMessage(error)}`;
    ports.logWarning(`[${teamName}] ${diagnostic}`);
    return buildOpenCodeMemberInboxRelayTimeoutResult({
      diagnostic,
      attempted: options.onlyMessageId ? 1 : 0,
    });
  }
}

async function readOpenCodeAlreadyReadProofRecord(input: {
  teamName: string;
  memberName: string;
  messageId: string;
  ports: RelayOpenCodeMemberInboxMessagesPorts;
}): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
  try {
    if (!(await input.ports.isOpenCodeRuntimeRecipient(input.teamName, input.memberName))) {
      return null;
    }
    const memberIdentity = await input.ports.resolveOpenCodeMemberDeliveryIdentity(
      input.teamName,
      input.memberName
    );
    if (!memberIdentity.ok) {
      return null;
    }
    return await input.ports
      .createOpenCodePromptDeliveryLedger(input.teamName, memberIdentity.laneId)
      .getByInboxMessage({
        teamName: input.teamName,
        memberName: memberIdentity.canonicalMemberName,
        laneId: memberIdentity.laneId,
        inboxMessageId: input.messageId,
      });
  } catch {
    return null;
  }
}

async function runOpenCodeMemberInboxRelayWork(
  input: RelayOpenCodeMemberInboxMessagesInput,
  ports: RelayOpenCodeMemberInboxMessagesPorts,
  isCurrentGeneration: () => boolean
): Promise<OpenCodeMemberInboxRelayResult> {
  const { teamName, memberName } = input;
  const options = input.options ?? {};
  const result = createOpenCodeMemberInboxRelayResult();
  const isRuntimeRecipient = await ports.isOpenCodeRuntimeRecipient(teamName, memberName);
  if (!isCurrentGeneration()) {
    return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
  }
  if (!isRuntimeRecipient) {
    result.lastDelivery = { delivered: false, reason: 'recipient_is_not_opencode' };
    return result;
  }
  const memberIdentity = await ports.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName);
  if (!isCurrentGeneration()) {
    return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
  }
  if (!memberIdentity.ok) {
    result.lastDelivery = { delivered: false, reason: memberIdentity.reason };
    return result;
  }
  const promptLedger = ports.createOpenCodePromptDeliveryLedger(teamName, memberIdentity.laneId);

  let inboxMessages: readonly InboxMessage[] = [];
  try {
    inboxMessages = await ports.readInboxMessages(teamName, memberName);
  } catch (error) {
    const diagnostic = `opencode_inbox_read_failed: ${ports.getErrorMessage(error)}`;
    return buildOpenCodeInboxReadFailedResult(diagnostic);
  }
  if (!isCurrentGeneration()) {
    return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
  }

  const onlyMessageId = options.onlyMessageId?.trim();
  if (onlyMessageId) {
    const targetMessage = inboxMessages.find((message) => message.messageId === onlyMessageId);
    if (targetMessage?.read && targetMessage.messageKind !== 'member_work_sync_nudge') {
      const alreadyReadRecord = await promptLedger
        .getByInboxMessage({
          teamName,
          memberName: memberIdentity.canonicalMemberName,
          laneId: memberIdentity.laneId,
          inboxMessageId: onlyMessageId,
        })
        .catch(() => null);
      if (!isCurrentGeneration()) {
        return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
      }
      return buildOpenCodeMemberInboxAlreadyReadResult(alreadyReadRecord);
    }
    if (!targetMessage) {
      return buildOpenCodeMemberInboxMessageMissingResult({
        messageId: onlyMessageId,
        reason: 'opencode_inbox_message_missing',
      });
    }
  }
  const unread = selectOpenCodeMemberInboxRelayUnreadMessages({
    inboxMessages,
    onlyMessageId,
    // Terminal ledger rows remain unread so they can be recovered later. Scan the
    // full ordered inbox here; otherwise a batch-sized prefix of terminal rows
    // permanently starves every deliverable message behind it.
    maxRelay: inboxMessages.length,
  });

  let taskRefInferenceTasks: Promise<readonly TeamTask[]> | null = null;
  const readTaskRefInferenceTasks = (): Promise<readonly TeamTask[]> => {
    taskRefInferenceTasks ??= ports.readTaskRefInferenceTasks(teamName).catch(() => []);
    return taskRefInferenceTasks;
  };

  for (const message of unread) {
    let existingRecord = await promptLedger
      .getByInboxMessage({
        teamName,
        memberName: memberIdentity.canonicalMemberName,
        laneId: memberIdentity.laneId,
        inboxMessageId: message.messageId,
      })
      .catch(() => null);
    if (!isCurrentGeneration()) {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    if (existingRecord?.status === 'failed_terminal') {
      const requeuedRecord = await ports.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded({
        ledger: promptLedger,
        ledgerRecord: existingRecord,
      });
      if (!isCurrentGeneration()) {
        return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
      }
      if (requeuedRecord.status !== 'failed_terminal') {
        existingRecord = requeuedRecord;
      }
    }
    if (existingRecord?.status === 'failed_terminal') {
      const requeuedRecord = await ports.requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded({
        ledger: promptLedger,
        ledgerRecord: existingRecord,
      });
      if (!isCurrentGeneration()) {
        return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
      }
      if (requeuedRecord.status !== 'failed_terminal') {
        existingRecord = requeuedRecord;
      }
    }
    if (existingRecord?.status === 'failed_terminal') {
      let recoveredRecord: OpenCodePromptDeliveryLedgerRecord | null = null;
      let recoveredVisibleReply: OpenCodeVisibleReplyProof | null = null;
      if (typeof promptLedger.applyDestinationProof === 'function') {
        try {
          const proof = await ports.applyDestinationProof({
            ledger: promptLedger,
            ledgerRecord: existingRecord,
            teamName,
            replyRecipient: existingRecord.replyRecipient,
            memberName: memberIdentity.canonicalMemberName,
          });
          recoveredRecord = proof.ledgerRecord;
          recoveredVisibleReply = proof.visibleReply;
        } catch {
          recoveredRecord = null;
          recoveredVisibleReply = null;
        }
      }
      if (!isCurrentGeneration()) {
        return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
      }
      const recoveredReadAllowed = recoveredRecord
        ? await ports.isOpenCodeDeliveryResponseReadCommitAllowed({
            teamName,
            memberName: memberIdentity.canonicalMemberName,
            responseState: recoveredRecord.responseState,
            actionMode: recoveredRecord.actionMode ?? undefined,
            taskRefs: recoveredRecord.taskRefs,
            visibleReply: recoveredVisibleReply,
            ledgerRecord: recoveredRecord,
          })
        : false;
      if (!isCurrentGeneration()) {
        return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
      }
      if (recoveredRecord && recoveredReadAllowed) {
        try {
          await ports.markInboxMessagesRead(teamName, memberName, [message]);
          const committed = await promptLedger.markInboxReadCommitted({
            id: recoveredRecord.id,
            committedAt: ports.nowIso(),
          });
          ports.logOpenCodePromptDeliveryEvent(
            'opencode_prompt_delivery_inbox_committed_read',
            committed,
            { recoveredTerminal: true }
          );
          result.delivered += 1;
          result.relayed += 1;
          result.lastDelivery = {
            delivered: true,
            accepted: true,
            responsePending: false,
            responseState: committed.responseState,
            ledgerStatus: committed.status,
            ledgerRecordId: committed.id,
            laneId: memberIdentity.laneId,
            visibleReplyMessageId: committed.visibleReplyMessageId ?? undefined,
            visibleReplyCorrelation: committed.visibleReplyCorrelation ?? undefined,
            diagnostics: committed.diagnostics,
          };
          break;
        } catch (error) {
          const diagnostic = `opencode_inbox_mark_read_failed_after_terminal_recovery: ${ports.getErrorMessage(
            error
          )}`;
          result.failed += 1;
          result.lastDelivery = {
            delivered: false,
            reason: 'opencode_inbox_mark_read_failed_after_terminal_recovery',
            diagnostics: [diagnostic],
          };
          result.diagnostics = [...(result.diagnostics ?? []), diagnostic];
          break;
        }
      }
      const diagnostic =
        existingRecord.lastReason ??
        `opencode_prompt_delivery_failed_terminal: ${message.messageId}`;
      result.diagnostics = [...(result.diagnostics ?? []), diagnostic];
      if (onlyMessageId) {
        result.failed += 1;
        result.lastDelivery = {
          delivered: false,
          accepted: false,
          ledgerStatus: existingRecord.status,
          ledgerRecordId: existingRecord.id,
          laneId: memberIdentity.laneId,
          reason: existingRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
          diagnostics: existingRecord.diagnostics.length
            ? existingRecord.diagnostics
            : [diagnostic],
        };
      }
      continue;
    }
    const existingTaskRefs = existingRecord?.taskRefs?.length ? existingRecord.taskRefs : undefined;
    const metadataTaskRefs = options.deliveryMetadata?.taskRefs?.length
      ? options.deliveryMetadata.taskRefs
      : undefined;
    const messageTaskRefs = message.taskRefs?.length ? message.taskRefs : undefined;
    const inferredTaskRefs =
      existingTaskRefs || metadataTaskRefs || messageTaskRefs
        ? []
        : await inferOpenCodeInboxMessageTaskRefs({
            teamName,
            message,
            readTasks: readTaskRefInferenceTasks,
          });
    if (!isCurrentGeneration()) {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    const deliveryDecision = resolveOpenCodeMemberInboxDeliveryDecision({
      memberName,
      message,
      existingRecord,
      deliveryMetadata: options.deliveryMetadata,
      inferredTaskRefs,
      source: options.source,
    });
    result.attempted += 1;
    const attachmentPayloads = await ports.resolveOpenCodeInboxAttachmentPayloads({
      teamName,
      message,
    });
    if (!isCurrentGeneration()) {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    if (!attachmentPayloads.ok) {
      const attachmentFailure = await handleOpenCodeInboxAttachmentFailure({
        teamName,
        canonicalMemberName: memberIdentity.canonicalMemberName,
        laneId: memberIdentity.laneId,
        message,
        existingRecord,
        decision: deliveryDecision,
        attachmentPayloads,
        ports: {
          ledger: promptLedger,
          resolveCurrentOpenCodeRuntimeRunId: ports.resolveCurrentOpenCodeRuntimeRunId,
          markFailedTerminal: ports.markOpenCodePromptLedgerFailedTerminal,
          logPromptDeliveryEvent: ports.logOpenCodePromptDeliveryEvent,
          nowIso: ports.nowIso,
          getErrorMessage: ports.getErrorMessage,
        },
      });
      result.failed += attachmentFailure.failed;
      result.diagnostics = [
        ...(result.diagnostics ?? []),
        ...(attachmentFailure.diagnostics ?? []),
      ];
      result.lastDelivery = attachmentFailure.lastDelivery;
      break;
    }
    if (!isCurrentGeneration()) {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    const delivery = await ports.deliverOpenCodeMemberMessage(teamName, {
      memberName,
      text: message.text,
      messageId: message.messageId,
      replyRecipient: deliveryDecision.replyRecipient,
      actionMode: deliveryDecision.actionMode ?? undefined,
      messageKind: message.messageKind,
      workSyncIntent: message.workSyncIntent,
      workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
      taskRefs: deliveryDecision.taskRefs,
      attachments: attachmentPayloads.attachments,
      source: deliveryDecision.source,
      inboxTimestamp: message.timestamp,
    });
    result.lastDelivery = delivery;
    if (!delivery.delivered) {
      const failureProjection = projectOpenCodeInboxDeliveryFailure({
        delivery,
        suppressRuntimeInactiveWarning: ports.suppressRuntimeInactiveWarning(teamName),
      });
      result.failed += failureProjection.result.failed;
      result.diagnostics = [
        ...(result.diagnostics ?? []),
        ...(failureProjection.result.diagnostics ?? []),
      ];
      result.lastDelivery = failureProjection.result.lastDelivery;
      if (failureProjection.shouldLogWarning) {
        ports.logWarning(
          `[${teamName}] OpenCode inbox relay failed for ${memberName}/${message.messageId}: ${
            delivery.reason ?? 'unknown error'
          }`
        );
      }
      break;
    }
    if (delivery.responsePending) {
      result.diagnostics = [
        ...(result.diagnostics ?? []),
        ...(delivery.diagnostics ?? [delivery.reason ?? 'opencode_delivery_response_pending']),
      ];
      break;
    }
    const readCommit = await commitOpenCodeInboxRelayReadAfterDelivery({
      teamName,
      memberName,
      message,
      delivery,
      ports: {
        markInboxMessagesRead: ports.markInboxMessagesRead,
        createOpenCodePromptDeliveryLedger: ports.createOpenCodePromptDeliveryLedger,
        logPromptDeliveryEvent: ports.logOpenCodePromptDeliveryEvent,
        nowIso: ports.nowIso,
        getErrorMessage: ports.getErrorMessage,
      },
    });
    if (!readCommit.ok) {
      result.failed += readCommit.result.failed;
      result.lastDelivery = readCommit.result.lastDelivery;
      result.diagnostics = [
        ...(result.diagnostics ?? []),
        ...(readCommit.result.diagnostics ?? []),
      ];
      ports.logWarning(`[${teamName}] ${readCommit.diagnostic}`);
      break;
    }
    result.delivered += 1;
    result.relayed += 1;
    break;
  }

  return dedupeOpenCodeMemberInboxRelayDiagnostics(result);
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

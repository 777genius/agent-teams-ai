import { OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT } from '../opencode/delivery/OpenCodeDeliveryReplyContract';
import { OpenCodePromptDeliveryCancelledError } from '../opencode/delivery/OpenCodePromptDeliveryCancellationGuard';
import {
  hashOpenCodePromptDeliveryPayload,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import { OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS } from '../opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { isOpenCodeAttachmentDeliveryFailureReason } from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import {
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
import {
  buildOpenCodeCoalesceDeferredDiagnostic,
  buildOpenCodeCoalescedNoticeText,
  buildOpenCodeCoalesceNotDispatchedDiagnostic,
  canCoalesceNoticesIntoOpenCodeDelivery,
  findNextUnreadUserMessageIndex,
  isOpenCodeCoalescedNoticeDeliveryProven,
  type OpenCodeReplyOptionalCoalescePorts,
  selectOpenCodeReplyOptionalCoalescedFollowers,
} from './TeamProvisioningOpenCodeInboxCoalescePolicy';
import {
  commitOpenCodeAlreadyReadInboxRow,
  isOpenCodeInboxReadCommitOwed,
  recoverOpenCodeOwedInboxReadCommit,
} from './TeamProvisioningOpenCodeInboxReadCommitRecovery';
import {
  getActiveOpenCodeMemberInboxRelayWork,
  registerOpenCodeMemberInboxRelayWork,
} from './TeamProvisioningOpenCodeMemberInboxRelayLease';
import {
  buildOpenCodeInboxReadFailedResult,
  buildOpenCodeMemberInboxAlreadyReadResult,
  buildOpenCodeMemberInboxMessageMissingResult,
  buildOpenCodeMemberInboxQueuedBehindResult,
  buildOpenCodeMemberInboxRelaySupersededResult,
  buildOpenCodeMemberInboxRelayTimeoutResult,
  buildOpenCodeMemberWorkSyncReadWaitingResult,
  createOpenCodeMemberInboxRelayResult,
  dedupeOpenCodeMemberInboxRelayDiagnostics,
  type OpenCodeMemberInboxRelayResult,
} from './TeamProvisioningOpenCodeMemberInboxRelayResults';
import { settleOpenCodePostCompletionNotices } from './TeamProvisioningOpenCodePostCompletionSettlement';

import type {
  OpenCodeMemberIdentityResolution,
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliverySource,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodeVisibleReplyProof } from '../opencode/delivery/OpenCodePromptDeliveryWatchdog';
import type { AgentActionMode, InboxMessage, TaskRef, TeamTask } from '@shared/types';

export { scheduleOpenCodeMemberInboxDeliveryWakeWithPorts } from './TeamProvisioningOpenCodeMemberInboxDeliveryWake';
export type { OpenCodeMemberInboxRelayResult } from './TeamProvisioningOpenCodeMemberInboxRelayResults';

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
    checkpoint?: () => void | Promise<void>;
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
      let alreadyReadRecord = await promptLedger
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
      if (alreadyReadRecord && !alreadyReadRecord.inboxReadCommittedAt) {
        // The read row IS the double-delivery guard; a missing ledger stamp is
        // bookkeeping drift that keeps this record looking like unfinished
        // work. Align the ledger with the row.
        alreadyReadRecord = await commitOpenCodeAlreadyReadInboxRow({
          ledger: promptLedger,
          record: alreadyReadRecord,
          ports,
        });
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

  // A rider that did not travel with this prompt must still get a turn of its
  // own: the anchor's read-commit usually re-fires the inbox watcher, but a
  // delivery that writes no inbox row would otherwise leave the rider waiting.
  const scheduleOpenCodeCoalesceRiderWake = (rider?: RelayInboxMessage): void => {
    if (!rider || rider.read) return;
    ports.scheduleOpenCodeMemberInboxDeliveryWake({
      teamName,
      memberName,
      messageId: rider.messageId,
      delayMs: OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
    });
  };

  let taskRefInferenceTasks: Promise<readonly TeamTask[]> | null = null;
  const readTaskRefInferenceTasks = (): Promise<readonly TeamTask[]> => {
    taskRefInferenceTasks ??= ports.readTaskRefInferenceTasks(teamName).catch(() => []);
    return taskRefInferenceTasks;
  };

  // How a queued row is judged as a follower: by its own reply contract and its
  // own ledger state, never by the anchor's. Both the coalescing prompt and the
  // post-completion read-commit select followers this way.
  const coalescePorts: OpenCodeReplyOptionalCoalescePorts = {
    resolveReplyRecipient: (candidate) =>
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName,
        message: candidate,
        existingRecord: null,
        deliveryMetadata: options.deliveryMetadata,
        inferredTaskRefs: [],
        source: options.source,
      }).replyRecipient,
    hasExistingRecord: async (candidate) =>
      Boolean(
        await promptLedger
          .getByInboxMessage({
            teamName,
            memberName: memberIdentity.canonicalMemberName,
            laneId: memberIdentity.laneId,
            inboxMessageId: candidate.messageId,
          })
          .catch(() => null)
      ),
  };

  // Cursor-driven walk: a pending non-user delivery may skip ahead to a newer
  // user message (see findNextUnreadUserMessageIndex) instead of breaking.
  let cursor = 0;
  while (cursor < unread.length) {
    const index = cursor;
    cursor += 1;
    const message = unread[index];
    if (!message) {
      break;
    }
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
    if (existingRecord && isOpenCodeInboxReadCommitOwed(existingRecord)) {
      // The read flag is still owed for this row: the retry budget is spent, or
      // the record settled 'responded' through a pass that never came back to
      // commit. Settle it from existing proof, without a delivery attempt.
      const recovery = await recoverOpenCodeOwedInboxReadCommit({
        teamName,
        memberName,
        canonicalMemberName: memberIdentity.canonicalMemberName,
        laneId: memberIdentity.laneId,
        message,
        ledger: promptLedger,
        ledgerRecord: existingRecord,
        shouldAbort: () => !isCurrentGeneration(),
        checkpoint: () => {
          if (!isCurrentGeneration()) throw new OpenCodePromptDeliveryCancelledError();
        },
        ports,
      });
      if (recovery.outcome === 'aborted') {
        return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
      }
      if (recovery.outcome === 'committed') {
        result.delivered += 1;
        result.relayed += 1;
        result.lastDelivery = recovery.delivery;
        break;
      }
      if (recovery.outcome === 'commit_failed') {
        result.failed += 1;
        result.lastDelivery = recovery.delivery;
        result.diagnostics = [...(result.diagnostics ?? []), recovery.diagnostic];
        break;
      }
      if (existingRecord.status === 'failed_terminal') {
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
      // 'responded' without recoverable proof: fall through to the normal
      // delivery path below - its observe pass, and the plain-text
      // materialization, are what produce the missing proof.
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
    // Settled team (board complete, final user message already sent): this
    // notice and the reply-optional notices behind it are read-committed
    // without spending a runtime turn on any of them.
    const settlement = await settleOpenCodePostCompletionNotices({
      unread,
      index,
      anchorReplyRecipient: deliveryDecision.replyRecipient,
      anchorHasLedgerRecord: Boolean(existingRecord),
      ports: {
        ...coalescePorts,
        readTasks: readTaskRefInferenceTasks,
        readTasksAfterCommit: () => ports.readTaskRefInferenceTasks(teamName),
        readUserInbox: () => ports.readInboxMessages(teamName, 'user'),
        markRead: (messages) => ports.markInboxMessagesRead(teamName, memberName, messages),
        logReadCommitFailure: (error) =>
          ports.logWarning(
            `[${teamName}] OpenCode inbox relay could not read-commit settled notices for ${memberName}: ${ports.getErrorMessage(
              error
            )}`
          ),
        isCurrentGeneration,
      },
    });
    if (settlement.kind === 'superseded') {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    if (settlement.kind === 'read_committed') {
      result.relayed += settlement.messages.length;
      result.diagnostics = [...(result.diagnostics ?? []), settlement.diagnostic];
      for (let skipIndex = index + 1; skipIndex < unread.length; skipIndex += 1) {
        if (!settlement.messages.includes(unread[skipIndex])) break;
        cursor = Math.max(cursor, skipIndex + 1);
      }
      continue;
    }
    if (settlement.kind === 'catch_up') {
      // The rows are read, but work reopened during the commit: the anchor is
      // delivered anyway so the reopened board is not announced to nobody.
      result.diagnostics = [...(result.diagnostics ?? []), settlement.diagnostic];
      taskRefInferenceTasks = Promise.resolve(settlement.tasks);
    }
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
    // Reply-optional notices (system/task notifications, teammate reports)
    // that queued up behind this one ride along in the same prompt: one runtime
    // turn instead of one per notice. Draining them one at a time made the lead
    // spend a full turn on every done/started/comment notification, and each
    // turn is memoryless, so it kept re-answering the same finished work.
    // Riders ride along ONLY in a prompt this call actually dispatches, and are
    // marked read only on `coalescedNoticesDelivered` - never on `delivered`.
    const coalesceAllowed = canCoalesceNoticesIntoOpenCodeDelivery(existingRecord);
    const coalescable = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread,
      index,
      anchorReplyRecipient: deliveryDecision.replyRecipient,
      ports: coalescePorts,
    });
    const coalesced = coalesceAllowed ? coalescable : [];
    if (!isCurrentGeneration()) {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    if (!coalesceAllowed && coalescable.length > 0) {
      // Only a rider that would really have ridden along was deferred: an
      // accepted anchor with nothing coalescable behind it was merely observed.
      result.diagnostics = [
        ...(result.diagnostics ?? []),
        buildOpenCodeCoalesceDeferredDiagnostic({
          anchorMessageId: message.messageId,
          deferredMessageId: coalescable[0]?.messageId,
          record: existingRecord,
        }),
      ];
      // The anchor's read-commit normally re-fires the file watcher and the
      // rider becomes its own anchor; an anchor that ends terminally writes no
      // inbox row, so arm an explicit wake too.
      scheduleOpenCodeCoalesceRiderWake(coalescable[0]);
    }
    const delivery = await ports.deliverOpenCodeMemberMessage(teamName, {
      memberName,
      text: message.text,
      ...(coalesced.length
        ? { coalescedNoticeText: buildOpenCodeCoalescedNoticeText(coalesced) }
        : {}),
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
    if (!isCurrentGeneration()) {
      return buildOpenCodeMemberInboxRelaySupersededResult(input.relayKey);
    }
    result.lastDelivery = delivery;
    if (coalesced.length > 0 && isOpenCodeCoalescedNoticeDeliveryProven(delivery)) {
      try {
        await ports.markInboxMessagesRead(teamName, memberName, coalesced);
        result.relayed += coalesced.length;
        result.diagnostics = [
          ...(result.diagnostics ?? []),
          `opencode_inbox_relay_coalesced_notices: ${message.messageId} += ${coalesced
            .map((candidate) => candidate.messageId)
            .join(',')}`,
        ];
      } catch (error) {
        // The riders stay unread and become their own anchors on the next pass.
        // The anchor's own read-commit below is unaffected.
        ports.logWarning(
          `[${teamName}] OpenCode inbox relay could not mark coalesced notices read for ${memberName}: ${ports.getErrorMessage(
            error
          )}`
        );
      }
    } else if (coalesced.length > 0) {
      // The prompt was not dispatched with the riders (observe-only pass, queued
      // behind another record, response already sufficient). Leave them unread.
      result.diagnostics = [
        ...(result.diagnostics ?? []),
        buildOpenCodeCoalesceNotDispatchedDiagnostic({
          anchorMessageId: message.messageId,
          deferredMessageIds: coalesced.map((candidate) => candidate.messageId),
          delivery,
        }),
      ];
      scheduleOpenCodeCoalesceRiderWake(coalesced[0]);
    }
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
      // A pending non-user delivery (teammate report, system/task notification)
      // must not starve a newer user message: hand that message to the delivery
      // service, which queues it until fresh observation settles the blocker.
      const nextUserMessageIndex = findNextUnreadUserMessageIndex({
        unread,
        afterIndex: index,
        currentReplyRecipient: deliveryDecision.replyRecipient,
      });
      if (nextUserMessageIndex > index) {
        cursor = nextUserMessageIndex;
        continue;
      }
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
  const normalizedFrom = typeof input.message.from === 'string' ? input.message.from.trim() : '';
  const senderIsUnaddressable =
    !normalizedFrom ||
    normalizedFrom.toLowerCase() === OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT;
  const existingTaskRefs = input.existingRecord?.taskRefs?.length
    ? input.existingRecord.taskRefs
    : undefined;
  const metadataTaskRefs = input.deliveryMetadata?.taskRefs?.length
    ? input.deliveryMetadata.taskRefs
    : undefined;
  const messageTaskRefs = input.message.taskRefs?.length ? input.message.taskRefs : undefined;
  const taskRefs =
    existingTaskRefs ?? metadataTaskRefs ?? messageTaskRefs ?? input.inferredTaskRefs;
  // System/task notifications and taskRef-carrying messages from unaddressable
  // senders are informational: the informational marker tells the runtime
  // adapter to build an FYI delivery instead of a message_send reply contract.
  // A delivery contract must never point at a recipient message_send rejects.
  // The task references the delivery actually carries decide this, whatever
  // their origin: a notice that names its task only in the text (inferred
  // references) is the same task notice as one carrying structured taskRefs,
  // and both are attached to the delivery below.
  const informationalNotice =
    input.message.source === 'system_notification' ||
    (senderIsUnaddressable && taskRefs.length > 0);
  const fallbackReplyRecipient = informationalNotice
    ? OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT
    : !senderIsUnaddressable &&
        normalizedFrom.toLowerCase() !== input.memberName.trim().toLowerCase()
      ? normalizedFrom
      : 'user';

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
    taskRefs,
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
  if (input.delivery.accepted === true && input.delivery.ledgerStatus !== 'failed_terminal') {
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

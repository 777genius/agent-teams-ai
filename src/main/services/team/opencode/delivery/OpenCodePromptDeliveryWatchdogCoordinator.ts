import { getErrorMessage as defaultGetErrorMessage } from '@shared/utils/errorHandling';

import { isOpenCodePromptDeliveryWatchdogRecordTerminal } from './OpenCodePromptDeliveryFollowUpPolicy';
import {
  hashOpenCodePromptDeliveryPayload,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import {
  buildOpenCodeAcceptedDeliveryMissingPromptProofRetry,
  buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan,
  buildOpenCodePromptLedgerFailedTerminalPlan,
  buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan,
  getOpenCodeDeliveryPendingReason,
  hasOpenCodeObservedMessageSendToolCall,
  isLegacyOpenCodeMemberWorkSyncReadCommitAllowed,
  isOpenCodeDeliveryResponseReadCommitAllowed,
  isOpenCodeDirectUserPromptDelivery,
  normalizeOpenCodeDeliveryResponseObservation,
} from './OpenCodePromptDeliveryReadCommitPolicy';
import {
  OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
  type OpenCodeVisibleReplyProof,
} from './OpenCodePromptDeliveryWatchdog';

import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
} from '../../runtime';
import type { OpenCodeRuntimeMessageAdapter } from './OpenCodeMemberMessageDeliveryService';
import type { OpenCodePromptDeliveryWatchdogScheduler } from './OpenCodePromptDeliveryWatchdogScheduler';
import type { OpenCodeVisibleReplyProofService } from './OpenCodeVisibleReplyProofService';
import type { AgentActionMode, InboxMessage, TaskRef } from '@shared/types/team';

type OpenCodeDeliveryResponseState = NonNullable<
  OpenCodeTeamRuntimeMessageResult['responseObservation']
>['state'];

export interface OpenCodePromptDeliveryWatchdogCoordinatorPorts {
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  taskRefsIncludeAll(
    actual: readonly TaskRef[] | undefined,
    expected: readonly TaskRef[] | undefined
  ): boolean;
  visibleReplyProofService: Pick<
    OpenCodeVisibleReplyProofService,
    'applyDestinationProof' | 'materializePlainTextReplyIfNeeded'
  >;
  maybeSyncRuntimePermissionsAfterDelivery(input: {
    teamName: string;
    runId?: string | null;
    laneId: string;
    memberName: string;
    cwd: string;
    sessionId?: string | null;
    responseState?: OpenCodeDeliveryResponseState;
    reason?: string | null;
    diagnostics?: readonly string[];
  }): Promise<void>;
  rememberRuntimePidFromBridge(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    runId?: string | null;
    runtimeSessionId?: string | null;
    runtimePid?: number;
    reason: string;
  }): Promise<void>;
  watchdogScheduler: Pick<
    OpenCodePromptDeliveryWatchdogScheduler,
    'isEnabled' | 'schedule' | 'isStaleError'
  >;
  schedulePromptDeliveryWatchdog?(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void;
  canDeliverToTeamRuntime(teamName: string): boolean;
  recoverRuntimeLanesForWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime: boolean }
  ): Promise<string[]>;
  stopRuntimeLanesForStoppedTeam(teamName: string): Promise<unknown>;
  readActiveRuntimeLaneIds(teamName: string): Promise<string[] | null>;
  createLedger(teamName: string, laneId: string): OpenCodePromptDeliveryLedgerStore;
  resolveMembersForRuntimeLane(teamName: string, laneId: string): Promise<string[]>;
  getInboxMessages(teamName: string, memberName: string): Promise<InboxMessage[]>;
  resolveCurrentRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  hasStableInboxMessageId(message: InboxMessage): message is InboxMessage & { messageId: string };
  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  info(message: string, context?: string): void;
  warn(message: string): void;
  nowIso(): string;
  sleep(ms: number): Promise<void>;
  getErrorMessage(error: unknown): string;
}

export class OpenCodePromptDeliveryWatchdogCoordinator {
  constructor(private readonly ports: OpenCodePromptDeliveryWatchdogCoordinatorPorts) {}

  async isDeliveryResponseReadCommitAllowed(input: {
    teamName?: string;
    memberName?: string;
    responseState?: OpenCodeDeliveryResponseState;
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): Promise<boolean> {
    return isOpenCodeDeliveryResponseReadCommitAllowed({
      ...input,
      hasAcceptedMemberWorkSyncReport: (report) =>
        this.ports.hasAcceptedMemberWorkSyncReport(report),
      taskRefsIncludeAll: this.ports.taskRefsIncludeAll,
    });
  }

  async isLegacyMemberWorkSyncReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    responseObservation?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>;
  }): Promise<boolean> {
    return isLegacyOpenCodeMemberWorkSyncReadCommitAllowed({
      ...input,
      hasAcceptedMemberWorkSyncReport: (report) =>
        this.ports.hasAcceptedMemberWorkSyncReport(report),
    });
  }

  getDeliveryPendingReason(input: {
    responseState?: OpenCodeDeliveryResponseState;
    actionMode?: AgentActionMode | null;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): string {
    return getOpenCodeDeliveryPendingReason({
      ...input,
      taskRefsIncludeAll: this.ports.taskRefsIncludeAll,
    });
  }

  async markAcceptedDeliveryMissingPromptProofForRetry(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const retryPlan = buildOpenCodeAcceptedDeliveryMissingPromptProofRetry({
      ledgerRecord: input.ledgerRecord,
      now: this.ports.nowIso(),
      eventContext: input.eventContext,
    });
    const ledgerRecord = await input.ledger.markAcceptanceUnknown(retryPlan.markInput);
    this.ports.logPromptDeliveryEvent('opencode_prompt_delivery_retry_scheduled', ledgerRecord, {
      ...retryPlan.eventExtra,
    });
    return ledgerRecord;
  }

  async requeueNoAssistantTerminalDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const requeuePlan = buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan({
      ledgerRecord: input.ledgerRecord,
      scheduledAt: this.ports.nowIso(),
    });
    if (!requeuePlan) {
      return input.ledgerRecord;
    }

    const requeued = await input.ledger.markNextAttemptScheduled(requeuePlan.markInput);
    this.ports.info(requeuePlan.logEvent, JSON.stringify(requeuePlan.logContext));
    return requeued;
  }

  async requeueRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const requeuePlan = buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan({
      ledgerRecord: input.ledgerRecord,
      scheduledAt: this.ports.nowIso(),
    });
    if (!requeuePlan) {
      return input.ledgerRecord;
    }

    const requeued = await input.ledger.markNextAttemptScheduled(requeuePlan.markInput);
    this.ports.info(requeuePlan.logEvent, JSON.stringify(requeuePlan.logContext));
    return requeued;
  }

  async markLedgerFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const failurePlan = buildOpenCodePromptLedgerFailedTerminalPlan({
      id: input.id,
      reason: input.reason,
      diagnostics: input.diagnostics,
      failedAt: input.failedAt,
      eventContext: input.eventContext,
    });
    const failed = await input.ledger.markFailedTerminal(failurePlan.markInput);
    this.ports.logPromptDeliveryEvent('opencode_prompt_delivery_terminal_failure', failed, {
      ...failurePlan.eventExtra,
    });
    return failed;
  }

  async observeDirectUserDeliveryInlineIfNeeded(input: {
    adapter: OpenCodeRuntimeMessageAdapter;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    laneId: string;
    cwd: string;
    text: string;
    messageId: string;
    runtimeRunId?: string | null;
    replyRecipient?: string | null;
    actionMode?: AgentActionMode;
    messageKind?: OpenCodeTeamRuntimeMessageInput['messageKind'];
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    workSyncReviewRequestEventIds?: string[];
    taskRefs?: TaskRef[];
    promptAccepted: boolean;
    visibleReply?: OpenCodeVisibleReplyProof | null;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }> {
    let ledgerRecord = input.ledgerRecord;
    let visibleReply = input.visibleReply ?? null;
    const observeMessageDelivery = input.adapter.observeMessageDelivery;
    const readAllowed = await this.isDeliveryResponseReadCommitAllowed({
      teamName: input.teamName,
      memberName: input.memberName,
      responseState: ledgerRecord.responseState,
      actionMode: ledgerRecord.actionMode ?? undefined,
      taskRefs: ledgerRecord.taskRefs,
      visibleReply,
      ledgerRecord,
    });
    const shouldObserveInline =
      observeMessageDelivery &&
      input.promptAccepted &&
      isOpenCodeDirectUserPromptDelivery(ledgerRecord) &&
      (ledgerRecord.source === 'manual' ||
        (ledgerRecord.responseState === 'tool_error' &&
          hasOpenCodeObservedMessageSendToolCall(ledgerRecord))) &&
      !readAllowed &&
      !visibleReply &&
      !ledgerRecord.visibleReplyMessageId;

    if (!shouldObserveInline || !observeMessageDelivery) {
      return { ledgerRecord, visibleReply };
    }

    for (let inlineObserveAttempt = 1; inlineObserveAttempt <= 4; inlineObserveAttempt += 1) {
      await this.ports.sleep(OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS);
      let observed: OpenCodeTeamRuntimeMessageResult;
      try {
        observed = await observeMessageDelivery.call(input.adapter, {
          ...(input.runtimeRunId ? { runId: input.runtimeRunId } : {}),
          teamName: input.teamName,
          laneId: input.laneId,
          memberName: input.memberName,
          cwd: input.cwd,
          text: input.text,
          messageId: input.messageId,
          replyRecipient: input.replyRecipient ?? undefined,
          actionMode: input.actionMode,
          messageKind: input.messageKind,
          workSyncIntent: input.workSyncIntent,
          workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds,
          taskRefs: input.taskRefs,
          prePromptCursor: ledgerRecord.prePromptCursor,
          sessionId: ledgerRecord.runtimeSessionId ?? undefined,
          runtimePromptMessageId:
            ledgerRecord.lastRuntimePromptMessageId ??
            ledgerRecord.runtimePromptMessageId ??
            undefined,
        });
      } catch (error) {
        const reason = `opencode_direct_user_delivery_inline_observe_failed: ${this.ports.getErrorMessage(
          error
        )}`;
        await this.ports.maybeSyncRuntimePermissionsAfterDelivery({
          teamName: input.teamName,
          runId: input.runtimeRunId,
          laneId: input.laneId,
          memberName: input.memberName,
          cwd: input.cwd,
          sessionId: ledgerRecord.runtimeSessionId,
          reason,
          diagnostics: [
            `opencode_direct_user_delivery_inline_observe_attempt_${inlineObserveAttempt}`,
            reason,
          ],
        });
        ledgerRecord = await input.ledger.applyObservation({
          id: ledgerRecord.id,
          responseObservation: {
            state: 'reconcile_failed',
            deliveredUserMessageId: null,
            assistantMessageId: null,
            toolCallNames: [],
            visibleMessageToolCallId: null,
            visibleReplyMessageId: null,
            visibleReplyCorrelation: null,
            latestAssistantPreview: null,
            reason,
          },
          diagnostics: [
            `opencode_direct_user_delivery_inline_observe_attempt_${inlineObserveAttempt}`,
            reason,
          ],
          observedAt: this.ports.nowIso(),
        });
        break;
      }
      await this.ports.rememberRuntimePidFromBridge({
        teamName: input.teamName,
        memberName: input.memberName,
        laneId: input.laneId,
        runId: input.runtimeRunId,
        runtimeSessionId: observed.sessionId,
        runtimePid: observed.runtimePid,
        reason: 'opencode_delivery_inline_observe_runtime_pid_observed',
      });
      const observedResponse = normalizeOpenCodeDeliveryResponseObservation(
        observed.responseObservation
      );
      await this.ports.maybeSyncRuntimePermissionsAfterDelivery({
        teamName: input.teamName,
        runId: input.runtimeRunId,
        laneId: input.laneId,
        memberName: input.memberName,
        cwd: input.cwd,
        sessionId: observed.sessionId,
        responseState: observedResponse?.state,
        reason: observedResponse?.reason ?? observed.diagnostics[0],
        diagnostics: observed.diagnostics,
      });
      const hadMessageSendToolError = hasOpenCodeObservedMessageSendToolCall(ledgerRecord);
      ledgerRecord = await input.ledger.applyObservation({
        id: ledgerRecord.id,
        responseObservation: observedResponse ?? {
          state: observed.ok ? 'not_observed' : 'reconcile_failed',
          deliveredUserMessageId: null,
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: observed.diagnostics[0] ?? null,
        },
        sessionId: observed.sessionId,
        runtimePromptMessageId: observed.runtimePromptMessageId,
        diagnostics: [
          `opencode_direct_user_delivery_inline_observe_attempt_${inlineObserveAttempt}`,
          ...(hadMessageSendToolError ? ['opencode_message_send_tool_error_inline_observe'] : []),
          ...observed.diagnostics,
        ],
        observedAt: this.ports.nowIso(),
      });
      const proof = await this.ports.visibleReplyProofService.applyDestinationProof({
        ledger: input.ledger,
        ledgerRecord,
        teamName: input.teamName,
        replyRecipient: input.replyRecipient,
        memberName: input.memberName,
      });
      ledgerRecord = proof.ledgerRecord;
      visibleReply = proof.visibleReply;
      const materialized =
        await this.ports.visibleReplyProofService.materializePlainTextReplyIfNeeded({
          ledger: input.ledger,
          ledgerRecord,
          teamName: input.teamName,
          memberName: input.memberName,
          visibleReply,
        });
      ledgerRecord = materialized.ledgerRecord;
      visibleReply = materialized.visibleReply;
      const observedReadAllowed = await this.isDeliveryResponseReadCommitAllowed({
        teamName: input.teamName,
        memberName: input.memberName,
        responseState: ledgerRecord.responseState,
        actionMode: ledgerRecord.actionMode ?? undefined,
        taskRefs: ledgerRecord.taskRefs,
        visibleReply,
        ledgerRecord,
      });
      if (observedReadAllowed) {
        break;
      }
    }

    return { ledgerRecord, visibleReply };
  }

  schedule(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void {
    if (this.ports.schedulePromptDeliveryWatchdog) {
      this.ports.schedulePromptDeliveryWatchdog(input);
      return;
    }
    this.ports.watchdogScheduler.schedule(input);
  }

  async isStaleError(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    error: unknown;
  }): Promise<boolean> {
    return this.ports.watchdogScheduler.isStaleError(input);
  }

  async scan(teamName: string): Promise<number> {
    if (!this.ports.watchdogScheduler.isEnabled()) {
      return 0;
    }
    const canDeliverToTeamRuntime = this.ports.canDeliverToTeamRuntime(teamName);
    const recoveredLaneIds = await this.ports.recoverRuntimeLanesForWatchdog(teamName, {
      allowCommittedSessionRecoveryWithoutTeamRuntime: !canDeliverToTeamRuntime,
    });
    if (!canDeliverToTeamRuntime && recoveredLaneIds.length === 0) {
      await this.ports.stopRuntimeLanesForStoppedTeam(teamName);
      return 0;
    }
    const activeFromIndex = await this.ports.readActiveRuntimeLaneIds(teamName);
    if (!activeFromIndex && recoveredLaneIds.length === 0) {
      return 0;
    }
    const activeLaneIds = [
      ...new Set([...(canDeliverToTeamRuntime ? (activeFromIndex ?? []) : []), ...recoveredLaneIds]),
    ];
    return await this.scanActiveLanes(teamName, activeLaneIds);
  }

  async scanActiveLanes(teamName: string, laneIds: string[]): Promise<number> {
    if (!this.ports.watchdogScheduler.isEnabled()) {
      return 0;
    }
    let scheduled = 0;
    for (const laneId of [...new Set(laneIds.map((laneId) => laneId.trim()).filter(Boolean))]) {
      const ledger = this.ports.createLedger(teamName, laneId);
      await ledger.pruneTerminalRecords({ now: new Date() }).catch((error: unknown) => {
        this.ports.warn(
          `[${teamName}] OpenCode prompt delivery ledger prune failed for ${laneId}: ${this.ports.getErrorMessage(
            error
          )}`
        );
      });
      const records = await ledger.list().catch(() => []);
      for (const record of records) {
        if (isOpenCodePromptDeliveryWatchdogRecordTerminal(record)) {
          continue;
        }
        const nextAttemptMs = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : NaN;
        const delayMs = Number.isFinite(nextAttemptMs)
          ? Math.max(500, nextAttemptMs - Date.now())
          : OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS;
        this.schedule({
          teamName,
          memberName: record.memberName,
          messageId: record.inboxMessageId,
          delayMs,
        });
        scheduled += 1;
      }
      const members = await this.ports.resolveMembersForRuntimeLane(teamName, laneId);
      for (const memberName of members) {
        const inboxMessages = await this.ports.getInboxMessages(teamName, memberName).catch(() => []);
        for (const message of inboxMessages) {
          if (
            message.read ||
            typeof message.text !== 'string' ||
            message.text.trim().length === 0 ||
            !this.ports.hasStableInboxMessageId(message)
          ) {
            continue;
          }
          const existing = await ledger
            .getByInboxMessage({
              teamName,
              memberName,
              laneId,
              inboxMessageId: message.messageId,
            })
            .catch(() => null);
          if (existing) {
            continue;
          }
          const replyRecipient =
            typeof message.from === 'string' &&
            message.from.trim() &&
            message.from.trim().toLowerCase() !== memberName.trim().toLowerCase()
              ? message.from.trim()
              : 'user';
          const now = this.ports.nowIso();
          const record = await ledger.ensurePending({
            teamName,
            memberName,
            laneId,
            runId: await this.ports.resolveCurrentRuntimeRunId(teamName, laneId),
            inboxMessageId: message.messageId,
            inboxTimestamp: message.timestamp,
            source: 'watchdog',
            replyRecipient,
            actionMode: message.actionMode ?? null,
            messageKind: message.messageKind ?? null,
            workSyncIntent: message.workSyncIntent ?? null,
            taskRefs: message.taskRefs ?? [],
            payloadHash: hashOpenCodePromptDeliveryPayload({
              text: message.text,
              replyRecipient,
              actionMode: message.actionMode ?? null,
              taskRefs: message.taskRefs ?? [],
              attachments: message.attachments,
              source: 'watchdog',
            }),
            now,
          });
          const recovered = await ledger.markAcceptanceUnknown({
            id: record.id,
            reason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
            nextAttemptAt: now,
            markedAt: now,
          });
          this.ports.logPromptDeliveryEvent('opencode_prompt_delivery_retry_scheduled', recovered, {
            acceptanceUnknown: true,
            reason: recovered.lastReason,
          });
          this.schedule({
            teamName,
            memberName: recovered.memberName,
            messageId: recovered.inboxMessageId,
            delayMs: 500,
          });
          scheduled += 1;
        }
      }
    }
    return scheduled;
  }
}

export function createOpenCodePromptDeliveryWatchdogCoordinator(
  ports: Partial<OpenCodePromptDeliveryWatchdogCoordinatorPorts> &
    Pick<
      OpenCodePromptDeliveryWatchdogCoordinatorPorts,
      | 'hasAcceptedMemberWorkSyncReport'
      | 'taskRefsIncludeAll'
      | 'visibleReplyProofService'
      | 'maybeSyncRuntimePermissionsAfterDelivery'
      | 'rememberRuntimePidFromBridge'
      | 'watchdogScheduler'
      | 'canDeliverToTeamRuntime'
      | 'recoverRuntimeLanesForWatchdog'
      | 'stopRuntimeLanesForStoppedTeam'
      | 'readActiveRuntimeLaneIds'
      | 'createLedger'
      | 'resolveMembersForRuntimeLane'
      | 'getInboxMessages'
      | 'resolveCurrentRuntimeRunId'
      | 'hasStableInboxMessageId'
      | 'logPromptDeliveryEvent'
    >
): OpenCodePromptDeliveryWatchdogCoordinator {
  return new OpenCodePromptDeliveryWatchdogCoordinator({
    info: () => undefined,
    warn: () => undefined,
    nowIso: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getErrorMessage: defaultGetErrorMessage,
    ...ports,
  });
}

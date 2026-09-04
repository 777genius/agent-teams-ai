import {
  describePrimaryLaneBootstrapSelfHeal,
  OPENCODE_PRIMARY_LANE_BOOTSTRAP_MISSING_REASON,
  OPENCODE_PRIMARY_LANE_BOOTSTRAP_UNRECOVERABLE_REASON,
  PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS,
  type PrimaryLaneBootstrapSelfHealDecision,
} from './OpenCodePrimaryLaneBootstrapSelfHeal';
import { deferOpenCodePromptDeliveryAttempt } from './OpenCodePromptDeliveryDeferral';
import {
  hashOpenCodePromptDeliveryPayload,
  isOpenCodePromptDeliveryCancelled,
  isOpenCodePromptResponseStateResponded,
  OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryStatus,
} from './OpenCodePromptDeliveryLedger';
import {
  hasOpenCodeAcceptedRuntimePrompt,
  hasOpenCodeObservedMessageSendToolCall,
  isOpenCodeNoAssistantDeliveryFailure,
} from './OpenCodePromptDeliveryReadCommitPolicy';
import {
  getOpenCodePromptDeliveryPendingAgeMs,
  OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS,
} from './OpenCodePromptDeliveryStalePendingPolicy';
import {
  isOpenCodeDeliveryProofPendingReason,
  isOpenCodePromptDeliveryObserveLaterResponseState,
  OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
  OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS,
  OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS,
} from './OpenCodePromptDeliveryWatchdog';
import {
  isOpenCodeResolvedBehaviorChangedReason,
  isOpenCodeSessionRefreshResponseState,
  isOpenCodeSessionTransportChangedReason,
} from './OpenCodeSessionRefreshReasonClassifier';

export interface OpenCodePromptDeliveryFollowUpDependencies {
  markFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  logEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  scheduleWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void;
  nowIso?: () => string;
  nowMs?: () => number;
}

export function getOpenCodeDeliveryNextDelayMs(input: {
  responseState?: OpenCodePromptDeliveryLedgerRecord['responseState'];
  retry: boolean;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
}): number {
  if (
    input.retry &&
    input.responseState === 'tool_error' &&
    hasOpenCodeObservedMessageSendToolCall(input.ledgerRecord)
  ) {
    return OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS;
  }
  // A retry after an observed answer is a re-prompt, not a first delivery: give
  // the turn that produced the answer room to finish before asking again.
  if (
    input.retry &&
    input.responseState &&
    isOpenCodePromptResponseStateResponded(input.responseState)
  ) {
    return OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS;
  }
  if (input.retry) {
    return OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS;
  }
  if (isOpenCodePromptDeliveryObserveLaterResponseState(input.responseState)) {
    return OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS;
  }
  return OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS;
}

export function isOpenCodePromptDeliveryWatchdogRecordTerminal(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  if (record.status === 'failed_terminal') {
    return true;
  }
  if (record.status !== 'responded') {
    return false;
  }
  // A cancelled record is finished whatever it still owes: its run is gone, so
  // re-arming a wake for it would ask a runtime that is no longer there.
  if (isOpenCodePromptDeliveryCancelled(record)) {
    return true;
  }
  // A responded record still owes the inbox read-commit until
  // `inboxReadCommittedAt` is stamped: the reply proof can land through another
  // channel after the relay pass that observed the response, and a record the
  // watchdog treats as terminal is never re-armed - the unread inbox row then
  // stays unread forever even though the member answered.
  return Boolean(record.inboxReadCommittedAt);
}

export function isExplicitOpenCodeSessionRefreshStamp(reason: string | null | undefined): boolean {
  return (
    isOpenCodeResolvedBehaviorChangedReason(reason) ||
    isOpenCodeSessionTransportChangedReason(reason)
  );
}

export function isOpenCodeSessionRefreshRetryRecord(
  record: OpenCodePromptDeliveryLedgerRecord,
  reason: string | null | undefined
): boolean {
  const stampedSessionRefreshReason = record.lastSessionRefreshReason?.trim();
  const stampedSessionRefreshReasonIsExplicit = isExplicitOpenCodeSessionRefreshStamp(
    stampedSessionRefreshReason
  );
  const currentReason = reason?.trim();
  const lastReason = record.lastReason?.trim();
  const currentReasonConfirmsStamp = currentReason
    ? currentReason === stampedSessionRefreshReason
    : lastReason === stampedSessionRefreshReason;
  if (
    record.responseState === 'session_stale' &&
    stampedSessionRefreshReason &&
    stampedSessionRefreshReasonIsExplicit &&
    currentReasonConfirmsStamp
  ) {
    return isOpenCodeSessionRefreshResponseState({
      responseState: record.responseState,
      reason: currentReason ?? stampedSessionRefreshReason,
    });
  }
  if (record.responseState !== 'session_stale') {
    return isOpenCodeSessionRefreshResponseState({
      responseState: record.responseState,
      reason,
    });
  }
  return isOpenCodeSessionRefreshResponseState({
    responseState: record.responseState,
    reason,
    diagnostics: record.diagnostics,
  });
}

export class OpenCodePromptDeliveryFollowUpPolicy {
  private readonly nowIso: () => string;
  private readonly nowMs: () => number;

  constructor(private readonly deps: OpenCodePromptDeliveryFollowUpDependencies) {
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /**
   * A lane that structurally cannot accept a send must not spend send attempts.
   *
   * The refusal is not a failed delivery: the prompt never left, and no number
   * of retries can make the lane's missing session commit happen. Spending the
   * attempt budget on it only reaches `failed_terminal` faster - and a terminal
   * row is never re-armed: the watchdog treats it as finished, and the one-shot
   * re-relay that a terminal ledger write triggers is scoped to the stale-pending
   * reason. A row that terminalizes this way is dead for the life of the team.
   * Defer instead (move only the deadline, exactly as a postponed dispatch does)
   * and let the self-heal budget, not the attempt counter, decide when to stop.
   *
   * A cancelled record is never touched here. Force stop persists the
   * cancellation before the stop, so a re-bootstrap decision taken just before it
   * would otherwise defer a row - and arm a watchdog wake - for a run the user has
   * already ended.
   */
  private async scheduleUndeliverablePrimaryLaneBootstrap(
    input: {
      ledger: OpenCodePromptDeliveryLedgerStore;
      ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
      teamName: string;
      memberName: string;
      reason: string;
      selfHealExhausted?: boolean;
      selfHealDiagnostic?: string;
    },
    now: string
  ): Promise<OpenCodePromptDeliveryLedgerRecord> {
    if (isOpenCodePromptDeliveryCancelled(input.ledgerRecord)) {
      return input.ledgerRecord;
    }
    if (input.selfHealExhausted === true) {
      return await this.deps.markFailedTerminal({
        ledger: input.ledger,
        id: input.ledgerRecord.id,
        reason: OPENCODE_PRIMARY_LANE_BOOTSTRAP_UNRECOVERABLE_REASON,
        diagnostics: [
          input.reason,
          input.selfHealDiagnostic ??
            'OpenCode primary lane never committed a runtime session and the re-bootstrap budget is exhausted.',
        ],
        failedAt: now,
        eventContext: { primaryLaneBootstrapMissing: true, selfHealExhausted: true },
      });
    }
    const delayMs = PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS;
    const ledgerRecord = await deferOpenCodePromptDeliveryAttempt({
      ledger: input.ledger,
      ledgerRecord: input.ledgerRecord,
      delayMs,
      nowMs: this.nowMs(),
    });
    if (isOpenCodePromptDeliveryCancelled(ledgerRecord)) return ledgerRecord;
    this.deps.logEvent('opencode_prompt_delivery_retry_deferred', ledgerRecord, {
      reason: input.reason,
      primaryLaneBootstrapMissing: true,
    });
    this.deps.scheduleWatchdog({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: input.ledgerRecord.inboxMessageId,
      delayMs,
    });
    return ledgerRecord;
  }

  async schedule(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    retry: boolean;
    reason: string;
    /** Set once `decidePrimaryLaneBootstrapSelfHeal` has returned `give_up`. */
    selfHealExhausted?: boolean;
    /** The `give_up` clause, so the terminal row says why the ladder ended. */
    selfHealDiagnostic?: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const now = this.nowIso();
    if (input.reason.trim() === OPENCODE_PRIMARY_LANE_BOOTSTRAP_MISSING_REASON) {
      return await this.scheduleUndeliverablePrimaryLaneBootstrap(input, now);
    }
    const sessionRefreshRetry =
      input.retry && isOpenCodeSessionRefreshRetryRecord(input.ledgerRecord, input.reason);
    const acceptedPromptSessionStaleObservation =
      !input.retry &&
      input.ledgerRecord.responseState === 'session_stale' &&
      hasOpenCodeAcceptedRuntimePrompt(input.ledgerRecord);
    if (acceptedPromptSessionStaleObservation) {
      const maxSessionRefreshAttempts =
        input.ledgerRecord.maxSessionRefreshAttempts ??
        OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS;
      if ((input.ledgerRecord.sessionRefreshAttempts ?? 0) >= maxSessionRefreshAttempts) {
        return await this.deps.markFailedTerminal({
          ledger: input.ledger,
          id: input.ledgerRecord.id,
          reason: 'opencode_session_stale_observe_loop_after_accepted_prompt',
          diagnostics: [
            input.reason,
            `OpenCode session stayed stale while observing an accepted prompt after ${maxSessionRefreshAttempts} attempt(s).`,
          ],
          failedAt: now,
          eventContext: {
            observeOnlyAfterAcceptedPrompt: true,
            sessionRefreshAttempts: input.ledgerRecord.sessionRefreshAttempts ?? 0,
            maxSessionRefreshAttempts,
          },
        });
      }
      const delayMs = OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS;
      const nextAttemptAt = new Date(this.nowMs() + delayMs).toISOString();
      const ledgerRecord = await input.ledger.markSessionStaleObservationScheduled({
        id: input.ledgerRecord.id,
        nextAttemptAt,
        reason: input.reason,
        scheduledAt: now,
        maxSessionRefreshAttempts,
        diagnostics: ['opencode_session_stale_observe_scheduled_after_accepted_prompt'],
      });
      if (isOpenCodePromptDeliveryCancelled(ledgerRecord)) return ledgerRecord;
      this.deps.logEvent('opencode_prompt_delivery_response_observed', ledgerRecord, {
        retry: false,
        reason: input.reason,
        observeOnlyAfterAcceptedPrompt: true,
        sessionRefreshAttempts: ledgerRecord.sessionRefreshAttempts ?? 0,
        maxSessionRefreshAttempts,
      });
      this.deps.scheduleWatchdog({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.ledgerRecord.inboxMessageId,
        delayMs,
      });
      return ledgerRecord;
    }
    if (sessionRefreshRetry) {
      const maxSessionRefreshAttempts =
        input.ledgerRecord.maxSessionRefreshAttempts ??
        OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS;
      if ((input.ledgerRecord.sessionRefreshAttempts ?? 0) >= maxSessionRefreshAttempts) {
        return await this.deps.markFailedTerminal({
          ledger: input.ledger,
          id: input.ledgerRecord.id,
          reason: 'opencode_session_refresh_loop_after_resolved_behavior_changed',
          diagnostics: [
            input.reason,
            `OpenCode session stayed stale after ${maxSessionRefreshAttempts} session refresh attempt(s).`,
          ],
          failedAt: now,
          eventContext: {
            retry: true,
            sessionRefreshAttempts: input.ledgerRecord.sessionRefreshAttempts ?? 0,
            maxSessionRefreshAttempts,
          },
        });
      }
      const delayMs = getOpenCodeDeliveryNextDelayMs({
        responseState: input.ledgerRecord.responseState,
        retry: input.retry,
        ledgerRecord: input.ledgerRecord,
      });
      const nextAttemptAt = new Date(this.nowMs() + delayMs).toISOString();
      const ledgerRecord = await input.ledger.markSessionRefreshScheduled({
        id: input.ledgerRecord.id,
        nextAttemptAt,
        reason: input.reason,
        scheduledAt: now,
        maxSessionRefreshAttempts,
        diagnostics: ['opencode_session_refresh_scheduled_after_resolved_behavior_changed'],
      });
      if (isOpenCodePromptDeliveryCancelled(ledgerRecord)) return ledgerRecord;
      this.deps.logEvent('opencode_prompt_delivery_session_refresh_scheduled', ledgerRecord, {
        retry: true,
        reason: input.reason,
        sessionRefreshAttempts: ledgerRecord.sessionRefreshAttempts ?? 0,
        maxSessionRefreshAttempts,
      });
      this.deps.scheduleWatchdog({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.ledgerRecord.inboxMessageId,
        delayMs,
      });
      return ledgerRecord;
    }
    const canScheduleNoAssistantRecoveryRetry =
      input.retry &&
      input.ledgerRecord.attempts === input.ledgerRecord.maxAttempts &&
      isOpenCodeNoAssistantDeliveryFailure(input.ledgerRecord);
    if (
      input.retry &&
      input.ledgerRecord.attempts >= input.ledgerRecord.maxAttempts &&
      !canScheduleNoAssistantRecoveryRetry
    ) {
      // The attempt budget bounds SENDS. A record whose only missing piece is
      // the destination proof of an answer the runtime already produced must
      // not go terminal here: nothing re-arms a terminal record, so its unread
      // inbox row would stay unread until an unrelated inbox write. Re-arm it
      // observe-only instead - no further attempt and no further runtime turn
      // is spent - and let the proof settle it. The stale-pending hard cap
      // bounds how long the proof may stay missing.
      const pendingAgeMs = getOpenCodePromptDeliveryPendingAgeMs(input.ledgerRecord, this.nowMs());
      const proofPendingObserveRearm =
        isOpenCodeDeliveryProofPendingReason(input.reason) &&
        hasOpenCodeAcceptedRuntimePrompt(input.ledgerRecord) &&
        isOpenCodePromptResponseStateResponded(input.ledgerRecord.responseState) &&
        pendingAgeMs !== null &&
        pendingAgeMs < OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS;
      if (!proofPendingObserveRearm) {
        return await this.deps.markFailedTerminal({
          ledger: input.ledger,
          id: input.ledgerRecord.id,
          reason: input.reason,
          failedAt: now,
          eventContext: { retry: input.retry },
        });
      }
      const observeDelayMs = getOpenCodeDeliveryNextDelayMs({
        responseState: input.ledgerRecord.responseState,
        retry: true,
        ledgerRecord: input.ledgerRecord,
      });
      // A 'responded' record keeps its status - it is already excluded from
      // automatic selection, so only its durable deadline needs to move. Any
      // other status is parked as 'accepted' so the next wake observes instead
      // of dispatching; 'retry_scheduled' would spend another send.
      const ledgerRecord =
        input.ledgerRecord.status === 'responded'
          ? await deferOpenCodePromptDeliveryAttempt({
              ledger: input.ledger,
              ledgerRecord: input.ledgerRecord,
              delayMs: observeDelayMs,
              nowMs: this.nowMs(),
            })
          : await input.ledger.markNextAttemptScheduled({
              id: input.ledgerRecord.id,
              status: 'accepted',
              nextAttemptAt: new Date(this.nowMs() + observeDelayMs).toISOString(),
              reason: input.reason,
              scheduledAt: now,
            });
      if (isOpenCodePromptDeliveryCancelled(ledgerRecord)) return ledgerRecord;
      this.deps.logEvent('opencode_prompt_delivery_proof_pending_observe_rearmed', ledgerRecord, {
        reason: input.reason,
        attempts: ledgerRecord.attempts,
        maxAttempts: ledgerRecord.maxAttempts,
        pendingAgeMs,
      });
      this.deps.scheduleWatchdog({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.ledgerRecord.inboxMessageId,
        delayMs: observeDelayMs,
      });
      return ledgerRecord;
    }
    const delayMs = getOpenCodeDeliveryNextDelayMs({
      responseState: input.ledgerRecord.responseState,
      retry: input.retry,
      ledgerRecord: input.ledgerRecord,
    });
    const nextAttemptAt = new Date(this.nowMs() + delayMs).toISOString();
    const ledgerRecord = await input.ledger.markNextAttemptScheduled({
      id: input.ledgerRecord.id,
      status: input.retry ? 'retry_scheduled' : 'accepted',
      nextAttemptAt,
      reason: input.reason,
      scheduledAt: now,
    });
    if (isOpenCodePromptDeliveryCancelled(ledgerRecord)) return ledgerRecord;
    this.deps.logEvent(
      input.retry
        ? 'opencode_prompt_delivery_retry_scheduled'
        : 'opencode_prompt_delivery_response_observed',
      ledgerRecord,
      { retry: input.retry, reason: input.reason }
    );
    this.deps.scheduleWatchdog({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: input.ledgerRecord.inboxMessageId,
      delayMs,
    });
    return ledgerRecord;
  }
}

export interface UndeliverableOpenCodePrimaryLaneBootstrapDelivery {
  delivered: false;
  reason: string;
  diagnostics: string[];
  ledgerStatus?: OpenCodePromptDeliveryStatus;
  ledgerRecordId?: string;
}

/** Structural view of the inbox row the relay is trying to deliver. */
export interface UndeliverableOpenCodePrimaryLaneBootstrapMessage {
  messageId?: string;
  text: string;
  inboxTimestamp?: string;
  source?: OpenCodePromptDeliveryLedgerRecord['source'];
  replyRecipient?: string;
  actionMode?: OpenCodePromptDeliveryLedgerRecord['actionMode'];
  messageKind?: OpenCodePromptDeliveryLedgerRecord['messageKind'];
  workSyncIntent?: OpenCodePromptDeliveryLedgerRecord['workSyncIntent'];
  taskRefs?: OpenCodePromptDeliveryLedgerRecord['taskRefs'];
  attachments?: { id?: string; filename?: string; mimeType?: string; size?: number }[];
}

export interface UndeliverableOpenCodePrimaryLaneBootstrapDeps {
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
  openCodePromptDeliveryFollowUpPolicy: Pick<OpenCodePromptDeliveryFollowUpPolicy, 'schedule'>;
  nowIso?(): string;
}

/**
 * The primary lane refused the send because it holds no committed session, so
 * the unwinnable dispatch never happens - and with it, the only path that ever
 * reached the follow-up policy disappears. The ledger row the relay owns is
 * opened and settled HERE instead: deferred while the self-heal still has budget
 * (the deadline moves, no attempt is spent), and driven to `failed_terminal`
 * with `opencode_primary_lane_bootstrap_unrecoverable` once `give_up` lands, so
 * an exhausted ladder ends somewhere the UI and the durable log can see.
 */
export async function settleUndeliverableOpenCodePrimaryLaneBootstrap(
  deps: UndeliverableOpenCodePrimaryLaneBootstrapDeps,
  message: UndeliverableOpenCodePrimaryLaneBootstrapMessage,
  input: {
    teamName: string;
    laneId: string;
    memberName: string;
    runId?: string | null;
    decision: PrimaryLaneBootstrapSelfHealDecision;
  }
): Promise<UndeliverableOpenCodePrimaryLaneBootstrapDelivery> {
  const diagnostic = describePrimaryLaneBootstrapSelfHeal({
    memberName: input.memberName,
    decision: input.decision,
  });
  const delivery: UndeliverableOpenCodePrimaryLaneBootstrapDelivery = {
    delivered: false,
    reason: OPENCODE_PRIMARY_LANE_BOOTSTRAP_MISSING_REASON,
    diagnostics: [diagnostic],
  };
  const inboxMessageId = message.messageId?.trim();
  if (!inboxMessageId) {
    return delivery;
  }
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const ledger = deps.createOpenCodePromptDeliveryLedger(input.teamName, input.laneId);
  const replyRecipient = message.replyRecipient ?? 'user';
  const ledgerRecord = await ledger.ensurePending({
    teamName: input.teamName,
    memberName: input.memberName,
    laneId: input.laneId,
    runId: input.runId ?? null,
    inboxMessageId,
    inboxTimestamp: message.inboxTimestamp ?? now,
    source: message.source ?? 'manual',
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
      source: message.source,
    }),
    now,
  });
  const settled = await deps.openCodePromptDeliveryFollowUpPolicy.schedule({
    ledger,
    ledgerRecord,
    teamName: input.teamName,
    memberName: input.memberName,
    retry: true,
    reason: OPENCODE_PRIMARY_LANE_BOOTSTRAP_MISSING_REASON,
    selfHealExhausted: input.decision.action === 'give_up',
    selfHealDiagnostic: diagnostic,
  });
  return {
    ...delivery,
    ledgerStatus: settled.status,
    ledgerRecordId: settled.id,
    diagnostics:
      settled.status === 'failed_terminal'
        ? Array.from(new Set([diagnostic, ...settled.diagnostics]))
        : delivery.diagnostics,
  };
}

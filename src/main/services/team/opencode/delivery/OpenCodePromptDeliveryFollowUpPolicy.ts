import {
  isOpenCodeResolvedBehaviorChangedReason,
  isOpenCodeSessionRefreshResponseState,
  isOpenCodeSessionTransportChangedReason,
  OPENCODE_PROMPT_DELIVERY_SESSION_REFRESH_MAX_ATTEMPTS,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import {
  hasOpenCodeAcceptedRuntimePrompt,
  hasOpenCodeObservedMessageSendToolCall,
  isOpenCodeNoAssistantDeliveryFailure,
} from './OpenCodePromptDeliveryReadCommitPolicy';
import {
  isOpenCodePromptDeliveryObserveLaterResponseState,
  OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
  OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS,
} from './OpenCodePromptDeliveryWatchdog';

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
  return !(
    record.responseState === 'responded_plain_text' &&
    !record.visibleReplyMessageId &&
    !record.inboxReadCommittedAt
  );
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

  async schedule(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    retry: boolean;
    reason: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const now = this.nowIso();
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
      return await this.deps.markFailedTerminal({
        ledger: input.ledger,
        id: input.ledgerRecord.id,
        reason: input.reason,
        failedAt: now,
        eventContext: { retry: input.retry },
      });
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

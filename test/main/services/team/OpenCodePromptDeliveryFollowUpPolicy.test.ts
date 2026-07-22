import {
  isOpenCodeSessionRefreshRetryRecord,
  type OpenCodePromptDeliveryFollowUpDependencies,
  OpenCodePromptDeliveryFollowUpPolicy,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import {
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { describe, expect, it, vi } from 'vitest';

const NOW_ISO = '2026-05-18T08:32:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const NEXT_RETRY_AT = new Date(NOW_MS + OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS).toISOString();

type MarkFailedTerminalInput = Parameters<
  OpenCodePromptDeliveryFollowUpDependencies['markFailedTerminal']
>[0];
type MarkNextAttemptScheduledInput = Parameters<
  OpenCodePromptDeliveryLedgerStore['markNextAttemptScheduled']
>[0];
type MarkSessionRefreshScheduledInput = Parameters<
  OpenCodePromptDeliveryLedgerStore['markSessionRefreshScheduled']
>[0];

function baseRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'opencode-prompt:test',
    teamName: 'team-a',
    memberName: 'atlas',
    laneId: 'secondary:opencode:atlas',
    runId: 'run-1',
    runtimeSessionId: 'ses-1',
    inboxMessageId: 'msg-1',
    inboxTimestamp: '2026-05-18T08:31:00.000Z',
    source: 'watcher',
    messageKind: null,
    replyRecipient: 'team-lead',
    actionMode: null,
    taskRefs: [],
    payloadHash: 'sha256:test',
    status: 'accepted',
    responseState: 'not_observed',
    attempts: 1,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: '2026-05-18T08:31:30.000Z',
    lastObservedAt: '2026-05-18T08:31:45.000Z',
    acceptedAt: '2026-05-18T08:31:30.000Z',
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'delivered-1',
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: null,
    diagnostics: [],
    createdAt: '2026-05-18T08:31:00.000Z',
    updatedAt: '2026-05-18T08:31:45.000Z',
    ...overrides,
  };
}

function asLedger(methods: Record<string, unknown>): OpenCodePromptDeliveryLedgerStore {
  return methods as unknown as OpenCodePromptDeliveryLedgerStore;
}

function createPolicy(overrides: Partial<OpenCodePromptDeliveryFollowUpDependencies> = {}) {
  const deps = {
    markFailedTerminal: vi.fn(async (input: MarkFailedTerminalInput) =>
      baseRecord({
        id: input.id,
        status: 'failed_terminal',
        failedAt: input.failedAt,
        lastReason: input.reason,
        diagnostics: input.diagnostics ?? [input.reason],
        updatedAt: input.failedAt,
      })
    ),
    logEvent: vi.fn(),
    scheduleWatchdog: vi.fn(),
    nowIso: () => NOW_ISO,
    nowMs: () => NOW_MS,
    ...overrides,
  } satisfies OpenCodePromptDeliveryFollowUpDependencies;

  return {
    deps,
    policy: new OpenCodePromptDeliveryFollowUpPolicy(deps),
  };
}

describe('OpenCodePromptDeliveryFollowUpPolicy', () => {
  it('schedules one bounded recovery retry before terminalizing no-assistant delivery', async () => {
    const { deps, policy } = createPolicy();
    const record = baseRecord({
      responseState: 'prompt_delivered_no_assistant_message',
      attempts: 3,
      maxAttempts: 3,
      lastReason: 'prompt_delivered_no_assistant_message',
      diagnostics: ['prompt_delivered_no_assistant_message'],
    });
    const markNextAttemptScheduled = vi.fn(
      async (
        input: MarkNextAttemptScheduledInput
      ): Promise<OpenCodePromptDeliveryLedgerRecord> => ({
        ...record,
        status: input.status,
        nextAttemptAt: input.nextAttemptAt,
        lastReason: input.reason,
        updatedAt: input.scheduledAt,
      })
    );
    const ledger = asLedger({ markNextAttemptScheduled });

    const nextRecord = await policy.schedule({
      ledger,
      ledgerRecord: record,
      teamName: 'team-a',
      memberName: 'atlas',
      retry: true,
      reason: 'prompt_delivered_no_assistant_message',
    });

    expect(deps.markFailedTerminal).not.toHaveBeenCalled();
    expect(markNextAttemptScheduled).toHaveBeenCalledWith({
      id: record.id,
      status: 'retry_scheduled',
      nextAttemptAt: NEXT_RETRY_AT,
      reason: 'prompt_delivered_no_assistant_message',
      scheduledAt: NOW_ISO,
    });
    expect(nextRecord.status).toBe('retry_scheduled');
    expect(deps.logEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_retry_scheduled',
      nextRecord,
      { retry: true, reason: 'prompt_delivered_no_assistant_message' }
    );
    expect(deps.scheduleWatchdog).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'atlas',
      messageId: record.inboxMessageId,
      delayMs: OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS,
    });
  });

  it('marks exhausted non-recoverable retries terminal with retry context', async () => {
    const taskRefs = [{ taskId: 'task-1', displayId: 'task-1', teamName: 'team-a' }];
    const record = baseRecord({
      id: 'opencode-prompt:work-sync-proof-missing',
      inboxMessageId: 'msg-work-sync-proof-missing',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      actionMode: 'do',
      taskRefs,
      payloadHash: 'sha256:work-sync',
      status: 'retry_scheduled',
      responseState: 'responded_non_visible_tool',
      attempts: 3,
      maxAttempts: 3,
      respondedAt: '2026-05-18T08:31:45.000Z',
      observedAssistantMessageId: 'assistant-1',
      observedToolCallNames: ['member_work_sync_status'],
      lastReason: 'member_work_sync_report_required',
      diagnostics: ['member_work_sync_report_required'],
    });
    const failedRecord = baseRecord({
      ...record,
      status: 'failed_terminal',
      failedAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    const markFailedTerminal = vi.fn(async () => failedRecord);
    const { deps, policy } = createPolicy({ markFailedTerminal });
    const ledger = asLedger({});

    const nextRecord = await policy.schedule({
      ledger,
      ledgerRecord: record,
      teamName: 'team-a',
      memberName: 'atlas',
      retry: true,
      reason: 'member_work_sync_report_required',
    });

    expect(nextRecord).toBe(failedRecord);
    expect(markFailedTerminal).toHaveBeenCalledWith({
      ledger,
      id: record.id,
      reason: 'member_work_sync_report_required',
      failedAt: NOW_ISO,
      eventContext: { retry: true },
    });
    expect(deps.logEvent).not.toHaveBeenCalled();
    expect(deps.scheduleWatchdog).not.toHaveBeenCalled();
  });

  it('uses stamped session-refresh evidence instead of stale historical diagnostics', async () => {
    const { deps, policy } = createPolicy();
    const record = baseRecord({
      id: 'opencode-prompt:session-refresh',
      responseState: 'session_stale',
      sessionRefreshAttempts: 0,
      maxSessionRefreshAttempts: 5,
      lastReason: 'resolved_behavior_changed:old->new',
      lastSessionRefreshReason: 'resolved_behavior_changed:old->new',
      diagnostics: ['network timeout', 'resolved_behavior_changed:old->new'],
    });
    const markNextAttemptScheduled = vi.fn();
    const markSessionRefreshScheduled = vi.fn(
      async (
        input: MarkSessionRefreshScheduledInput
      ): Promise<OpenCodePromptDeliveryLedgerRecord> => ({
        ...record,
        status: 'retry_scheduled',
        responseState: 'session_stale',
        nextAttemptAt: input.nextAttemptAt,
        sessionRefreshAttempts: 1,
        lastSessionRefreshReason: input.reason,
        lastReason: input.reason,
        updatedAt: input.scheduledAt,
      })
    );
    const ledger = asLedger({ markNextAttemptScheduled, markSessionRefreshScheduled });

    const nextRecord = await policy.schedule({
      ledger,
      ledgerRecord: record,
      teamName: 'team-a',
      memberName: 'atlas',
      retry: true,
      reason: 'resolved_behavior_changed:old->new',
    });

    expect(deps.markFailedTerminal).not.toHaveBeenCalled();
    expect(markNextAttemptScheduled).not.toHaveBeenCalled();
    expect(markSessionRefreshScheduled).toHaveBeenCalledWith({
      id: record.id,
      nextAttemptAt: NEXT_RETRY_AT,
      reason: 'resolved_behavior_changed:old->new',
      scheduledAt: NOW_ISO,
      maxSessionRefreshAttempts: 5,
      diagnostics: ['opencode_session_refresh_scheduled_after_resolved_behavior_changed'],
    });
    expect(nextRecord).toMatchObject({
      status: 'retry_scheduled',
      sessionRefreshAttempts: 1,
    });
    expect(deps.logEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_session_refresh_scheduled',
      nextRecord,
      {
        retry: true,
        reason: 'resolved_behavior_changed:old->new',
        sessionRefreshAttempts: 1,
        maxSessionRefreshAttempts: 5,
      }
    );
  });

  it('does not reuse stamped session-refresh evidence for current action-required stale sessions', async () => {
    const { policy } = createPolicy();
    const record = baseRecord({
      id: 'opencode-prompt:session-stale-auth',
      responseState: 'session_stale',
      sessionRefreshAttempts: 1,
      maxSessionRefreshAttempts: 5,
      lastReason: 'authentication_failed: invalid api key',
      lastSessionRefreshReason: 'resolved_behavior_changed:old->new',
      diagnostics: ['resolved_behavior_changed:old->new', 'authentication_failed: invalid api key'],
    });
    const markSessionRefreshScheduled = vi.fn();
    const markNextAttemptScheduled = vi.fn(
      async (
        input: MarkNextAttemptScheduledInput
      ): Promise<OpenCodePromptDeliveryLedgerRecord> => ({
        ...record,
        status: input.status,
        nextAttemptAt: input.nextAttemptAt,
        lastReason: input.reason,
        updatedAt: input.scheduledAt,
      })
    );
    const ledger = asLedger({ markSessionRefreshScheduled, markNextAttemptScheduled });

    const nextRecord = await policy.schedule({
      ledger,
      ledgerRecord: record,
      teamName: 'team-a',
      memberName: 'atlas',
      retry: true,
      reason: 'authentication_failed: invalid api key',
    });

    expect(markSessionRefreshScheduled).not.toHaveBeenCalled();
    expect(markNextAttemptScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: record.id,
        status: 'retry_scheduled',
        reason: 'authentication_failed: invalid api key',
      })
    );
    expect(nextRecord.status).toBe('retry_scheduled');
  });

  it('does not let generic session-refresh stamps bypass current action-required diagnostics', async () => {
    const { policy } = createPolicy();
    const record = baseRecord({
      id: 'opencode-prompt:session-stale-generic-auth',
      responseState: 'session_stale',
      sessionRefreshAttempts: 1,
      maxSessionRefreshAttempts: 5,
      lastReason: 'OpenCode API error',
      lastSessionRefreshReason: 'OpenCode API error',
      diagnostics: ['OpenCode API error', 'permission_blocked'],
    });
    const markSessionRefreshScheduled = vi.fn();
    const markNextAttemptScheduled = vi.fn(
      async (
        input: MarkNextAttemptScheduledInput
      ): Promise<OpenCodePromptDeliveryLedgerRecord> => ({
        ...record,
        status: input.status,
        nextAttemptAt: input.nextAttemptAt,
        lastReason: input.reason,
        updatedAt: input.scheduledAt,
      })
    );
    const ledger = asLedger({ markSessionRefreshScheduled, markNextAttemptScheduled });

    const nextRecord = await policy.schedule({
      ledger,
      ledgerRecord: record,
      teamName: 'team-a',
      memberName: 'atlas',
      retry: true,
      reason: 'OpenCode API error',
    });

    expect(markSessionRefreshScheduled).not.toHaveBeenCalled();
    expect(markNextAttemptScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: record.id,
        status: 'retry_scheduled',
        reason: 'OpenCode API error',
      })
    );
    expect(nextRecord.status).toBe('retry_scheduled');
    expect(
      isOpenCodeSessionRefreshRetryRecord(
        {
          ...record,
          id: 'opencode-prompt:session-stale-display-auth',
          lastReason: 'OpenCode session changed; refreshing the session before retry.',
          lastSessionRefreshReason:
            'OpenCode session changed; refreshing the session before retry.',
        },
        'OpenCode session changed; refreshing the session before retry.'
      )
    ).toBe(false);
  });

  it('does not reuse stale session-refresh stamps for later non-session-stale retries', async () => {
    const { policy } = createPolicy();
    const record = baseRecord({
      id: 'opencode-prompt:no-assistant-after-refresh',
      responseState: 'prompt_delivered_no_assistant_message',
      attempts: 3,
      maxAttempts: 3,
      sessionRefreshAttempts: 1,
      maxSessionRefreshAttempts: 5,
      lastReason: 'prompt_delivered_no_assistant_message',
      lastSessionRefreshReason: 'resolved_behavior_changed:old->new',
      diagnostics: ['resolved_behavior_changed:old->new', 'prompt_delivered_no_assistant_message'],
    });
    const markSessionRefreshScheduled = vi.fn();
    const markNextAttemptScheduled = vi.fn(
      async (
        input: MarkNextAttemptScheduledInput
      ): Promise<OpenCodePromptDeliveryLedgerRecord> => ({
        ...record,
        status: input.status,
        nextAttemptAt: input.nextAttemptAt,
        lastReason: input.reason,
        updatedAt: input.scheduledAt,
      })
    );
    const ledger = asLedger({ markSessionRefreshScheduled, markNextAttemptScheduled });

    const nextRecord = await policy.schedule({
      ledger,
      ledgerRecord: record,
      teamName: 'team-a',
      memberName: 'atlas',
      retry: true,
      reason: 'prompt_delivered_no_assistant_message',
    });

    expect(markSessionRefreshScheduled).not.toHaveBeenCalled();
    expect(markNextAttemptScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: record.id,
        status: 'retry_scheduled',
        reason: 'prompt_delivered_no_assistant_message',
      })
    );
    expect(nextRecord.status).toBe('retry_scheduled');
  });
});

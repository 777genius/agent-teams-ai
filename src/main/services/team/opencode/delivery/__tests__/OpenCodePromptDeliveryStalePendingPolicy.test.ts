import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeStalePendingPlainTextObservation,
  decideOpenCodeStalePendingResolution,
  decideOpenCodeStalePendingUserPreemption,
  getOpenCodeObservedSessionActivity,
  getOpenCodePromptDeliveryPendingAgeMs,
  isOpenCodePromptDeliveryStalePending,
  OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON,
  OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS,
  OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS,
  OPENCODE_REPLY_OPTIONAL_TURN_END_REASON,
  OPENCODE_STALE_PENDING_HARD_CAP_REASON,
  OPENCODE_STALE_PENDING_POLICY_CONFIG,
  OPENCODE_STALE_PENDING_PREEMPTED_REASON,
  OPENCODE_STALE_PENDING_TERMINAL_REASON,
} from '../OpenCodePromptDeliveryStalePendingPolicy';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';

const NOW_MS = Date.parse('2026-08-22T18:20:00.000Z');
/** The shipped windows. The policy has no defaults, so every call states them. */
const POLICY = OPENCODE_STALE_PENDING_POLICY_CONFIG;
const BUSY = 'OpenCode session status busy';
const TREATED_IDLE =
  'OpenCode session status was busy but transcript has a completed assistant response for the latest user message; treating session as idle';

function minutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

/** Mirrors the live stuck record: accepted task-comment notification, pending forever. */
function record(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'opencode-prompt:stuck',
    teamName: 'reportrun16',
    memberName: 'team-lead',
    laneId: 'primary',
    runId: 'run-1',
    runtimeSessionId: 'ses_1',
    runtimePromptMessageId: 'msg_prompt',
    runtimePromptMessageIds: ['msg_prompt'],
    lastRuntimePromptMessageId: 'msg_prompt',
    inboxMessageId: 'task-comment-forward:1',
    inboxTimestamp: minutesAgo(32),
    source: 'watcher',
    messageKind: 'task_comment_notification',
    workSyncIntent: null,
    replyRecipient: 'system',
    actionMode: null,
    taskRefs: [],
    payloadHash: 'sha256:payload',
    status: 'accepted',
    responseState: 'pending',
    attempts: 1,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: minutesAgo(32),
    lastObservedAt: minutesAgo(0),
    acceptedAt: minutesAgo(32),
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'msg_prompt',
    observedAssistantMessageId: 'msg_assistant',
    observedAssistantPreview: null,
    observedToolCallNames: ['glob'],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: 'assistant_response_pending',
    diagnostics: [],
    createdAt: minutesAgo(32),
    updatedAt: minutesAgo(0),
    ...overrides,
  };
}

describe('getOpenCodeObservedSessionActivity', () => {
  it('classifies busy, treated-idle, and unknown bridge diagnostics', () => {
    expect(getOpenCodeObservedSessionActivity([BUSY])).toBe('busy');
    expect(getOpenCodeObservedSessionActivity([BUSY, TREATED_IDLE])).toBe('idle');
    expect(getOpenCodeObservedSessionActivity(['OpenCode session status idle'])).toBe('idle');
    expect(getOpenCodeObservedSessionActivity(['OpenCode app MCP is connected.'])).toBe('unknown');
    expect(getOpenCodeObservedSessionActivity(undefined)).toBe('unknown');
  });
});

describe('stale-pending detection', () => {
  it('measures age from the last send/acceptance, not from the last observation', () => {
    expect(getOpenCodePromptDeliveryPendingAgeMs(record(), NOW_MS)).toBe(32 * 60_000);
    expect(
      getOpenCodePromptDeliveryPendingAgeMs(
        record({ lastAttemptAt: null, acceptedAt: null, createdAt: minutesAgo(7) }),
        NOW_MS
      )
    ).toBe(7 * 60_000);
    expect(
      getOpenCodePromptDeliveryPendingAgeMs(
        { lastAttemptAt: null, acceptedAt: null, createdAt: 'not-a-date' },
        NOW_MS
      )
    ).toBeNull();
  });

  it('only flags accepted observe-only records past the stale window', () => {
    expect(isOpenCodePromptDeliveryStalePending(record(), NOW_MS, POLICY.staleAfterMs)).toBe(true);
    expect(
      isOpenCodePromptDeliveryStalePending(
        record({ lastAttemptAt: minutesAgo(4), acceptedAt: minutesAgo(4) }),
        NOW_MS,
        POLICY.staleAfterMs
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryStalePending(
        record({ status: 'responded' }),
        NOW_MS,
        POLICY.staleAfterMs
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryStalePending(
        record({ status: 'retry_scheduled' }),
        NOW_MS,
        POLICY.staleAfterMs
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryStalePending(
        record({ responseState: 'permission_blocked' }),
        NOW_MS,
        POLICY.staleAfterMs
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryStalePending(
        record({ responseState: 'session_stale' }),
        NOW_MS,
        POLICY.staleAfterMs
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryStalePending(
        record({ inboxReadCommittedAt: minutesAgo(1) }),
        NOW_MS,
        POLICY.staleAfterMs
      )
    ).toBe(false);
  });
});

describe('decideOpenCodeStalePendingResolution', () => {
  it('ships the named windows as the composition config', () => {
    expect(OPENCODE_STALE_PENDING_POLICY_CONFIG).toEqual({
      staleAfterMs: OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS,
      hardCapMs: OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS,
    });
  });

  it('bounds a delivery by the windows its caller states, never by windows of its own', () => {
    // Same record, same observation, two configs: only the config differs, so
    // whatever the policy decides here came from the caller.
    const tenMinutesIdle = {
      record: record({
        observedAssistantMessageId: null,
        lastAttemptAt: minutesAgo(10),
        acceptedAt: minutesAgo(10),
      }),
      laneKind: 'primary' as const,
      observation: { state: 'pending' as const, assistantMessageId: null },
      observedDiagnostics: [TREATED_IDLE],
      nowMs: NOW_MS,
    };
    expect(
      decideOpenCodeStalePendingResolution({ ...tenMinutesIdle, config: POLICY })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_TERMINAL_REASON });
    expect(
      decideOpenCodeStalePendingResolution({
        ...tenMinutesIdle,
        config: { staleAfterMs: 20 * 60_000, hardCapMs: POLICY.hardCapMs },
      })
    ).toEqual({ action: 'none' });

    const tenMinutesBusy = { ...tenMinutesIdle, observedDiagnostics: [BUSY] };
    expect(decideOpenCodeStalePendingResolution({ ...tenMinutesBusy, config: POLICY })).toEqual({
      action: 'keep_observing',
      reason: 'opencode_stale_pending_session_busy',
    });
    expect(
      decideOpenCodeStalePendingResolution({
        ...tenMinutesBusy,
        config: { staleAfterMs: POLICY.staleAfterMs, hardCapMs: 6 * 60_000 },
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_HARD_CAP_REASON });
  });

  it('settles a lead non-user message immediately once the turn ended (live stuck record)', () => {
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({ lastAttemptAt: minutesAgo(0), acceptedAt: minutesAgo(0) }),
        laneKind: 'primary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [BUSY, TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'settle_plain_text', reason: OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON });
  });

  it('does not settle a lead non-user message while the session is busy and fresh', () => {
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({ lastAttemptAt: minutesAgo(1), acceptedAt: minutesAgo(1) }),
        laneKind: 'primary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [BUSY],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
  });

  it('does not settle a fresh record while the observation carries no session activity', () => {
    // An assistant message row exists from the first observation of a running
    // turn (the bridge classifies "direct child has running tool calls" as
    // `pending`), so the assistant message alone is not proof the turn ended.
    // Absent diagnostics, or a raw status this policy does not read as busy,
    // are not idle evidence either: without one the record keeps waiting.
    const running = {
      record: record({ lastAttemptAt: minutesAgo(1), acceptedAt: minutesAgo(1) }),
      laneKind: 'primary' as const,
      observation: { state: 'pending' as const, assistantMessageId: 'msg_assistant' },
      nowMs: NOW_MS,
      config: POLICY,
    };
    expect(
      decideOpenCodeStalePendingResolution({ ...running, observedDiagnostics: undefined })
    ).toEqual({ action: 'none' });
    expect(decideOpenCodeStalePendingResolution({ ...running, observedDiagnostics: [] })).toEqual({
      action: 'none',
    });
    expect(
      decideOpenCodeStalePendingResolution({
        ...running,
        observedDiagnostics: ['OpenCode session status retry'],
      })
    ).toEqual({ action: 'none' });
    // Same for the reply-optional contract, which settles on any lane.
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({
          laneId: 'secondary:opencode:scribe',
          memberName: 'Scribe',
          replyRecipient: 'system',
          lastAttemptAt: minutesAgo(1),
          acceptedAt: minutesAgo(1),
        }),
        laneKind: 'secondary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: undefined,
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
  });

  it('still bounds a lane that never reports its session activity', () => {
    // A lane with no idle evidence at all is not settled as a finished turn,
    // but it does not block the lane either: at the stale window the unknown
    // session goes terminal, exactly like an idle one.
    expect(
      decideOpenCodeStalePendingResolution({
        record: record(),
        laneKind: 'primary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: undefined,
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_TERMINAL_REASON });
  });

  it('keeps observing a stale busy record until the non-user hard cap, then goes terminal', () => {
    const busy = {
      laneKind: 'primary' as const,
      observation: { state: 'pending' as const, assistantMessageId: null },
      observedDiagnostics: [BUSY],
      nowMs: NOW_MS,
      config: POLICY,
    };
    expect(
      decideOpenCodeStalePendingResolution({
        ...busy,
        record: record({
          observedAssistantMessageId: null,
          lastAttemptAt: minutesAgo(10),
          acceptedAt: minutesAgo(10),
        }),
      })
    ).toEqual({ action: 'keep_observing', reason: 'opencode_stale_pending_session_busy' });
    const overCap = minutesAgo(OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS / 60_000 + 1);
    expect(
      decideOpenCodeStalePendingResolution({
        ...busy,
        record: record({
          observedAssistantMessageId: null,
          lastAttemptAt: overCap,
          acceptedAt: overCap,
        }),
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_HARD_CAP_REASON });
    // Boundaries, exactly: a busy session at the stale window is still only
    // "slow", and it is the hard cap - not the stale window - that ends it.
    const atStaleWindow = minutesAgo(OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS / 60_000);
    expect(
      decideOpenCodeStalePendingResolution({
        ...busy,
        record: record({
          observedAssistantMessageId: null,
          lastAttemptAt: atStaleWindow,
          acceptedAt: atStaleWindow,
        }),
      })
    ).toEqual({ action: 'keep_observing', reason: 'opencode_stale_pending_session_busy' });
    const atCap = minutesAgo(OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS / 60_000);
    expect(
      decideOpenCodeStalePendingResolution({
        ...busy,
        record: record({
          observedAssistantMessageId: null,
          lastAttemptAt: atCap,
          acceptedAt: atCap,
        }),
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_HARD_CAP_REASON });
  });

  it('never hard-caps a busy user prompt', () => {
    const overCap = minutesAgo(OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS / 60_000 + 5);
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({ replyRecipient: 'user', lastAttemptAt: overCap, acceptedAt: overCap }),
        laneKind: 'primary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [BUSY],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'keep_observing', reason: 'opencode_stale_pending_session_busy' });
  });

  it('marks a stale idle user prompt terminal instead of faking a plain-text reply', () => {
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({ replyRecipient: 'user' }),
        laneKind: 'primary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [BUSY, TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_TERMINAL_REASON });
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({
          replyRecipient: 'user',
          lastAttemptAt: minutesAgo(2),
          acceptedAt: minutesAgo(2),
        }),
        laneKind: 'primary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
  });

  it('does not settle secondary-lane non-user records as plain text, only bounds them', () => {
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({ laneId: 'secondary:opencode:scribe', replyRecipient: 'team-lead' }),
        laneKind: 'secondary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_TERMINAL_REASON });
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({
          laneId: 'secondary:opencode:scribe',
          replyRecipient: 'team-lead',
          lastAttemptAt: minutesAgo(1),
          acceptedAt: minutesAgo(1),
        }),
        laneKind: 'secondary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
  });

  it('settles secondary-lane reply-optional records (informational, teammate report) once the turn ended', () => {
    // On live runs a dep-resolved notice to a teammate sat pending for five
    // minutes although the member had finished its turn - and its task - long
    // before: nothing in the notice asked for a reply.
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({
          laneId: 'secondary:opencode:scribe',
          memberName: 'Scribe',
          replyRecipient: 'system',
          lastAttemptAt: minutesAgo(1),
          acceptedAt: minutesAgo(1),
        }),
        laneKind: 'secondary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'settle_plain_text', reason: OPENCODE_REPLY_OPTIONAL_TURN_END_REASON });
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({
          laneId: 'secondary:opencode:scribe',
          memberName: 'Scribe',
          replyRecipient: 'Muse',
          lastAttemptAt: minutesAgo(1),
          acceptedAt: minutesAgo(1),
        }),
        laneKind: 'secondary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [TREATED_IDLE],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'settle_plain_text', reason: OPENCODE_REPLY_OPTIONAL_TURN_END_REASON });
    // Still busy: keep waiting.
    expect(
      decideOpenCodeStalePendingResolution({
        record: record({
          laneId: 'secondary:opencode:scribe',
          memberName: 'Scribe',
          replyRecipient: 'system',
          lastAttemptAt: minutesAgo(1),
          acceptedAt: minutesAgo(1),
        }),
        laneKind: 'secondary',
        observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
        observedDiagnostics: [BUSY],
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
  });

  it('ignores records that are not observe-only accepted prompts', () => {
    for (const overrides of [
      { status: 'retry_scheduled' as const },
      { status: 'responded' as const, responseState: 'responded_plain_text' as const },
      { responseState: 'session_stale' as const },
      { responseState: 'permission_blocked' as const },
      {
        acceptedAt: null,
        runtimePromptMessageId: null,
        runtimePromptMessageIds: [],
        lastRuntimePromptMessageId: null,
        deliveredUserMessageId: null,
      },
    ]) {
      expect(
        decideOpenCodeStalePendingResolution({
          record: record(overrides),
          laneKind: 'primary',
          observation: { state: 'pending', assistantMessageId: 'msg_assistant' },
          observedDiagnostics: [TREATED_IDLE],
          nowMs: NOW_MS,
          config: POLICY,
        })
      ).toEqual({ action: 'none' });
    }
  });
});

describe('decideOpenCodeStalePendingUserPreemption', () => {
  it('lets a new user message preempt a stale non-user record on the lead lane', () => {
    expect(
      decideOpenCodeStalePendingUserPreemption({
        activeRecord: record(),
        incomingReplyRecipient: 'user',
        laneKind: 'primary',
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'settle_plain_text', reason: OPENCODE_STALE_PENDING_PREEMPTED_REASON });
    expect(
      decideOpenCodeStalePendingUserPreemption({
        activeRecord: record({ observedAssistantMessageId: null }),
        incomingReplyRecipient: 'user',
        laneKind: 'primary',
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_PREEMPTED_REASON });
    expect(
      decideOpenCodeStalePendingUserPreemption({
        activeRecord: record({ laneId: 'secondary:opencode:scribe', replyRecipient: 'team-lead' }),
        incomingReplyRecipient: 'user',
        laneKind: 'secondary',
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toMatchObject({ action: 'fail_terminal', reason: OPENCODE_STALE_PENDING_PREEMPTED_REASON });
  });

  it('keeps queue-behind semantics for non-user senders, user-prompt blockers, and fresh records', () => {
    expect(
      decideOpenCodeStalePendingUserPreemption({
        activeRecord: record(),
        incomingReplyRecipient: 'Scribe',
        laneKind: 'primary',
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
    expect(
      decideOpenCodeStalePendingUserPreemption({
        activeRecord: record({ replyRecipient: 'user' }),
        incomingReplyRecipient: 'user',
        laneKind: 'primary',
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
    expect(
      decideOpenCodeStalePendingUserPreemption({
        activeRecord: record({
          lastAttemptAt: minutesAgo(OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS / 60_000 - 1),
          acceptedAt: minutesAgo(OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS / 60_000 - 1),
        }),
        incomingReplyRecipient: 'user',
        laneKind: 'primary',
        nowMs: NOW_MS,
        config: POLICY,
      })
    ).toEqual({ action: 'none' });
  });

  it('takes the stale window from its caller too', () => {
    const fresh = {
      activeRecord: record({ lastAttemptAt: minutesAgo(2), acceptedAt: minutesAgo(2) }),
      incomingReplyRecipient: 'user',
      laneKind: 'primary' as const,
      nowMs: NOW_MS,
    };
    expect(decideOpenCodeStalePendingUserPreemption({ ...fresh, config: POLICY })).toEqual({
      action: 'none',
    });
    expect(
      decideOpenCodeStalePendingUserPreemption({
        ...fresh,
        config: { staleAfterMs: 60_000, hardCapMs: POLICY.hardCapMs },
      })
    ).toEqual({ action: 'settle_plain_text', reason: OPENCODE_STALE_PENDING_PREEMPTED_REASON });
  });
});

describe('buildOpenCodeStalePendingPlainTextObservation', () => {
  it('carries the observed assistant evidence into a responded_plain_text observation', () => {
    expect(
      buildOpenCodeStalePendingPlainTextObservation({
        record: record(),
        reason: OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON,
      })
    ).toEqual({
      state: 'responded_plain_text',
      deliveredUserMessageId: 'msg_prompt',
      assistantMessageId: 'msg_assistant',
      toolCallNames: ['glob'],
      visibleMessageToolCallId: null,
      visibleReplyMessageId: null,
      visibleReplyCorrelation: null,
      latestAssistantPreview: null,
      reason: OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  logOpenCodeStalePendingResolution,
  OPENCODE_PROMPT_DELIVERY_TURN_USAGE_BASELINE_MS,
  OpenCodeStalePendingLogGate,
  readOpenCodeStalePendingTurnUsedTokens,
} from '../OpenCodeStalePendingObservationSignals';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';

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
    inboxTimestamp: '2026-08-22T17:48:00.000Z',
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
    lastAttemptAt: '2026-08-22T17:48:00.000Z',
    lastObservedAt: '2026-08-22T18:20:00.000Z',
    acceptedAt: '2026-08-22T17:48:00.000Z',
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
    createdAt: '2026-08-22T17:48:00.000Z',
    updatedAt: '2026-08-22T18:20:00.000Z',
    ...overrides,
  };
}

const PROBE_TARGET = {
  teamName: 'reportrun16',
  memberName: 'team-lead',
  laneId: 'primary',
  model: 'some-model',
};

describe('readOpenCodeStalePendingTurnUsedTokens', () => {
  // Negative control for the port being optional: with no probe wired the clock
  // has nothing but wall time, which is the behaviour that predates this signal.
  it('short-circuits when no probe is wired', async () => {
    await expect(
      readOpenCodeStalePendingTurnUsedTokens({
        ...PROBE_TARGET,
        pendingAgeMs: 10 * 60_000,
        read: undefined,
      })
    ).resolves.toBeNull();
  });

  it('samples only once the delivery has been quiet for the baseline window', async () => {
    const read = vi.fn().mockResolvedValue({ usedTokens: 183_000 });
    await expect(
      readOpenCodeStalePendingTurnUsedTokens({
        ...PROBE_TARGET,
        pendingAgeMs: OPENCODE_PROMPT_DELIVERY_TURN_USAGE_BASELINE_MS - 1,
        read,
      })
    ).resolves.toBeNull();
    await expect(
      readOpenCodeStalePendingTurnUsedTokens({ ...PROBE_TARGET, pendingAgeMs: null, read })
    ).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();

    await expect(
      readOpenCodeStalePendingTurnUsedTokens({
        ...PROBE_TARGET,
        pendingAgeMs: OPENCODE_PROMPT_DELIVERY_TURN_USAGE_BASELINE_MS,
        read,
      })
    ).resolves.toBe(183_000);
    expect(read).toHaveBeenCalledWith(PROBE_TARGET);
  });

  it('never lets a failing or empty probe change the decision', async () => {
    for (const read of [
      vi.fn().mockRejectedValue(new Error('reader unavailable')),
      vi.fn().mockResolvedValue(null),
      vi.fn().mockResolvedValue({ usedTokens: null }),
      vi.fn().mockResolvedValue({ usedTokens: Number.NaN }),
      vi.fn().mockResolvedValue({}),
    ]) {
      await expect(
        readOpenCodeStalePendingTurnUsedTokens({
          ...PROBE_TARGET,
          pendingAgeMs: 10 * 60_000,
          read,
        })
      ).resolves.toBeNull();
    }
  });
});

describe('OpenCodeStalePendingLogGate', () => {
  it('reports only the transition into a decision', () => {
    const gate = new OpenCodeStalePendingLogGate();
    expect(gate.isTransition('rec-1', 'keep_observing', 'busy')).toBe(true);
    expect(gate.isTransition('rec-1', 'keep_observing', 'busy')).toBe(false);
    expect(gate.isTransition('rec-1', 'keep_observing', 'evidence')).toBe(true);
    expect(gate.isTransition('rec-2', 'keep_observing', 'busy')).toBe(true);
    gate.forget('rec-1');
    expect(gate.isTransition('rec-1', 'keep_observing', 'evidence')).toBe(true);
    gate.clear();
    expect(gate.isTransition('rec-2', 'keep_observing', 'busy')).toBe(true);
  });
});

describe('logOpenCodeStalePendingResolution', () => {
  function sink(): { diagnostic: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
    return { diagnostic: vi.fn(), info: vi.fn() };
  }

  const context = {
    teamName: 'reportrun16',
    memberName: 'team-lead',
    laneId: 'primary',
    record: record(),
    turnActivity: { active: true, reason: 'session_status_busy' as const },
    hasExecutionEvidence: true,
    observedDiagnostics: ['OpenCode session status busy'],
    pendingAgeMs: 308_000,
  };

  it('writes nothing at all for a no-op resolution', () => {
    const logger = sink();
    logOpenCodeStalePendingResolution(logger, {
      ...context,
      resolution: { action: 'none' },
      gate: new OpenCodeStalePendingLogGate(),
    });
    expect(logger.diagnostic).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('writes one durable line per decision transition and downgrades the repeats', () => {
    const logger = sink();
    const gate = new OpenCodeStalePendingLogGate();
    const keepObserving = {
      ...context,
      resolution: { action: 'keep_observing' as const, reason: 'opencode_stale_pending_busy' },
      gate,
    };
    logOpenCodeStalePendingResolution(logger, keepObserving);
    logOpenCodeStalePendingResolution(logger, keepObserving);
    logOpenCodeStalePendingResolution(logger, keepObserving);
    expect(logger.diagnostic).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.diagnostic.mock.calls[0]?.[0]).toContain(
      'opencode_prompt_delivery_stale_pending team-lead/primary'
    );
    expect(logger.diagnostic.mock.calls[0]?.[0]).toContain('action=keep_observing');
    expect(logger.diagnostic.mock.calls[0]?.[0]).toContain('activity=busy');
    expect(logger.diagnostic.mock.calls[0]?.[0]).toContain('turnActive=true/session_status_busy');
    expect(logger.diagnostic.mock.calls[0]?.[0]).toContain('executionEvidence=true');
    expect(logger.diagnostic.mock.calls[0]?.[0]).toContain('pendingAgeMs=308000');
  });

  it('always writes a terminal decision durably and forgets the record', () => {
    const logger = sink();
    const gate = new OpenCodeStalePendingLogGate();
    const failed = {
      ...context,
      resolution: {
        action: 'fail_terminal' as const,
        reason: 'opencode_stale_pending_observe_window_exhausted',
        diagnostics: ['never settled'],
      },
      gate,
    };
    logOpenCodeStalePendingResolution(logger, failed);
    logOpenCodeStalePendingResolution(logger, failed);
    expect(logger.diagnostic).toHaveBeenCalledTimes(2);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

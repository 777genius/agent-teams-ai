import { RuntimeRecoverySignalAdapter } from '@features/team-runtime-recovery/main';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeFailureSignal } from '@features/team-runtime-recovery/contracts';
import type { RuntimeRecoveryJob } from '@features/team-runtime-recovery/core/application';
import type { InboxMessage, TeamAgentRuntimeSnapshot } from '@shared/types';

const snapshot: TeamAgentRuntimeSnapshot = {
  teamName: 'sandbox-team',
  runId: 'run-1',
  updatedAt: '2026-07-16T10:00:00.000Z',
  members: {
    bob: {
      memberName: 'bob',
      alive: true,
      restartable: true,
      providerId: 'codex',
      providerBackendId: 'codex-native',
      runtimeSessionId: 'session-1',
      runtimeModel: 'gpt-5',
      updatedAt: '2026-07-16T10:00:00.000Z',
    },
  },
};

function createAdapter(messagesByMember: Record<string, InboxMessage[]>) {
  const signals: RuntimeFailureSignal[] = [];
  const execute = vi.fn(async (signal: RuntimeFailureSignal) => {
    signals.push(signal);
    return { outcome: 'scheduled' as const, job: {} as never };
  });
  return {
    signals,
    execute,
    adapter: new RuntimeRecoverySignalAdapter({
      observe: { execute },
      getCurrentContextId: () => 'local',
      getRuntimeSnapshot: async () => snapshot,
      getLeadName: async () => 'team-lead',
      getInboxMessages: async (_teamName, memberName) => messagesByMember[memberName] ?? [],
    }),
  };
}

describe('RuntimeRecoverySignalAdapter', () => {
  it('uses structured agent_error metadata and correlates a recovery failure chain', async () => {
    const recovery: InboxMessage = {
      from: 'system',
      to: 'bob',
      text: 'continue safely',
      timestamp: '2026-07-16T09:59:00.000Z',
      read: true,
      messageId: 'recovery-message-1',
      messageKind: 'runtime_recovery_nudge',
      taskRefs: [{ taskId: 'task-1', displayId: 'T1', teamName: 'sandbox-team' }],
      runtimeRecovery: {
        schemaVersion: 1,
        recoveryId: 'job-1',
        sourceFailureId: 'failure-1',
        attempt: 1,
        reasonCode: 'provider_overloaded',
        payloadHash: 'hash',
      },
    };
    const error: InboxMessage = {
      from: 'bob',
      to: 'team-lead',
      text: 'bob hit a mailbox turn execution error. API Error: 529',
      timestamp: '2026-07-16T10:00:00.000Z',
      read: false,
      messageId: 'agent-error-1',
      messageKind: 'agent_error',
      agentError: {
        schemaVersion: 1,
        type: 'api_error',
        phase: 'terminal',
        detail: 'API Error: 529 overloaded_error',
        failedMessageId: 'recovery-message-1',
        runtimeSessionId: 'session-1',
        bootstrapRunId: 'run-1',
        innerRecoveryAttempts: 3,
      },
    };
    const { adapter, signals } = createAdapter({
      'team-lead': [error],
      bob: [recovery],
    });

    await adapter.scanTeamInbox('sandbox-team');

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: 'agent_error_mailbox',
      detail: 'API Error: 529 overloaded_error',
      failedMessageId: 'recovery-message-1',
      causedByRecoveryMessageId: 'recovery-message-1',
      runtimeSessionId: 'session-1',
      providerId: 'codex',
      taskRefs: recovery.taskRefs,
    });
  });

  it('supports wrapped legacy 529 text without requiring an anchored prefix', async () => {
    const { adapter, signals } = createAdapter({
      'team-lead': [
        {
          from: 'bob',
          to: 'team-lead',
          text: 'bob hit a mailbox turn execution error. Marking row processed. API Error: API Error: 529 overloaded_error',
          timestamp: '2026-07-16T10:00:00.000Z',
          read: false,
          messageId: 'legacy-error-1',
          messageKind: 'agent_error',
        },
      ],
    });

    await adapter.scanTeamInbox('sandbox-team');

    expect(signals[0]).toMatchObject({ source: 'legacy_message_scan', phase: 'terminal' });
  });

  it('does not treat an orchestrator-owned timeout recovery notice as terminal', async () => {
    const { adapter, execute } = createAdapter({
      'team-lead': [
        {
          from: 'bob',
          to: 'team-lead',
          text: 'bob hit a Codex native mailbox timeout. Scheduling one recovery turn that will inspect state before continuing. API Error: timeout',
          timestamp: '2026-07-16T10:00:00.000Z',
          read: false,
          messageId: 'sdk-retry-notice',
          messageKind: 'agent_error',
        },
      ],
    });

    await adapter.scanTeamInbox('sandbox-team');

    expect(execute).not.toHaveBeenCalled();
  });

  it('correlates an OpenCode terminal ledger outcome to the accepted recovery turn', async () => {
    const { adapter, signals } = createAdapter({});
    const job: RuntimeRecoveryJob = {
      id: 'job-1',
      signal: {
        id: 'failure-1',
        source: 'member_runtime_advisory',
        phase: 'terminal',
        observedAt: '2026-07-16T10:00:00.000Z',
        contextId: 'local',
        teamName: 'sandbox-team',
        memberName: 'bob',
        targetKind: 'member',
        detail: 'API Error: 529',
        providerId: 'opencode',
      },
      reasonCode: 'provider_overloaded',
      normalizedDetailHash: 'hash',
      circuitKey: 'circuit',
      status: 'awaiting_outcome',
      attempt: 1,
      nextAttemptAt: '2026-07-16T10:01:00.000Z',
      expiresAt: '2026-07-16T12:00:00.000Z',
      createdAt: '2026-07-16T10:00:00.000Z',
      updatedAt: '2026-07-16T10:01:00.000Z',
      recoveryMessageId: 'recovery-message-1',
    };

    await adapter.observeRecoveryOutcomeFailure({
      job,
      recoveryMessageId: 'recovery-message-1',
      responseState: 'session_error',
      detail: 'API Error: 529 overloaded_error',
      observedAt: '2026-07-16T10:02:00.000Z',
    });

    expect(signals[0]).toMatchObject({
      id: 'recovery-outcome:job-1:recovery-message-1:session_error',
      causedByRecoveryMessageId: 'recovery-message-1',
      detail: 'API Error: 529 overloaded_error',
      source: 'member_runtime_advisory',
      phase: 'terminal',
    });
  });
});

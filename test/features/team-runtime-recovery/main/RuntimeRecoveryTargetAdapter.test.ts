import { RuntimeRecoveryTargetAdapter } from '@features/team-runtime-recovery/main';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeRecoveryJob } from '@features/team-runtime-recovery/core/application';
import type { InboxMessage, TeamAgentRuntimeSnapshot, TeamTaskWithKanban } from '@shared/types';

const NOW = new Date('2026-07-16T10:02:00.000Z');

function makeJob(): RuntimeRecoveryJob {
  return {
    id: 'job-1',
    signal: {
      id: 'signal-1',
      source: 'agent_error_mailbox',
      phase: 'terminal',
      observedAt: '2026-07-16T10:00:00.000Z',
      contextId: 'local',
      teamName: 'sandbox-team',
      memberName: 'bob',
      targetKind: 'member',
      detail: 'API Error: 529',
      runId: 'run-1',
      runtimeSessionId: 'session-1',
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'model-a',
      taskRefs: [{ taskId: 'task-1', displayId: 'T1', teamName: 'sandbox-team' }],
    },
    reasonCode: 'provider_overloaded',
    normalizedDetailHash: 'hash',
    circuitKey: 'circuit',
    status: 'claimed',
    attempt: 0,
    nextAttemptAt: NOW.toISOString(),
    expiresAt: '2026-07-16T12:00:00.000Z',
    createdAt: '2026-07-16T10:00:00.000Z',
    updatedAt: NOW.toISOString(),
  };
}

function createAdapter(
  overrides: {
    runId?: string;
    sessionId?: string;
    providerId?: 'opencode' | 'anthropic';
    messages?: InboxMessage[];
    task?: TeamTaskWithKanban | null;
    busy?: boolean;
    enabled?: boolean;
    alive?: boolean;
  } = {}
) {
  const snapshot: TeamAgentRuntimeSnapshot = {
    teamName: 'sandbox-team',
    updatedAt: NOW.toISOString(),
    runId: overrides.runId ?? 'run-1',
    members: {
      bob: {
        memberName: 'bob',
        alive: overrides.alive ?? true,
        restartable: true,
        providerId: overrides.providerId ?? 'opencode',
        providerBackendId: overrides.providerId === 'anthropic' ? 'cli-sdk' : 'opencode-cli',
        runtimeModel: 'model-a',
        runtimeSessionId: overrides.sessionId ?? 'session-1',
        updatedAt: NOW.toISOString(),
      },
    },
  };
  const busy = vi.fn(async () => ({
    busy: overrides.busy ?? false,
    reason: overrides.busy ? 'opencode_retry_pending' : undefined,
    retryAfterIso: '2026-07-16T10:03:00.000Z',
  }));
  return {
    busy,
    adapter: new RuntimeRecoveryTargetAdapter({
      config: {
        getConfig: () => ({
          transientErrorsEnabled: overrides.enabled ?? true,
          rateLimitsEnabled: true,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      now: () => NOW,
      getCurrentContextId: () => 'local',
      getRuntimeState: async () => ({ isAlive: true, runId: snapshot.runId }),
      getRuntimeSnapshot: async () => snapshot,
      getLeadName: async () => 'team-lead',
      getInboxMessages: async () => overrides.messages ?? [],
      getTask: async () => overrides.task ?? ({ status: 'in_progress' } as TeamTaskWithKanban),
      getMemberAdvisory: async () => null,
      getOpenCodeBusyStatus: busy,
    }),
  };
}

describe('RuntimeRecoveryTargetAdapter', () => {
  it.each([
    ['run changed', { runId: 'run-2' }, 'run_changed'],
    ['session changed', { sessionId: 'session-2' }, 'runtime_session_changed'],
    ['provider changed', { providerId: 'anthropic' as const }, 'provider_changed'],
    ['setting disabled', { enabled: false }, 'setting_disabled'],
  ])('rejects %s', async (_label, overrides, reason) => {
    const { adapter } = createAdapter(overrides);
    await expect(adapter.preflight(makeJob())).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reason,
    });
  });

  it('cancels when a newer manual user message exists', async () => {
    const { adapter } = createAdapter({
      messages: [
        {
          from: 'user',
          to: 'bob',
          text: 'Do something else',
          timestamp: '2026-07-16T10:01:00.000Z',
          read: false,
          messageId: 'manual-1',
          source: 'user_sent',
        },
      ],
    });

    await expect(adapter.preflight(makeJob())).resolves.toMatchObject({
      ok: false,
      reason: 'new_manual_activity',
    });
  });

  it('does not dispatch while OpenCode has its own retry or foreground turn', async () => {
    const { adapter } = createAdapter({ busy: true });

    await expect(adapter.preflight(makeJob())).resolves.toEqual({
      ok: false,
      retryable: true,
      reason: 'opencode_retry_pending',
      retryAt: '2026-07-16T10:03:00.000Z',
    });
  });

  it('supersedes recovery when every referenced task is complete', async () => {
    const { adapter } = createAdapter({ task: { status: 'completed' } as TeamTaskWithKanban });

    await expect(adapter.preflight(makeJob())).resolves.toMatchObject({
      ok: false,
      reason: 'tasks_completed',
    });
  });

  it('escalates an offline teammate to the lead without rerouting work automatically', async () => {
    const { adapter } = createAdapter({ alive: false });

    await expect(adapter.preflight(makeJob())).resolves.toMatchObject({
      ok: false,
      reason: 'member_offline',
      escalateToLead: true,
      leadName: 'team-lead',
    });
  });
});

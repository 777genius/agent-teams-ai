import { RuntimeTurnSettledIngestor } from '@features/member-work-sync/core/application';
import { ClaudeStopHookPayloadNormalizer } from '@features/member-work-sync/main/infrastructure/ClaudeStopHookPayloadNormalizer';
import { NodeHashAdapter } from '@features/member-work-sync/main/infrastructure/NodeHashAdapter';
import { OpenCodeTurnSettledPayloadNormalizer } from '@features/member-work-sync/main/infrastructure/OpenCodeTurnSettledPayloadNormalizer';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberWorkSyncAuditEvent,
  RuntimeTurnSettledClaimedPayload,
  RuntimeTurnSettledEventStorePort,
  RuntimeTurnSettledInvalidResult,
  RuntimeTurnSettledProcessedResult,
  RuntimeTurnSettledTargetResolverPort,
} from '@features/member-work-sync/core/application';

function makePayload(raw: string): RuntimeTurnSettledClaimedPayload {
  return {
    id: 'event-1.claude.json',
    fileName: 'event-1.claude.json',
    filePath: '/tmp/event-1.claude.json',
    provider: 'claude',
    raw,
    claimedAt: '2026-04-29T12:00:00.000Z',
  };
}

function makeOpenCodePayload(raw: string): RuntimeTurnSettledClaimedPayload {
  return {
    id: 'event-1.opencode.json',
    fileName: 'event-1.opencode.json',
    filePath: '/tmp/event-1.opencode.json',
    provider: 'opencode',
    raw,
    claimedAt: '2026-04-29T12:00:00.000Z',
  };
}

describe('RuntimeTurnSettledIngestor', () => {
  it('normalizes Claude Stop payloads and enqueues resolved member reconcile', async () => {
    const payload = makePayload(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'ses-1',
        transcript_path: '/tmp/ses-1.jsonl',
      })
    );
    const processed: RuntimeTurnSettledProcessedResult[] = [];
    const store: RuntimeTurnSettledEventStorePort = {
      claimPending: vi.fn(async () => [payload]),
      markProcessed: vi.fn(async (_payload, result) => {
        processed.push(result);
      }),
      markInvalid: vi.fn(),
    };
    const resolver: RuntimeTurnSettledTargetResolverPort = {
      resolve: vi.fn(async () => ({ ok: true as const, teamName: 'team-a', memberName: 'alice' })),
    };
    const enqueueRuntimeTurnSettled = vi.fn(() => true);
    const auditEvents: MemberWorkSyncAuditEvent[] = [];

    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: store,
      normalizer: new ClaudeStopHookPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: resolver,
      reconcileQueue: { enqueueRuntimeTurnSettled },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event);
        },
      },
    });

    await expect(ingestor.drainPending()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      unresolved: 0,
      ignored: 0,
      invalid: 0,
      failed: 0,
    });
    expect(enqueueRuntimeTurnSettled).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'alice',
      event: expect.objectContaining({
        provider: 'claude',
        hookEventName: 'Stop',
        sessionId: 'ses-1',
        transcriptPath: '/tmp/ses-1.jsonl',
      }),
    });
    expect(processed[0]).toMatchObject({
      outcome: 'enqueued',
      teamName: 'team-a',
      memberName: 'alice',
    });
  });

  it('leaves a claimed payload unprocessed when the reconcile queue rejects it', async () => {
    const payload = makePayload(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'ses-1',
        transcript_path: '/tmp/ses-1.jsonl',
      })
    );
    const markProcessed = vi.fn();
    const warn = vi.fn();
    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: {
        claimPending: vi.fn(async () => [payload]),
        markProcessed,
        markInvalid: vi.fn(),
      },
      normalizer: new ClaudeStopHookPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: {
        resolve: vi.fn(async () => ({
          ok: true as const,
          teamName: 'team-a',
          memberName: 'alice',
        })),
      },
      reconcileQueue: { enqueueRuntimeTurnSettled: vi.fn(() => false) },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
      logger: {
        debug: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });

    await expect(ingestor.drainPending()).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      unresolved: 0,
      ignored: 0,
      invalid: 0,
      failed: 1,
    });
    expect(markProcessed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('runtime turn settled reconcile enqueue rejected', {
      filePath: payload.filePath,
      provider: 'claude',
      teamName: 'team-a',
      memberName: 'alice',
    });
  });

  it('quarantines malformed payloads without enqueueing reconcile', async () => {
    const payload = makePayload('not-json');
    const invalid: RuntimeTurnSettledInvalidResult[] = [];
    const store: RuntimeTurnSettledEventStorePort = {
      claimPending: vi.fn(async () => [payload]),
      markProcessed: vi.fn(),
      markInvalid: vi.fn(async (_payload, result) => {
        invalid.push(result);
      }),
    };

    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: store,
      normalizer: new ClaudeStopHookPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: { resolve: vi.fn() },
      reconcileQueue: { enqueueRuntimeTurnSettled: vi.fn(() => true) },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
    });

    await expect(ingestor.drainPending()).resolves.toMatchObject({
      claimed: 1,
      invalid: 1,
      enqueued: 0,
    });
    expect(invalid[0]).toMatchObject({ reason: 'invalid_json' });
  });

  it('records unresolved Stop events as processed diagnostics', async () => {
    const payload = makePayload(
      JSON.stringify({ hook_event_name: 'Stop', transcript_path: '/tmp/unknown.jsonl' })
    );
    const processed: RuntimeTurnSettledProcessedResult[] = [];
    const store: RuntimeTurnSettledEventStorePort = {
      claimPending: vi.fn(async () => [payload]),
      markProcessed: vi.fn(async (_payload, result) => {
        processed.push(result);
      }),
      markInvalid: vi.fn(),
    };

    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: store,
      normalizer: new ClaudeStopHookPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: {
        resolve: vi.fn(async () => ({
          ok: false as const,
          reason: 'no_matching_member_session',
        })),
      },
      reconcileQueue: { enqueueRuntimeTurnSettled: vi.fn(() => true) },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
    });

    await expect(ingestor.drainPending()).resolves.toMatchObject({
      claimed: 1,
      unresolved: 1,
      ignored: 0,
      enqueued: 0,
    });
    expect(processed[0]).toMatchObject({
      outcome: 'unresolved',
      reason: 'no_matching_member_session',
    });
  });

  it('normalizes OpenCode turn-settled payloads and enqueues provider-owned member reconcile', async () => {
    const payload = makeOpenCodePayload(
      JSON.stringify({
        schemaVersion: 1,
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        sessionId: 'ses-opencode-1',
        runtimePromptMessageId: 'msg_123',
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        teamName: 'team-a',
        cwd: '/tmp/project',
        outcome: 'success',
        recordedAt: '2026-04-29T12:00:00.000Z',
      })
    );
    const processed: RuntimeTurnSettledProcessedResult[] = [];
    const store: RuntimeTurnSettledEventStorePort = {
      claimPending: vi.fn(async () => [payload]),
      markProcessed: vi.fn(async (_payload, result) => {
        processed.push(result);
      }),
      markInvalid: vi.fn(),
    };
    const resolver: RuntimeTurnSettledTargetResolverPort = {
      resolve: vi.fn(async () => ({ ok: true as const, teamName: 'team-a', memberName: 'jack' })),
    };
    const enqueueRuntimeTurnSettled = vi.fn(() => true);
    const auditEvents: MemberWorkSyncAuditEvent[] = [];

    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: store,
      normalizer: new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: resolver,
      reconcileQueue: { enqueueRuntimeTurnSettled },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event);
        },
      },
    });

    await expect(ingestor.drainPending()).resolves.toMatchObject({
      claimed: 1,
      enqueued: 1,
      invalid: 0,
      unresolved: 0,
      ignored: 0,
    });
    expect(enqueueRuntimeTurnSettled).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'jack',
      event: expect.objectContaining({
        provider: 'opencode',
        hookEventName: 'Stop',
        sessionId: 'ses-opencode-1',
        turnId: 'msg_123',
        teamName: 'team-a',
        memberName: 'jack',
        agentId: 'secondary:opencode:jack',
        outcome: 'success',
      }),
    });
    expect(processed[0]).toMatchObject({
      outcome: 'enqueued',
      teamName: 'team-a',
      memberName: 'jack',
    });
    expect(auditEvents.map((event) => event.event)).toEqual([
      'turn_settled_claimed',
      'turn_settled_resolved',
    ]);
  });

  it.each([
    'timeout',
    'stream_unavailable',
    'prompt_rejected',
    'idle_without_assistant_activity',
    'unknown',
  ])('enqueues prompt-owned OpenCode outcome %s for recovery reconcile', async (outcome) => {
    const payload = makeOpenCodePayload(
      JSON.stringify({
        schemaVersion: 1,
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        sessionId: 'ses-opencode-1',
        runtimePromptMessageId: 'msg_123',
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        teamName: 'team-a',
        outcome,
        recordedAt: '2026-04-29T12:00:00.000Z',
      })
    );
    const processed: RuntimeTurnSettledProcessedResult[] = [];
    const store: RuntimeTurnSettledEventStorePort = {
      claimPending: vi.fn(async () => [payload]),
      markProcessed: vi.fn(async (_payload, result) => {
        processed.push(result);
      }),
      markInvalid: vi.fn(),
    };
    const resolver: RuntimeTurnSettledTargetResolverPort = {
      resolve: vi.fn(async () => ({ ok: true as const, teamName: 'team-a', memberName: 'jack' })),
    };
    const enqueueRuntimeTurnSettled = vi.fn(() => true);

    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: store,
      normalizer: new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: resolver,
      reconcileQueue: { enqueueRuntimeTurnSettled },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
    });

    await expect(ingestor.drainPending()).resolves.toMatchObject({
      claimed: 1,
      enqueued: 1,
      unresolved: 0,
      ignored: 0,
      invalid: 0,
    });
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'opencode',
        turnId: 'msg_123',
        threadId: 'msg_123',
        outcome,
      })
    );
    expect(enqueueRuntimeTurnSettled).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'jack',
      event: expect.objectContaining({
        provider: 'opencode',
        turnId: 'msg_123',
        outcome,
      }),
    });
    expect(processed[0]).toMatchObject({
      outcome: 'enqueued',
      teamName: 'team-a',
      memberName: 'jack',
    });
  });

  it.each([
    'timeout',
    'stream_unavailable',
    'prompt_rejected',
    'idle_without_assistant_activity',
    'unknown',
  ])('ignores non-terminal OpenCode outcome %s without prompt identity', async (outcome) => {
    const payload = makeOpenCodePayload(
      JSON.stringify({
        schemaVersion: 1,
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        sessionId: 'ses-opencode-1',
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        teamName: 'team-a',
        outcome,
        recordedAt: '2026-04-29T12:00:00.000Z',
      })
    );
    const processed: RuntimeTurnSettledProcessedResult[] = [];
    const store: RuntimeTurnSettledEventStorePort = {
      claimPending: vi.fn(async () => [payload]),
      markProcessed: vi.fn(async (_payload, result) => {
        processed.push(result);
      }),
      markInvalid: vi.fn(),
    };
    const resolver: RuntimeTurnSettledTargetResolverPort = {
      resolve: vi.fn(),
    };
    const enqueueRuntimeTurnSettled = vi.fn(() => true);

    const ingestor = new RuntimeTurnSettledIngestor({
      eventStore: store,
      normalizer: new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter()),
      targetResolver: resolver,
      reconcileQueue: { enqueueRuntimeTurnSettled },
      clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
    });

    await expect(ingestor.drainPending()).resolves.toMatchObject({
      claimed: 1,
      enqueued: 0,
      unresolved: 0,
      ignored: 1,
      invalid: 0,
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(enqueueRuntimeTurnSettled).not.toHaveBeenCalled();
    expect(processed[0]).toMatchObject({
      outcome: 'ignored',
      reason: `opencode_non_terminal_outcome:${outcome}`,
    });
  });

  it.each(['timeout', 'idle_without_assistant_activity'])(
    'ignores non-terminal OpenCode outcome %s with turnId but without runtime prompt identity',
    async (outcome) => {
      const payload = makeOpenCodePayload(
        JSON.stringify({
          schemaVersion: 1,
          provider: 'opencode',
          source: 'agent-teams-orchestrator-opencode',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: 'ses-opencode-1',
          turnId: 'msg_launch_or_bootstrap',
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
          teamName: 'team-a',
          outcome,
          recordedAt: '2026-04-29T12:00:00.000Z',
        })
      );
      const processed: RuntimeTurnSettledProcessedResult[] = [];
      const store: RuntimeTurnSettledEventStorePort = {
        claimPending: vi.fn(async () => [payload]),
        markProcessed: vi.fn(async (_payload, result) => {
          processed.push(result);
        }),
        markInvalid: vi.fn(),
      };
      const resolver: RuntimeTurnSettledTargetResolverPort = {
        resolve: vi.fn(),
      };
      const enqueueRuntimeTurnSettled = vi.fn(() => true);

      const ingestor = new RuntimeTurnSettledIngestor({
        eventStore: store,
        normalizer: new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter()),
        targetResolver: resolver,
        reconcileQueue: { enqueueRuntimeTurnSettled },
        clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
      });

      await expect(ingestor.drainPending()).resolves.toMatchObject({
        claimed: 1,
        enqueued: 0,
        unresolved: 0,
        ignored: 1,
        invalid: 0,
      });
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(enqueueRuntimeTurnSettled).not.toHaveBeenCalled();
      expect(processed[0]?.event).toEqual(
        expect.objectContaining({
          provider: 'opencode',
          turnId: 'msg_launch_or_bootstrap',
          outcome,
        })
      );
      expect(processed[0]?.event).not.toHaveProperty('threadId');
      expect(processed[0]).toMatchObject({
        outcome: 'ignored',
        reason: `opencode_non_terminal_outcome:${outcome}`,
      });
    }
  );

  it.each(['success', 'error'])(
    'ignores terminal OpenCode outcome %s with turnId but without runtime prompt identity',
    async (outcome) => {
      const payload = makeOpenCodePayload(
        JSON.stringify({
          schemaVersion: 1,
          provider: 'opencode',
          source: 'agent-teams-orchestrator-opencode',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: 'ses-opencode-1',
          turnId: 'msg_launch_or_bootstrap',
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
          teamName: 'team-a',
          outcome,
          recordedAt: '2026-04-29T12:00:00.000Z',
        })
      );
      const processed: RuntimeTurnSettledProcessedResult[] = [];
      const store: RuntimeTurnSettledEventStorePort = {
        claimPending: vi.fn(async () => [payload]),
        markProcessed: vi.fn(async (_payload, result) => {
          processed.push(result);
        }),
        markInvalid: vi.fn(),
      };
      const resolver: RuntimeTurnSettledTargetResolverPort = {
        resolve: vi.fn(),
      };
      const enqueueRuntimeTurnSettled = vi.fn(() => true);

      const ingestor = new RuntimeTurnSettledIngestor({
        eventStore: store,
        normalizer: new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter()),
        targetResolver: resolver,
        reconcileQueue: { enqueueRuntimeTurnSettled },
        clock: { now: () => new Date('2026-04-29T12:01:00.000Z') },
      });

      await expect(ingestor.drainPending()).resolves.toMatchObject({
        claimed: 1,
        enqueued: 0,
        unresolved: 0,
        ignored: 1,
        invalid: 0,
      });
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(enqueueRuntimeTurnSettled).not.toHaveBeenCalled();
      expect(processed[0]).toMatchObject({
        event: expect.objectContaining({
          provider: 'opencode',
          turnId: 'msg_launch_or_bootstrap',
          outcome,
        }),
        outcome: 'ignored',
        reason: 'opencode_missing_prompt_identity',
      });
    }
  );
});

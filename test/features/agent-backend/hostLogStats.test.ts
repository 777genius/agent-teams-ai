import { describe, expect, it, vi } from 'vitest';

import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import {
  projectTeamActivityLogs,
  projectTeamActivityStats,
} from '../../../src/features/agent-backend/main/adapters/output/projectTeamActivity';
import { createHostLogStatsApi } from '../../../src/features/agent-backend/renderer/createHostLogStatsApi';

import type {
  AgentBackendApi,
  BackendActivityEvent,
} from '../../../src/features/agent-backend/contracts/operations';
const stats = {
  kind: 'host_activity_stats' as const,
  memberName: 'alice',
  scope: 'retained_runtime_activity' as const,
  generations: 1,
  observedMessages: 1,
  toolUsage: { Read: 1 },
  compactions: 1,
  inputTokens: null,
  outputTokens: 7,
  costUsd: null,
  gaps: ['retention'],
  computedAt: '2026-10-23T00:00:00Z',
};
const log = {
  kind: 'host_activity' as const,
  sessionId: 'host-TEST',
  memberId: 'alice-id',
  memberName: 'alice',
  generation: '1',
  description: 'Captured runtime activity',
  startTime: null,
  durationMs: null,
  messageCount: 1,
  isOngoing: false,
  events: [],
  gaps: ['retention'],
};
describe('Host Logs/Stats finite projections', () => {
  it('preserves explicit unknown metrics, drops extras and refuses wrong selection or fabricated clocks', () => {
    const result = projectTeamActivityStats(
      { kind: 'team-activity-stats', stats: { ...stats, privateSession: 'SECRET' } },
      'alice'
    );
    expect(result.stats.inputTokens).toBeNull();
    expect(result.stats.costUsd).toBeNull();
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(() => projectTeamActivityStats({ kind: 'team-activity-stats', stats }, 'bob')).toThrow();
    const event = vi.fn((raw: unknown) => raw as BackendActivityEvent);
    const logs = projectTeamActivityLogs(
      { kind: 'team-activity-logs', logs: [{ ...log, nativeRef: 'SECRET' }] },
      event,
      { memberName: 'alice' }
    );
    expect(JSON.stringify(logs)).not.toContain('SECRET');
    expect(() =>
      projectTeamActivityLogs({ kind: 'team-activity-logs', logs: [log] }, event, {
        taskId: 'other-task',
      })
    ).toThrow();
    expect(() =>
      projectTeamActivityLogs(
        { kind: 'team-activity-logs', logs: [{ ...log, startTime: 'invented' }] },
        event,
        { memberName: 'alice' }
      )
    ).toThrow();
  });
  it('projects child provenance separately and refuses raw native IDs or nested child envelopes', () => {
    const request = {
      handle: { handleId: 'TEST' },
      commandId: 'TEST-read',
      operation: 'team.activity.logs.read' as const,
      payload: { memberName: 'alice' },
    };
    const child = {
      kind: 'subagent',
      phase: 'usage',
      childId: `child-${'a'.repeat(64)}`,
      parentToolRef: `tool-${'b'.repeat(64)}`,
      childTotalTokens: 99,
      childToolUses: 3,
      childDurationMs: 21,
      sessionRef: 'SECRET',
    };
    const result = (data: unknown) =>
      projectBackendResult(request, {
        ok: true,
        value: {
          kind: 'team-activity-logs',
          logs: [
            {
              ...log,
              events: [{ eventId: 'TEST-event', sequence: 1, inputId: 'TEST-input', data }],
            },
          ],
        },
      });
    expect(JSON.stringify(result(child))).toContain('childTotalTokens');
    expect(JSON.stringify(result(child))).not.toContain('SECRET');
    expect(() => result({ ...child, childId: 'raw-native-child' })).toThrow();
    expect(() => result({ ...child, phase: 'fact', fact: child })).toThrow();
    expect(() =>
      projectTeamActivityStats(
        { kind: 'team-activity-stats', stats: { ...stats, outputTokens: 1.5 } },
        'alice'
      )
    ).toThrow();
  });
  it('keeps exact original handle/query and refuses late responses after context changes', async () => {
    let current = true;
    const invoke = vi
      .fn<AgentBackendApi['invoke']>()
      .mockResolvedValue({ ok: true, value: { kind: 'team-activity-stats', stats } });
    const backend: AgentBackendApi = { invoke, getConnections: vi.fn() };
    const api = createHostLogStatsApi({
      backend,
      captureScope: () => () => current,
      async resolve() {
        return {
          handle: { handleId: 'TEST-original' },
          assertCurrent() {
            if (!current) throw new Error('Context changed');
          },
        };
      },
    });
    expect(await api.getMemberStats('host-team:TEST-original', 'alice')).toEqual(stats);
    expect(invoke.mock.calls[0]![0]).toMatchObject({
      handle: { handleId: 'TEST-original' },
      payload: { memberName: 'alice' },
      operation: 'team.activity.stats.read',
    });
    invoke.mockImplementation(async () => {
      current = false;
      return { ok: true, value: { kind: 'team-activity-logs', logs: [log] } };
    });
    await expect(
      api.getLogsForTask('host-team:TEST-original', 'TEST-task', {
        owner: 'bob',
        since: 'arbitrary',
      })
    ).rejects.toThrow('Context changed');
    expect(invoke.mock.calls[1]![0].payload).toEqual({ taskId: 'TEST-task' });
  });
});

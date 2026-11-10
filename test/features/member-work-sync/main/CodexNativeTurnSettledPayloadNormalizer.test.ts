import { CodexNativeTurnSettledPayloadNormalizer } from '@features/member-work-sync/main/infrastructure/CodexNativeTurnSettledPayloadNormalizer';
import { NodeHashAdapter } from '@features/member-work-sync/main/infrastructure/NodeHashAdapter';
import { describe, expect, it } from 'vitest';

describe('CodexNativeTurnSettledPayloadNormalizer', () => {
  it('normalizes orchestrator-native Codex turn-settled payloads', () => {
    const normalizer = new CodexNativeTurnSettledPayloadNormalizer(new NodeHashAdapter());

    const result = normalizer.normalize({
      provider: 'codex',
      raw: JSON.stringify({
        schemaVersion: 1,
        provider: 'codex',
        source: 'agent-teams-orchestrator-codex-native',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        sessionId: 'ses-1',
        threadId: 'thread-1',
        agentId: 'jack@team-a',
        agentName: 'jack',
        teamName: 'team-a',
        cwd: '/tmp/project',
        outcome: 'success',
        recordedAt: '2026-04-29T12:00:00.000Z',
      }),
      recordedAt: '2026-04-29T12:00:01.000Z',
    });

    expect(result).toEqual({
      ok: true,
      event: expect.objectContaining({
        provider: 'codex',
        hookEventName: 'Stop',
        sessionId: 'ses-1',
        threadId: 'thread-1',
        teamName: 'team-a',
        memberName: 'jack',
        agentId: 'jack@team-a',
        cwd: '/tmp/project',
        outcome: 'success',
        recordedAt: '2026-04-29T12:00:00.000Z',
      }),
    });
  });

  it('rejects Codex payloads without durable team/member identity', () => {
    const normalizer = new CodexNativeTurnSettledPayloadNormalizer(new NodeHashAdapter());

    expect(
      normalizer.normalize({
        provider: 'codex',
        raw: JSON.stringify({
          provider: 'codex',
          source: 'agent-teams-orchestrator-codex-native',
          eventName: 'runtime_turn_settled',
          sessionId: 'ses-1',
        }),
        recordedAt: '2026-04-29T12:00:01.000Z',
      })
    ).toEqual({ ok: false, reason: 'missing_team_member_identity' });
  });
});

import { describe, expect, it } from 'vitest';

import { OpenCodeTurnSettledPayloadNormalizer } from '@features/member-work-sync/main/infrastructure/OpenCodeTurnSettledPayloadNormalizer';
import { NodeHashAdapter } from '@features/member-work-sync/main/infrastructure/NodeHashAdapter';

describe('OpenCodeTurnSettledPayloadNormalizer', () => {
  it('normalizes orchestrator-native OpenCode turn-settled payloads', () => {
    const normalizer = new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter());

    const result = normalizer.normalize({
      provider: 'opencode',
      raw: JSON.stringify({
        schemaVersion: 1,
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        sessionId: 'ses-opencode-1',
        runtimePromptMessageId: 'msg_123',
        laneId: 'lane-jack',
        memberName: 'jack',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        outcome: 'success',
        observedAt: '2026-04-29T12:00:00.000Z',
      }),
      recordedAt: '2026-04-29T12:00:01.000Z',
    });

    expect(result).toEqual({
      ok: true,
      event: expect.objectContaining({
        provider: 'opencode',
        hookEventName: 'Stop',
        sessionId: 'ses-opencode-1',
        turnId: 'msg_123',
        threadId: 'msg_123',
        teamName: 'team-a',
        memberName: 'jack',
        agentId: 'lane-jack',
        cwd: '/tmp/project',
        outcome: 'success',
        runtimeInstanceId: 'opencode:lane-jack:ses-opencode-1',
        recordedAt: '2026-04-29T12:00:00.000Z',
      }),
    });
    if (result.ok) {
      expect(result.event.completedGeneration).toEqual(expect.any(Number));
    }
  });

  it('rejects OpenCode payloads without durable team/member identity', () => {
    const normalizer = new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter());

    expect(
      normalizer.normalize({
        provider: 'opencode',
        raw: JSON.stringify({
          provider: 'opencode',
          source: 'agent-teams-orchestrator-opencode',
          eventName: 'runtime_turn_settled',
          sessionId: 'ses-opencode-1',
        }),
        recordedAt: '2026-04-29T12:00:01.000Z',
      })
    ).toEqual({ ok: false, reason: 'missing_team_member_identity' });
  });

  it('rejects payloads from non-agent-teams OpenCode sources', () => {
    const normalizer = new OpenCodeTurnSettledPayloadNormalizer(new NodeHashAdapter());

    expect(
      normalizer.normalize({
        provider: 'opencode',
        raw: JSON.stringify({
          provider: 'opencode',
          source: 'some-other-source',
          eventName: 'runtime_turn_settled',
          sessionId: 'ses-opencode-1',
          teamName: 'team-a',
          memberName: 'jack',
        }),
        recordedAt: '2026-04-29T12:00:01.000Z',
      })
    ).toEqual({ ok: false, reason: 'source_mismatch' });
  });
});

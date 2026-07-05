import { describe, expect, it } from 'vitest';

import {
  buildRuntimeBootstrapCheckinCommandId,
  buildRuntimeControlCommandId,
  buildRuntimeControlEventId,
  buildRuntimeDeliverMessageCommandId,
  buildRuntimeHeartbeatCommandId,
  buildRuntimePermissionAnswerCommandId,
  buildRuntimeTaskEventCommandId,
  createRuntimeControlCommandId,
  isRuntimeControlProviderId,
  normalizeRuntimeControlIdPart,
} from '../index';

describe('RuntimeControlIds', () => {
  it('normalizes runtime control id values without accepting blanks', () => {
    expect(createRuntimeControlCommandId(' command-1 ')).toBe('command-1');
    expect(normalizeRuntimeControlIdPart(' team-a ', 'teamName')).toBe('team-a');
    expect(normalizeRuntimeControlIdPart(' Team:One ', 'teamName')).toBe('Team%3AOne');
    expect(() => createRuntimeControlCommandId('   ')).toThrow(
      'Runtime control id missing commandId'
    );
    expect(() => normalizeRuntimeControlIdPart('', 'runId')).toThrow(
      'Runtime control id missing runId'
    );
  });

  it('follows the runtime control provider id convention', () => {
    expect(isRuntimeControlProviderId('opencode')).toBe(true);
    expect(isRuntimeControlProviderId('subscription')).toBe(true);
    expect(isRuntimeControlProviderId('codex')).toBe(false);
  });

  it('builds stable command ids for runtime ingress operations', () => {
    expect(
      buildRuntimeBootstrapCheckinCommandId({
        providerId: 'opencode',
        teamName: 'Team',
        laneId: 'lane-1',
        runId: 'run-1',
        memberName: 'Builder',
        runtimeSessionId: 'session-1',
      })
    ).toBe('opencode:bootstrap-checkin:Team:lane-1:run-1:Builder:session-1');

    expect(
      buildRuntimeHeartbeatCommandId({
        providerId: 'opencode',
        teamName: 'Team',
        laneId: 'lane-1',
        runId: 'run-1',
        memberName: 'Builder',
        runtimeSessionId: 'session-1',
        observedAt: '2026-01-01T00:00:00.000Z',
      })
    ).toBe('opencode:heartbeat:Team:lane-1:run-1:Builder:session-1:2026-01-01T00%3A00%3A00.000Z');

    expect(
      buildRuntimeTaskEventCommandId({
        providerId: 'opencode',
        teamName: 'Team',
        laneId: 'lane-1',
        runId: 'run-1',
        idempotencyKey: 'task-key-1',
      })
    ).toBe('opencode:task-event:Team:lane-1:run-1:task-key-1');

    expect(
      buildRuntimeDeliverMessageCommandId({
        providerId: 'opencode',
        teamName: 'Team',
        laneId: 'lane-1',
        runId: 'run-1',
        idempotencyKey: 'message-key-1',
      })
    ).toBe('opencode:deliver-message:Team:lane-1:run-1:message-key-1');

    expect(
      buildRuntimePermissionAnswerCommandId({
        providerId: 'opencode',
        teamName: 'Team',
        laneId: 'lane-1',
        runId: 'run-1',
        requestId: 'request-1',
        decision: 'allow',
      })
    ).toBe('opencode:permission-answer:Team:lane-1:run-1:request-1:allow');
  });

  it('rejects invalid provider values at runtime for command and event ids', () => {
    expect(() =>
      buildRuntimeControlCommandId({
        providerId: 'codex' as never,
        verb: 'heartbeat',
        teamName: 'Team',
        laneId: 'lane-1',
        runId: 'run-1',
      })
    ).toThrow('Invalid runtime control provider: codex');

    expect(() =>
      buildRuntimeControlEventId({
        providerId: 'codex' as never,
        eventType: 'RuntimeHeartbeatAccepted',
        commandId: createRuntimeControlCommandId('command-1'),
        occurredAt: '2026-01-01T00:00:00.000Z',
      })
    ).toThrow('Invalid runtime control provider: codex');
  });
});

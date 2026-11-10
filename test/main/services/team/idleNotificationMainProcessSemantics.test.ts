import { describe, expect, it } from 'vitest';

import { classifyIdleNotificationForMainProcess } from '../../../../src/main/services/team/idleNotificationMainProcessSemantics';

describe('idleNotificationMainProcessSemantics', () => {
  it('classifies heartbeat, passive peer summary, interrupted, and failure consistently', () => {
    expect(
      classifyIdleNotificationForMainProcess('{"type":"idle_notification","idleReason":"available"}')
    ).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: false,
      handling: 'silent_noise',
    });

    expect(
      classifyIdleNotificationForMainProcess(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        })
      )
    ).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: true,
      peerSummary: '[to bob] aligned on rollout order',
      handling: 'passive_activity',
    });

    expect(
      classifyIdleNotificationForMainProcess(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'interrupted',
          summary: '[to bob] waiting for clarification',
        })
      )
    ).toMatchObject({
      primaryKind: 'interrupted',
      hasPeerSummary: true,
      handling: 'visible_actionable',
    });

    expect(
      classifyIdleNotificationForMainProcess(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'failed',
          completedStatus: 'failed',
          failureReason: 'teammate crashed',
        })
      )
    ).toMatchObject({
      primaryKind: 'failure',
      hasPeerSummary: false,
      handling: 'visible_actionable',
    });
  });

  it('treats whitespace summary as heartbeat noise and task-terminal states as actionable', () => {
    expect(
      classifyIdleNotificationForMainProcess(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '   ',
        })
      )
    ).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: false,
      handling: 'silent_noise',
    });

    expect(
      classifyIdleNotificationForMainProcess(
        JSON.stringify({
          type: 'idle_notification',
          completedTaskId: 'task-1',
          completedStatus: 'resolved',
        })
      )
    ).toMatchObject({
      primaryKind: 'task_terminal',
      handling: 'visible_actionable',
    });

    expect(
      classifyIdleNotificationForMainProcess(
        JSON.stringify({
          type: 'idle_notification',
          completedStatus: 'blocked',
        })
      )
    ).toMatchObject({
      primaryKind: 'task_terminal',
      handling: 'visible_actionable',
    });
  });

  it('returns null for malformed or non-idle payloads', () => {
    expect(classifyIdleNotificationForMainProcess('{')).toBeNull();
    expect(
      classifyIdleNotificationForMainProcess('{"type":"shutdown_request","reason":"done"}')
    ).toBeNull();
  });
});

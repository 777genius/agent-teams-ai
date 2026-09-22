import { describe, expect, it } from 'vitest';

import {
  classifyIdleNotification,
  getIdleNoiseLabel,
  shouldKeepIdleMessageInActivityWhenNoiseHidden,
} from '@renderer/utils/idleNotificationSemantics';

describe('idleNotificationSemantics', () => {
  it('classifies heartbeat, passive peer summary, interrupted, and failure consistently', () => {
    expect(
      classifyIdleNotification('{"type":"idle_notification","idleReason":"available"}')
    ).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: false,
      liveDelivery: 'silent_finalize',
      uiPresentation: 'heartbeat',
      countsAsBootstrapConfirmation: true,
    });

    expect(
      classifyIdleNotification(
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
      liveDelivery: 'passive_activity',
      uiPresentation: 'peer_summary',
      countsAsBootstrapConfirmation: true,
    });

    expect(
      classifyIdleNotification(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'interrupted',
          summary: '[to bob] waiting for clarification',
        })
      )
    ).toMatchObject({
      primaryKind: 'interrupted',
      hasPeerSummary: true,
      liveDelivery: 'visible_actionable',
      uiPresentation: 'interrupted',
    });

    expect(
      classifyIdleNotification(
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
      liveDelivery: 'visible_actionable',
      uiPresentation: 'failure',
      countsAsBootstrapConfirmation: false,
    });
  });

  it('keeps only payload-backed peer summaries in the hidden-noise activity sink', () => {
    expect(
      shouldKeepIdleMessageInActivityWhenNoiseHidden(
        '{"type":"idle_notification","idleReason":"available"}'
      )
    ).toBe(false);

    expect(
      shouldKeepIdleMessageInActivityWhenNoiseHidden(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '   ',
        })
      )
    ).toBe(false);

    expect(
      shouldKeepIdleMessageInActivityWhenNoiseHidden(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        })
      )
    ).toBe(true);
  });

  it('keeps pure heartbeat as compact noise but not heartbeat with payload summary', () => {
    expect(getIdleNoiseLabel('{"type":"idle_notification","idleReason":"available"}')).toBe(
      'Idle (available)'
    );
    expect(
      getIdleNoiseLabel(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        })
      )
    ).toBeNull();
  });
});

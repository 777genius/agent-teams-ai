import { describe, expect, it } from 'vitest';

import {
  classifyIdleNotificationText,
  getIdleGraphLabel,
  shouldExcludeInboxTextFromReplyCandidates,
  shouldSuppressDesktopNotificationForInboxText,
} from '../../../src/shared/utils/idleNotificationSemantics';

describe('idleNotificationSemantics', () => {
  it('classifies passive peer summaries as heartbeat with peer summary', () => {
    const classified = classifyIdleNotificationText(
      JSON.stringify({
        type: 'idle_notification',
        idleReason: 'available',
        summary: '[to bob] aligned on rollout order',
      })
    );

    expect(classified).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: true,
      peerSummary: '[to bob] aligned on rollout order',
      countsAsBootstrapConfirmation: true,
    });
  });

  it('suppresses desktop notifications for idle payloads but not normal text', () => {
    expect(
      shouldSuppressDesktopNotificationForInboxText(
        '{"type":"idle_notification","idleReason":"available"}'
      )
    ).toBe(true);
    expect(
      shouldSuppressDesktopNotificationForInboxText('Need one more input from you')
    ).toBe(false);
  });

  it('excludes passive idle summaries from reply candidates', () => {
    expect(
      shouldExcludeInboxTextFromReplyCandidates(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        })
      )
    ).toBe(true);
    expect(shouldExcludeInboxTextFromReplyCandidates('Human reply')).toBe(false);
  });

  it('builds graph labels from semantic idle summaries instead of generic idle', () => {
    expect(
      getIdleGraphLabel(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        })
      )
    ).toBe('[to bob] aligned on rollout order');
    expect(getIdleGraphLabel('{"type":"idle_notification","idleReason":"available"}')).toBe(
      'idle'
    );
  });
});

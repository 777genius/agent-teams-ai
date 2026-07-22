import { describe, expect, it } from 'vitest';

import { projectLeadRelayReply } from '../TeamProvisioningLeadRelayProjection';

const baseInput = {
  relayPrompt: 'relay prompt',
  replyVisibility: 'internal_activity' as const,
  capturedVisibleSendMessage: false,
  capturedUserVisibleSendMessage: false,
  leadName: 'team-lead',
  runId: 'run-1',
  nowIso: '2026-01-01T00:00:00.000Z',
  nowMs: 123,
};

describe('lead relay reply projection', () => {
  it('suppresses empty, internal-control, duplicate, and unverified state replies', () => {
    expect(projectLeadRelayReply({ ...baseInput, replyText: null })).toEqual({
      kind: 'suppressed',
      reason: 'empty',
    });
    expect(
      projectLeadRelayReply({
        ...baseInput,
        replyText: '<teammate-message from="alice" to="team-lead">Hi</teammate-message>',
      })
    ).toEqual({ kind: 'suppressed', reason: 'internal_control' });
    expect(
      projectLeadRelayReply({
        ...baseInput,
        replyText: 'Forwarded via SendMessage.',
        capturedVisibleSendMessage: true,
      })
    ).toEqual({ kind: 'suppressed', reason: 'visible_duplicate' });
    expect(
      projectLeadRelayReply({
        ...baseInput,
        replyText: '#abcd1234 is complete',
      })
    ).toEqual({ kind: 'suppressed', reason: 'unverified_state' });
  });

  it('projects internal relay replies to live activity', () => {
    expect(projectLeadRelayReply({ ...baseInput, replyText: 'I will check this.' })).toEqual({
      kind: 'live_activity',
      text: 'I will check this.',
      messageId: 'lead-relay-run-1-123',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('projects user-visible relay replies to persisted lead-process messages', () => {
    expect(
      projectLeadRelayReply({
        ...baseInput,
        replyVisibility: 'user',
        replyText: 'I created a task for this.',
      })
    ).toEqual({
      kind: 'user_message',
      message: {
        from: 'team-lead',
        to: 'user',
        text: 'I created a task for this.',
        timestamp: '2026-01-01T00:00:00.000Z',
        read: true,
        summary: 'I created a task for this.',
        messageId: 'lead-process-run-1-123',
        source: 'lead_process',
      },
    });
  });
});

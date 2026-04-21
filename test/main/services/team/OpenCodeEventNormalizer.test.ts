import { describe, expect, it } from 'vitest';

import {
  mapOpenCodeStatusToDurableState,
  normalizeOpenCodeEvent,
  normalizeOpenCodeSessionStatus,
} from '../../../../src/main/services/team/opencode/events/OpenCodeEventNormalizer';

describe('OpenCodeEventNormalizer', () => {
  it('normalizes v1.14 session.status object', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'session.status',
        properties: {
          sessionID: 'ses_1',
          status: { type: 'retry', attempt: 2, message: 'rate limited', next: 123 },
        },
      })
    ).toMatchObject({
      kind: 'session_status',
      sessionId: 'ses_1',
      status: {
        type: 'retry',
        retryAttempt: 2,
        retryMessage: 'rate limited',
        retryNextAt: 123,
        rawShape: 'v1.14',
      },
    });
  });

  it('normalizes legacy string status and active compatibility status', () => {
    expect(normalizeOpenCodeSessionStatus('active')).toMatchObject({
      type: 'busy',
      rawShape: 'legacy-string',
    });
    expect(normalizeOpenCodeSessionStatus('idle')).toMatchObject({
      type: 'idle',
      rawShape: 'legacy-string',
    });
    expect(normalizeOpenCodeSessionStatus('unexpected')).toMatchObject({
      type: 'unknown',
      rawShape: 'legacy-string',
    });
  });

  it('normalizes deprecated session.idle as an idle session status', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      })
    ).toMatchObject({
      kind: 'session_status',
      sessionId: 'ses_1',
      status: {
        type: 'idle',
        rawShape: 'v1.14',
      },
    });
  });

  it('normalizes global event envelopes without losing directory evidence', () => {
    expect(
      normalizeOpenCodeEvent({
        directory: '/repo',
        payload: {
          type: 'server.heartbeat',
          properties: {},
        },
      })
    ).toEqual({
      kind: 'server_heartbeat',
      scope: 'global',
      directory: '/repo',
      raw: {
        directory: '/repo',
        payload: {
          type: 'server.heartbeat',
          properties: {},
        },
      },
    });
  });

  it('normalizes message.updated role and message id from info snapshot', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'message.updated',
        properties: {
          sessionID: 'ses_1',
          info: { id: 'msg_1', role: 'assistant' },
        },
      })
    ).toMatchObject({
      kind: 'message_updated',
      sessionId: 'ses_1',
      messageId: 'msg_1',
      role: 'assistant',
    });
  });

  it('normalizes message.part.updated snapshots separately from streaming deltas', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: {
            id: 'part_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'complete text',
          },
        },
      })
    ).toMatchObject({
      kind: 'message_part_updated',
      sessionId: 'ses_1',
      messageId: 'msg_1',
      partId: 'part_1',
      partType: 'text',
      textSnapshot: 'complete text',
    });
  });

  it('normalizes streaming text from message.part.delta', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_1',
          messageID: 'msg_1',
          partID: 'part_1',
          field: 'text',
          delta: 'hello',
        },
      })
    ).toMatchObject({
      kind: 'message_part_delta',
      sessionId: 'ses_1',
      messageId: 'msg_1',
      partId: 'part_1',
      field: 'text',
      delta: 'hello',
    });
  });

  it('normalizes permission events across v1.14 and legacy ids', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'permission.asked',
        properties: {
          sessionID: 'ses_1',
          id: 'perm_1',
        },
      })
    ).toMatchObject({
      kind: 'permission_asked',
      sessionId: 'ses_1',
      requestId: 'perm_1',
    });

    expect(
      normalizeOpenCodeEvent({
        type: 'permission.replied',
        properties: {
          sessionID: 'ses_1',
          requestID: 'perm_legacy',
        },
      })
    ).toMatchObject({
      kind: 'permission_replied',
      sessionId: 'ses_1',
      requestId: 'perm_legacy',
    });
  });

  it('returns unknown event instead of throwing on incomplete known payloads', () => {
    expect(
      normalizeOpenCodeEvent({
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_1',
          messageID: 'msg_1',
          field: 'text',
          delta: 'hello',
        },
      })
    ).toMatchObject({
      kind: 'unknown',
      type: 'message.part.delta',
    });
  });

  it('maps normalized status and projections to durable session state', () => {
    expect(
      mapOpenCodeStatusToDurableState(normalizeOpenCodeSessionStatus({ type: 'busy' }), {
        hasPendingPermission: true,
        hasLatestAssistantError: false,
        replyPendingSinceMessageId: null,
      })
    ).toBe('blocked');
    expect(
      mapOpenCodeStatusToDurableState(normalizeOpenCodeSessionStatus({ type: 'busy' }), {
        hasPendingPermission: false,
        hasLatestAssistantError: true,
        replyPendingSinceMessageId: null,
      })
    ).toBe('error');
    expect(
      mapOpenCodeStatusToDurableState(normalizeOpenCodeSessionStatus({ type: 'retry' }), {
        hasPendingPermission: false,
        hasLatestAssistantError: false,
        replyPendingSinceMessageId: null,
      })
    ).toBe('retrying');
    expect(
      mapOpenCodeStatusToDurableState(normalizeOpenCodeSessionStatus({ type: 'busy' }), {
        hasPendingPermission: false,
        hasLatestAssistantError: false,
        replyPendingSinceMessageId: null,
      })
    ).toBe('running');
    expect(
      mapOpenCodeStatusToDurableState(normalizeOpenCodeSessionStatus({ type: 'idle' }), {
        hasPendingPermission: false,
        hasLatestAssistantError: false,
        replyPendingSinceMessageId: 'msg_1',
      })
    ).toBe('reply_pending');
    expect(
      mapOpenCodeStatusToDurableState(normalizeOpenCodeSessionStatus({ type: 'idle' }), {
        hasPendingPermission: false,
        hasLatestAssistantError: false,
        replyPendingSinceMessageId: null,
      })
    ).toBe('idle');
  });
});

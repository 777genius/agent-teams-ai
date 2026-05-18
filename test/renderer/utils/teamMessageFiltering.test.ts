import { describe, expect, it } from 'vitest';

import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';

import type { InboxMessage } from '@shared/types';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'team-lead',
    text: 'Hello',
    timestamp: '2026-03-09T12:00:00.000Z',
    read: true,
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('filterTeamMessages', () => {
  it('keeps lead-to-user messages visible', () => {
    const messages = [
      makeMessage({
        from: 'lead',
        to: 'user',
        text: 'Accepted cross-team request. Delegating now.',
        source: 'lead_process',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].to).toBe('user');
    expect(result[0].source).toBe('lead_process');
  });

  it('hides bare transcript speaker placeholders from lead output', () => {
    const messages = [
      makeMessage({
        messageId: 'speaker-placeholder',
        from: 'team-lead',
        to: 'user',
        text: 'Human:',
        source: 'lead_process',
      }),
      makeMessage({
        messageId: 'visible-message',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['visible-message']);
  });

  it('hides native app-managed bootstrap private control messages', () => {
    const messages = [
      makeMessage({
        messageId: 'native-bootstrap-private-check',
        source: undefined,
        text: '<agent_teams_native_app_managed_bootstrap_check>\nprivate\n</agent_teams_native_app_managed_bootstrap_check>',
      }),
      makeMessage({
        messageId: 'visible-message',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['visible-message']);
  });

  it('keeps user-authored native bootstrap marker quotes visible', () => {
    const messages = [
      makeMessage({
        from: 'user',
        messageId: 'user-native-bootstrap-quote',
        source: 'user_sent',
        text: '<agent_teams_native_app_managed_bootstrap_check>\nquoted\n</agent_teams_native_app_managed_bootstrap_check>',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['user-native-bootstrap-quote']);
  });

  it('hides leaked lead inbox relay prompt echoes', () => {
    const messages = [
      makeMessage({
        messageId: 'lead-relay-echo',
        source: 'lead_process',
        to: 'user',
        text: `Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).
If action is required, delegate via task creation or SendMessage, and keep responses minimal.

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`,
      }),
      makeMessage({
        messageId: 'visible-message',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['visible-message']);
  });

  it('does not hide user-authored text that quotes an internal prompt', () => {
    const messages = [
      makeMessage({
        messageId: 'quoted-control-prompt',
        source: 'user_sent',
        text: `Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`,
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['quoted-control-prompt']);
  });

  it('hides Human-prefixed teammate protocol echoes', () => {
    const messages = [
      makeMessage({
        messageId: 'teammate-protocol-echo',
        source: 'lead_process',
        text: 'Human: <teammate-message teammate_id="alice">{"type":"idle_notification"}</teammate-message>',
      }),
      makeMessage({
        messageId: 'visible-message',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['visible-message']);
  });

  it('hides relay bridge copies when the original message is visible', () => {
    const messages = [
      makeMessage({
        messageId: 'orig-1',
        to: 'alice',
        source: 'system_notification',
        text: 'Original inbox notification',
      }),
      makeMessage({
        messageId: 'relay-1',
        to: 'alice',
        source: 'lead_process',
        text: 'Original inbox notification',
        relayOfMessageId: 'orig-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('orig-1');
  });

  it('hides same-direction relay bridge copies even when sanitized text differs', () => {
    const messages = [
      makeMessage({
        messageId: 'orig-1',
        to: 'alice',
        source: 'system_notification',
        text: 'Comment on task #abcd1234.\n<agent-block>hidden</agent-block>',
      }),
      makeMessage({
        messageId: 'relay-1',
        to: 'alice',
        source: 'lead_process',
        text: 'Comment on task #abcd1234.',
        relayOfMessageId: 'orig-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['orig-1']);
  });

  it('keeps relay bridge copies when the original message is not visible', () => {
    const messages = [
      makeMessage({
        messageId: 'relay-1',
        to: 'alice',
        source: 'lead_process',
        text: 'Original inbox notification',
        relayOfMessageId: 'orig-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('relay-1');
  });

  it('keeps OpenCode visible replies linked to a visible delivery prompt', () => {
    const messages = [
      makeMessage({
        messageId: 'delivery-1',
        from: 'team-lead',
        to: 'jack',
        source: 'runtime_delivery',
        text: 'Please send a short greeting to the user.',
      }),
      makeMessage({
        messageId: 'reply-1',
        from: 'jack',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Привет! Я Джек, готов помочь.',
        relayOfMessageId: 'delivery-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['delivery-1', 'reply-1']);
  });

  it('keeps same-direction OpenCode follow-ups when the visible text differs', () => {
    const messages = [
      makeMessage({
        messageId: 'reply-1',
        from: 'jack',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Initial answer.',
      }),
      makeMessage({
        messageId: 'reply-2',
        from: 'jack',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Additional context after checking logs.',
        relayOfMessageId: 'reply-1',
      }),
      makeMessage({
        messageId: 'reply-3',
        from: 'jack',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Initial answer.',
        relayOfMessageId: 'reply-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['reply-1', 'reply-2']);
  });

  it('hides exact duplicate OpenCode replies for the same delivered app message', () => {
    const messages = [
      makeMessage({
        messageId: 'user-request-1',
        from: 'user',
        to: 'team-lead',
        source: 'user_sent',
        text: 'Ask everyone to message me.',
      }),
      makeMessage({
        messageId: 'delivery-1',
        from: 'team-lead',
        to: 'bob',
        source: 'runtime_delivery',
        text: 'Please message the user directly.',
        relayOfMessageId: 'user-request-1',
      }),
      makeMessage({
        messageId: 'reply-1',
        from: 'bob',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Привет! Я готов к работе.',
        relayOfMessageId: 'delivery-1',
      }),
      makeMessage({
        messageId: 'reply-2',
        from: 'bob',
        to: 'user',
        source: 'runtime_delivery',
        text: ' Привет! Я готов к работе. ',
        relayOfMessageId: 'delivery-1',
      }),
      makeMessage({
        messageId: 'reply-3',
        from: 'bob',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Дополнительный контекст после проверки.',
        relayOfMessageId: 'delivery-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual([
      'user-request-1',
      'reply-1',
      'reply-3',
    ]);
  });

  it('hides internal lead relay deliveries while keeping member replies', () => {
    const messages = [
      makeMessage({
        messageId: 'user-request-1',
        from: 'user',
        to: 'team-lead',
        source: 'user_sent',
        text: 'Ask everyone to message me.',
      }),
      makeMessage({
        messageId: 'delivery-1',
        from: 'team-lead',
        to: 'jack',
        source: 'runtime_delivery',
        text: 'Please message the user directly.',
        relayOfMessageId: 'user-request-1',
      }),
      makeMessage({
        messageId: 'reply-1',
        from: 'jack',
        to: 'user',
        source: 'runtime_delivery',
        text: 'Привет! Я Джек, готов помочь.',
        relayOfMessageId: 'delivery-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['user-request-1', 'reply-1']);
  });

  it('hides internal relay deliveries from custom-named leads', () => {
    const messages = [
      makeMessage({
        messageId: 'user-request-1',
        from: 'user',
        to: 'captain',
        source: 'user_sent',
        text: 'Ask Alice to check this.',
      }),
      makeMessage({
        messageId: 'delivery-1',
        from: 'captain',
        to: 'alice',
        source: 'lead_process',
        text: 'Please check this for the user.',
        relayOfMessageId: 'user-request-1',
      }),
      makeMessage({
        messageId: 'reply-1',
        from: 'alice',
        to: 'user',
        source: 'runtime_delivery',
        text: 'I checked it.',
        relayOfMessageId: 'delivery-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      leadNames: ['captain'],
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['user-request-1', 'reply-1']);
  });

  it('keeps member relay messages when the sender is not a configured lead', () => {
    const messages = [
      makeMessage({
        messageId: 'user-request-1',
        from: 'user',
        to: 'captain',
        source: 'user_sent',
        text: 'Ask Alice to check this.',
      }),
      makeMessage({
        messageId: 'member-relay-1',
        from: 'captain',
        to: 'alice',
        source: 'runtime_delivery',
        text: 'Alice, can you check this?',
        relayOfMessageId: 'user-request-1',
      }),
    ];

    const result = filterTeamMessages(messages, {
      leadNames: ['team-lead'],
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual([
      'user-request-1',
      'member-relay-1',
    ]);
  });

  it('still filters noise messages when showNoise is false', () => {
    const messages = [
      makeMessage({
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
      makeMessage({
        messageId: 'msg-2',
        text: 'Real visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: false },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-2');
  });

  it('can preserve passive peer-summary idle rows in the activity sink while keeping pure heartbeat hidden even after read', () => {
    const messages = [
      makeMessage({
        messageId: 'heartbeat-hidden',
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
      makeMessage({
        messageId: 'peer-summary-visible',
        read: true,
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
      }),
      makeMessage({
        messageId: 'row-summary-only-hidden',
        summary: 'Preview only',
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
    ];

    const result = filterTeamMessages(messages, {
      includePassiveIdlePeerSummariesWhenNoiseHidden: true,
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: false },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['peer-summary-visible']);
  });

  it('hides task comment notifications by semantic kind instead of text matching', () => {
    const messages = [
      makeMessage({
        messageId: 'task-comment-1',
        source: 'system_notification',
        messageKind: 'task_comment_notification',
        summary: 'Comment on #abcd1234',
        text: 'Some future wording that may change completely.',
      }),
      makeMessage({
        messageId: 'msg-2',
        source: 'system_notification',
        summary: 'Task #abcd1234 started',
        text: 'Visible system notification',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-2');
  });

  it('hides task stall remediation automation rows from conversational message counts by default', () => {
    const messages = [
      makeMessage({
        messageId: 'task-stall:demo:task-a:epoch-a',
        from: 'system',
        to: 'jack',
        source: 'system_notification',
        messageKind: 'task_stall_remediation',
        summary: 'Potential stalled task',
        text: 'Task #abcd1234 may be stalled.',
      }),
      makeMessage({
        messageId: 'msg-2',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['msg-2']);
  });

  it('hides member work sync nudges from conversational message counts by default', () => {
    const messages = [
      makeMessage({
        messageId: 'member-work-sync:demo:jack:agenda-a',
        from: 'system',
        to: 'jack',
        source: 'system_notification',
        messageKind: 'member_work_sync_nudge',
        summary: 'Work sync check',
        text: 'Work sync check: call member_work_sync_status.',
      }),
      makeMessage({
        messageId: 'msg-2',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['msg-2']);
  });

  it('hides review pickup escalation automation rows from conversational message counts by default', () => {
    const messages = [
      makeMessage({
        messageId: 'member-work-sync-review-pickup-escalation:abc123',
        from: 'system',
        to: 'lead',
        source: 'system_notification',
        summary: 'Review pickup still pending',
        text: 'Review pickup needs lead attention.\n\nReviewer: tom',
      }),
      makeMessage({
        messageId: 'msg-2',
        text: 'Visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual(['msg-2']);
  });

  it('can include task stall remediation automation rows for the activity timeline', () => {
    const messages = [
      makeMessage({
        messageId: 'task-stall:demo:task-a:legacy-epoch',
        from: 'system',
        to: 'jack',
        source: 'system_notification',
        summary: 'Potential stalled task',
        text: 'Task #abcd1234 may be stalled.',
      }),
    ];

    const result = filterTeamMessages(messages, {
      includeAutomationEvents: true,
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual([
      'task-stall:demo:task-a:legacy-epoch',
    ]);
  });

  it('keeps member work sync nudges hidden from the activity timeline by default', () => {
    const messages = [
      makeMessage({
        messageId: 'member-work-sync:demo:jack:agenda-a',
        from: 'system',
        to: 'jack',
        source: 'system_notification',
        messageKind: 'member_work_sync_nudge',
        summary: 'Work sync check',
        text: 'Work sync check: call member_work_sync_status.',
      }),
    ];

    const result = filterTeamMessages(messages, {
      includeAutomationEvents: true,
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toEqual([]);
  });

  it('can include member work sync nudges for diagnostics when explicitly requested', () => {
    const messages = [
      makeMessage({
        messageId: 'member-work-sync:demo:jack:agenda-a',
        from: 'system',
        to: 'jack',
        source: 'system_notification',
        messageKind: 'member_work_sync_nudge',
        summary: 'Work sync check',
        text: 'Work sync check: call member_work_sync_status.',
      }),
    ];

    const result = filterTeamMessages(messages, {
      includeAutomationEvents: true,
      includeMemberWorkSyncNudges: true,
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result.map((message) => message.messageId)).toEqual([
      'member-work-sync:demo:jack:agenda-a',
    ]);
  });

  it('keeps review pickup escalation hidden even when regular automation rows are included', () => {
    const messages = [
      makeMessage({
        messageId: 'member-work-sync-review-pickup-escalation:abc123',
        from: 'system',
        to: 'lead',
        source: 'system_notification',
        summary: 'Review pickup still pending',
        text: 'Review pickup needs lead attention.\n\nReviewer: tom',
      }),
    ];

    const result = filterTeamMessages(messages, {
      includeAutomationEvents: true,
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toEqual([]);
  });

});

import { describe, expect, it } from 'vitest';

import {
  groupTimelineItems,
  isLeadThought,
} from '../../../../../src/renderer/components/team/activity/LeadThoughtsGroup';

import type { InboxMessage } from '../../../../../src/shared/types';

function makeLeadSessionMsg(text: string, overrides?: Partial<InboxMessage>): InboxMessage {
  return {
    from: 'team-lead',
    text,
    timestamp: '2026-03-28T18:30:00.000Z',
    read: true,
    source: 'lead_session',
    ...overrides,
  };
}

describe('LeadThoughtsGroup', () => {
  it('does not classify slash command results as lead thoughts', () => {
    const resultMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Total cost: $1.05',
      timestamp: '2026-03-27T22:06:00.000Z',
      read: true,
      source: 'lead_session',
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/cost',
      },
    };

    expect(isLeadThought(resultMessage)).toBe(false);
    expect(groupTimelineItems([resultMessage])).toEqual([
      {
        type: 'message',
        message: resultMessage,
      },
    ]);
  });

  describe('teammate-message noise filtering', () => {
    it('excludes closed <teammate-message> blocks with idle_notification from timeline', () => {
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="tom" color="blue"> {"type":"idle_notification","from":"tom","timestamp":"2026-03-28T18:30:49.102Z","idleReason":"available"}</teammate-message>'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes unclosed <teammate-message> blocks with idle_notification from timeline', () => {
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="tom" color="blue"> {"type":"idle_notification","from":"tom","timestamp":"2026-03-28T18:30:49.102Z","idleReason":"available"}'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes <teammate-message> blocks with shutdown_request from timeline', () => {
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="bob" color="green"> {"type":"shutdown_request"}</teammate-message>'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes raw idle_notification JSON from timeline', () => {
      const noise = makeLeadSessionMsg(
        '{"type":"idle_notification","from":"alice","idleReason":"available"}'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('does not exclude noise messages with a recipient (captured SendMessage)', () => {
      const sendMsg = makeLeadSessionMsg(
        '{"type":"idle_notification","from":"tom","idleReason":"available"}',
        { to: 'alice' }
      );
      // Has a recipient, so isLeadThought returns false (line 61), but isLeadSessionNoise
      // also returns false because `to` is non-empty — message should appear in timeline.
      expect(groupTimelineItems([sendMsg])).toEqual([
        { type: 'message', message: sendMsg },
      ]);
    });

    it('does not exclude non-lead noise messages from timeline', () => {
      const inboxMsg: InboxMessage = {
        from: 'tom',
        text: '{"type":"idle_notification","from":"tom","idleReason":"available"}',
        timestamp: '2026-03-28T18:30:00.000Z',
        read: true,
        // No source — regular inbox message
      };
      expect(groupTimelineItems([inboxMsg])).toEqual([
        { type: 'message', message: inboxMsg },
      ]);
    });

    it('keeps regular lead thoughts alongside noise', () => {
      const thought = makeLeadSessionMsg('Team is ready. Distributing tasks...');
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="tom" color="blue"> {"type":"idle_notification","from":"tom","idleReason":"available"}</teammate-message>'
      );
      const thought2 = makeLeadSessionMsg('Assigned task #1 to bob.');

      const items = groupTimelineItems([thought, noise, thought2]);
      // Noise is excluded; both thoughts should be grouped
      expect(items.length).toBe(1);
      expect(items[0].type).toBe('lead-thoughts');
      if (items[0].type === 'lead-thoughts') {
        expect(items[0].group.thoughts).toHaveLength(2);
        expect(items[0].group.thoughts[0].text).toBe(thought.text);
        expect(items[0].group.thoughts[1].text).toBe(thought2.text);
      }
    });
  });
});

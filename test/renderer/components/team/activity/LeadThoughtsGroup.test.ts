import { describe, expect, it } from 'vitest';

import {
  groupTimelineItems,
  isLeadThought,
} from '../../../../../src/renderer/components/team/activity/LeadThoughtsGroup';

import type { InboxMessage } from '../../../../../src/shared/types';

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
});

import { describe, expect, it } from 'vitest';

import { isLeadThought } from '../../../../../src/renderer/components/team/activity/LeadThoughtsGroup';

describe('LeadThoughtsGroup', () => {
  it('does not classify outbound runtime messages with recipients as lead thoughts', () => {
    expect(
      isLeadThought({
        from: 'team-lead',
        to: 'alice',
        text: 'Please check task #abcd1234',
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_process',
      })
    ).toBe(false);
  });
});

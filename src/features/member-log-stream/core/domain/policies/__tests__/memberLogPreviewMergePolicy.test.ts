import { describe, expect, it } from 'vitest';

import { buildMemberLogPreviewMember } from '../memberLogPreviewMergePolicy';

import type { MemberLogPreviewItem } from '../../../../contracts';

function item(id: string, timestamp: string): MemberLogPreviewItem {
  return {
    id,
    kind: 'text',
    provider: 'claude_transcript',
    timestamp,
    title: 'Assistant',
    preview: id,
    tone: 'neutral',
  };
}

describe('memberLogPreviewMergePolicy', () => {
  it('merges sources newest first with stable tie break and max three items', () => {
    const member = buildMemberLogPreviewMember({
      memberName: 'alice',
      generatedAt: '2026-04-01T12:00:00.000Z',
      maxItems: 3,
      sourceResults: [
        {
          coverage: { provider: 'opencode_runtime', status: 'included' },
          items: [item('b', '2026-04-01T12:00:00.000Z'), item('a', '2026-04-01T12:00:00.000Z')],
          warnings: [],
        },
        {
          coverage: { provider: 'claude_transcript', status: 'included' },
          items: [
            item('newest', '2026-04-01T12:01:00.000Z'),
            item('oldest', '2026-04-01T11:59:00.000Z'),
          ],
          warnings: [{ code: 'large_log_window_limited', message: 'limited' }],
          overflowCount: 1,
        },
      ],
    });

    expect(member.items.map((preview) => preview.id)).toEqual(['newest', 'a', 'b']);
    expect(member.coverage.map((coverage) => coverage.provider)).toEqual([
      'claude_transcript',
      'opencode_runtime',
    ]);
    expect(member.warnings).toEqual([{ code: 'large_log_window_limited', message: 'limited' }]);
    expect(member.truncated).toBe(true);
    expect(member.overflowCount).toBe(2);
  });
});

import {
  buildReplaceMembersDiff,
  buildReplaceMembersSummaryMessage,
} from '@main/services/team/memberUpdateNotifications';
import { describe, expect, it } from 'vitest';

describe('member update notifications', () => {
  it('reports MCP policy changes as restart-required live roster updates', () => {
    const diff = buildReplaceMembersDiff(
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
        },
      ],
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
          mcpPolicy: { mode: 'appOnly' },
        },
      ]
    );

    expect(diff.updated).toEqual([
      {
        name: 'alice',
        changes: ['MCP access policy changed - restart required'],
      },
    ]);
    expect(buildReplaceMembersSummaryMessage(diff)).toContain(
      'MCP access policy changed - restart required'
    );
  });
});

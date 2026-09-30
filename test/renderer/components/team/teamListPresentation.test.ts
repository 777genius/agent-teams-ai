import { describe, expect, it } from 'vitest';

import {
  formatTeamProjectPathName,
  resolveLaunchDialogMembers,
} from '@renderer/components/team/teamListPresentation';

describe('team list presentation', () => {
  it('formats a project path and adapts snapshots for the launch dialog', () => {
    expect(formatTeamProjectPathName('/workspace/agent-teams')).toBe('agent-teams');

    expect(
      resolveLaunchDialogMembers([
        { name: 'busy', currentTaskId: 'task-1' },
        { name: 'idle' },
      ] as never)
    ).toMatchObject([
      { name: 'busy', status: 'active', messageCount: 0, lastActiveAt: null },
      { name: 'idle', status: 'idle', messageCount: 0, lastActiveAt: null },
    ]);
  });
});

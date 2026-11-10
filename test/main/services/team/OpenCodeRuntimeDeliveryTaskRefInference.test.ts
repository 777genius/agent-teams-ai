import { describe, expect, it } from 'vitest';

import { inferOpenCodeTaskRefsFromInboxMessage } from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryTaskRefInference';

const TEAM_NAME = 'relay-works-69';
const TASKS = [
  { id: 'a7fd5f34-ff82-4ead-8089-34064454a623', displayId: 'a7fd5f34' },
  { id: '8dc34135-1111-4111-8111-8dc341350000', displayId: '8dc34135' },
  { id: '1', displayId: '1' },
];

describe('inferOpenCodeTaskRefsFromInboxMessage', () => {
  it('preserves structured task refs', () => {
    const structured = [{ teamName: TEAM_NAME, taskId: 'task-1', displayId: 'abcd1234' }];

    expect(
      inferOpenCodeTaskRefsFromInboxMessage({
        teamName: TEAM_NAME,
        message: {
          text: 'Ignore text #a7fd5f34.',
          taskRefs: structured,
        },
        tasks: TASKS,
      })
    ).toEqual(structured);
  });

  it('uses the summary before ambiguous full text', () => {
    expect(
      inferOpenCodeTaskRefsFromInboxMessage({
        teamName: TEAM_NAME,
        message: {
          text: [
            '**Comment on task #a7fd5f34** _Calculator styles_',
            '',
            '> **Dependency resolved** - task #8dc34135 completed.',
            '> All blockers for #a7fd5f34 are resolved - this task is ready to start.',
          ].join('\n'),
          summary: 'Comment on #a7fd5f34',
        },
        tasks: TASKS,
      })
    ).toEqual([{ teamName: TEAM_NAME, taskId: TASKS[0].id, displayId: 'a7fd5f34' }]);
  });

  it('uses a comment heading when the summary is missing', () => {
    expect(
      inferOpenCodeTaskRefsFromInboxMessage({
        teamName: TEAM_NAME,
        message: {
          text: [
            '**Comment on #a7fd5f34** _Calculator styles_',
            '',
            'Dependency #8dc34135 is resolved.',
          ].join('\n'),
        },
        tasks: TASKS,
      })
    ).toEqual([{ teamName: TEAM_NAME, taskId: TASKS[0].id, displayId: 'a7fd5f34' }]);
  });

  it('does not infer from ambiguous text without a unique candidate field', () => {
    expect(
      inferOpenCodeTaskRefsFromInboxMessage({
        teamName: TEAM_NAME,
        message: {
          text: 'Dependency resolved: #8dc34135 unblocks #a7fd5f34.',
        },
        tasks: TASKS,
      })
    ).toEqual([]);
  });

  it('supports short display ids', () => {
    expect(
      inferOpenCodeTaskRefsFromInboxMessage({
        teamName: TEAM_NAME,
        message: {
          summary: 'Comment on #1',
          text: 'Ready.',
        },
        tasks: TASKS,
      })
    ).toEqual([{ teamName: TEAM_NAME, taskId: '1', displayId: '1' }]);
  });
});

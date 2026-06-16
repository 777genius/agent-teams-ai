import { MemberWorkSyncTaskImpactResolver } from '@features/member-work-sync/main/adapters/input/MemberWorkSyncTaskImpactResolver';
import { describe, expect, it, vi } from 'vitest';

import type { TeamTask } from '@shared/types';

describe('MemberWorkSyncTaskImpactResolver', () => {
  it('targets owner, reviewer, dependent owners and lead oversight without team-wide fan-out', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-a',
        displayId: '#11111111',
        subject: 'Changed',
        status: 'in_progress',
        owner: 'alice',
        reviewState: 'review',
        historyEvents: [
          {
            id: 'evt-review',
            type: 'review_requested',
            timestamp: '2026-04-29T00:00:00.000Z',
            from: 'none',
            to: 'review',
            reviewer: 'bob',
          },
        ],
      },
      {
        id: 'task-b',
        subject: 'Unblocked by A',
        status: 'pending',
        owner: 'tom',
        blockedBy: ['task-a'],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'bob', 'team-lead', 'tom']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: '#11111111' })).resolves.toEqual({
      memberNames: ['alice', 'bob', 'tom'],
      fallbackTeamWide: false,
      diagnostics: [],
    });
  });

  it('falls back to team-wide routing when a task was removed before impact can be resolved', async () => {
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => []) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: { loadActiveMemberNames: vi.fn(async () => ['alice']) },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: 'deleted-task' })).resolves.toEqual(
      {
        memberNames: [],
        fallbackTeamWide: true,
        diagnostics: ['task_not_found'],
      }
    );
  });

  it('targets lead when a deleted task breaks active dependent work', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-deleted',
        subject: 'Deleted dependency',
        status: 'deleted',
        owner: 'alice',
        deletedAt: '2026-04-29T00:00:00.000Z',
      },
      {
        id: 'task-dependent',
        subject: 'Depends on deleted task',
        status: 'pending',
        owner: 'tom',
        blockedBy: ['task-deleted'],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead', 'tom']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: 'task-deleted' })).resolves.toEqual(
      {
        memberNames: ['alice', 'team-lead', 'tom'],
        fallbackTeamWide: false,
        diagnostics: ['dependent_task_has_deleted_dependency'],
      }
    );
  });

  it('targets dependent owners when dependencies reference the changed task by display id', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-a',
        displayId: '#11111111',
        subject: 'Changed dependency',
        status: 'in_progress',
        owner: 'alice',
      },
      {
        id: 'task-b',
        subject: 'Depends on display id',
        status: 'pending',
        owner: 'tom',
        blockedBy: [' 11111111 '],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead', 'tom']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: 'task-a' })).resolves.toEqual({
      memberNames: ['alice', 'tom'],
      fallbackTeamWide: false,
      diagnostics: [],
    });
  });

  it('targets dependent owners when a display-id dependency is ambiguous but includes the changed task', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-a',
        displayId: '#11111111',
        subject: 'Changed dependency',
        status: 'in_progress',
        owner: 'alice',
      },
      {
        id: 'task-duplicate',
        displayId: '#11111111',
        subject: 'Duplicate display id',
        status: 'completed',
        owner: 'zoe',
      },
      {
        id: 'task-b',
        subject: 'Depends on ambiguous display id',
        status: 'pending',
        owner: 'tom',
        blockedBy: [' 11111111 '],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead', 'tom', 'zoe']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: 'task-a' })).resolves.toEqual({
      memberNames: ['alice', 'tom'],
      fallbackTeamWide: false,
      diagnostics: [],
    });
  });

  it('falls back team-wide when the changed task reference is ambiguous', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-a',
        displayId: '#11111111',
        subject: 'First duplicate',
        status: 'in_progress',
        owner: 'alice',
      },
      {
        id: 'task-b',
        displayId: '#11111111',
        subject: 'Second duplicate',
        status: 'pending',
        owner: 'tom',
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead', 'tom']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: '#11111111' })).resolves.toEqual({
      memberNames: [],
      fallbackTeamWide: true,
      diagnostics: ['task_reference_ambiguous'],
    });
  });

  it('prefers canonical task ids over colliding display ids', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-a',
        displayId: '#11111111',
        subject: 'Changed dependency',
        status: 'completed',
        owner: 'alice',
      },
      {
        id: 'task-collision',
        displayId: '#task-a',
        subject: 'Display collision',
        status: 'in_progress',
        owner: 'zoe',
      },
      {
        id: 'task-b',
        subject: 'Depends on canonical id',
        status: 'pending',
        owner: 'tom',
        blockedBy: ['task-a'],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead', 'tom', 'zoe']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: 'task-a' })).resolves.toEqual({
      memberNames: ['alice', 'tom'],
      fallbackTeamWide: false,
      diagnostics: [],
    });
  });

  it('does not target owners of already approved dependent tasks', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-a',
        subject: 'Changed dependency',
        status: 'completed',
        owner: 'alice',
      },
      {
        id: 'task-approved-dependent',
        subject: 'Already approved dependent',
        status: 'in_progress',
        owner: 'tom',
        blockedBy: ['task-a'],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: {
        getState: vi.fn(async () => ({
          tasks: {
            'task-approved-dependent': {
              column: 'approved',
              movedAt: '2026-05-06T19:06:07.257Z',
            },
          },
        })),
      },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead', 'tom']),
      },
    } as never);

    await expect(resolver.resolve({ teamName: 'team-a', taskId: 'task-a' })).resolves.toEqual({
      memberNames: ['alice'],
      fallbackTeamWide: false,
      diagnostics: [],
    });
  });

  it('does not treat stale review state as reviewer-missing when kanban says approved', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-approved',
        subject: 'Approved after review',
        status: 'in_progress',
        owner: 'alice',
        reviewState: 'review',
        historyEvents: [
          {
            id: 'evt-review',
            type: 'review_requested',
            timestamp: '2026-05-06T19:00:00.000Z',
            from: 'none',
            to: 'review',
            reviewer: 'bob',
          },
        ],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: {
        getState: vi.fn(async () => ({
          tasks: {
            'task-approved': {
              column: 'approved',
              movedAt: '2026-05-06T19:06:07.257Z',
            },
          },
        })),
      },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'bob', 'team-lead']),
      },
    } as never);

    await expect(
      resolver.resolve({ teamName: 'team-a', taskId: 'task-approved' })
    ).resolves.toEqual({
      memberNames: ['alice'],
      fallbackTeamWide: false,
      diagnostics: [],
    });
  });

  it('targets lead oversight when the changed task is a self-review', async () => {
    const tasks: TeamTask[] = [
      {
        id: 'task-self-review',
        subject: 'Self review',
        status: 'completed',
        owner: 'alice',
        reviewState: 'review',
        historyEvents: [
          {
            id: 'evt-self-review',
            type: 'review_requested',
            timestamp: '2026-05-06T19:00:00.000Z',
            from: 'none',
            to: 'review',
            reviewer: 'alice',
          },
        ],
      },
    ];
    const resolver = new MemberWorkSyncTaskImpactResolver({
      taskReader: { getTasks: vi.fn(async () => tasks) },
      kanbanManager: { getState: vi.fn(async () => ({ tasks: {} })) },
      activeMemberSource: {
        loadActiveMemberNames: vi.fn(async () => ['alice', 'team-lead']),
      },
    } as never);

    await expect(
      resolver.resolve({ teamName: 'team-a', taskId: 'task-self-review' })
    ).resolves.toEqual({
      memberNames: ['alice', 'team-lead'],
      fallbackTeamWide: false,
      diagnostics: ['self_review_invalid'],
    });
  });
});

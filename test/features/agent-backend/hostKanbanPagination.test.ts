import { describe, expect, it, vi } from 'vitest';

import { readHostPagedSnapshot } from '../../../src/features/agent-backend/renderer/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';

const cursor = '1.' + 'a'.repeat(64);
const position = {
  streamId: '33333333-3333-4333-8333-333333333333',
  sequence: 0,
  cursor: '11111111-1111-4111-8111-111111111111',
};
const connection = {
  handle: { handleId: 'TEST-original-owner' },
  label: 'Captured Host',
  members: [],
} as BackendConnectionSnapshot['bindings'][number];

function pages() {
  const first: BackendTeamSnapshot = {
    teamName: 'TEST-team',
    revision: 'a'.repeat(64),
    feed: position,
    members: [{ name: 'alice', role: 'lead' }],
    tasks: [{ id: 'TEST-task', subject: 'Retained task', status: 'completed' }],
    messages: [],
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {}, columnOrder: { review: [] } },
    nextCursor: cursor,
  };
  const last: BackendTeamSnapshot = {
    ...first,
    tasks: [],
    kanbanState: {
      teamName: 'TEST-team',
      reviewers: ['alice'],
      tasks: {
        'TEST-task': { column: 'review', movedAt: '2026-01-01', reviewer: 'alice' },
      },
      columnOrder: { review: ['TEST-task'] },
    },
    nextCursor: null,
  };
  return { first, last };
}

describe('captured Host Kanban snapshot pages', () => {
  it('reconstructs exact Kanban records and task view only after all pages are validated', async () => {
    const { first, last } = pages();
    const invoke = vi.fn(async (request: { payload: { cursor?: string } }) => ({
      ok: true as const,
      value: request.payload.cursor === cursor ? last : first,
    }));
    const backend = { invoke } as unknown as Pick<AgentBackendApi, 'invoke'>;
    const product = await readHostPagedSnapshot(
      backend,
      connection,
      () => true,
      new TeamProductReadOrder()
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].payload).toEqual({ cursor });
    expect(product.data.kanbanState).toEqual(last.kanbanState);
    expect(product.data.tasks[0]).toMatchObject({
      id: 'TEST-task',
      kanbanColumn: 'review',
      reviewer: 'alice',
    });
    expect(product.data.nextCursor).toBeUndefined();
    product.assertCurrent();
  });

  it('refuses a torn Kanban page before exposing any partial product state', async () => {
    const { first, last } = pages();
    const invoke = vi.fn(async (request: { payload: { cursor?: string } }) => ({
      ok: true as const,
      value: request.payload.cursor ? { ...last, revision: 'b'.repeat(64) } : first,
    }));
    await expect(readHostPagedSnapshot(
      { invoke } as unknown as Pick<AgentBackendApi, 'invoke'>,
      connection,
      () => true,
      new TeamProductReadOrder()
    )).rejects.toThrow('changed during paged read');
  });
});

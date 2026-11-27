// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { readHostPagedSnapshot } from '../../../src/features/agent-backend/core/application/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/core/application/TeamProductReadOrder';

import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';

const goal = {
  goalId: 'TEST-goal',
  revision: 1,
  disposition: 'stopped' as const,
  startedAt: '2026-11-27T08:00:00.000Z',
  deadlineAt: '2026-11-27T20:00:00.000Z',
  attemptLimit: 100,
  attemptsUsed: 4,
  canResume: true,
};

function read(second: Partial<BackendTeamSnapshot>) {
  const base: BackendTeamSnapshot = {
    teamName: 'TEST-team',
    revision: 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [{ name: 'lead', role: 'lead' }],
    tasks: [],
    messages: [],
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
    autonomousGoal: goal,
    autonomousGoalAvailable: false,
  };
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { ...base, nextCursor: 'TEST-next' } })
    .mockResolvedValueOnce({ ok: true, value: { ...base, ...second, nextCursor: null } });
  return readHostPagedSnapshot(
    { invoke },
    { handle: { handleId: 'TEST-handle' }, label: 'TEST', members: [] },
    () => true,
    new TeamProductReadOrder()
  );
}

describe('coherent paged continuation status', () => {
  it('rejects changed intake readiness even when the product revision is unchanged', async () => {
    await expect(read({ autonomousGoalAvailable: true })).rejects.toThrow(
      'Host team changed during paged read'
    );
  });
  it('rejects changed Resume readiness in the same goal revision', async () => {
    await expect(read({ autonomousGoal: { ...goal, canResume: false } })).rejects.toThrow(
      'Host team changed during paged read'
    );
  });
  it('publishes identical status and readiness from coherent pages', async () => {
    const result = await read({});
    expect(result.data.autonomousGoal).toEqual(goal);
    expect(result.data.autonomousGoalAvailable).toBe(false);
    expect(() => result.assertCurrent()).not.toThrow();
  });
});

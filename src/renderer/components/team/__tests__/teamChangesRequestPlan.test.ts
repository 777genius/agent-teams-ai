import { describe, expect, it } from 'vitest';

import {
  buildTeamChangeRequestPlan,
  buildTeamChangesTasksFingerprint,
  TEAM_CHANGES_MAX_REQUESTS,
  TEAM_CHANGES_UNKNOWN_SCAN_LIMIT,
} from '../teamChangesRequestPlan';

import type { TeamTaskWithKanban } from '@shared/types';

function task(overrides: Partial<TeamTaskWithKanban> & { id: string }): TeamTaskWithKanban {
  const { id, subject, status, ...rest } = overrides;
  return {
    id,
    subject: subject ?? `Task ${id}`,
    status: status ?? 'pending',
    ...rest,
  };
}

function changedTasks(count: number): TeamTaskWithKanban[] {
  return Array.from({ length: count }, (_, index) =>
    task({
      id: `changed-${index}`,
      status: 'completed',
      changePresence: 'has_changes',
      updatedAt: `2026-05-09T08:${String(index).padStart(2, '0')}:00.000Z`,
    })
  );
}

describe('buildTeamChangeRequestPlan', () => {
  it('separates automatic fresh summaries from explicit manual backfill retry', () => {
    const tasks = changedTasks(3);
    const automatic = buildTeamChangeRequestPlan(tasks, 0, true);
    expect(automatic.requests.every((request) => request.options?.forceFresh === true)).toBe(true);
    expect(automatic.requests.every((request) => request.options?.retryBackfill !== true)).toBe(true);
    const manual = buildTeamChangeRequestPlan(tasks, 0, true, { retryBackfill: true });
    expect(manual.requests.every((request) => request.options?.retryBackfill === true)).toBe(true);
    expect(manual.requests.every((request) => request.options?.forceFresh === true)).toBe(true);
  });

  it('scans unknown pending tasks only when they have work evidence', () => {
    const plan = buildTeamChangeRequestPlan(
      [
        task({ id: 'plain-pending', status: 'pending', changePresence: 'unknown' }),
        task({
          id: 'worked-pending',
          status: 'pending',
          changePresence: 'unknown',
          workIntervals: [{ startedAt: '2026-05-09T08:00:00.000Z' }],
        }),
      ],
      0,
      false
    );

    expect(plan.requests.map((request) => request.taskId)).toEqual(['worked-pending']);
    expect([...plan.eligibleTaskIds]).toEqual(['worked-pending']);
  });

  it('keeps known changed tasks even when they are currently pending', () => {
    const plan = buildTeamChangeRequestPlan(
      [task({ id: 'known-changed', status: 'pending', changePresence: 'has_changes' })],
      0,
      false
    );

    expect(plan.requests.map((request) => request.taskId)).toEqual(['known-changed']);
    expect(plan.eligibleTaskIds.has('known-changed')).toBe(true);
  });

  it('skips deleted and duplicate tasks before counting candidates', () => {
    const plan = buildTeamChangeRequestPlan(
      [
        task({ id: 'changed', status: 'completed', changePresence: 'has_changes' }),
        task({ id: 'changed', status: 'completed', changePresence: 'has_changes' }),
        task({ id: 'deleted', status: 'deleted', changePresence: 'has_changes' }),
      ],
      0,
      false
    );

    expect(plan.requests.map((request) => request.taskId)).toEqual(['changed']);
    expect(plan.eligibleCount).toBe(1);
    expect(plan.deferredCount).toBe(0);
  });

  it('caps selected requests and reports deferred candidates', () => {
    const plan = buildTeamChangeRequestPlan(changedTasks(TEAM_CHANGES_MAX_REQUESTS + 5), 0, false);

    expect(plan.requests).toHaveLength(TEAM_CHANGES_MAX_REQUESTS);
    expect(plan.eligibleCount).toBe(TEAM_CHANGES_MAX_REQUESTS + 5);
    expect(plan.deferredCount).toBe(5);
  });

  it('supports smaller first-pass caps without changing eligible counts', () => {
    const plan = buildTeamChangeRequestPlan(changedTasks(30), 0, false, {
      maxRequests: 12,
      unknownScanLimit: 6,
    });

    expect(plan.requests).toHaveLength(12);
    expect(plan.eligibleCount).toBe(30);
    expect(plan.deferredCount).toBe(18);
  });

  it('skips satisfied candidates without counting them as deferred', () => {
    const tasks = changedTasks(30);
    const satisfiedTaskIds = new Set(
      Array.from({ length: 12 }, (_, index) => `changed-${29 - index}`)
    );

    const plan = buildTeamChangeRequestPlan(tasks, 0, false, { satisfiedTaskIds });

    expect(plan.requests).toHaveLength(18);
    expect(plan.requests.some((request) => satisfiedTaskIds.has(request.taskId))).toBe(false);
    expect(plan.eligibleCount).toBe(30);
    expect(plan.deferredCount).toBe(0);
    expect([...satisfiedTaskIds].every((taskId) => plan.eligibleTaskIds.has(taskId))).toBe(true);
  });

  it('keeps forceFresh request options while skipping same-chain satisfied candidates', () => {
    const tasks = changedTasks(30);
    const satisfiedTaskIds = new Set(['changed-29', 'changed-28', 'changed-27']);

    const plan = buildTeamChangeRequestPlan(tasks, 0, true, {
      maxRequests: 9,
      satisfiedTaskIds,
    });

    expect(plan.requests).toHaveLength(9);
    expect(plan.requests.some((request) => satisfiedTaskIds.has(request.taskId))).toBe(false);
    expect(plan.requests.every((request) => request.options?.forceFresh === true)).toBe(true);
  });

  it('rotates unknown scans and preserves summary-only request options', () => {
    const tasks = Array.from({ length: TEAM_CHANGES_UNKNOWN_SCAN_LIMIT + 4 }, (_, index) =>
      task({
        id: `task-${index}`,
        status: 'completed',
        changePresence: 'unknown',
        updatedAt: `2026-05-09T08:${String(index).padStart(2, '0')}:00.000Z`,
      })
    );

    const firstPass = buildTeamChangeRequestPlan(tasks, 0, true);
    const secondPass = buildTeamChangeRequestPlan(tasks, firstPass.nextUnknownScanCursor, false);

    expect(firstPass.requests).toHaveLength(TEAM_CHANGES_UNKNOWN_SCAN_LIMIT);
    expect(firstPass.requests[0].options?.summaryOnly).toBe(true);
    expect(firstPass.requests[0].options?.forceFresh).toBe(true);
    expect(secondPass.requests[0].taskId).toBe('task-3');
  });

  it('changes fingerprint when review state changes without timestamp changes', () => {
    const baseTask = task({
      id: 'reviewing',
      status: 'completed',
      changePresence: 'unknown',
      updatedAt: '2026-05-09T08:00:00.000Z',
      reviewState: 'none',
    });

    expect(buildTeamChangesTasksFingerprint([baseTask])).not.toBe(
      buildTeamChangesTasksFingerprint([{ ...baseTask, reviewState: 'review' }])
    );
  });

  it('keeps fingerprint stable for task reorder and irrelevant history events', () => {
    const first = task({
      id: 'task-a',
      status: 'pending',
      historyEvents: [
        {
          id: 'event-created',
          type: 'task_created',
          timestamp: '2026-05-09T08:00:00.000Z',
          status: 'pending',
        },
        {
          id: 'event-owner',
          type: 'owner_changed',
          timestamp: '2026-05-09T08:01:00.000Z',
          from: 'alice',
          to: 'bob',
        },
      ],
    });
    const second = task({
      id: 'task-b',
      status: 'completed',
      historyEvents: [
        {
          id: 'event-status',
          type: 'status_changed',
          timestamp: '2026-05-09T08:02:00.000Z',
          from: 'in_progress',
          to: 'completed',
        },
      ],
    });

    expect(buildTeamChangesTasksFingerprint([first, second])).toBe(
      buildTeamChangesTasksFingerprint([
        second,
        {
          ...first,
          historyEvents: [
            ...(first.historyEvents ?? []),
            {
              id: 'event-owner-2',
              type: 'owner_changed',
              timestamp: '2026-05-09T08:03:00.000Z',
              from: 'bob',
              to: 'carol',
            },
          ],
        },
      ])
    );
  });
});

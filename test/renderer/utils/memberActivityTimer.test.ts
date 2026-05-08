import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberActivityTimerId,
  deriveReviewActivityTimerAnchor,
  deriveWorkActivityTimerAnchor,
  formatMemberActivityElapsed,
  readMemberActivityTimerElapsed,
  resetMemberActivityTimerStoreForTests,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';

import type { TeamTaskWithKanban } from '@shared/types';

const baseTask: TeamTaskWithKanban = {
  id: 'task-1',
  displayId: 'abc12345',
  subject: 'Build feature',
  status: 'in_progress',
  createdAt: '2026-05-07T09:00:00.000Z',
  reviewState: 'none',
};

describe('memberActivityTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetMemberActivityTimerStoreForTests();
    globalThis.localStorage?.clear();
  });

  it('anchors work timers to the active work interval', () => {
    const task: TeamTaskWithKanban = {
      ...baseTask,
      workIntervals: [
        {
          startedAt: '2026-05-07T09:10:00.000Z',
          completedAt: '2026-05-07T09:15:00.000Z',
        },
        { startedAt: '2026-05-07T09:20:00.000Z' },
      ],
    };

    const anchor = deriveWorkActivityTimerAnchor(task, {
      teamName: 'alpha',
      memberName: 'bob',
    });

    expect(anchor?.startedAt).toBe('2026-05-07T09:20:00.000Z');
    expect(anchor?.baseElapsedMs).toBe(300_000);
    expect(anchor?.timerId).toContain('task-1');
  });

  it('adds completed work intervals to the active timer elapsed value', () => {
    const task: TeamTaskWithKanban = {
      ...baseTask,
      workIntervals: [
        {
          startedAt: '2026-05-07T09:10:00.000Z',
          completedAt: '2026-05-07T09:15:00.000Z',
        },
        { startedAt: '2026-05-07T09:20:00.000Z' },
      ],
    };
    const anchor = deriveWorkActivityTimerAnchor(task, {
      teamName: 'alpha',
      memberName: 'bob',
    });
    expect(anchor).not.toBeNull();

    expect(
      readMemberActivityTimerElapsed({
        timerId: anchor!.timerId,
        startedAtMs: anchor!.startedAtMs,
        baseElapsedMs: anchor!.baseElapsedMs,
        running: true,
        runId: 'run-1',
        nowMs: Date.parse('2026-05-07T09:21:00.000Z'),
      })
    ).toBe(360_000);
  });

  it('does not invent a work timer when task start evidence is missing', () => {
    expect(
      deriveWorkActivityTimerAnchor(baseTask, {
        teamName: 'alpha',
        memberName: 'bob',
      })
    ).toBeNull();
  });

  it('treats closed work intervals without an active interval as paused', () => {
    const task: TeamTaskWithKanban = {
      ...baseTask,
      workIntervals: [
        {
          startedAt: '2026-05-07T09:10:00.000Z',
          completedAt: '2026-05-07T09:15:00.000Z',
        },
      ],
      historyEvents: [
        {
          id: 'evt-1',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-07T09:10:00.000Z',
        },
      ],
    };

    expect(
      deriveWorkActivityTimerAnchor(task, {
        teamName: 'alpha',
        memberName: 'bob',
      })
    ).toBeNull();
  });

  it('anchors review timers only after the reviewer actually starts review', () => {
    const assignedOnly: TeamTaskWithKanban = {
      ...baseTask,
      status: 'completed',
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'alice',
      historyEvents: [
        {
          id: 'evt-1',
          type: 'review_requested',
          from: 'none',
          to: 'review',
          reviewer: 'alice',
          timestamp: '2026-05-07T09:30:00.000Z',
        },
      ],
    };

    expect(
      deriveReviewActivityTimerAnchor(assignedOnly, {
        teamName: 'alpha',
        memberName: 'alice',
      })
    ).toBeNull();

    const started: TeamTaskWithKanban = {
      ...assignedOnly,
      historyEvents: [
        ...(assignedOnly.historyEvents ?? []),
        {
          id: 'evt-2',
          type: 'review_started',
          from: 'review',
          to: 'review',
          actor: 'alice',
          timestamp: '2026-05-07T09:35:00.000Z',
        },
      ],
    };

    expect(
      deriveReviewActivityTimerAnchor(started, {
        teamName: 'alpha',
        memberName: 'alice',
      })?.startedAt
    ).toBe('2026-05-07T09:35:00.000Z');
  });

  it('anchors review timers to persisted review intervals and adds paused review time', () => {
    const task: TeamTaskWithKanban = {
      ...baseTask,
      status: 'completed',
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'alice',
      historyEvents: [
        {
          id: 'evt-1',
          type: 'review_started',
          from: 'review',
          to: 'review',
          actor: 'alice',
          timestamp: '2026-05-07T09:30:00.000Z',
        },
      ],
      reviewIntervals: [
        {
          reviewer: 'alice',
          startedAt: '2026-05-07T09:30:00.000Z',
          completedAt: '2026-05-07T09:35:00.000Z',
        },
        { reviewer: 'alice', startedAt: '2026-05-07T09:40:00.000Z' },
      ],
    };

    const anchor = deriveReviewActivityTimerAnchor(task, {
      teamName: 'alpha',
      memberName: 'alice',
    });

    expect(anchor?.startedAt).toBe('2026-05-07T09:40:00.000Z');
    expect(anchor?.baseElapsedMs).toBe(300_000);
  });

  it('pauses elapsed time while the activity is not running and resumes from the frozen value', () => {
    const timerId = createMemberActivityTimerId({
      teamName: 'alpha',
      memberName: 'bob',
      phase: 'work',
      taskId: 'task-1',
      startedAt: '2026-05-07T09:00:00.000Z',
    });
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');

    syncMemberActivityTimer({
      timerId,
      startedAtMs,
      baseElapsedMs: 0,
      running: true,
      runId: 'run-1',
      nowMs: Date.parse('2026-05-07T09:01:00.000Z'),
    });

    expect(
      readMemberActivityTimerElapsed({
        timerId,
        startedAtMs,
        baseElapsedMs: 0,
        running: true,
        runId: 'run-1',
        nowMs: Date.parse('2026-05-07T09:02:00.000Z'),
      })
    ).toBe(120_000);

    syncMemberActivityTimer({
      timerId,
      startedAtMs,
      baseElapsedMs: 0,
      running: false,
      runId: 'run-1',
      nowMs: Date.parse('2026-05-07T09:02:00.000Z'),
    });

    expect(
      readMemberActivityTimerElapsed({
        timerId,
        startedAtMs,
        baseElapsedMs: 0,
        running: false,
        runId: 'run-1',
        nowMs: Date.parse('2026-05-07T09:05:00.000Z'),
      })
    ).toBe(120_000);

    syncMemberActivityTimer({
      timerId,
      startedAtMs,
      baseElapsedMs: 0,
      running: true,
      runId: 'run-1',
      nowMs: Date.parse('2026-05-07T09:05:00.000Z'),
    });

    expect(
      readMemberActivityTimerElapsed({
        timerId,
        startedAtMs,
        baseElapsedMs: 0,
        running: true,
        runId: 'run-1',
        nowMs: Date.parse('2026-05-07T09:06:00.000Z'),
      })
    ).toBe(180_000);
  });

  it('caps elapsed time across unobserved runtime run transitions', () => {
    const timerId = createMemberActivityTimerId({
      teamName: 'alpha',
      memberName: 'bob',
      phase: 'work',
      taskId: 'task-1',
      startedAt: '2026-05-07T09:00:00.000Z',
    });
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');

    syncMemberActivityTimer({
      timerId,
      startedAtMs,
      baseElapsedMs: 0,
      running: true,
      runId: 'run-1',
      nowMs: Date.parse('2026-05-07T09:01:00.000Z'),
    });

    syncMemberActivityTimer({
      timerId,
      startedAtMs,
      baseElapsedMs: 0,
      running: true,
      runId: 'run-2',
      nowMs: Date.parse('2026-05-07T10:00:00.000Z'),
    });

    expect(
      readMemberActivityTimerElapsed({
        timerId,
        startedAtMs,
        baseElapsedMs: 0,
        running: true,
        runId: 'run-2',
        nowMs: Date.parse('2026-05-07T10:00:00.000Z'),
      })
    ).toBe(65_000);
  });

  it('formats seconds, minutes, and hours compactly', () => {
    expect(formatMemberActivityElapsed(9_000)).toBe('9s');
    expect(formatMemberActivityElapsed(65_000)).toBe('1m 05s');
    expect(formatMemberActivityElapsed(3_780_000)).toBe('1h 03m');
  });
});

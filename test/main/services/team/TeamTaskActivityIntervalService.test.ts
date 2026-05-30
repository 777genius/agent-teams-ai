import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskActivityIntervalService } from '../../../../src/main/services/team/TeamTaskActivityIntervalService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

let tempDir = '';

async function writeTask(teamName: string, task: Record<string, unknown>): Promise<void> {
  const taskDir = path.join(tempDir, 'tasks', teamName);
  const taskId = String(task.id);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, `${taskId}.json`), JSON.stringify(task, null, 2), 'utf8');
}

async function readTask(teamName: string, taskId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(tempDir, 'tasks', teamName, `${taskId}.json`), 'utf8')
  ) as Record<string, unknown>;
}

describe('TeamTaskActivityIntervalService', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-task-activity-'));
    setClaudeBasePathOverride(tempDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setClaudeBasePathOverride(null);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('pauses all active work and review intervals for a team without changing task status', async () => {
    await writeTask('alpha', {
      id: 'task-1',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      reviewIntervals: [{ reviewer: 'alice', startedAt: '2026-05-08T10:05:00.000Z' }],
      historyEvents: [],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:10:00.000Z'
    );
    const task = await readTask('alpha', 'task-1');

    expect(result.changedTasks).toBe(1);
    expect(task.status).toBe('in_progress');
    expect(task.workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:10:00.000Z' },
    ]);
    expect(task.reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:05:00.000Z',
        completedAt: '2026-05-08T10:10:00.000Z',
      },
    ]);
  });

  it('pauses only the selected member work and review intervals', async () => {
    await writeTask('alpha', {
      id: 'bob-task',
      subject: 'Bob',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      reviewIntervals: [{ reviewer: 'alice', startedAt: '2026-05-08T10:01:00.000Z' }],
      historyEvents: [],
    });
    await writeTask('alpha', {
      id: 'tom-task',
      subject: 'Tom',
      owner: 'tom',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      reviewIntervals: [{ reviewer: 'bob', startedAt: '2026-05-08T10:02:00.000Z' }],
      historyEvents: [],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForMember(
      'alpha',
      'bob',
      '2026-05-08T10:05:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'bob-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
    ]);
    expect((await readTask('alpha', 'bob-task')).reviewIntervals).toEqual([
      { reviewer: 'alice', startedAt: '2026-05-08T10:01:00.000Z' },
    ]);
    expect((await readTask('alpha', 'tom-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z' },
    ]);
    expect((await readTask('alpha', 'tom-task')).reviewIntervals).toEqual([
      {
        reviewer: 'bob',
        startedAt: '2026-05-08T10:02:00.000Z',
        completedAt: '2026-05-08T10:05:00.000Z',
      },
    ]);
  });

  it('materializes closed intervals for legacy active history timers on pause', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'bob',
      status: 'completed',
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:05:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:10:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:10:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:05:00.000Z',
        completedAt: '2026-05-08T10:10:00.000Z',
      },
    ]);
  });

  it('does not backfill legacy history time once persisted intervals exist', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:20:00.000Z' }],
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'bob',
      status: 'completed',
      reviewIntervals: [{ reviewer: 'alice', startedAt: '2026-05-08T10:25:00.000Z' }],
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:05:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:30:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:20:00.000Z', completedAt: '2026-05-08T10:30:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:25:00.000Z',
        completedAt: '2026-05-08T10:30:00.000Z',
      },
    ]);
  });

  it('backfills the active legacy cycle when only older persisted intervals exist', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [
        { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      ],
      historyEvents: [
        {
          id: 'event-work-started-old',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
        {
          id: 'event-work-paused-old',
          type: 'status_changed',
          from: 'in_progress',
          to: 'completed',
          timestamp: '2026-05-08T10:05:00.000Z',
        },
        {
          id: 'event-work-started-current',
          type: 'status_changed',
          from: 'completed',
          to: 'in_progress',
          timestamp: '2026-05-08T10:20:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'bob',
      status: 'completed',
      reviewIntervals: [
        {
          reviewer: 'alice',
          startedAt: '2026-05-08T10:00:00.000Z',
          completedAt: '2026-05-08T10:05:00.000Z',
        },
      ],
      historyEvents: [
        {
          id: 'event-review-started-old',
          type: 'review_started',
          timestamp: '2026-05-08T10:00:00.000Z',
          actor: 'alice',
        },
        {
          id: 'event-review-approved-old',
          type: 'review_approved',
          timestamp: '2026-05-08T10:05:00.000Z',
          actor: 'alice',
        },
        {
          id: 'event-review-started-current',
          type: 'review_started',
          timestamp: '2026-05-08T10:20:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:30:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      { startedAt: '2026-05-08T10:20:00.000Z', completedAt: '2026-05-08T10:30:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:00:00.000Z',
        completedAt: '2026-05-08T10:05:00.000Z',
      },
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:20:00.000Z',
        completedAt: '2026-05-08T10:30:00.000Z',
      },
    ]);
  });

  it('ignores malformed persisted intervals when materializing legacy history timers', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ completedAt: '2026-05-08T10:01:00.000Z' }],
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'bob',
      status: 'completed',
      reviewIntervals: [{ startedAt: '2026-05-08T10:04:00.000Z' }],
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:05:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:10:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { completedAt: '2026-05-08T10:01:00.000Z' },
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:10:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      { startedAt: '2026-05-08T10:04:00.000Z', completedAt: '2026-05-08T10:10:00.000Z' },
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:05:00.000Z',
        completedAt: '2026-05-08T10:10:00.000Z',
      },
    ]);
  });

  it('normalizes invalid completedAt values before renderer filtering can fall back to history', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:02:00.000Z', completedAt: 'bad-date' }],
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'bob',
      status: 'completed',
      reviewIntervals: [
        { reviewer: 'alice', startedAt: '2026-05-08T10:06:00.000Z', completedAt: 456 },
      ],
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:05:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:10:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:02:00.000Z', completedAt: '2026-05-08T10:02:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:06:00.000Z',
        completedAt: '2026-05-08T10:06:00.000Z',
      },
    ]);
  });

  it('resumes active work and current review intervals for the selected member', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [
        { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      ],
      historyEvents: [],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'alice',
      status: 'completed',
      reviewIntervals: [
        {
          reviewer: 'bob',
          startedAt: '2026-05-08T10:06:00.000Z',
          completedAt: '2026-05-08T10:08:00.000Z',
        },
      ],
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:06:00.000Z',
          actor: 'bob',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().resumeActiveIntervalsForMember(
      'alpha',
      'bob',
      '2026-05-08T10:20:00.000Z'
    );
    const workTask = await readTask('alpha', 'work-task');
    const reviewTask = await readTask('alpha', 'review-task');

    expect(result.changedTasks).toBe(2);
    expect(workTask.workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      { startedAt: '2026-05-08T10:20:00.000Z' },
    ]);
    expect(reviewTask.reviewIntervals).toEqual([
      {
        reviewer: 'bob',
        startedAt: '2026-05-08T10:06:00.000Z',
        completedAt: '2026-05-08T10:08:00.000Z',
      },
      { reviewer: 'bob', startedAt: '2026-05-08T10:20:00.000Z' },
    ]);
  });

  it('resumes active intervals for multiple members in a single pass', async () => {
    await writeTask('alpha', {
      id: 'bob-task',
      subject: 'Bob work',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [
        { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      ],
      historyEvents: [],
    });
    await writeTask('alpha', {
      id: 'alice-task',
      subject: 'Alice work',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [
        { startedAt: '2026-05-08T11:00:00.000Z', completedAt: '2026-05-08T11:05:00.000Z' },
      ],
      historyEvents: [],
    });
    await writeTask('alpha', {
      id: 'carol-task',
      subject: 'Carol work',
      owner: 'carol',
      status: 'in_progress',
      workIntervals: [
        { startedAt: '2026-05-08T12:00:00.000Z', completedAt: '2026-05-08T12:05:00.000Z' },
      ],
      historyEvents: [],
    });

    const result = new TeamTaskActivityIntervalService().resumeActiveIntervalsForMembers(
      'alpha',
      ['bob', 'alice'],
      '2026-05-08T10:20:00.000Z'
    );
    const bobTask = await readTask('alpha', 'bob-task');
    const aliceTask = await readTask('alpha', 'alice-task');
    const carolTask = await readTask('alpha', 'carol-task');

    // Both listed members resumed in one pass; a member outside the set is untouched.
    expect(result.changedTasks).toBe(2);
    expect((bobTask.workIntervals as unknown[]).at(-1)).toEqual({
      startedAt: '2026-05-08T10:20:00.000Z',
    });
    expect((aliceTask.workIntervals as unknown[]).at(-1)).toEqual({
      startedAt: '2026-05-08T10:20:00.000Z',
    });
    expect(carolTask.workIntervals).toHaveLength(1);
  });

  it('skips unchanged batched resume task reads after a no-op pass', async () => {
    await writeTask('alpha', {
      id: 'bob-task',
      subject: 'Bob work',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      historyEvents: [],
    });

    const service = new TeamTaskActivityIntervalService();
    expect(
      service.resumeActiveIntervalsForMembers(
        'alpha',
        ['bob'],
        '2026-05-08T10:20:00.000Z'
      ).changedTasks
    ).toBe(0);

    const jsonParseSpy = vi.spyOn(JSON, 'parse');
    const secondResult = service.resumeActiveIntervalsForMembers(
      'alpha',
      ['bob'],
      '2026-05-08T10:25:00.000Z'
    );

    expect(secondResult.changedTasks).toBe(0);
    expect(jsonParseSpy).not.toHaveBeenCalled();
  });

  it('skips the task lock after an unchanged batched resume no-op pass', async () => {
    await writeTask('alpha', {
      id: 'bob-task',
      subject: 'Bob work',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      historyEvents: [],
    });

    const service = new TeamTaskActivityIntervalService();
    expect(
      service.resumeActiveIntervalsForMembers(
        'alpha',
        ['bob'],
        '2026-05-08T10:20:00.000Z'
      ).changedTasks
    ).toBe(0);

    const mutateWithLockSpy = vi.spyOn(
      TeamTaskActivityIntervalService.prototype as unknown as {
        mutateTeamTasksWithLock: (
          teamName: string,
          run: () => { changedTasks: number; failed?: boolean }
        ) => { changedTasks: number; failed?: boolean };
      },
      'mutateTeamTasksWithLock'
    );
    const secondResult = service.resumeActiveIntervalsForMembers(
      'alpha',
      ['bob'],
      '2026-05-08T10:25:00.000Z'
    );

    expect(secondResult.changedTasks).toBe(0);
    expect(mutateWithLockSpy).not.toHaveBeenCalled();
  });

  it('refreshes batched resume cache when a task file changes', async () => {
    await writeTask('alpha', {
      id: 'bob-task',
      subject: 'Bob work',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      historyEvents: [],
    });

    const service = new TeamTaskActivityIntervalService();
    expect(
      service.resumeActiveIntervalsForMembers(
        'alpha',
        ['bob'],
        '2026-05-08T10:20:00.000Z'
      ).changedTasks
    ).toBe(0);

    await writeTask('alpha', {
      id: 'bob-task',
      subject: 'Bob work',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [
        {
          startedAt: '2026-05-08T10:00:00.000Z',
          completedAt: '2026-05-08T10:05:00.000Z',
        },
      ],
      historyEvents: [],
      signaturePadding: 'changed-file-signature',
    });

    const result = service.resumeActiveIntervalsForMembers(
      'alpha',
      ['bob'],
      '2026-05-08T10:30:00.000Z'
    );
    const task = await readTask('alpha', 'bob-task');

    expect(result.changedTasks).toBe(1);
    expect(task.workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      { startedAt: '2026-05-08T10:30:00.000Z' },
    ]);
  });

  it('reopens and closes lead work intervals across activity changes', async () => {
    await writeTask('alpha', {
      id: 'lead-task',
      subject: 'Lead follow-up',
      owner: 'team-lead',
      status: 'in_progress',
      workIntervals: [
        { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      ],
      historyEvents: [
        {
          id: 'event-created-active',
          type: 'task_created',
          status: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
          actor: 'team-lead',
        },
      ],
    });

    const service = new TeamTaskActivityIntervalService();
    const resumeResult = service.resumeActiveIntervalsForMember(
      'alpha',
      'team-lead',
      '2026-05-08T10:20:00.000Z'
    );
    expect(resumeResult.changedTasks).toBe(1);
    expect((await readTask('alpha', 'lead-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      { startedAt: '2026-05-08T10:20:00.000Z' },
    ]);

    const pauseResult = service.pauseActiveIntervalsForMember(
      'alpha',
      'team-lead',
      '2026-05-08T10:25:00.000Z'
    );
    expect(pauseResult.changedTasks).toBe(1);
    expect((await readTask('alpha', 'lead-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:05:00.000Z' },
      { startedAt: '2026-05-08T10:20:00.000Z', completedAt: '2026-05-08T10:25:00.000Z' },
    ]);
  });

  it('does not resume intervals before the active work or review start', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:05:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'alice',
      status: 'completed',
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:06:00.000Z',
          actor: 'bob',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().resumeActiveIntervalsForMember(
      'alpha',
      'bob',
      '2026-05-08T10:00:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:05:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      { reviewer: 'bob', startedAt: '2026-05-08T10:06:00.000Z' },
    ]);
  });

  it('resumes active intervals when existing open-like persisted intervals are malformed', async () => {
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:10:00.000Z', completedAt: '' }],
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'alice',
      status: 'completed',
      reviewIntervals: [
        { reviewer: 'bob', startedAt: '2026-05-08T10:11:00.000Z', completedAt: 123 },
      ],
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:05:00.000Z',
          actor: 'bob',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().resumeActiveIntervalsForMember(
      'alpha',
      'bob',
      '2026-05-08T10:20:00.000Z'
    );

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:10:00.000Z', completedAt: '' },
      { startedAt: '2026-05-08T10:20:00.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      { reviewer: 'bob', startedAt: '2026-05-08T10:11:00.000Z', completedAt: 123 },
      { reviewer: 'bob', startedAt: '2026-05-08T10:20:00.000Z' },
    ]);
  });

  it('does not resume review intervals for non-completed tasks with stale review history', async () => {
    await writeTask('alpha', {
      id: 'task-1',
      subject: 'Build',
      owner: 'bob',
      status: 'pending',
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:06:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().resumeActiveIntervalsForMember(
      'alpha',
      'alice',
      '2026-05-08T10:20:00.000Z'
    );
    const task = await readTask('alpha', 'task-1');

    expect(result.changedTasks).toBe(0);
    expect(task.reviewIntervals).toBeUndefined();
  });

  it('repairs stale open intervals using last runtime evidence plus a small grace window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    await writeTask('alpha', {
      id: 'task-1',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      reviewIntervals: [{ reviewer: 'alice', startedAt: '2026-05-08T10:10:00.000Z' }],
      historyEvents: [],
    });

    const result = new TeamTaskActivityIntervalService().repairStaleIntervalsAfterCrash('alpha', {
      version: 2,
      teamName: 'alpha',
      updatedAt: '2026-05-08T10:31:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['bob', 'alice'],
      members: {
        bob: {
          name: 'bob',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeLastSeenAt: '2026-05-08T10:30:00.000Z',
          lastEvaluatedAt: '2026-05-08T10:31:00.000Z',
        },
        alice: {
          name: 'alice',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt: '2026-05-08T10:20:00.000Z',
          lastEvaluatedAt: '2026-05-08T10:31:00.000Z',
        },
      },
      summary: { confirmedCount: 2, pendingCount: 0, failedCount: 0, runtimeAlivePendingCount: 0 },
      teamLaunchState: 'clean_success',
    });
    const task = await readTask('alpha', 'task-1');

    expect(result.changedTasks).toBe(1);
    expect(task.workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:30:05.000Z' },
    ]);
    expect(task.reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:10:00.000Z',
        completedAt: '2026-05-08T10:20:05.000Z',
      },
    ]);
  });

  it('repairs legacy active history timers into closed intervals after a crash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    await writeTask('alpha', {
      id: 'work-task',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      historyEvents: [
        {
          id: 'event-work-started',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-05-08T10:00:00.000Z',
        },
      ],
    });
    await writeTask('alpha', {
      id: 'review-task',
      subject: 'Review',
      owner: 'bob',
      status: 'completed',
      historyEvents: [
        {
          id: 'event-review-started',
          type: 'review_started',
          timestamp: '2026-05-08T10:10:00.000Z',
          actor: 'alice',
        },
      ],
    });

    const result = new TeamTaskActivityIntervalService().repairStaleIntervalsAfterCrash('alpha', {
      version: 2,
      teamName: 'alpha',
      updatedAt: '2026-05-08T10:31:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['bob', 'alice'],
      members: {
        bob: {
          name: 'bob',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeLastSeenAt: '2026-05-08T10:30:00.000Z',
          lastEvaluatedAt: '2026-05-08T10:31:00.000Z',
        },
        alice: {
          name: 'alice',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt: '2026-05-08T10:20:00.000Z',
          lastEvaluatedAt: '2026-05-08T10:31:00.000Z',
        },
      },
      summary: { confirmedCount: 2, pendingCount: 0, failedCount: 0, runtimeAlivePendingCount: 0 },
      teamLaunchState: 'clean_success',
    });

    expect(result.changedTasks).toBe(2);
    expect((await readTask('alpha', 'work-task')).workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:30:05.000Z' },
    ]);
    expect((await readTask('alpha', 'review-task')).reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:10:00.000Z',
        completedAt: '2026-05-08T10:20:05.000Z',
      },
    ]);
  });

  it('repairs stale open intervals near their start time when no runtime evidence exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    await writeTask('alpha', {
      id: 'task-1',
      subject: 'Build',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z' }],
      reviewIntervals: [{ reviewer: 'alice', startedAt: '2026-05-08T10:10:00.000Z' }],
      historyEvents: [],
    });

    const result = new TeamTaskActivityIntervalService().repairStaleIntervalsAfterCrash('alpha');
    const task = await readTask('alpha', 'task-1');

    expect(result.changedTasks).toBe(1);
    expect(task.workIntervals).toEqual([
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '2026-05-08T10:00:05.000Z' },
    ]);
    expect(task.reviewIntervals).toEqual([
      {
        reviewer: 'alice',
        startedAt: '2026-05-08T10:10:00.000Z',
        completedAt: '2026-05-08T10:10:05.000Z',
      },
    ]);
  });

  it('reports failure when task files cannot be scanned', async () => {
    await fs.mkdir(path.join(tempDir, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'tasks', 'alpha'), 'not a directory', 'utf8');

    const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
      'alpha',
      '2026-05-08T10:10:00.000Z'
    );

    expect(result).toEqual({ changedTasks: 0, failed: true });
  });
});

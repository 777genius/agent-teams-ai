import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamLogSourceTracker } from '../../../../src/main/services/team/TeamLogSourceTracker';

import type { TeamMemberLogsFinder } from '../../../../src/main/services/team/TeamMemberLogsFinder';
import type { TeamChangeEvent } from '../../../../src/shared/types';

describe('TeamLogSourceTracker', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('emits task-log-change for matching runtime freshness signals without broad log-source-change', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-'));

    const logsFinder = {
      getLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'change_presence');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const taskId = '123e4567-e89b-12d3-a456-426614174999';
    const signalDir = path.join(tempDir, '.board-task-log-freshness');
    await mkdir(signalDir, { recursive: true });
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
      });
    });

    expect(emitter.mock.calls.map(([event]) => event.type)).not.toContain('log-source-change');

    await tracker.disableTracking('demo', 'change_presence');
  });

  it('keeps task-log tracking alive until the last consumer unsubscribes', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-refcount-'));

    const logsFinder = {
      getLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'task_log_stream');
    await tracker.enableTracking('demo', 'task_log_stream');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await tracker.disableTracking('demo', 'task_log_stream');

    const taskId = '223e4567-e89b-12d3-a456-426614174999';
    const signalDir = path.join(tempDir, '.board-task-log-freshness');
    await mkdir(signalDir, { recursive: true });
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
      });
    });

    emitter.mockClear();
    await tracker.disableTracking('demo', 'task_log_stream');
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":false}');
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(emitter).not.toHaveBeenCalled();
  });

  it('does not reinitialize when another consumer joins an already tracked team', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-init-'));

    const logsFinder = {
      getLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);

    await tracker.enableTracking('demo', 'tool_activity');
    await tracker.enableTracking('demo', 'task_log_stream');

    expect(logsFinder.getLogSourceWatchContext).toHaveBeenCalledTimes(1);

    await tracker.disableTracking('demo', 'task_log_stream');
    await tracker.disableTracking('demo', 'tool_activity');
  });

  it('supports stall_monitor as an independent tracking consumer', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-stall-monitor-'));

    const logsFinder = {
      getLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'stall_monitor');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const taskId = '323e4567-e89b-12d3-a456-426614174999';
    const signalDir = path.join(tempDir, '.board-task-log-freshness');
    await mkdir(signalDir, { recursive: true });
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
      });
    });

    await tracker.disableTracking('demo', 'stall_monitor');
  });
});

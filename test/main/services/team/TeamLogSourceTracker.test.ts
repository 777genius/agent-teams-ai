import { createHash } from 'crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  shouldIgnoreLogSourceWatcherPath,
  TeamLogSourceTracker,
} from '../../../../src/main/services/team/TeamLogSourceTracker';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type { TeamMemberLogsFinder } from '../../../../src/main/services/team/TeamMemberLogsFinder';
import type { TeamChangeEvent } from '../../../../src/shared/types';

const originalChokidarUsePolling = process.env.CHOKIDAR_USEPOLLING;
const originalChokidarInterval = process.env.CHOKIDAR_INTERVAL;

function safeTaskIdSegment(taskId: string): string {
  return `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`;
}

function teamLogFreshnessDir(teamName = 'demo'): string {
  return path.join(getTeamsBasePath(), teamName, 'task-log-freshness');
}

describe('TeamLogSourceTracker', () => {
  let tempDir: string | null = null;

  beforeAll(() => {
    process.env.CHOKIDAR_USEPOLLING = '1';
    process.env.CHOKIDAR_INTERVAL = '25';
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  afterAll(() => {
    if (originalChokidarUsePolling === undefined) {
      delete process.env.CHOKIDAR_USEPOLLING;
    } else {
      process.env.CHOKIDAR_USEPOLLING = originalChokidarUsePolling;
    }
    if (originalChokidarInterval === undefined) {
      delete process.env.CHOKIDAR_INTERVAL;
    } else {
      process.env.CHOKIDAR_INTERVAL = originalChokidarInterval;
    }
  });

  it('emits task-log-change for matching runtime freshness signals without broad log-source-change', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-'));
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
})),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'change_presence');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 350));

    const taskId = '123e4567-e89b-12d3-a456-426614174999';
    const signalDir = teamLogFreshnessDir();
    await mkdir(signalDir, { recursive: true });
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
        taskSignalKind: 'log',
      });
    });

    expect(emitter.mock.calls.map(([event]) => event.type)).not.toContain('log-source-change');

    await tracker.disableTracking('demo', 'change_presence');
  });

  it('keeps task-log tracking alive until the last consumer unsubscribes', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-refcount-'));
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
})),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'task_log_stream');
    await tracker.enableTracking('demo', 'task_log_stream');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 350));

    await tracker.disableTracking('demo', 'task_log_stream');

    const taskId = '223e4567-e89b-12d3-a456-426614174999';
    const signalDir = teamLogFreshnessDir();
    await mkdir(signalDir, { recursive: true });
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
        taskSignalKind: 'log',
      });
    });

    emitter.mockClear();
    await tracker.disableTracking('demo', 'task_log_stream');
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":false}');
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(emitter).not.toHaveBeenCalled();
  });

  it('creates team log freshness dir without creating missing live cwd roots', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-missing-root-'));
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));
    const transcriptProjectDir = path.join(tempDir, 'transcript-project');
    const missingWorkspaceDir = path.join(tempDir, 'missing-workspace');

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: transcriptProjectDir,
        projectPath: missingWorkspaceDir,
        taskFreshnessRootDirs: [missingWorkspaceDir],
        sessionIds: [],
        watchSessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'task_log_stream');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await stat(teamLogFreshnessDir())).isDirectory()).toBe(true);
    await expect(stat(missingWorkspaceDir)).rejects.toThrow();

    const taskId = 'transcript-root-task';
    await writeFile(
      path.join(teamLogFreshnessDir(), `${encodeURIComponent(taskId)}.json`),
      JSON.stringify({ taskId }),
      'utf8'
    );

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
        taskSignalKind: 'log',
      });
    });

    await tracker.disableTracking('demo', 'task_log_stream');
  });

  it('emits log freshness kind from Windows-safe hashed task-log freshness files', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-safe-log-'));
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'task_log_stream');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const taskId = 'AUX';
    const signalDir = teamLogFreshnessDir();
    await mkdir(signalDir, { recursive: true });
    await writeFile(
      path.join(signalDir, `${safeTaskIdSegment(taskId)}.json`),
      JSON.stringify({ taskId, updatedAt: '2026-04-19T12:00:00.000Z' }),
      'utf8'
    );

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
        taskSignalKind: 'log',
      });
    });

    await tracker.disableTracking('demo', 'task_log_stream');
  });

  it('watches team-scoped log freshness and live cwd task-change freshness roots', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-codex-root-'));
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));
    const transcriptProjectDir = path.join(tempDir, 'transcripts');
    const workspaceProjectDir = path.join(tempDir, 'workspace');
    const memberProjectDir = path.join(tempDir, 'member-workspace');
    await mkdir(transcriptProjectDir, { recursive: true });
    await mkdir(workspaceProjectDir, { recursive: true });
    await mkdir(memberProjectDir, { recursive: true });

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: transcriptProjectDir,
        projectPath: workspaceProjectDir,
        taskFreshnessRootDirs: [workspaceProjectDir, memberProjectDir],
        sessionIds: [],
        watchSessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'task_log_stream');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 350));

    await expect(stat(path.join(memberProjectDir, '.board-task-log-freshness'))).rejects.toThrow();
    await expect(stat(path.join(workspaceProjectDir, '.board-task-log-freshness'))).rejects.toThrow();

    const changeTaskId = 'codex-task-2';
    await mkdir(path.join(workspaceProjectDir, '.board-task-change-freshness'), {
      recursive: true,
    });
    await writeFile(
      path.join(
        workspaceProjectDir,
        '.board-task-change-freshness',
        `${encodeURIComponent(changeTaskId)}.json`
      ),
      JSON.stringify({ taskId: changeTaskId }),
      'utf8'
    );

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId: changeTaskId,
        taskSignalKind: 'change',
      });
    });

    await tracker.disableTracking('demo', 'task_log_stream');
  });

  it('emits log-source-change for scoped root transcripts', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-scoped-root-'));
    await writeFile(path.join(tempDir, 'lead-session.jsonl'), '{"seq":1}\n');

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: ['lead-session'],
        watchSessionIds: ['lead-session'],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'change_presence');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writeFile(path.join(tempDir, 'lead-session.jsonl'), '{"seq":2}\n');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'log-source-change',
        teamName: 'demo',
      });
    });

    await tracker.disableTracking('demo', 'change_presence');
  });

  it('ignores old unscoped root transcript changes', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-unscoped-root-'));
    await writeFile(path.join(tempDir, 'lead-session.jsonl'), '{"seq":1}\n');
    await writeFile(path.join(tempDir, 'old-session.jsonl'), '{"seq":1}\n');

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: ['lead-session'],
        watchSessionIds: ['lead-session'],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'change_presence');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writeFile(path.join(tempDir, 'old-session.jsonl'), '{"seq":2}\n');
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(emitter.mock.calls.map(([event]) => event.type)).not.toContain('log-source-change');

    await tracker.disableTracking('demo', 'change_presence');
  });

  it('emits log-source-change when a scoped root transcript appears', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-pending-root-'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: ['new-runtime'],
        watchSessionIds: ['new-runtime'],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'change_presence');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writeFile(path.join(tempDir, 'new-runtime.jsonl'), '{"seq":1}\n');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'log-source-change',
        teamName: 'demo',
      });
    });

    await tracker.disableTracking('demo', 'change_presence');
  });

  it('does not reinitialize when another consumer joins an already tracked team', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-init-'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
})),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);

    await tracker.enableTracking('demo', 'tool_activity');
    await tracker.enableTracking('demo', 'task_log_stream');

    expect(logsFinder.getLiveLogSourceWatchContext).toHaveBeenCalledTimes(1);

    await tracker.disableTracking('demo', 'task_log_stream');
    await tracker.disableTracking('demo', 'tool_activity');
  });

  it('holds at most one acquisition across repeated ensureTracking calls', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-ensure-'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);

    for (let i = 0; i < 5; i += 1) {
      await tracker.ensureTracking('demo');
    }
    expect(logsFinder.getLiveLogSourceWatchContext).toHaveBeenCalledTimes(1);

    // A single release of the ensure consumer must fully tear tracking down —
    // repeated ensure calls previously stacked acquisitions that nothing ever
    // released, so the per-team watcher lived for the whole app lifetime.
    // Re-ensuring after the release re-initializes, proving teardown happened.
    await tracker.disableTracking('demo', 'change_presence_ensure');
    await tracker.ensureTracking('demo');
    expect(logsFinder.getLiveLogSourceWatchContext).toHaveBeenCalledTimes(2);

    await tracker.disableTracking('demo', 'change_presence_ensure');
  });

  it('keeps tracking alive for explicit consumers when the ensure acquisition is released', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-ensure-mix-'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
      })),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);

    await tracker.ensureTracking('demo');
    await tracker.enableTracking('demo', 'tool_activity');
    expect(logsFinder.getLiveLogSourceWatchContext).toHaveBeenCalledTimes(1);

    // Releasing the ensure acquisition must not tear down tracking held by an
    // explicit consumer: a follow-up ensure joins without re-initializing.
    await tracker.disableTracking('demo', 'change_presence_ensure');
    await tracker.ensureTracking('demo');
    expect(logsFinder.getLiveLogSourceWatchContext).toHaveBeenCalledTimes(1);

    // Once every consumer is gone, tracking re-initializes on the next ensure.
    await tracker.disableTracking('demo', 'tool_activity');
    await tracker.disableTracking('demo', 'change_presence_ensure');
    await tracker.ensureTracking('demo');
    expect(logsFinder.getLiveLogSourceWatchContext).toHaveBeenCalledTimes(2);

    await tracker.disableTracking('demo', 'change_presence_ensure');
  });

  it('notifies log-source listeners before forwarding the external team change event', () => {
    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: '/tmp/demo',
        sessionIds: [],
        watchSessionIds: [],
})),
    } as unknown as TeamMemberLogsFinder;
    const tracker = new TeamLogSourceTracker(logsFinder);
    const events: string[] = [];
    tracker.onLogSourceChange(() => {
      events.push('listener');
    });
    tracker.setEmitter(() => {
      events.push('emitter');
    });

    (
      tracker as unknown as {
        emitLogSourceChange: (teamName: string) => void;
      }
    ).emitLogSourceChange('demo');

    expect(events).toEqual(['listener', 'emitter']);
  });

  it('supports stall_monitor as an independent tracking consumer', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-stall-monitor-'));
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
})),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'stall_monitor');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const taskId = '323e4567-e89b-12d3-a456-426614174999';
    const signalDir = teamLogFreshnessDir();
    await mkdir(signalDir, { recursive: true });
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
        taskSignalKind: 'log',
      });
    });

    await tracker.disableTracking('demo', 'stall_monitor');
  });

  it('emits the task id from Windows-safe hashed task-change freshness files', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-safe-task-'));

    const logsFinder = {
      getLiveLogSourceWatchContext: vi.fn(async () => ({
        projectDir: tempDir!,
        sessionIds: [],
        watchSessionIds: [],
})),
    } as unknown as TeamMemberLogsFinder;

    const tracker = new TeamLogSourceTracker(logsFinder);
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    tracker.setEmitter(emitter);

    await tracker.enableTracking('demo', 'change_presence');
    emitter.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const taskId = 'CON';
    const signalDir = path.join(tempDir, '.board-task-change-freshness');
    await mkdir(signalDir, { recursive: true });
    await writeFile(
      path.join(signalDir, `${safeTaskIdSegment(taskId)}.json`),
      JSON.stringify({ taskId, updatedAt: '2026-04-19T12:00:00.000Z' }),
      'utf8'
    );

    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'demo',
        taskId,
        taskSignalKind: 'change',
      });
    });
    expect(emitter.mock.calls).not.toContainEqual([
      expect.objectContaining({ type: 'task-log-change', taskId: safeTaskIdSegment(taskId) }),
    ]);

    await tracker.disableTracking('demo', 'change_presence');
  });

  it('ignores internal ledger artifact paths but keeps freshness signals visible', () => {
    const projectDir = '/tmp/demo-project';
    const scopedSessionIds = new Set(['lead-session']);

    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-changes', 'events', 'task.jsonl')
      )
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-changes', 'locks', 'task.lock', 'owner.json')
      )
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-change-freshness', 'task.json')
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-log-freshness', 'task.json'),
        { scopedSessionIds }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'lead-session.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'old-session.jsonl'), {
        scopedSessionIds,
      })
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'pending-session.jsonl'),
        {
          scopedSessionIds,
          pendingRootSessionIds: new Set(['pending-session']),
        }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'lead-session'), {
        scopedSessionIds,
      })
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'pending-session'), {
        scopedSessionIds,
        pendingRootSessionIds: new Set(['pending-session']),
      })
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'old-session'), {
        scopedSessionIds,
      })
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'lead-session', 'subagents', 'agent-worker.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'lead-session', 'subagents', 'agent-acompact-worker.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'old-session', 'subagents', 'agent-worker.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(true);
  });
});

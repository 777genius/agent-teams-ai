import {
  TeamViewSnapshotAssembler,
  type TeamViewSnapshotAssemblerPorts,
  type TeamViewTaskChangeLogSourceSnapshot,
} from '@features/team-view-read-model/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  KanbanState,
  MemberRuntimeAdvisory,
  TeamConfig,
  TeamMemberSnapshot,
  TeamProcess,
  TeamTask,
  TeamTaskWithKanban,
} from '@shared/types';

interface FakePresenceIndex {
  byTaskId: Record<string, 'present' | 'absent'>;
}

interface FakeLogSourceSnapshot extends TeamViewTaskChangeLogSourceSnapshot {
  source: 'fake';
}

type Ports = TeamViewSnapshotAssemblerPorts<FakePresenceIndex, FakeLogSourceSnapshot>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function buildConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'My team',
    members: [{ name: 'team-lead', role: 'Lead' }],
    ...overrides,
  };
}

function buildMember(name: string, cwd?: string): TeamMemberSnapshot {
  return {
    name,
    currentTaskId: null,
    taskCount: 0,
    ...(cwd ? { cwd } : {}),
  };
}

function buildTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    subject: 'Inspect snapshot',
    status: 'pending',
    ...overrides,
  };
}

function buildProcess(stopped = false): TeamProcess {
  return {
    id: 'process-1',
    label: 'Lead',
    pid: 101,
    registeredAt: '2026-07-28T10:00:00.000Z',
    ...(stopped ? { stoppedAt: '2026-07-28T10:05:00.000Z' } : {}),
  };
}

function createHarness(overrides: Partial<Ports> = {}) {
  const compactTask = vi.fn((task: TeamTaskWithKanban): TeamTaskWithKanban => task);
  const ports: Ports = {
    readConfig: vi.fn(async () => buildConfig()),
    readTasks: vi.fn(async () => []),
    readInboxNames: vi.fn(async () => []),
    readMembersMeta: vi.fn(async () => []),
    readTeamMeta: vi.fn(async () => null),
    readLaunchSnapshot: vi.fn(async () => null),
    readKanbanState: vi.fn(async () => ({
      teamName: 'my-team',
      reviewers: [],
      tasks: {},
    })),
    startTaskChangePresenceRead: vi.fn(() => ({
      enabled: false,
      logSourceSnapshot: null,
      presenceIndex: Promise.resolve(null),
    })),
    projectTaskWithKanban: vi.fn((task) => ({
      ...task,
      reviewState: 'none',
      reviewer: null,
    })),
    projectTaskChangePresence: vi.fn(() => ({})),
    resolveMembers: vi.fn(() => []),
    readMemberRuntimeAdvisories: vi.fn(async () => new Map()),
    resolveGitBranch: vi.fn(async () => null),
    memberBranchConcurrency: 8,
    readProcesses: vi.fn(async () => []),
    selectCurrentActiveTask: vi.fn((tasks) => tasks[0] ?? null),
    compactTask,
    logDebug: vi.fn(),
    logWarning: vi.fn(),
    ...overrides,
  };
  return {
    assembler: new TeamViewSnapshotAssembler(ports),
    ports,
  };
}

describe('TeamViewSnapshotAssembler', () => {
  it('short-circuits every downstream port when config is missing', async () => {
    const { assembler, ports } = createHarness({
      readConfig: vi.fn(async () => null),
    });

    await expect(assembler.getTeamData('missing-team')).rejects.toThrow(
      'Team not found: missing-team'
    );

    expect(ports.startTaskChangePresenceRead).not.toHaveBeenCalled();
    expect(ports.readTasks).not.toHaveBeenCalled();
    expect(ports.readInboxNames).not.toHaveBeenCalled();
    expect(ports.readMembersMeta).not.toHaveBeenCalled();
    expect(ports.readTeamMeta).not.toHaveBeenCalled();
    expect(ports.readLaunchSnapshot).not.toHaveBeenCalled();
    expect(ports.readKanbanState).not.toHaveBeenCalled();
    expect(ports.resolveMembers).not.toHaveBeenCalled();
    expect(ports.readProcesses).not.toHaveBeenCalled();
  });

  it('starts independent reads in parallel and preserves fallback and warning order', async () => {
    const order: string[] = [];
    const tasks = createDeferred<readonly TeamTask[]>();
    const inboxNames = createDeferred<string[]>();
    const membersMeta = createDeferred<TeamConfig['members']>();
    const teamMeta = createDeferred<null>();
    const launch = createDeferred<null>();
    const kanban = createDeferred<KanbanState>();
    const { assembler, ports } = createHarness({
      startTaskChangePresenceRead: vi.fn(() => {
        order.push('presence');
        return {
          enabled: false,
          logSourceSnapshot: null,
          presenceIndex: Promise.resolve(null),
        };
      }),
      readTasks: vi.fn(() => {
        order.push('tasks');
        return tasks.promise;
      }),
      readInboxNames: vi.fn(() => {
        order.push('inboxNames');
        return inboxNames.promise;
      }),
      readMembersMeta: vi.fn(() => {
        order.push('membersMeta');
        return membersMeta.promise;
      }),
      readTeamMeta: vi.fn(() => {
        order.push('teamMeta');
        return teamMeta.promise;
      }),
      readLaunchSnapshot: vi.fn(() => {
        order.push('launch');
        return launch.promise;
      }),
      readKanbanState: vi.fn(() => {
        order.push('kanban');
        return kanban.promise;
      }),
      resolveMembers: vi.fn(() => {
        order.push('resolveMembers');
        return [];
      }),
      readProcesses: vi.fn(async () => {
        order.push('processes');
        throw new Error('processes failed');
      }),
    });

    const pending = assembler.getTeamData('my-team');
    await flushMicrotasks();

    expect(order).toEqual([
      'presence',
      'inboxNames',
      'membersMeta',
      'teamMeta',
      'launch',
      'kanban',
      'tasks',
    ]);
    expect(ports.resolveMembers).not.toHaveBeenCalled();
    expect(ports.readProcesses).not.toHaveBeenCalled();

    kanban.reject(new Error('kanban failed'));
    tasks.reject(new Error('tasks failed'));
    launch.reject(new Error('launch failed'));
    membersMeta.reject(new Error('members failed'));
    teamMeta.reject(new Error('team meta failed'));
    inboxNames.reject(new Error('inboxes failed'));

    const snapshot = await pending;

    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.members).toEqual([]);
    expect(snapshot.kanbanState).toEqual({
      teamName: 'my-team',
      reviewers: [],
      tasks: {},
    });
    expect(snapshot.warnings).toEqual([
      'Tasks failed to load',
      'Inboxes failed to load',
      'Member metadata failed to load',
      'Team runtime metadata failed to load',
      'Launch state failed to load',
      'Kanban state failed to load',
      'Processes failed to load',
    ]);
    expect(order.slice(-2)).toEqual(['resolveMembers', 'processes']);
  });

  it('keeps presence and member resolver failures fatal', async () => {
    const presence = createDeferred<FakePresenceIndex | null>();
    const presenceHarness = createHarness({
      startTaskChangePresenceRead: vi.fn(() => ({
        enabled: true,
        logSourceSnapshot: {
          source: 'fake' as const,
          projectFingerprint: 'project',
          logSourceGeneration: 'generation',
        },
        presenceIndex: presence.promise,
      })),
    });
    const pending = presenceHarness.assembler.getTeamData('my-team');
    await flushMicrotasks();
    presence.reject(new Error('presence failed'));

    await expect(pending).rejects.toThrow('presence failed');
    expect(presenceHarness.ports.resolveMembers).not.toHaveBeenCalled();

    const resolverHarness = createHarness({
      resolveMembers: vi.fn(() => {
        throw new Error('resolver failed');
      }),
    });
    await expect(resolverHarness.assembler.getTeamData('my-team')).rejects.toThrow(
      'resolver failed'
    );
    expect(resolverHarness.ports.readProcesses).not.toHaveBeenCalled();
  });

  it('skips branches in thin mode and enriches differing branches in full mode', async () => {
    const resolveGitBranch = vi.fn(async (cwd: string) =>
      cwd === '/repo-alice' ? 'feature/alice' : 'main'
    );
    const resolveMembers = vi.fn(() => [
      buildMember('team-lead', '/repo'),
      buildMember('alice', '/repo-alice'),
    ]);
    const { assembler } = createHarness({
      readConfig: vi.fn(async () =>
        buildConfig({
          projectPath: '/repo',
          members: [
            { name: 'team-lead', role: 'Lead', cwd: '/repo' },
            { name: 'alice', role: 'Developer', cwd: '/repo-alice' },
          ],
        })
      ),
      resolveMembers,
      resolveGitBranch,
    });

    const thin = await assembler.getTeamData('my-team', {
      includeMemberBranches: false,
    });
    expect(resolveGitBranch).not.toHaveBeenCalled();
    expect(thin.members.find((member) => member.name === 'alice')?.gitBranch).toBeUndefined();

    const full = await assembler.getTeamData('my-team');
    expect(resolveGitBranch).toHaveBeenCalledWith('/repo');
    expect(resolveGitBranch).toHaveBeenCalledWith('/repo-alice');
    expect(full.members.find((member) => member.name === 'alice')?.gitBranch).toBe('feature/alice');
  });

  it('treats the 250ms runtime-advisory budget as best-effort', async () => {
    vi.useFakeTimers();
    try {
      const advisories = createDeferred<Map<string, MemberRuntimeAdvisory>>();
      const { assembler, ports } = createHarness({
        resolveMembers: vi.fn(() => [buildMember('alice')]),
        readMemberRuntimeAdvisories: vi.fn(() => advisories.promise),
      });

      const pending = assembler.getTeamData('my-team');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(250);
      const snapshot = await pending;

      expect(snapshot.members[0]?.runtimeAdvisory).toBeUndefined();
      expect(snapshot.warnings).toBeUndefined();
      expect(ports.logDebug).toHaveBeenCalledWith(expect.stringContaining('exceeded 250ms budget'));

      advisories.resolve(new Map());
      await flushMicrotasks();
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades runtime-advisory failures to the stable warning', async () => {
    const { assembler } = createHarness({
      resolveMembers: vi.fn(() => [buildMember('alice')]),
      readMemberRuntimeAdvisories: vi.fn(async () => {
        throw new Error('advisory failed');
      }),
    });

    const snapshot = await assembler.getTeamData('my-team');

    expect(snapshot.members[0]?.runtimeAdvisory).toBeUndefined();
    expect(snapshot.warnings).toEqual(['Member runtime advisories failed to load']);
  });

  it('compacts projected tasks through the focused compaction port', async () => {
    const task = buildTask({ description: 'uncompacted description' });
    const compactTask = vi.fn((projected: TeamTaskWithKanban) => ({
      ...projected,
      description: 'compact',
    }));
    const { assembler } = createHarness({
      readTasks: vi.fn(async () => [task]),
      compactTask,
    });

    const snapshot = await assembler.getTeamData('my-team');

    expect(compactTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        reviewState: 'none',
        reviewer: null,
      })
    );
    expect(snapshot.tasks[0]?.description).toBe('compact');
    expect(task.description).toBe('uncompacted description');
  });

  it('derives alive and offline snapshots without mutating process state', async () => {
    const readProcesses = vi
      .fn<Ports['readProcesses']>()
      .mockResolvedValueOnce([buildProcess()])
      .mockResolvedValueOnce([buildProcess(true)]);
    const { assembler } = createHarness({ readProcesses });

    const alive = await assembler.getTeamData('my-team');
    const offline = await assembler.getTeamData('my-team');

    expect(alive.isAlive).toBe(true);
    expect(offline.isAlive).toBe(false);
    expect(alive.processes).toEqual([buildProcess()]);
    expect(offline.processes).toEqual([buildProcess(true)]);
  });

  it('emits the existing slow-snapshot diagnostic from completion-time marks', async () => {
    let now = 0;
    const logWarning = vi.fn();
    const { assembler } = createHarness({
      now: () => {
        now += 200;
        return now;
      },
      logWarning,
    });

    await assembler.getTeamData('my-team', { includeMemberBranches: false });

    expect(logWarning).toHaveBeenCalledWith(
      expect.stringMatching(
        /getTeamData team=my-team slow total=\d+ms .* branchMode=skipped counts=tasks:0,inboxNames:0,members:0,processes:0/
      )
    );
  });
});

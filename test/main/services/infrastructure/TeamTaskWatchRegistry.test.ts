import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeLiveTeamWatchScope,
  computeTeamWatchScope,
  markTeamEngaged,
  resetTeamWatchScopeForTests,
  setAliveTeamsProvider,
} from '../../../../src/main/services/infrastructure/teamWatchScope';

type MockChokidarWatcher = {
  targets: string[];
  options: unknown;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  on: (event: string, handler: (...args: unknown[]) => void) => MockChokidarWatcher;
  emit: (event: string, ...args: unknown[]) => void;
  add: (paths: string | string[]) => void;
  unwatch: (paths: string | string[]) => void;
  close: ReturnType<typeof vi.fn>;
};

const chokidarMock = vi.hoisted(() => {
  const instances: MockChokidarWatcher[] = [];
  const make = () => (targets: string | string[], options: unknown) => {
    const watcher = {
      targets: (Array.isArray(targets) ? targets : [targets]).map((t) => String(t)),
      options,
      handlers: new Map<string, Array<(...args: unknown[]) => void>>(),
      close: vi.fn().mockResolvedValue(undefined),
      emit(event: string, ...args: unknown[]) {
        for (const h of watcher.handlers.get(event) ?? []) h(...args);
      },
      add(paths: string | string[]) {
        for (const p of (Array.isArray(paths) ? paths : [paths]).map((x) => String(x))) {
          if (!watcher.targets.includes(p)) watcher.targets.push(p);
        }
      },
      unwatch(paths: string | string[]) {
        const drop = new Set((Array.isArray(paths) ? paths : [paths]).map((x) => String(x)));
        watcher.targets = watcher.targets.filter((t) => !drop.has(t));
      },
    } as MockChokidarWatcher;
    watcher.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const hs = watcher.handlers.get(event) ?? [];
      hs.push(handler);
      watcher.handlers.set(event, hs);
      return watcher;
    });
    instances.push(watcher);
    return watcher;
  };
  const watch = vi.fn(make());
  return {
    instances,
    watch,
    reset() {
      instances.length = 0;
      watch.mockReset();
      watch.mockImplementation(make());
    },
  };
});

vi.mock('chokidar', () => ({ watch: chokidarMock.watch }));

// Lets a test park a reconcile pass in the middle of collecting its targets,
// after the first team is already in the collected set.
const statGate = vi.hoisted(() => ({ hold: null as Promise<void> | null, parked: false }));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const stats = await actual.stat(...args);
      if (statGate.hold) {
        statGate.parked = true;
        await statGate.hold;
      }
      return stats;
    },
  };
});

import { TeamTaskWatchRegistry } from '../../../../src/main/services/infrastructure/TeamTaskWatchRegistry';

function latestTargets(): string[] {
  const last = chokidarMock.instances.at(-1);
  return (last?.targets ?? []).map((t) => path.normalize(t));
}

/** Every path handed to a chokidar instance created since `fromCall`. */
function watchedSince(fromCall: number): string[] {
  return chokidarMock.watch.mock.calls
    .slice(fromCall)
    .flatMap(([targets]) => (Array.isArray(targets) ? targets : [targets]))
    .map((target) => path.normalize(String(target)));
}

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('TeamTaskWatchRegistry scoping', () => {
  let root: string;

  beforeEach(() => {
    chokidarMock.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttwr-scope-'));
    for (const team of ['alpha', 'beta', 'gamma']) {
      fs.mkdirSync(path.join(root, team, 'inboxes'), { recursive: true });
      fs.writeFileSync(path.join(root, team, 'config.json'), '{}');
      fs.writeFileSync(path.join(root, team, 'inboxes', 'team-lead.json'), '[]');
    }
  });

  afterEach(() => {
    resetTeamWatchScopeForTests();
    setPlatform(originalPlatform);
    statGate.hold = null;
    statGate.parked = false;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('watches team dirs by artifact scope and inboxes by live scope (teams kind)', async () => {
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
      getScopedTeamNames: () => new Set(['alpha', 'beta']),
      getScopedInboxTeamNames: () => new Set(['alpha']),
    });
    await registry.start();
    const targets = latestTargets();
    await registry.close();

    expect(targets).toContain(path.normalize(root));
    // alpha is live: root and inbox are watched
    expect(targets).toContain(path.normalize(path.join(root, 'alpha')));
    expect(targets).toContain(path.normalize(path.join(root, 'alpha', 'inboxes')));

    // beta is only UI-engaged: root is watched, inbox is not
    expect(targets).toContain(path.normalize(path.join(root, 'beta')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'beta', 'inboxes')));

    // gamma is idle: nothing per-team is watched
    expect(targets).not.toContain(path.normalize(path.join(root, 'gamma')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'gamma', 'inboxes')));
  });

  it('falls back to watching every team when no scope provider is given', async () => {
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
    });
    await registry.start();
    const targets = latestTargets();
    await registry.close();

    for (const team of ['alpha', 'beta', 'gamma']) {
      expect(targets).toContain(path.normalize(path.join(root, team)));
      expect(targets).toContain(path.normalize(path.join(root, team, 'inboxes')));
    }
  });

  it('falls back to watching every team when the scope provider returns null', async () => {
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
      getScopedTeamNames: () => null,
    });
    await registry.start();
    const targets = latestTargets();
    await registry.close();

    for (const team of ['alpha', 'beta', 'gamma']) {
      expect(targets).toContain(path.normalize(path.join(root, team)));
    }
  });

  it('scopes task dirs and never adds inboxes (tasks kind)', async () => {
    const registry = new TeamTaskWatchRegistry({
      kind: 'tasks',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
      getScopedTeamNames: () => new Set(['beta']),
    });
    await registry.start();
    const targets = latestTargets();
    await registry.close();

    expect(targets).toContain(path.normalize(root));
    expect(targets).toContain(path.normalize(path.join(root, 'beta')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'alpha')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'gamma')));
    // tasks kind never watches inboxes
    expect(targets).not.toContain(path.normalize(path.join(root, 'beta', 'inboxes')));
  });

  it('re-resolves scope on requestReconcile (newly scoped team gets watched)', async () => {
    const scoped = new Set<string>(['alpha']);
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
      getScopedTeamNames: () => scoped,
    });
    await registry.start();
    expect(latestTargets()).not.toContain(path.normalize(path.join(root, 'beta')));

    scoped.add('beta');
    await registry.requestReconcile();
    const targets = latestTargets();
    await registry.close();

    expect(targets).toContain(path.normalize(path.join(root, 'beta')));
  });

  describe('task directory backfill', () => {
    const HOUR_MS = 60 * 60 * 1000;

    function setMtime(file: string, mtimeMs: number): void {
      const time = new Date(mtimeMs);
      fs.utimesSync(file, time, time);
    }

    function ageDirectory(team: string, mtimeMs = Date.now() - HOUR_MS): void {
      const dir = path.join(root, team);
      for (const name of fs.readdirSync(dir)) {
        setMtime(path.join(dir, name), mtimeMs);
      }
      // The directory mtime is aged last: touching entries above can bump it.
      setMtime(dir, mtimeMs);
    }

    function seedTaskFiles(team: string, count: number): void {
      for (let id = 1; id <= count; id++) {
        fs.writeFileSync(path.join(root, team, `${id}.json`), '{}');
      }
      ageDirectory(team);
    }

    function createTasksRegistry(scoped: Set<string>, events: string[]): TeamTaskWatchRegistry {
      return new TeamTaskWatchRegistry({
        kind: 'tasks',
        rootPath: root,
        onChange: (_eventType, relativePath) => events.push(relativePath),
        onError: () => {},
        getScopedTeamNames: () => scoped,
      });
    }

    it('does not replay historical task files when a team enters scope', async () => {
      seedTaskFiles('beta', 50);
      const events: string[] = [];
      const scoped = new Set(['alpha']);
      const registry = createTasksRegistry(scoped, events);
      try {
        await registry.start();
        scoped.add('beta');
        await registry.requestReconcile();
      } finally {
        await registry.close();
      }

      expect(latestTargets()).toContain(path.normalize(path.join(root, 'beta')));
      expect(events).toEqual([]);
    });

    it('replays a task file created while the team was unwatched', async () => {
      seedTaskFiles('beta', 50);
      const events: string[] = [];
      const scoped = new Set(['alpha']);
      const registry = createTasksRegistry(scoped, events);
      try {
        await registry.start();
        fs.writeFileSync(path.join(root, 'beta', '51.json'), '{}');
        scoped.add('beta');
        await registry.requestReconcile();
      } finally {
        await registry.close();
      }

      expect(events).toEqual(['beta/51.json']);
    });

    it('replays an in-place edit of an old task file', async () => {
      seedTaskFiles('beta', 5);
      const events: string[] = [];
      const scoped = new Set(['alpha']);
      const registry = createTasksRegistry(scoped, events);
      try {
        await registry.start();
        // Writing into an existing file leaves the directory mtime untouched.
        const dirMtimeBefore = fs.statSync(path.join(root, 'beta')).mtimeMs;
        fs.writeFileSync(path.join(root, 'beta', '3.json'), '{"edited":true}');
        expect(fs.statSync(path.join(root, 'beta')).mtimeMs).toBe(dirMtimeBefore);
        scoped.add('beta');
        await registry.requestReconcile();
      } finally {
        await registry.close();
      }

      expect(events).toEqual(['beta/3.json']);
    });

    it('replays a task written through a temp file and rename', async () => {
      seedTaskFiles('beta', 5);
      const events: string[] = [];
      const scoped = new Set(['alpha']);
      const registry = createTasksRegistry(scoped, events);
      try {
        await registry.start();
        fs.writeFileSync(path.join(root, 'beta', '.4.json.tmp'), '{"edited":true}');
        fs.renameSync(path.join(root, 'beta', '.4.json.tmp'), path.join(root, 'beta', '4.json'));
        scoped.add('beta');
        await registry.requestReconcile();
      } finally {
        await registry.close();
      }

      expect(events).toEqual(['beta/4.json']);
    });

    it('backfills a task directory created in the race window', async () => {
      const events: string[] = [];
      const scoped = new Set(['alpha', 'delta']);
      const registry = createTasksRegistry(scoped, events);
      try {
        await registry.start();
        expect(latestTargets()).not.toContain(path.normalize(path.join(root, 'delta')));
        fs.mkdirSync(path.join(root, 'delta'));
        fs.writeFileSync(path.join(root, 'delta', '1.json'), '{}');
        fs.writeFileSync(path.join(root, 'delta', '2.json'), '{}');
        await registry.requestReconcile();
      } finally {
        await registry.close();
      }

      expect([...events].sort()).toEqual(['delta/1.json', 'delta/2.json']);
    });

    // Passes far apart on a controlled clock, so the 2 s tolerance cannot hide a
    // boundary that moved with an unrelated pass.
    const CLOCK_START_MS = 1_800_000_000_000;

    async function withClock<T>(run: (at: (offsetMs: number) => void) => Promise<T>): Promise<T> {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(CLOCK_START_MS);
      try {
        return await run((offsetMs) => vi.setSystemTime(CLOCK_START_MS + offsetMs));
      } finally {
        vi.useRealTimers();
      }
    }

    function writeTaskAt(team: string, name: string, offsetMs: number): void {
      const file = path.join(root, team, name);
      fs.writeFileSync(file, '{}');
      setMtime(file, CLOCK_START_MS + offsetMs);
    }

    it('replays a write made while the team was out of scope across unrelated passes', async () => {
      seedTaskFiles('beta', 5);
      ageDirectory('gamma', CLOCK_START_MS - HOUR_MS);
      ageDirectory('beta', CLOCK_START_MS - HOUR_MS);
      const events: string[] = [];
      const scoped = new Set(['alpha']);
      const registry = createTasksRegistry(scoped, events);
      await withClock(async (at) => {
        try {
          await registry.start();
          at(5_000);
          writeTaskAt('beta', '6.json', 5_000);
          // An unrelated team entering scope is a pass that changes the target set.
          at(20_000);
          scoped.add('gamma');
          await registry.requestReconcile();
          expect(events).toEqual([]);
          at(40_000);
          scoped.add('beta');
          await registry.requestReconcile();
        } finally {
          await registry.close();
        }
      });

      expect(events).toEqual(['beta/6.json']);
    });

    it('replays only files written after a team left the scope', async () => {
      seedTaskFiles('beta', 5);
      ageDirectory('gamma', CLOCK_START_MS - HOUR_MS);
      ageDirectory('beta', CLOCK_START_MS - HOUR_MS);
      const events: string[] = [];
      const scoped = new Set(['alpha', 'beta']);
      const registry = createTasksRegistry(scoped, events);
      await withClock(async (at) => {
        try {
          await registry.start();
          // Written while watched: delivered live, so it must not be replayed.
          at(5_000);
          writeTaskAt('beta', '6.json', 5_000);
          at(10_000);
          scoped.delete('beta');
          await registry.requestReconcile();
          expect(latestTargets()).not.toContain(path.normalize(path.join(root, 'beta')));
          at(15_000);
          writeTaskAt('beta', '7.json', 15_000);
          at(20_000);
          scoped.add('gamma');
          await registry.requestReconcile();
          at(30_000);
          scoped.add('beta');
          await registry.requestReconcile();
        } finally {
          await registry.close();
        }
      });

      expect(events).toEqual(['beta/7.json']);
    });

    it('treats the 2 s tolerance as an inclusive boundary on the file mtime', async () => {
      const startMs = 1_800_000_000_000;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(startMs);
      try {
        const files: [string, number][] = [
          ['inside.json', startMs - 1_000],
          ['tie.json', startMs - 2_000],
          ['outside.json', startMs - 3_000],
        ];
        for (const [name, mtimeMs] of files) {
          fs.writeFileSync(path.join(root, 'beta', name), '{}');
          setMtime(path.join(root, 'beta', name), mtimeMs);
        }
        setMtime(path.join(root, 'beta', 'config.json'), startMs - HOUR_MS);

        const events: string[] = [];
        const scoped = new Set(['alpha']);
        const registry = createTasksRegistry(scoped, events);
        try {
          await registry.start();
          scoped.add('beta');
          await registry.requestReconcile();
        } finally {
          await registry.close();
        }

        expect([...events].sort()).toEqual(['beta/inside.json', 'beta/tie.json']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps replaying every team-root and inbox file regardless of age', async () => {
      ageDirectory('beta');
      ageDirectory(path.join('beta', 'inboxes'));
      fs.writeFileSync(path.join(root, 'beta', 'inboxes', 'fresh.json'), '[]');
      const events: string[] = [];
      const artifactScoped = new Set(['alpha']);
      const inboxScoped = new Set(['alpha']);
      const registry = new TeamTaskWatchRegistry({
        kind: 'teams',
        rootPath: root,
        onChange: (_eventType, relativePath) => events.push(relativePath),
        onError: () => {},
        getScopedTeamNames: () => artifactScoped,
        getScopedInboxTeamNames: () => inboxScoped,
      });
      try {
        await registry.start();
        artifactScoped.add('beta');
        inboxScoped.add('beta');
        await registry.requestReconcile();
      } finally {
        await registry.close();
      }

      expect(events).toEqual(
        expect.arrayContaining([
          'beta/config.json',
          'beta/inboxes/team-lead.json',
          'beta/inboxes/fresh.json',
        ])
      );
    });
  });

  it('backfills existing inbox files when a live team enters inbox scope', async () => {
    const artifactScoped = new Set<string>(['alpha', 'beta']);
    const inboxScoped = new Set<string>(['alpha']);
    const events: Array<{ eventType: string; relativePath: string }> = [];
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: (eventType, relativePath) => {
        events.push({ eventType, relativePath });
      },
      onError: () => {},
      getScopedTeamNames: () => artifactScoped,
      getScopedInboxTeamNames: () => inboxScoped,
    });
    await registry.start();
    expect(latestTargets()).not.toContain(path.normalize(path.join(root, 'beta', 'inboxes')));
    expect(events).toEqual([]);

    inboxScoped.add('beta');
    await registry.requestReconcile();

    await registry.close();
    expect(latestTargets()).toContain(path.normalize(path.join(root, 'beta', 'inboxes')));
    expect(events).toContainEqual({
      eventType: 'add',
      // The registry always emits forward-slash relative paths (see toRelativePath).
      relativePath: 'beta/inboxes/team-lead.json',
    });
  });

  it('recovers provisioning inboxes before ready without replaying historical teams', async () => {
    let nowMs = 0;
    setAliveTeamsProvider(() => []);
    const events: string[] = [];
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: (_eventType, relativePath) => events.push(relativePath),
      onError: () => {},
      getScopedTeamNames: () => computeTeamWatchScope(nowMs),
      getScopedInboxTeamNames: () => computeLiveTeamWatchScope(nowMs),
    });
    try {
      await registry.start();
      markTeamEngaged('beta', nowMs);
      await registry.requestReconcile();
      expect(events).toContain('beta/inboxes/team-lead.json');
      expect(events.some((event) => /^(alpha|gamma)\//.test(event))).toBe(false);
      const deliveredCount = events.length;
      await registry.requestReconcile();
      expect(events).toHaveLength(deliveredCount);

      nowMs = 5 * 60_000 + 1;
      await registry.requestReconcile();
      expect(latestTargets()).not.toContain(path.join(root, 'beta', 'inboxes'));
    } finally {
      await registry.close();
    }
  });

  it('backfills only explicitly scoped live inboxes on initial startup', async () => {
    const events: Array<{ eventType: string; relativePath: string }> = [];
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: (eventType, relativePath) => {
        events.push({ eventType, relativePath });
      },
      onError: () => {},
      getScopedTeamNames: () => new Set(['alpha', 'beta']),
      getScopedInboxTeamNames: () => new Set(['alpha']),
      backfillInitialScopedInboxFiles: true,
    });

    await registry.start();
    chokidarMock.instances.at(-1)?.emit('ready');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await registry.close();

    expect(events).toEqual([
      {
        eventType: 'add',
        // The registry always emits forward-slash relative paths (see toRelativePath).
        relativePath: 'alpha/inboxes/team-lead.json',
      },
    ]);
  });

  it('keeps the initial baseline silent when inbox scope falls back to all teams', async () => {
    const onChange = vi.fn();
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange,
      onError: () => {},
      getScopedInboxTeamNames: () => null,
      backfillInitialScopedInboxFiles: true,
    });

    await registry.start();
    chokidarMock.instances.at(-1)?.emit('ready');
    await registry.close();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('suspendTeam keeps a team out of reconciles until resumeTeam', async () => {
    setPlatform('win32');
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
    });
    await registry.start();
    expect(latestTargets()).toContain(path.normalize(path.join(root, 'alpha')));

    await expect(registry.suspendTeam('alpha')).resolves.toBe(true);
    let targets = latestTargets();
    expect(targets).not.toContain(path.normalize(path.join(root, 'alpha')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'alpha', 'inboxes')));
    expect(targets).toContain(path.normalize(path.join(root, 'beta')));

    // A reconcile while suspended must not re-add the team.
    await registry.requestReconcile();
    expect(latestTargets()).not.toContain(path.normalize(path.join(root, 'alpha')));

    await registry.resumeTeam('alpha');
    targets = latestTargets();
    await registry.close();
    expect(targets).toContain(path.normalize(path.join(root, 'alpha')));
    expect(targets).toContain(path.normalize(path.join(root, 'alpha', 'inboxes')));
  });

  it('suspendTeam reports false when the team holds no live watch targets', async () => {
    setPlatform('win32');
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
      getScopedTeamNames: () => new Set(['alpha']),
      getScopedInboxTeamNames: () => new Set(['alpha']),
    });
    await registry.start();
    const instancesAfterStart = chokidarMock.instances.length;

    await expect(registry.suspendTeam('gamma')).resolves.toBe(false);

    // Nothing was released, so nothing was torn down either.
    expect(chokidarMock.instances.length).toBe(instancesAfterStart);
    await registry.close();
  });

  it('closes the watcher instance on win32 so the directory handle is released', async () => {
    setPlatform('win32');
    const onChange = vi.fn();
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange,
      onError: () => {},
    });
    await registry.start();
    const firstWatcher = chokidarMock.instances.at(-1) as MockChokidarWatcher;

    await expect(registry.suspendTeam('alpha')).resolves.toBe(true);

    // chokidar's unwatch() leaves the ReadDirectoryChangesW handle open; only
    // closing the instance releases it, so the rebuild must be a new instance.
    expect(chokidarMock.instances.length).toBe(2);
    expect(firstWatcher.close).toHaveBeenCalledTimes(1);
    expect(chokidarMock.instances.at(-1)).not.toBe(firstWatcher);

    // A late event from the closing watcher must not be delivered.
    firstWatcher.emit('change', path.join(root, 'beta', 'config.json'));
    expect(onChange).not.toHaveBeenCalled();

    await registry.close();
  });

  it('does not replay the initial inbox backfill when a suspend rebuilds the watcher', async () => {
    setPlatform('win32');
    const events: Array<{ eventType: string; relativePath: string }> = [];
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: (eventType, relativePath) => {
        events.push({ eventType, relativePath });
      },
      onError: () => {},
      getScopedTeamNames: () => new Set(['alpha', 'beta']),
      getScopedInboxTeamNames: () => new Set(['alpha', 'beta']),
      backfillInitialScopedInboxFiles: true,
    });
    await registry.start();
    chokidarMock.instances.at(-1)?.emit('ready');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    events.length = 0;

    await expect(registry.suspendTeam('beta')).resolves.toBe(true);
    expect(chokidarMock.instances.length).toBe(2);
    // The rebuilt instance fires its own 'ready'. The initial scoped inbox
    // backfill is designed to run once, on the first watcher; replaying it here
    // would redeliver every live inbox message of every other team in the
    // middle of a delete.
    chokidarMock.instances.at(-1)?.emit('ready');
    await registry.resumeTeam('beta');
    await registry.close();

    expect(events.filter((event) => event.relativePath.startsWith('alpha/'))).toEqual([]);
  });

  it('unwatches in place without rebuilding the watcher off win32', async () => {
    setPlatform('darwin');
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
    });
    await registry.start();
    const firstWatcher = chokidarMock.instances.at(-1) as MockChokidarWatcher;

    await expect(registry.suspendTeam('alpha')).resolves.toBe(true);

    // inotify/kqueue drop their watch on unwatch and a POSIX rename ignores
    // open descriptors, so rebuilding would only re-open a descriptor for every
    // watched file of every other team.
    expect(chokidarMock.instances.length).toBe(1);
    expect(firstWatcher.close).not.toHaveBeenCalled();
    expect(latestTargets()).not.toContain(path.normalize(path.join(root, 'alpha')));
    expect(latestTargets()).toContain(path.normalize(path.join(root, 'beta')));

    await registry.close();
  });

  it('does not let a reconcile that started earlier re-watch the suspended team', async () => {
    setPlatform('win32');
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: vi.fn(),
      onError: vi.fn(),
    });
    await registry.start();
    const watchCallsBeforeSuspend = chokidarMock.watch.mock.calls.length;

    // Park a reconcile pass inside collectTargets, after it has already put
    // "alpha" in its target list. This is the pass the 30 s interval or a burst
    // of directory events starts on its own.
    let releaseReconcile!: () => void;
    statGate.hold = new Promise<void>((resolve) => {
      releaseReconcile = () => {
        statGate.hold = null;
        resolve();
      };
    });
    const parkedReconcile = registry.requestReconcile();
    await vi.waitFor(() => {
      expect(statGate.parked).toBe(true);
    });

    const suspend = registry.suspendTeam('alpha');
    setTimeout(releaseReconcile, 0);
    await suspend;

    // The parked pass has been applied by the time suspension resolves, and it
    // was applied without the suspended team: the caller renames
    // teams/alpha next, and on Windows a re-opened watch handle anywhere in
    // that tree turns the rename into an EPERM no retry can outlast.
    const rebuilt = watchedSince(watchCallsBeforeSuspend);
    expect(rebuilt).not.toHaveLength(0);
    expect(rebuilt).not.toContain(path.normalize(path.join(root, 'alpha')));
    expect(rebuilt).not.toContain(path.normalize(path.join(root, 'alpha', 'inboxes')));
    expect(rebuilt).toContain(path.normalize(path.join(root, 'beta')));

    await parkedReconcile;
    expect(watchedSince(watchCallsBeforeSuspend)).not.toContain(
      path.normalize(path.join(root, 'alpha'))
    );
    await registry.close();
  });

  it('coalesces a burst of addDir events into a single incremental watcher update', async () => {
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
    });
    await registry.start();
    const instancesAfterStart = chokidarMock.instances.length;
    const watcher = chokidarMock.instances.at(-1) as MockChokidarWatcher;

    // A new team dir appears, then a burst of addDir events fire for it.
    fs.mkdirSync(path.join(root, 'delta', 'inboxes'), { recursive: true });
    for (let i = 0; i < 4; i += 1) {
      watcher.emit('addDir', path.join(root, 'delta'));
    }

    // Wait past the debounce window for the single coalesced reconcile to run.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const finalTargets = latestTargets();
    await registry.close();

    // Coalesced into a single reconcile; the watcher is updated incrementally
    // (no teardown/recreate, so no new chokidar instance) and now includes the dir.
    expect(chokidarMock.instances.length).toBe(instancesAfterStart);
    expect(finalTargets).toContain(path.normalize(path.join(root, 'delta')));
  });
});

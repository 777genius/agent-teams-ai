import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

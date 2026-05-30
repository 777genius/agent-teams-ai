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

import { TeamTaskWatchRegistry } from '../../../../src/main/services/infrastructure/TeamTaskWatchRegistry';

function latestTargets(): string[] {
  const last = chokidarMock.instances.at(-1);
  return (last?.targets ?? []).map((t) => path.normalize(t));
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('watches only scoped team dirs but every team inbox (teams kind)', async () => {
    const registry = new TeamTaskWatchRegistry({
      kind: 'teams',
      rootPath: root,
      onChange: () => {},
      onError: () => {},
      getScopedTeamNames: () => new Set(['alpha']),
    });
    await registry.start();
    const targets = latestTargets();
    await registry.close();

    expect(targets).toContain(path.normalize(root));
    // scoped team root watched, unscoped team roots not watched
    expect(targets).toContain(path.normalize(path.join(root, 'alpha')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'beta')));
    expect(targets).not.toContain(path.normalize(path.join(root, 'gamma')));
    // ALL inboxes watched regardless of scope (cross-team delivery)
    expect(targets).toContain(path.normalize(path.join(root, 'alpha', 'inboxes')));
    expect(targets).toContain(path.normalize(path.join(root, 'beta', 'inboxes')));
    expect(targets).toContain(path.normalize(path.join(root, 'gamma', 'inboxes')));
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

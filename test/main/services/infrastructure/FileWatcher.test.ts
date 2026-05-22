import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FsType from 'fs';

type MockChokidarWatcher = {
  targets: string[];
  options: unknown;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  on: (event: string, handler: (...args: unknown[]) => void) => MockChokidarWatcher;
  close: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
};

const chokidarMock = vi.hoisted(() => {
  const instances: MockChokidarWatcher[] = [];

  const createWatchImplementation = () => (targets: string | string[], options: unknown) => {
    const watcher = {
      targets: (Array.isArray(targets) ? targets : [targets]).map((target) => String(target)),
      options,
      handlers: new Map<string, Array<(...args: unknown[]) => void>>(),
      close: vi.fn().mockResolvedValue(undefined),
      emit(event: string, ...args: unknown[]) {
        for (const handler of watcher.handlers.get(event) ?? []) {
          handler(...args);
        }
      },
    } as MockChokidarWatcher;

    watcher.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = watcher.handlers.get(event) ?? [];
      handlers.push(handler);
      watcher.handlers.set(event, handlers);
      return watcher;
    });

    instances.push(watcher);
    return watcher;
  };

  const watch = vi.fn(createWatchImplementation());

  return {
    instances,
    watch,
    createWatcher(targets: string | string[], options: unknown): MockChokidarWatcher {
      return createWatchImplementation()(targets, options);
    },
    reset() {
      instances.length = 0;
      watch.mockReset();
      watch.mockImplementation(createWatchImplementation());
    },
  };
});

vi.mock('chokidar', () => ({
  watch: chokidarMock.watch,
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    watch: vi.fn(),
    // Stash the real existsSync so tests can delegate to it for real file I/O
    __realExistsSync: actual.existsSync,
  };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    access: vi.fn(),
    // Stash the real access for tests with real files
    __realAccess: actual.access,
  };
});

vi.mock('../../../../src/main/services/error/ErrorDetector', () => ({
  errorDetector: {
    detectErrors: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../../src/main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({
      getConfig: () => ({
        notifications: { includeSubagentErrors: true, triggers: [] },
      }),
    }),
  },
}));

vi.mock('../../../../src/main/services/discovery/ProjectPathResolver', () => ({
  projectPathResolver: {
    invalidateProject: vi.fn(),
  },
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';

import { errorDetector } from '../../../../src/main/services/error/ErrorDetector';
import { DataCache } from '../../../../src/main/services/infrastructure/DataCache';
import { FileWatcher } from '../../../../src/main/services/infrastructure/FileWatcher';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import { OPENCODE_TASK_LOG_ATTRIBUTION_FILE } from '../../../../src/shared/constants/opencodeTaskLogAttribution';

function createFakeWatcher(): FsType.FSWatcher {
  const emitter = new EventEmitter() as EventEmitter & { close: () => void };
  emitter.close = vi.fn(() => {
    emitter.emit('close');
  });
  return emitter as unknown as FsType.FSWatcher;
}

function getChokidarWatcherForRoot(rootPath: string): MockChokidarWatcher {
  const normalizedRoot = path.normalize(rootPath);
  const watcher = [...chokidarMock.instances]
    .reverse()
    .find((instance) => instance.targets.includes(normalizedRoot));
  if (!watcher) {
    throw new Error(`Missing chokidar watcher for ${normalizedRoot}`);
  }
  return watcher;
}

function expectChokidarOptions(watcher: MockChokidarWatcher): void {
  expect(watcher.options).toEqual({
    ignoreInitial: true,
    ignorePermissionErrors: true,
    followSymlinks: false,
    depth: 0,
  });
}

/** Make existsSync delegate to the real implementation (needed for tests with real temp files) */
function useRealExistsSync() {
  const realFn = (fs as unknown as { __realExistsSync: typeof fs.existsSync }).__realExistsSync;
  vi.mocked(fs.existsSync).mockImplementation((p) => realFn(p));
}

function useRealAccess() {
  const realFn = (fsp as unknown as { __realAccess: typeof fsp.access }).__realAccess;
  vi.mocked(fsp.access).mockImplementation((p, mode) => realFn(p, mode));
}

function createMockNotificationManager() {
  return {
    addError: vi.fn().mockResolvedValue(null),
  } as unknown as Parameters<FileWatcher['setNotificationManager']>[0];
}

/** Helper to write a valid JSONL line */
function jsonlLine(uuid: string, text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    }) + '\n'
  );
}

describe('FileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chokidarMock.reset();
  });

  afterEach(() => {
    setClaudeBasePathOverride(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries and starts watchers when directories appear later', async () => {
    const dataCache = new DataCache(50, 10, false);
    let dirsAvailable = false;

    const accessMock = vi.mocked(fsp.access);
    accessMock.mockImplementation(async (targetPath) => {
      if ((targetPath === '/tmp/projects' || targetPath === '/tmp/todos') && dirsAvailable) {
        return;
      }
      throw new Error('ENOENT');
    });

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(watchMock).toHaveBeenCalledTimes(0);

    dirsAvailable = true;
    await vi.advanceTimersByTimeAsync(2000);

    expect(watchMock).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('recovers from watcher errors by re-registering affected watcher', async () => {
    const dataCache = new DataCache(50, 10, false);
    const projectWatcher = createFakeWatcher();
    const todoWatcher = createFakeWatcher();
    const replacementProjectWatcher = createFakeWatcher();

    const accessMock = vi.mocked(fsp.access);
    accessMock.mockImplementation(async (targetPath) => {
      if (targetPath === '/tmp/projects' || targetPath === '/tmp/todos') {
        return;
      }
      throw new Error('ENOENT');
    });

    const watchMock = vi.mocked(fs.watch);
    watchMock
      .mockImplementationOnce(() => projectWatcher)
      .mockImplementationOnce(() => todoWatcher)
      .mockImplementationOnce(() => replacementProjectWatcher);

    const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchMock).toHaveBeenCalledTimes(2);

    (projectWatcher as unknown as EventEmitter).emit('error', new Error('watch failed'));
    await vi.advanceTimersByTimeAsync(2000);

    expect(watchMock).toHaveBeenCalledTimes(3);
    watcher.stop();
  });

  it('falls back to teams polling when the chokidar registry hits the file descriptor limit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-team-emfile-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.writeFileSync(path.join(teamsDir, 'base-1', 'inboxes', 'user.json'), '[]', 'utf8');
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchersByPath = new Map<string, FsType.FSWatcher>([
      [projectsDir, createFakeWatcher()],
      [todosDir, createFakeWatcher()],
    ]);
    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation((targetPath) => {
      const watcherForPath = watchersByPath.get(String(targetPath));
      if (!watcherForPath) {
        throw new Error(`Unexpected watch path: ${String(targetPath)}`);
      }
      return watcherForPath;
    });

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);
    teamsWatcher.emit(
      'error',
      Object.assign(new Error('too many open files'), {
        code: 'EMFILE',
        path: path.join(teamsDir, 'base-1', 'inboxes'),
        syscall: 'scandir',
      })
    );
    await vi.advanceTimersByTimeAsync(0);

    const watcherAny = watcher as unknown as {
      retryTimer: NodeJS.Timeout | null;
      teamsPollingTimer: NodeJS.Timeout | null;
      teamsPollingPrimed: boolean;
    };
    expect(watcherAny.teamsPollingTimer).not.toBeNull();
    expect(watcherAny.retryTimer).toBeNull();
    await vi.waitFor(() => expect(watcherAny.teamsPollingPrimed).toBe(true));
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(teamsWatcher.close).toHaveBeenCalled();

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['ENOSPC', 'ERR_FS_WATCHER_LIMIT', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'])(
    'falls back to tasks polling when chokidar reports %s',
    async (code) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-task-limit-'));
      setClaudeBasePathOverride(tempDir);
      const projectsDir = path.join(tempDir, 'projects');
      const todosDir = path.join(tempDir, 'todos');
      const teamsDir = path.join(tempDir, 'teams');
      const tasksDir = path.join(tempDir, 'tasks');
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.mkdirSync(todosDir, { recursive: true });
      fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
      fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
      useRealAccess();

      const watchMock = vi.mocked(fs.watch);
      watchMock.mockImplementation(() => createFakeWatcher());

      const dataCache = new DataCache(50, 10, false);
      const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
      watcher.start();

      await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

      const tasksWatcher = getChokidarWatcherForRoot(tasksDir);
      tasksWatcher.emit('error', Object.assign(new Error(code), { code }));
      await vi.advanceTimersByTimeAsync(0);

      const watcherAny = watcher as unknown as {
        retryTimer: NodeJS.Timeout | null;
        tasksPollingTimer: NodeJS.Timeout | null;
      };
      expect(watcherAny.tasksPollingTimer).not.toBeNull();
      expect(watcherAny.retryTimer).toBeNull();
      expect(tasksWatcher.close).toHaveBeenCalled();

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  );

  it('falls back to polling when chokidar throws a known error during initial teams start', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-team-sync-limit-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());
    chokidarMock.watch.mockImplementation((targets, options) => {
      const targetList = Array.isArray(targets) ? targets : [targets];
      if (targetList.includes(path.normalize(teamsDir))) {
        throw Object.assign(new Error('watch limit'), { code: 'EMFILE' });
      }
      return chokidarMock.createWatcher(targets, options);
    });

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    watcher.start();

    await vi.waitFor(() => {
      const watcherAny = watcher as unknown as {
        retryTimer: NodeJS.Timeout | null;
        teamsPollingTimer: NodeJS.Timeout | null;
      };
      expect(watcherAny.teamsPollingTimer).not.toBeNull();
      expect(watcherAny.retryTimer).toBeNull();
    });

    expect(chokidarMock.watch).toHaveBeenCalledTimes(2);
    expect(getChokidarWatcherForRoot(tasksDir)).toBeTruthy();

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('retries chokidar registry after a non-limit error without enabling polling', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-team-nonlimit-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);
    teamsWatcher.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    await vi.advanceTimersByTimeAsync(0);

    const watcherAny = watcher as unknown as {
      retryTimer: NodeJS.Timeout | null;
      teamsPollingTimer: NodeJS.Timeout | null;
    };
    expect(watcherAny.teamsPollingTimer).toBeNull();
    expect(watcherAny.retryTimer).not.toBeNull();
    expect(teamsWatcher.close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(3));

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not allow the legacy env var to force teams and tasks polling', async () => {
    vi.stubEnv('AGENT_TEAMS_FILEWATCHER_TEAM_TASK_POLLING', '1');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-team-chokidar-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    watcher.start();

    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const watcherAny = watcher as unknown as {
      teamsPollingTimer: NodeJS.Timeout | null;
      tasksPollingTimer: NodeJS.Timeout | null;
    };
    expect(watcherAny.teamsPollingTimer).toBeNull();
    expect(watcherAny.tasksPollingTimer).toBeNull();
    expect(watchMock).not.toHaveBeenCalledWith(teamsDir, expect.anything(), expect.anything());
    expect(watchMock).not.toHaveBeenCalledWith(tasksDir, expect.anything(), expect.anything());
    expectChokidarOptions(getChokidarWatcherForRoot(teamsDir));
    expectChokidarOptions(getChokidarWatcherForRoot(tasksDir));

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits team and task changes from the chokidar registry with stable relative paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-events-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'config.json'));
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'inboxes', 'user.json'));
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'sentMessages.json'));
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'processes.json'));

    const tasksWatcher = getChokidarWatcherForRoot(tasksDir);
    tasksWatcher.emit('change', path.join(tasksDir, 'base-1', 'task-1.json'));

    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([
      { type: 'config', teamName: 'base-1', detail: 'config.json' },
      { type: 'inbox', teamName: 'base-1', detail: 'inboxes/user.json' },
      { type: 'inbox', teamName: 'base-1', detail: 'sentMessages.json' },
      { type: 'process', teamName: 'base-1', detail: 'processes.json' },
      { type: 'task', teamName: 'base-1', detail: 'task-1.json', taskId: 'task-1' },
    ]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits unlink events from the chokidar registry with the same relative path contract', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-unlink-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    getChokidarWatcherForRoot(teamsDir).emit(
      'unlink',
      path.join(teamsDir, 'base-1', 'config.json')
    );
    getChokidarWatcherForRoot(tasksDir).emit(
      'unlink',
      path.join(tasksDir, 'base-1', 'task-1.json')
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([
      { type: 'config', teamName: 'base-1', detail: 'config.json' },
      { type: 'task', teamName: 'base-1', detail: 'task-1.json', taskId: 'task-1' },
    ]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes relative chokidar paths and ignores paths outside the watched root', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-paths-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);
    teamsWatcher.emit('change', 'base-1/config.json');
    teamsWatcher.emit('change', path.join(tempDir, 'outside', 'base-2', 'config.json'));

    const tasksWatcher = getChokidarWatcherForRoot(tasksDir);
    tasksWatcher.emit('change', 'base-1/task-1.json');
    tasksWatcher.emit('change', path.join(tempDir, 'outside', 'base-2', 'task-2.json'));

    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([
      { type: 'config', teamName: 'base-1', detail: 'config.json' },
      { type: 'task', teamName: 'base-1', detail: 'task-1.json', taskId: 'task-1' },
    ]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not emit existing files from the initial chokidar registry baseline', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-baseline-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    fs.writeFileSync(path.join(teamsDir, 'base-1', 'config.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(teamsDir, 'base-1', 'inboxes', 'user.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(tasksDir, 'base-1', 'task-1.json'), '{}', 'utf8');
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits existing files once when reconciliation discovers new team and task directories', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-new-files-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    fs.mkdirSync(path.join(teamsDir, 'base-2', 'inboxes'), { recursive: true });
    fs.writeFileSync(path.join(teamsDir, 'base-2', 'config.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(teamsDir, 'base-2', 'inboxes', 'user.json'), '[]', 'utf8');
    fs.mkdirSync(path.join(tasksDir, 'base-2'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'base-2', 'task-2.json'), '{}', 'utf8');

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          { type: 'config', teamName: 'base-2', detail: 'config.json' },
          { type: 'inbox', teamName: 'base-2', detail: 'inboxes/user.json' },
          { type: 'task', teamName: 'base-2', detail: 'task-2.json', taskId: 'task-2' },
        ])
      );
    });

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits existing inbox files once when reconciliation discovers a new inbox directory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-new-inbox-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    const inboxDir = path.join(teamsDir, 'base-1', 'inboxes');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));
    expect(getChokidarWatcherForRoot(teamsDir).targets).not.toContain(path.normalize(inboxDir));

    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'user.json'), '[]', 'utf8');

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(getChokidarWatcherForRoot(teamsDir).targets).toContain(path.normalize(inboxDir));
      expect(events).toEqual([
        { type: 'inbox', teamName: 'base-1', detail: 'inboxes/user.json' },
      ]);
    });

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reconciles new team directories immediately after an addDir event', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-adddir-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    const addedTeamDir = path.join(teamsDir, 'base-2');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));
    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);

    fs.mkdirSync(addedTeamDir, { recursive: true });
    fs.writeFileSync(path.join(addedTeamDir, 'config.json'), '{}', 'utf8');
    teamsWatcher.emit('addDir', addedTeamDir);

    await vi.waitFor(() => {
      expect(chokidarMock.watch).toHaveBeenCalledTimes(3);
      expect(getChokidarWatcherForRoot(teamsDir).targets).toContain(path.normalize(addedTeamDir));
      expect(events).toEqual([{ type: 'config', teamName: 'base-2', detail: 'config.json' }]);
    });

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores events from an old chokidar generation after registry rebuild', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-generation-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));
    const oldTeamsWatcher = getChokidarWatcherForRoot(teamsDir);

    fs.mkdirSync(path.join(teamsDir, 'base-2'), { recursive: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(3));
    const newTeamsWatcher = getChokidarWatcherForRoot(teamsDir);
    expect(newTeamsWatcher).not.toBe(oldTeamsWatcher);

    oldTeamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'config.json'));
    newTeamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'config.json'));
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([{ type: 'config', teamName: 'base-1', detail: 'config.json' }]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores stale chokidar events after stop closes the registry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-stale-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);
    const tasksWatcher = getChokidarWatcherForRoot(tasksDir);
    watcher.stop();

    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'config.json'));
    tasksWatcher.emit('change', path.join(tasksDir, 'base-1', 'task-1.json'));
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([]);
    expect(teamsWatcher.close).toHaveBeenCalled();
    expect(tasksWatcher.close).toHaveBeenCalled();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates fresh chokidar registries after stop and start', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-restart-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));
    const oldTeamsWatcher = getChokidarWatcherForRoot(teamsDir);

    watcher.stop();
    watcher.start();
    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(4));
    const newTeamsWatcher = getChokidarWatcherForRoot(teamsDir);
    expect(newTeamsWatcher).not.toBe(oldTeamsWatcher);

    oldTeamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'config.json'));
    newTeamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'config.json'));
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([{ type: 'config', teamName: 'base-1', detail: 'config.json' }]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters irrelevant team and task registry events before they reach FileWatcher handlers', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-filter-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const teamsWatcher = getChokidarWatcherForRoot(teamsDir);
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'members', 'member.json'));
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', '.opencode-runtime', 'state.json'));
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'runtime', 'runtime.json'));
    teamsWatcher.emit('change', path.join(teamsDir, 'base-1', 'notes.json'));
    teamsWatcher.emit('addDir', path.join(teamsDir, 'base-1', 'members'));

    const tasksWatcher = getChokidarWatcherForRoot(tasksDir);
    tasksWatcher.emit('change', path.join(tasksDir, 'base-1', '.lock'));
    tasksWatcher.emit('change', path.join(tasksDir, 'base-1', '.highwatermark'));
    tasksWatcher.emit('change', path.join(tasksDir, 'base-1', 'notes.txt'));
    tasksWatcher.emit('change', path.join(tasksDir, 'base-1', 'nested', 'task.json'));

    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps the teams registry shallow and excludes irrelevant runtime directories', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-scope-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    const teamDir = path.join(teamsDir, 'base-1');
    const inboxDir = path.join(teamDir, 'inboxes');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(path.join(teamDir, 'members'), { recursive: true });
    fs.mkdirSync(path.join(teamDir, '.opencode-runtime'), { recursive: true });
    fs.mkdirSync(path.join(teamDir, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));

    const targets = getChokidarWatcherForRoot(teamsDir).targets;
    expect(targets).toContain(path.normalize(teamsDir));
    expect(targets).toContain(path.normalize(teamDir));
    expect(targets).toContain(path.normalize(inboxDir));
    expect(targets).not.toContain(path.normalize(path.join(teamDir, 'members')));
    expect(targets).not.toContain(path.normalize(path.join(teamDir, '.opencode-runtime')));
    expect(targets).not.toContain(path.normalize(path.join(teamDir, 'runtime')));

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reconciles new and removed team inbox directories without content polling', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-chokidar-reconcile-'));
    setClaudeBasePathOverride(tempDir);
    const projectsDir = path.join(tempDir, 'projects');
    const todosDir = path.join(tempDir, 'todos');
    const teamsDir = path.join(tempDir, 'teams');
    const tasksDir = path.join(tempDir, 'tasks');
    const addedTeamDir = path.join(teamsDir, 'base-2');
    const addedInboxDir = path.join(addedTeamDir, 'inboxes');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(todosDir, { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'base-1', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'base-1'), { recursive: true });
    useRealAccess();

    const watchMock = vi.mocked(fs.watch);
    watchMock.mockImplementation(() => createFakeWatcher());

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, projectsDir, todosDir);
    watcher.start();

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(2));
    expect(getChokidarWatcherForRoot(teamsDir).targets).not.toContain(path.normalize(addedTeamDir));

    fs.mkdirSync(addedInboxDir, { recursive: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(getChokidarWatcherForRoot(teamsDir).targets).toContain(path.normalize(addedInboxDir))
    );

    fs.rmSync(addedTeamDir, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(getChokidarWatcherForRoot(teamsDir).targets).not.toContain(
        path.normalize(addedTeamDir)
      )
    );

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits team inbox changes from the teams polling fallback', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-team-poll-'));
    setClaudeBasePathOverride(tempDir);
    const teamsDir = path.join(tempDir, 'teams');
    const inboxDir = path.join(teamsDir, 'base-1', 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    const inboxPath = path.join(inboxDir, 'user.json');
    fs.writeFileSync(inboxPath, '[]', 'utf8');

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(
      dataCache,
      path.join(tempDir, 'projects'),
      path.join(tempDir, 'todos')
    );
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));

    const watcherAny = watcher as unknown as {
      isWatching: boolean;
      pollTeamsForChanges: () => Promise<void>;
    };
    watcherAny.isWatching = true;
    await watcherAny.pollTeamsForChanges();
    expect(events).toEqual([]);

    fs.writeFileSync(inboxPath, '[{"messageId":"m1"}]', 'utf8');
    await watcherAny.pollTeamsForChanges();
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([{ type: 'inbox', teamName: 'base-1', detail: 'inboxes/user.json' }]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits task changes from the tasks polling fallback', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-task-poll-'));
    setClaudeBasePathOverride(tempDir);
    const taskDir = path.join(tempDir, 'tasks', 'base-1');
    fs.mkdirSync(taskDir, { recursive: true });
    const taskPath = path.join(taskDir, 'task-1.json');
    fs.writeFileSync(taskPath, '{"status":"queued"}', 'utf8');

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(
      dataCache,
      path.join(tempDir, 'projects'),
      path.join(tempDir, 'todos')
    );
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));

    const watcherAny = watcher as unknown as {
      isWatching: boolean;
      pollTasksForChanges: () => Promise<void>;
    };
    watcherAny.isWatching = true;
    await watcherAny.pollTasksForChanges();
    expect(events).toEqual([]);

    fs.writeFileSync(taskPath, '{"status":"running"}', 'utf8');
    await watcherAny.pollTasksForChanges();
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual([
      { type: 'task', teamName: 'base-1', detail: 'task-1.json', taskId: 'task-1' },
    ]);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits log-source-change when OpenCode task-log attribution manifest changes', () => {
    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));

    (
      watcher as unknown as {
        processTeamsChange: (eventType: string, filename: string) => void;
      }
    ).processTeamsChange('change', `team-a/${OPENCODE_TASK_LOG_ATTRIBUTION_FILE}`);

    expect(events).toEqual([
      {
        type: 'log-source-change',
        teamName: 'team-a',
        detail: OPENCODE_TASK_LOG_ATTRIBUTION_FILE,
      },
    ]);
  });

  it('emits config team-change events for team and members metadata changes', () => {
    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');
    const events: unknown[] = [];
    watcher.on('team-change', (event) => events.push(event));

    const testWatcher = watcher as unknown as {
      processTeamsChange: (eventType: string, filename: string) => void;
    };
    testWatcher.processTeamsChange('change', 'team-a/team.meta.json');
    testWatcher.processTeamsChange('change', 'team-a/members.meta.json');

    expect(events).toEqual([
      { type: 'config', teamName: 'team-a', detail: 'team.meta.json' },
      { type: 'config', teamName: 'team-a', detail: 'members.meta.json' },
    ]);
  });

  it('keeps append offset pinned for partial trailing lines until completed', async () => {
    vi.useRealTimers();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-'));
    const filePath = path.join(tempDir, 'session.jsonl');
    const firstLine = jsonlLine('a1', 'hi');
    fs.writeFileSync(filePath, firstLine, 'utf8');

    const dataCache = new DataCache(50, 10, false);
    const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');

    const firstPass = await (
      watcher as unknown as {
        parseAppendedMessages: (
          targetPath: string,
          startOffset: number
        ) => Promise<{ parsedLineCount: number; consumedBytes: number }>;
      }
    ).parseAppendedMessages(filePath, 0);
    expect(firstPass.parsedLineCount).toBe(1);
    expect(firstPass.consumedBytes).toBe(Buffer.byteLength(firstLine, 'utf8'));

    const partialSuffix =
      '{"type":"assistant","uuid":"a2","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"partial"';
    fs.appendFileSync(filePath, partialSuffix, 'utf8');

    const partialPass = await (
      watcher as unknown as {
        parseAppendedMessages: (
          targetPath: string,
          startOffset: number
        ) => Promise<{ parsedLineCount: number; consumedBytes: number }>;
      }
    ).parseAppendedMessages(filePath, firstPass.consumedBytes);
    expect(partialPass.parsedLineCount).toBe(0);
    expect(partialPass.consumedBytes).toBe(0);

    const completion = '}]}}\n';
    fs.appendFileSync(filePath, completion, 'utf8');

    const completedPass = await (
      watcher as unknown as {
        parseAppendedMessages: (
          targetPath: string,
          startOffset: number
        ) => Promise<{ parsedLineCount: number; consumedBytes: number }>;
      }
    ).parseAppendedMessages(filePath, firstPass.consumedBytes);
    expect(completedPass.parsedLineCount).toBe(1);
    expect(completedPass.consumedBytes).toBeGreaterThan(0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pins fallback processed size to the last complete line until a trailing JSON object is completed', async () => {
    vi.useRealTimers();
    useRealExistsSync();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-fallback-partial-'));
    const projectsDir = path.join(tempDir, 'projects');
    const projectDir = path.join(projectsDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, 'session-1.jsonl');
    const firstLine = jsonlLine('u1', 'hello');
    const partialSuffix =
      '{"type":"assistant","uuid":"u2","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"partial"';
    fs.writeFileSync(filePath, firstLine + partialSuffix, 'utf8');

    const dataCache = new DataCache(50, 10, false);
    const notificationManager = createMockNotificationManager();
    const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
    watcher.setNotificationManager(notificationManager);

    vi.mocked(errorDetector.detectErrors).mockClear();
    vi.mocked(errorDetector.detectErrors).mockResolvedValue([]);

    const watcherAny = watcher as unknown as {
      detectErrorsInSessionFile: (
        projectId: string,
        sessionId: string,
        filePath: string
      ) => Promise<void>;
      lastProcessedLineCount: Map<string, number>;
      lastProcessedSize: Map<string, number>;
      instanceCreatedAt: number;
    };
    watcherAny.instanceCreatedAt = 0;

    await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

    expect(errorDetector.detectErrors).toHaveBeenCalledTimes(1);
    expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(1);
    expect(watcherAny.lastProcessedSize.get(filePath)).toBe(Buffer.byteLength(firstLine, 'utf8'));

    fs.appendFileSync(filePath, '}]}}\n', 'utf8');
    await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

    expect(errorDetector.detectErrors).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(errorDetector.detectErrors).mock.calls[1];
    expect(secondCallArgs?.[0]).toHaveLength(1);
    expect(secondCallArgs?.[0][0]?.uuid).toBe('u2');
    expect(watcherAny.lastProcessedSize.get(filePath)).toBe(fs.statSync(filePath).size);

    watcher.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Catch-Up Scan Tests
  // ===========================================================================

  describe('catch-up scan', () => {
    it('detects file growth missed by fs.watch', async () => {
      vi.useRealTimers();
      useRealExistsSync();
      vi.mocked(errorDetector.detectErrors).mockResolvedValue([]);

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-catchup-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'session-1.jsonl');
      const line1 = jsonlLine('u1', 'hello');
      fs.writeFileSync(filePath, line1, 'utf8');

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      // Simulate having previously processed the file by directly setting tracking state
      const watcherAny = watcher as unknown as {
        isWatching: boolean;
        lastProcessedLineCount: Map<string, number>;
        lastProcessedSize: Map<string, number>;
        activeSessionFiles: Map<
          string,
          { projectId: string; sessionId: string; lastObservedAt: number }
        >;
        runCatchUpScan: () => Promise<void>;
      };
      const initialSize = fs.statSync(filePath).size;
      watcherAny.isWatching = true;
      watcherAny.lastProcessedLineCount.set(filePath, 1);
      watcherAny.lastProcessedSize.set(filePath, initialSize);
      watcherAny.activeSessionFiles.set(filePath, {
        projectId: 'test-project',
        sessionId: 'session-1',
        lastObservedAt: Date.now(),
      });

      // Append new data WITHOUT triggering fs.watch (simulating a missed event)
      const line2 = jsonlLine('u2', 'world');
      fs.appendFileSync(filePath, line2, 'utf8');

      // Run catch-up scan manually
      await watcherAny.runCatchUpScan();

      // The error detector should have been called with the new message
      expect(errorDetector.detectErrors).toHaveBeenCalled();
      const calls = vi.mocked(errorDetector.detectErrors).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toBe('session-1');
      expect(lastCall[2]).toBe('test-project');

      // Verify tracking state was updated
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(2);
      expect(watcherAny.lastProcessedSize.get(filePath)).toBeGreaterThan(initialSize);

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('skips files with no size change', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-noop-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'session-1.jsonl');
      const line1 = jsonlLine('u1', 'hello');
      fs.writeFileSync(filePath, line1, 'utf8');

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      const watcherAny = watcher as unknown as {
        isWatching: boolean;
        lastProcessedLineCount: Map<string, number>;
        lastProcessedSize: Map<string, number>;
        activeSessionFiles: Map<
          string,
          { projectId: string; sessionId: string; lastObservedAt: number }
        >;
        runCatchUpScan: () => Promise<void>;
      };
      const currentSize = fs.statSync(filePath).size;
      watcherAny.isWatching = true;
      watcherAny.lastProcessedLineCount.set(filePath, 1);
      watcherAny.lastProcessedSize.set(filePath, currentSize);
      watcherAny.activeSessionFiles.set(filePath, {
        projectId: 'test-project',
        sessionId: 'session-1',
        lastObservedAt: Date.now(),
      });

      vi.mocked(errorDetector.detectErrors).mockClear();

      // Run catch-up scan without any file changes
      await watcherAny.runCatchUpScan();

      // Error detector should NOT have been called since file hasn't changed
      expect(errorDetector.detectErrors).not.toHaveBeenCalled();

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('removes stale files older than 1 hour from active tracking', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-stale-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'old-session.jsonl');
      fs.writeFileSync(filePath, jsonlLine('u1', 'old'), 'utf8');

      // Set file mtime to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(filePath, twoHoursAgo, twoHoursAgo);

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      const watcherAny = watcher as unknown as {
        isWatching: boolean;
        activeSessionFiles: Map<
          string,
          { projectId: string; sessionId: string; lastObservedAt: number }
        >;
        lastProcessedSize: Map<string, number>;
        runCatchUpScan: () => Promise<void>;
      };
      watcherAny.isWatching = true;
      watcherAny.activeSessionFiles.set(filePath, {
        projectId: 'test-project',
        sessionId: 'old-session',
        lastObservedAt: Date.now(),
      });
      watcherAny.lastProcessedSize.set(filePath, 0);

      await watcherAny.runCatchUpScan();

      // Stale file should be removed from active tracking
      expect(watcherAny.activeSessionFiles.has(filePath)).toBe(false);

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('handles deleted files gracefully during catch-up scan', async () => {
      vi.useRealTimers();

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');
      watcher.setNotificationManager(notificationManager);

      const filePath = '/tmp/projects/test-project/nonexistent.jsonl';

      const watcherAny = watcher as unknown as {
        isWatching: boolean;
        activeSessionFiles: Map<
          string,
          { projectId: string; sessionId: string; lastObservedAt: number }
        >;
        lastProcessedSize: Map<string, number>;
        lastProcessedLineCount: Map<string, number>;
        runCatchUpScan: () => Promise<void>;
      };
      watcherAny.isWatching = true;
      watcherAny.activeSessionFiles.set(filePath, {
        projectId: 'test-project',
        sessionId: 'nonexistent',
        lastObservedAt: Date.now(),
      });
      watcherAny.lastProcessedSize.set(filePath, 100);
      watcherAny.lastProcessedLineCount.set(filePath, 5);

      // Should not throw
      await watcherAny.runCatchUpScan();

      // Deleted file should be cleaned up
      expect(watcherAny.activeSessionFiles.has(filePath)).toBe(false);
      expect(watcherAny.lastProcessedSize.has(filePath)).toBe(false);
      expect(watcherAny.lastProcessedLineCount.has(filePath)).toBe(false);

      watcher.stop();
    });

    it('retires catch-up files after repeated stat timeouts', async () => {
      vi.useRealTimers();
      vi.mocked(errorDetector.detectErrors).mockClear();

      const fsProvider = {
        type: 'local' as const,
        exists: vi.fn().mockResolvedValue(true),
        readFile: vi.fn().mockResolvedValue(''),
        stat: vi.fn().mockRejectedValue(new Error('stat timeout')),
        readdir: vi.fn().mockResolvedValue([]),
        createReadStream: vi.fn(() => Readable.from([])),
        dispose: vi.fn(),
      };

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(
        dataCache,
        '/watch-root/projects',
        '/watch-root/todos',
        fsProvider
      );
      watcher.setNotificationManager(notificationManager);

      const filePath = '/watch-root/projects/test-project/session-timeout.jsonl';
      const watcherAny = watcher as unknown as {
        isWatching: boolean;
        activeSessionFiles: Map<
          string,
          { projectId: string; sessionId: string; lastObservedAt: number }
        >;
        catchUpStatFailures: Map<string, number>;
        lastProcessedSize: Map<string, number>;
        lastProcessedLineCount: Map<string, number>;
        runCatchUpScan: () => Promise<void>;
      };
      watcherAny.isWatching = true;
      watcherAny.activeSessionFiles.set(filePath, {
        projectId: 'test-project',
        sessionId: 'session-timeout',
        lastObservedAt: Date.now(),
      });
      watcherAny.lastProcessedSize.set(filePath, 100);
      watcherAny.lastProcessedLineCount.set(filePath, 5);

      await watcherAny.runCatchUpScan();
      expect(watcherAny.activeSessionFiles.has(filePath)).toBe(true);
      expect(watcherAny.catchUpStatFailures.get(filePath)).toBe(1);

      await watcherAny.runCatchUpScan();
      expect(watcherAny.activeSessionFiles.has(filePath)).toBe(true);
      expect(watcherAny.catchUpStatFailures.get(filePath)).toBe(2);

      await watcherAny.runCatchUpScan();
      expect(watcherAny.activeSessionFiles.has(filePath)).toBe(false);
      expect(watcherAny.catchUpStatFailures.has(filePath)).toBe(false);
      expect(watcherAny.lastProcessedSize.get(filePath)).toBe(100);
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(5);
      expect(errorDetector.detectErrors).not.toHaveBeenCalled();

      watcher.stop();
    });
  });

  // ===========================================================================
  // Concurrency Guard Tests
  // ===========================================================================

  describe('concurrency guard', () => {
    it('prevents concurrent processing of the same file', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-concurrent-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'session-1.jsonl');
      fs.writeFileSync(filePath, jsonlLine('u1', 'hello'), 'utf8');

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      // Make detectErrors slow to simulate long processing
      let detectResolve: () => void;
      const detectPromise = new Promise<void>((resolve) => {
        detectResolve = resolve;
      });

      const watcherAny = watcher as unknown as {
        detectErrorsInSessionFile: (
          projectId: string,
          sessionId: string,
          filePath: string
        ) => Promise<void>;
        processingInProgress: Set<string>;
        pendingReprocess: Set<string>;
        instanceCreatedAt: number;
      };
      // Ensure watcher treats the file as pre-existing so first call baselines
      watcherAny.instanceCreatedAt = Date.now() + 60_000;

      // First call establishes baseline (skips error detection on first read)
      vi.mocked(errorDetector.detectErrors).mockResolvedValue([]);
      await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

      // Append new data so subsequent calls have new lines to process
      fs.appendFileSync(filePath, jsonlLine('u2', 'world'));

      // Now make detectErrors slow to simulate long processing
      vi.mocked(errorDetector.detectErrors).mockImplementation(
        () =>
          new Promise((resolve) => {
            detectPromise.then(() => resolve([]));
          })
      );

      // Start call that will block on detectErrors (not first read anymore)
      const first = watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

      // Wait a tick so the first call enters the processing block and reaches detectErrors
      await new Promise((r) => setTimeout(r, 50));

      // Verify the file is marked as processing
      expect(watcherAny.processingInProgress.has(filePath)).toBe(true);

      // Second call should be deferred (returns immediately)
      const second = watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);
      await second;

      // Verify pending reprocess was set
      expect(watcherAny.pendingReprocess.has(filePath)).toBe(true);

      // Resolve the slow detectErrors
      detectResolve!();
      await first;

      // After first completes, pending reprocess triggers a re-run
      // Wait for the re-run to complete
      await new Promise((r) => setTimeout(r, 100));

      // pendingReprocess should be cleared after reprocessing
      expect(watcherAny.pendingReprocess.has(filePath)).toBe(false);
      expect(watcherAny.processingInProgress.has(filePath)).toBe(false);

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // Fallback Size Tracking Tests
  // ===========================================================================

  describe('lastProcessedSize in fallback path', () => {
    it('re-stats file after full parse to capture concurrent writes', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-size-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'session-1.jsonl');
      const line1 = jsonlLine('u1', 'hello');
      fs.writeFileSync(filePath, line1, 'utf8');

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      vi.mocked(errorDetector.detectErrors).mockResolvedValue([]);

      const watcherAny = watcher as unknown as {
        detectErrorsInSessionFile: (
          projectId: string,
          sessionId: string,
          filePath: string
        ) => Promise<void>;
        lastProcessedSize: Map<string, number>;
        lastProcessedLineCount: Map<string, number>;
        instanceCreatedAt: number;
      };
      // Treat file as new (created after watcher) so it goes through the full parse path
      watcherAny.instanceCreatedAt = 0;

      // First call - fallback path (no lastProcessedLineCount)
      await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

      // The lastProcessedSize should match the actual file size on disk
      const actualSize = fs.statSync(filePath).size;
      expect(watcherAny.lastProcessedSize.get(filePath)).toBe(actualSize);
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(1);

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // First-Read Baseline Tests (prevents old session error flooding)
  // ===========================================================================

  describe('first-read baseline behavior', () => {
    it('establishes baseline without detecting errors for pre-existing files', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-baseline-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'session-1.jsonl');
      // Write a file with multiple lines (simulating an existing session with errors)
      fs.writeFileSync(
        filePath,
        jsonlLine('u1', 'hello') + jsonlLine('u2', 'world') + jsonlLine('u3', 'error line'),
        'utf8'
      );

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      // Simulate watcher starting well after the file was created
      const watcherAny = watcher as unknown as {
        detectErrorsInSessionFile: (
          projectId: string,
          sessionId: string,
          filePath: string
        ) => Promise<void>;
        lastProcessedLineCount: Map<string, number>;
        lastProcessedSize: Map<string, number>;
        instanceCreatedAt: number;
      };
      watcherAny.instanceCreatedAt = Date.now() + 60_000; // watcher "started" in the future

      vi.mocked(errorDetector.detectErrors).mockClear();

      // First read should establish baseline, NOT detect errors
      await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

      // errorDetector.detectErrors should NOT have been called
      expect(errorDetector.detectErrors).not.toHaveBeenCalled();

      // Baseline tracking should be established
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(3);
      expect(watcherAny.lastProcessedSize.get(filePath)).toBe(fs.statSync(filePath).size);

      // notificationManager.addError should NOT have been called
      expect(notificationManager.addError).not.toHaveBeenCalled();

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('detects errors only in new data after baseline is established', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-post-baseline-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const filePath = path.join(projectDir, 'session-1.jsonl');
      // Initial content (old session data)
      fs.writeFileSync(filePath, jsonlLine('u1', 'hello') + jsonlLine('u2', 'world'), 'utf8');

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      // Simulate watcher starting well after the file was created
      const watcherAny = watcher as unknown as {
        detectErrorsInSessionFile: (
          projectId: string,
          sessionId: string,
          filePath: string
        ) => Promise<void>;
        lastProcessedLineCount: Map<string, number>;
        instanceCreatedAt: number;
      };
      watcherAny.instanceCreatedAt = Date.now() + 60_000;

      vi.mocked(errorDetector.detectErrors).mockClear();
      vi.mocked(errorDetector.detectErrors).mockResolvedValue([]);

      // First read: baseline only
      await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);
      expect(errorDetector.detectErrors).not.toHaveBeenCalled();
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(2);

      // Append new data
      fs.appendFileSync(filePath, jsonlLine('u3', 'new error'));

      // Second read: should detect errors in new data only
      await watcherAny.detectErrorsInSessionFile('test-project', 'session-1', filePath);

      expect(errorDetector.detectErrors).toHaveBeenCalledTimes(1);
      // Verify only the new message was passed to detectErrors
      const callArgs = vi.mocked(errorDetector.detectErrors).mock.calls[0];
      expect(callArgs[0]).toHaveLength(1); // only 1 new message

      // Tracking should now reflect all 3 lines
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(3);

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('detects errors immediately for files created after watcher startup', async () => {
      vi.useRealTimers();
      useRealExistsSync();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filewatcher-newfile-'));
      const projectsDir = path.join(tempDir, 'projects');
      const projectDir = path.join(projectsDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const dataCache = new DataCache(50, 10, false);
      const notificationManager = createMockNotificationManager();
      const watcher = new FileWatcher(dataCache, projectsDir, path.join(tempDir, 'todos'));
      watcher.setNotificationManager(notificationManager);

      vi.mocked(errorDetector.detectErrors).mockClear();
      vi.mocked(errorDetector.detectErrors).mockResolvedValue([]);

      // instanceCreatedAt is already set to "now" by the constructor,
      // and the file created below will have birthtimeMs >= instanceCreatedAt,
      // so it will be treated as a new file (no baseline skip)
      const filePath = path.join(projectDir, 'session-new.jsonl');
      fs.writeFileSync(filePath, jsonlLine('u1', 'hello') + jsonlLine('u2', 'error'), 'utf8');

      const watcherAny = watcher as unknown as {
        detectErrorsInSessionFile: (
          projectId: string,
          sessionId: string,
          filePath: string
        ) => Promise<void>;
        lastProcessedLineCount: Map<string, number>;
        instanceCreatedAt: number;
      };

      // Make the "new file after startup" case deterministic across filesystems
      // whose birthtime precision can differ on CI runners.
      watcherAny.instanceCreatedAt = 0;

      // First read of a NEW file should detect errors (not baseline-skip)
      await watcherAny.detectErrorsInSessionFile('test-project', 'session-new', filePath);

      expect(errorDetector.detectErrors).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(errorDetector.detectErrors).mock.calls[0];
      expect(callArgs[0]).toHaveLength(2); // all messages scanned
      expect(watcherAny.lastProcessedLineCount.get(filePath)).toBe(2);

      watcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // Timer Lifecycle Tests
  // ===========================================================================

  describe('timer lifecycle', () => {
    it('starts catch-up timer on start() and clears on stop()', () => {
      const dataCache = new DataCache(50, 10, false);

      vi.mocked(fsp.access).mockResolvedValue();
      vi.mocked(fs.watch).mockImplementation(() => createFakeWatcher());

      const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');

      const watcherAny = watcher as unknown as {
        catchUpTimer: NodeJS.Timeout | null;
      };

      expect(watcherAny.catchUpTimer).toBeNull();

      watcher.start();
      expect(watcherAny.catchUpTimer).not.toBeNull();

      watcher.stop();
      expect(watcherAny.catchUpTimer).toBeNull();
    });

    it('clears all tracking state on stop()', () => {
      const dataCache = new DataCache(50, 10, false);

      vi.mocked(fsp.access).mockResolvedValue();
      vi.mocked(fs.watch).mockImplementation(() => createFakeWatcher());

      const watcher = new FileWatcher(dataCache, '/tmp/projects', '/tmp/todos');

      const watcherAny = watcher as unknown as {
        activeSessionFiles: Map<string, unknown>;
        processingInProgress: Set<string>;
        pendingReprocess: Set<string>;
      };

      watcher.start();

      // Add some tracking state
      watcherAny.activeSessionFiles.set('/tmp/file.jsonl', {
        projectId: 'p',
        sessionId: 's',
      });
      watcherAny.processingInProgress.add('/tmp/file.jsonl');
      watcherAny.pendingReprocess.add('/tmp/file.jsonl');

      watcher.stop();

      expect(watcherAny.activeSessionFiles.size).toBe(0);
      expect(watcherAny.processingInProgress.size).toBe(0);
      expect(watcherAny.pendingReprocess.size).toBe(0);
    });
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const { withTeamBoardLock } = require('../src/internal/boardLock.js');
const taskStore = require('../src/internal/taskStore.js');

describe('taskStore validated scan snapshots', () => {
  const tempDirs = [];
  let cacheClockMs;
  let restoreTaskScanSnapshotCacheConfig;

  beforeEach(() => {
    cacheClockMs = 1_000;
    restoreTaskScanSnapshotCacheConfig = taskStore.configureTaskScanSnapshotCache({
      clock: () => cacheClockMs,
      ttlMs: 100,
      maxEntries: 32,
    });
  });

  afterEach(() => {
    restoreTaskScanSnapshotCacheConfig();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makePaths() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-test-'));
    const paths = {
      tasksDir: path.join(rootDir, 'tasks', 'test-team'),
      teamDir: path.join(rootDir, 'teams', 'test-team'),
    };
    tempDirs.push(rootDir);
    fs.mkdirSync(paths.tasksDir, { recursive: true });
    fs.mkdirSync(paths.teamDir, { recursive: true });
    return paths;
  }

  function makeTaskId(index) {
    const hex = Number(index).toString(16);
    return `${hex.padStart(8, '0')}-0000-4000-8000-${hex.padStart(12, '0')}`;
  }

  function writeTaskRow(paths, taskId, overrides = {}) {
    const task = {
      id: taskId,
      displayId: taskId.slice(0, 8),
      subject: `Task ${taskId.slice(0, 8)}`,
      description: `Description ${taskId.slice(0, 8)}`,
      status: 'pending',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      ...overrides,
    };
    fs.writeFileSync(
      path.join(paths.tasksDir, `${taskId}.json`),
      JSON.stringify(task, null, 2),
      'utf8'
    );
    return task;
  }

  function instrumentTaskScans(paths) {
    const tasksDir = path.resolve(paths.tasksDir);
    const originalReaddirSync = fs.readdirSync;
    const originalReadFileSync = fs.readFileSync;
    const originalJsonParse = JSON.parse;
    const counts = { readdir: 0, read: 0, parse: 0 };

    vi.spyOn(fs, 'readdirSync').mockImplementation(function instrumentedReaddir(filePath, ...args) {
      if (path.resolve(String(filePath)) === tasksDir) {
        counts.readdir += 1;
      }
      return originalReaddirSync.call(this, filePath, ...args);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation(function instrumentedRead(filePath, ...args) {
      const resolvedPath = path.resolve(String(filePath));
      if (resolvedPath.startsWith(`${tasksDir}${path.sep}`) && resolvedPath.endsWith('.json')) {
        counts.read += 1;
      }
      return originalReadFileSync.call(this, filePath, ...args);
    });
    vi.spyOn(JSON, 'parse').mockImplementation(function instrumentedParse(...args) {
      counts.parse += 1;
      return originalJsonParse.apply(this, args);
    });

    return counts;
  }

  function resetScanCounts(counts) {
    counts.readdir = 0;
    counts.read = 0;
    counts.parse = 0;
  }

  it('shares one validated full scan across nested reads in an outer board lock', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    const deletedId = makeTaskId(3);
    writeTaskRow(paths, firstId);
    writeTaskRow(paths, secondId);
    writeTaskRow(paths, deletedId, { status: 'deleted' });
    const counts = instrumentTaskScans(paths);

    withTeamBoardLock(paths, () => {
      expect(taskStore.readTask(paths, firstId).id).toBe(firstId);
      withTeamBoardLock(paths, () => {
        expect(taskStore.resolveTaskRef(paths, secondId.slice(0, 8))).toBe(secondId);
        expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual([firstId, secondId]);
        expect(taskStore.readTask(paths, firstId).subject).toBe('Task 00000001');
      });
    });

    expect(counts).toEqual({ readdir: 1, read: 3, parse: 3 });
  });

  it('shares one full scan across hot standalone get, list, and resolve reads inside the TTL', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    writeTaskRow(paths, firstId);
    writeTaskRow(paths, secondId);
    const counts = instrumentTaskScans(paths);

    expect(taskStore.readTask(paths, firstId).id).toBe(firstId);
    expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual([firstId, secondId]);
    expect(taskStore.resolveTaskRef(paths, secondId.slice(0, 8))).toBe(secondId);
    cacheClockMs += 99;
    expect(taskStore.readTask(paths, secondId).id).toBe(secondId);

    expect(counts).toEqual({ readdir: 1, read: 2, parse: 2 });
  });

  it('detects a cross-file identity collision on the first standalone lookup', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    writeTaskRow(paths, firstId);
    writeTaskRow(paths, secondId, { id: firstId });
    const counts = instrumentTaskScans(paths);

    expect(() => taskStore.readTask(paths, firstId)).toThrow('Task identity collision');

    expect(counts).toEqual({ readdir: 1, read: 2, parse: 2 });
  });

  it('invalidates the standalone snapshot immediately after its own write', () => {
    const paths = makePaths();
    const taskId = makeTaskId(1);
    writeTaskRow(paths, taskId);
    const counts = instrumentTaskScans(paths);

    expect(taskStore.readTask(paths, taskId).description).toBe('Description 00000001');
    taskStore.updateTaskFields(paths, taskId, { description: 'Fresh after own write' });
    expect(taskStore.readTask(paths, taskId).description).toBe('Fresh after own write');

    expect(counts).toEqual({ readdir: 2, read: 2, parse: 2 });
  });

  it('observes an equal-size external atomic replacement on the first read after TTL expiry', () => {
    const paths = makePaths();
    const taskId = makeTaskId(1);
    const originalTask = writeTaskRow(paths, taskId, { subject: 'before' });
    const taskPath = path.join(paths.tasksDir, `${taskId}.json`);
    const originalSize = fs.statSync(taskPath).size;
    const directoryStat = fs.statSync(paths.tasksDir);
    const counts = instrumentTaskScans(paths);

    expect(taskStore.readTask(paths, taskId).subject).toBe('before');

    const replacementPath = path.join(paths.tasksDir, '.external-replacement');
    fs.writeFileSync(
      replacementPath,
      JSON.stringify({ ...originalTask, subject: 'after!' }, null, 2),
      'utf8'
    );
    expect(fs.statSync(replacementPath).size).toBe(originalSize);
    fs.renameSync(replacementPath, taskPath);
    fs.utimesSync(paths.tasksDir, directoryStat.atime, directoryStat.mtime);

    expect(taskStore.readTask(paths, taskId).subject).toBe('before');
    cacheClockMs += 100;
    expect(taskStore.readTask(paths, taskId).subject).toBe('after!');

    expect(counts).toEqual({ readdir: 2, read: 2, parse: 2 });
  });

  it('detects a new cross-file duplicate on the first read after TTL expiry', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    writeTaskRow(paths, firstId);
    const secondTask = writeTaskRow(paths, secondId);
    const counts = instrumentTaskScans(paths);

    expect(taskStore.readTask(paths, firstId).id).toBe(firstId);

    const replacementPath = path.join(paths.tasksDir, '.external-duplicate');
    fs.writeFileSync(
      replacementPath,
      JSON.stringify({ ...secondTask, id: firstId }, null, 2),
      'utf8'
    );
    fs.renameSync(replacementPath, path.join(paths.tasksDir, `${secondId}.json`));

    expect(taskStore.readTask(paths, firstId).id).toBe(firstId);
    cacheClockMs += 100;
    expect(() => taskStore.readTask(paths, firstId)).toThrow('Task identity collision');

    expect(counts).toEqual({ readdir: 2, read: 4, parse: 4 });
  });

  it('keeps the shared snapshot LRU bounded and isolates cloned task and anomaly outputs', () => {
    restoreTaskScanSnapshotCacheConfig();
    restoreTaskScanSnapshotCacheConfig = taskStore.configureTaskScanSnapshotCache({
      clock: () => cacheClockMs,
      ttlMs: 100,
      maxEntries: 2,
    });
    const firstPaths = makePaths();
    const secondPaths = makePaths();
    const thirdPaths = makePaths();
    const firstId = makeTaskId(1);
    const mismatchId = makeTaskId(2);
    writeTaskRow(firstPaths, firstId, {
      comments: [{ id: 'comment-1', text: 'Original comment' }],
    });
    writeTaskRow(secondPaths, mismatchId, { id: makeTaskId(20) });
    writeTaskRow(thirdPaths, makeTaskId(3));
    const originalReaddirSync = fs.readdirSync;
    const readdirCounts = new Map();
    vi.spyOn(fs, 'readdirSync').mockImplementation(function countDirectoryScans(filePath, ...args) {
      const directory = path.resolve(String(filePath));
      readdirCounts.set(directory, (readdirCounts.get(directory) || 0) + 1);
      return originalReaddirSync.call(this, filePath, ...args);
    });

    const firstRows = taskStore.listTaskRows(firstPaths);
    firstRows.tasks[0].comments[0].text = 'Poisoned task clone';
    taskStore.readTask(secondPaths, mismatchId);
    const secondRows = taskStore.listTaskRows(secondPaths, { includeDeleted: true });
    secondRows.anomalies[0].detail = 'Poisoned anomaly clone';

    expect(
      taskStore.listTaskRows(secondPaths, { includeDeleted: true }).anomalies[0].detail
    ).toContain(`contains id "${makeTaskId(20)}"`);
    expect(taskStore.readTask(firstPaths, firstId).comments[0].text).toBe('Original comment');
    taskStore.readTask(thirdPaths, makeTaskId(3));
    taskStore.readTask(firstPaths, firstId);
    taskStore.readTask(secondPaths, mismatchId);

    expect(Object.fromEntries(readdirCounts)).toEqual({
      [path.resolve(firstPaths.tasksDir)]: 1,
      [path.resolve(secondPaths.tasksDir)]: 2,
      [path.resolve(thirdPaths.tasksDir)]: 1,
    });
  });

  it('invalidates immediately after a successful write so later reads rescan fresh rows', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    writeTaskRow(paths, firstId);
    writeTaskRow(paths, secondId);
    const counts = instrumentTaskScans(paths);

    withTeamBoardLock(paths, () => {
      expect(taskStore.readTask(paths, firstId).description).toBe('Description 00000001');
      taskStore.updateTaskFields(paths, firstId, { description: 'Fresh after write' });
      expect(taskStore.readTask(paths, firstId).description).toBe('Fresh after write');
      expect(taskStore.readTask(paths, secondId).id).toBe(secondId);
    });

    expect(counts).toEqual({ readdir: 2, read: 4, parse: 4 });
  });

  it('invalidates after a failed write attempt that may already have changed storage', () => {
    const paths = makePaths();
    const taskId = makeTaskId(1);
    writeTaskRow(paths, taskId);
    const counts = instrumentTaskScans(paths);
    const originalRenameSync = fs.renameSync;
    let failAfterPublishing = true;

    vi.spyOn(fs, 'renameSync').mockImplementation(function publishThenFail(source, target) {
      originalRenameSync.call(this, source, target);
      if (failAfterPublishing) {
        failAfterPublishing = false;
        throw new Error('injected failure after publishing task row');
      }
    });

    withTeamBoardLock(paths, () => {
      expect(taskStore.readTask(paths, taskId).description).toBe('Description 00000001');
      expect(() =>
        taskStore.updateTaskFields(paths, taskId, { description: 'Published before failure' })
      ).toThrow('injected failure after publishing task row');
      expect(taskStore.readTask(paths, taskId).description).toBe('Published before failure');
    });

    expect(counts).toEqual({ readdir: 2, read: 2, parse: 2 });
  });

  it('bounds TaskGet, update, link-related, and dependency scan counts on a 40-task board', () => {
    const paths = makePaths();
    const taskIds = Array.from({ length: 40 }, (_, index) => makeTaskId(index + 1));
    for (const taskId of taskIds) {
      writeTaskRow(paths, taskId);
    }
    const counts = instrumentTaskScans(paths);

    taskStore.readTask(paths, taskIds[0]);
    expect(counts).toEqual({ readdir: 1, read: 40, parse: 40 });
    resetScanCounts(counts);

    withTeamBoardLock(paths, () => {
      taskStore.readTask(paths, taskIds[0]);
      taskStore.updateTaskFields(paths, taskIds[0], { description: 'Updated' });
    });
    expect(counts).toEqual({ readdir: 1, read: 40, parse: 40 });
    resetScanCounts(counts);

    withTeamBoardLock(paths, () => taskStore.linkTask(paths, taskIds[0], taskIds[1], 'related'));
    expect(counts).toEqual({ readdir: 2, read: 80, parse: 80 });
    resetScanCounts(counts);

    withTeamBoardLock(paths, () => taskStore.linkTask(paths, taskIds[2], taskIds[1], 'blocked-by'));
    expect(counts).toEqual({ readdir: 2, read: 80, parse: 80 });
  });

  it('ends snapshot lifetime at outer lock exit and observes external identity changes', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    writeTaskRow(paths, firstId);
    writeTaskRow(paths, secondId);
    const counts = instrumentTaskScans(paths);

    withTeamBoardLock(paths, () => {
      expect(taskStore.readTask(paths, firstId).subject).toBe('Task 00000001');
      expect(taskStore.readTask(paths, firstId).subject).toBe('Task 00000001');
    });

    writeTaskRow(paths, secondId, { id: firstId, subject: 'External collision' });

    expect(() => withTeamBoardLock(paths, () => taskStore.readTask(paths, firstId))).toThrow(
      'Task identity collision'
    );
    expect(counts).toEqual({ readdir: 2, read: 4, parse: 4 });
  });

  it('isolates reflected storage identity and nested task data from the cached snapshot', () => {
    const paths = makePaths();
    const taskId = makeTaskId(1);
    writeTaskRow(paths, taskId, {
      comments: [{ id: 'comment-1', author: 'alice', text: 'Original comment' }],
    });

    withTeamBoardLock(paths, () => {
      const returnedTask = taskStore.readTask(paths, taskId);
      const identitySymbol = Object.getOwnPropertySymbols(returnedTask).find(
        (symbol) => symbol.description === 'taskStorageIdentity'
      );
      expect(identitySymbol).toBeDefined();
      const returnedIdentity = returnedTask[identitySymbol];

      expect(Object.isFrozen(returnedIdentity)).toBe(true);
      expect(Reflect.set(returnedIdentity, 'canonicalTaskId', 'poisoned-by-caller')).toBe(false);
      returnedTask.comments[0].text = 'Poisoned nested field';

      const laterTask = taskStore.readTask(paths, taskId);
      const laterIdentitySymbol = Object.getOwnPropertySymbols(laterTask).find(
        (symbol) => symbol.description === 'taskStorageIdentity'
      );
      expect(laterTask[laterIdentitySymbol]).not.toBe(returnedIdentity);
      expect(laterTask[laterIdentitySymbol].canonicalTaskId).toBe(taskId);
      expect(laterTask.comments[0].text).toBe('Original comment');

      expect(() =>
        taskStore.updateTaskFields(paths, taskId, { description: 'Valid after mutation attempt' })
      ).not.toThrow();
    });

    expect(taskStore.readTask(paths, taskId)).toMatchObject({
      id: taskId,
      description: 'Valid after mutation attempt',
    });
    expect(fs.existsSync(path.join(paths.tasksDir, 'poisoned-by-caller.json'))).toBe(false);
  });

  it('preserves canonical filename identity and rejects the mismatched persisted id', () => {
    const paths = makePaths();
    const canonicalId = makeTaskId(1);
    const persistedId = makeTaskId(2);
    writeTaskRow(paths, canonicalId, { id: persistedId, subject: 'Legacy mismatch' });

    withTeamBoardLock(paths, () => {
      expect(taskStore.readTask(paths, canonicalId)).toMatchObject({
        id: canonicalId,
        subject: 'Legacy mismatch',
      });
      expect(() => taskStore.readTask(paths, persistedId)).toThrow(
        `Non-canonical task reference "${persistedId}"`
      );
      taskStore.updateTaskFields(paths, canonicalId, { description: 'Canonical update' });
    });

    const persisted = JSON.parse(
      fs.readFileSync(path.join(paths.tasksDir, `${canonicalId}.json`), 'utf8')
    );
    expect(persisted).toMatchObject({ id: persistedId, description: 'Canonical update' });
    expect(fs.existsSync(path.join(paths.tasksDir, `${persistedId}.json`))).toBe(false);
  });

  it('fails closed for cross-file identity collisions', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    writeTaskRow(paths, firstId, { id: secondId });
    writeTaskRow(paths, secondId);

    withTeamBoardLock(paths, () => {
      expect(() => taskStore.readTask(paths, firstId)).toThrow('Task identity collision');
      expect(() => taskStore.readTask(paths, secondId)).toThrow('Task identity collision');
      expect(() =>
        taskStore.updateTaskFields(paths, firstId, { description: 'Unsafe update' })
      ).toThrow('Task identity collision');
    });
  });

  it('preserves display-id ambiguity and deleted filtering semantics', () => {
    const paths = makePaths();
    const firstId = makeTaskId(1);
    const secondId = makeTaskId(2);
    const deletedId = makeTaskId(3);
    writeTaskRow(paths, firstId, { displayId: 'shared' });
    writeTaskRow(paths, secondId, { displayId: 'shared' });
    writeTaskRow(paths, deletedId, { displayId: 'deleted-task', status: 'deleted' });

    withTeamBoardLock(paths, () => {
      expect(() => taskStore.readTask(paths, 'shared')).toThrow(
        'Ambiguous task reference "shared"'
      );
      expect(() => taskStore.readTask(paths, 'deleted-task')).toThrow(
        'Task not found: deleted-task'
      );
      expect(taskStore.readTask(paths, 'deleted-task', { includeDeleted: true }).id).toBe(
        deletedId
      );
      expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual([firstId, secondId]);
    });
  });
});

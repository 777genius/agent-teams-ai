import { EventEmitter } from 'events';
import type * as FsType from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { OPENCODE_TASK_LOG_ATTRIBUTION_FILE } from '../../../../src/shared/constants/opencodeTaskLogAttribution';

function createFakeWatcher(): FsType.FSWatcher {
  const emitter = new EventEmitter() as EventEmitter & { close: () => void };
  emitter.close = vi.fn(() => {
    emitter.emit('close');
  });
  return emitter as unknown as FsType.FSWatcher;
}

/** Make existsSync delegate to the real implementation (needed for tests with real temp files) */
function useRealExistsSync() {
  const realFn = (fs as unknown as { __realExistsSync: typeof fs.existsSync }).__realExistsSync;
  vi.mocked(fs.existsSync).mockImplementation((p) => realFn(p));
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
  });

  afterEach(() => {
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

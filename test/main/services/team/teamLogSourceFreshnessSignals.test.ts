import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeTaskLogFreshnessTaskId,
  getTaskFreshnessDirsForContext,
  getTeamTaskLogFreshnessDir,
  pushUniqueNormalizedPath,
  routeTaskFreshnessSignalChange,
} from '@main/services/team/teamLogSourceFreshnessSignals';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';

import type { TaskFreshnessSignalSink } from '@main/services/team/teamLogSourceFreshnessSignals';

function createSink(): TaskFreshnessSignalSink & {
  emitTaskLogChange: ReturnType<typeof vi.fn>;
  emitLogSourceChange: ReturnType<typeof vi.fn>;
} {
  return {
    emitTaskLogChange: vi.fn(),
    emitLogSourceChange: vi.fn(),
  };
}

const ROOT_DIR = path.resolve(path.sep, 'projects', 'demo');

describe('teamLogSourceFreshnessSignals', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  describe('pushUniqueNormalizedPath', () => {
    it('keeps only absolute paths and never repeats one', () => {
      const paths: string[] = [];
      pushUniqueNormalizedPath(paths, ROOT_DIR);
      pushUniqueNormalizedPath(paths, path.join(ROOT_DIR, 'nested', '..'));
      pushUniqueNormalizedPath(paths, path.join(ROOT_DIR, 'other'));
      pushUniqueNormalizedPath(paths, 'relative/path');
      pushUniqueNormalizedPath(paths, undefined);

      expect(paths).toEqual([ROOT_DIR, path.join(ROOT_DIR, 'other')]);
    });
  });

  describe('getTeamTaskLogFreshnessDir', () => {
    it('points at the team-scoped log freshness dir under the teams base path', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'log-source-freshness-signals-dir-'));
      setClaudeBasePathOverride(path.join(tempDir, '.claude'));

      expect(getTeamTaskLogFreshnessDir('demo')).toBe(
        path.join(getTeamsBasePath(), 'demo', 'task-log-freshness')
      );
    });
  });

  describe('decodeTaskLogFreshnessTaskId', () => {
    it('rejects file names that are not freshness signal files', () => {
      expect(decodeTaskLogFreshnessTaskId('task-7.txt')).toEqual({ kind: 'invalid' });
      expect(decodeTaskLogFreshnessTaskId('.json')).toEqual({ kind: 'invalid' });
    });

    it('decodes a percent-encoded task id back to its original form', () => {
      expect(decodeTaskLogFreshnessTaskId(`${encodeURIComponent('task/7 a')}.json`)).toEqual({
        kind: 'task-id',
        taskId: 'task/7 a',
      });
    });

    it('reports an opaque Windows-safe hashed segment instead of guessing a task id', () => {
      expect(decodeTaskLogFreshnessTaskId(`task-id-${'a1b2c3d4'.repeat(4)}.json`)).toEqual({
        kind: 'opaque-safe-segment',
      });
    });

    it('treats an undecodable or blank encoding as invalid', () => {
      expect(decodeTaskLogFreshnessTaskId('%E0%A4%A.json')).toEqual({ kind: 'invalid' });
      expect(decodeTaskLogFreshnessTaskId(`${encodeURIComponent('   ')}.json`)).toEqual({
        kind: 'invalid',
      });
    });
  });

  describe('getTaskFreshnessDirsForContext', () => {
    it('adds the live project dir to the legacy roots and keeps the team log-signal dir', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'log-source-freshness-signals-context-'));
      setClaudeBasePathOverride(path.join(tempDir, '.claude'));

      const dirs = getTaskFreshnessDirsForContext('demo', ROOT_DIR, [ROOT_DIR]);

      expect(dirs.legacyRootDirs).toEqual([ROOT_DIR]);
      expect(dirs.logSignalDirs).toEqual([getTeamTaskLogFreshnessDir('demo')]);
    });
  });

  describe('routeTaskFreshnessSignalChange', () => {
    it('emits the decoded task id with the log kind for the team log-signal dir', () => {
      const sink = createSink();
      const logSignalDir = path.join(ROOT_DIR, 'task-log-freshness');

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        path.join(logSignalDir, 'task-7.json'),
        { legacyRootDirs: [], logSignalDirs: [logSignalDir] },
        sink
      );

      expect(handled).toBe(true);
      expect(sink.emitTaskLogChange).toHaveBeenCalledWith({
        teamName: 'demo',
        taskId: 'task-7',
        taskSignalKind: 'log',
      });
      expect(sink.emitLogSourceChange).not.toHaveBeenCalled();
    });

    it('emits the change kind for a legacy root task-change freshness dir', () => {
      const sink = createSink();

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        path.join(ROOT_DIR, '.board-task-change-freshness', 'task-7.json'),
        { legacyRootDirs: [ROOT_DIR], logSignalDirs: [] },
        sink
      );

      expect(handled).toBe(true);
      expect(sink.emitTaskLogChange).toHaveBeenCalledWith({
        teamName: 'demo',
        taskId: 'task-7',
        taskSignalKind: 'change',
      });
    });

    it('claims the signal dir itself without emitting a task event', () => {
      const sink = createSink();
      const logSignalDir = path.join(ROOT_DIR, 'task-log-freshness');

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        logSignalDir,
        { legacyRootDirs: [], logSignalDirs: [logSignalDir] },
        sink
      );

      expect(handled).toBe(true);
      expect(sink.emitTaskLogChange).not.toHaveBeenCalled();
      expect(sink.emitLogSourceChange).not.toHaveBeenCalled();
    });

    it('claims a non-signal file inside a signal dir without emitting anything', () => {
      const sink = createSink();
      const logSignalDir = path.join(ROOT_DIR, 'task-log-freshness');

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        path.join(logSignalDir, 'not-a-signal.txt'),
        { legacyRootDirs: [], logSignalDirs: [logSignalDir] },
        sink
      );

      expect(handled).toBe(true);
      expect(sink.emitTaskLogChange).not.toHaveBeenCalled();
      expect(sink.emitLogSourceChange).not.toHaveBeenCalled();
    });

    it('leaves a path outside every freshness dir to the caller', () => {
      const sink = createSink();

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        path.join(ROOT_DIR, 'session.jsonl'),
        { legacyRootDirs: [ROOT_DIR], logSignalDirs: [path.join(ROOT_DIR, 'task-log-freshness')] },
        sink
      );

      expect(handled).toBe(false);
      expect(sink.emitTaskLogChange).not.toHaveBeenCalled();
      expect(sink.emitLogSourceChange).not.toHaveBeenCalled();
    });

    it('reads the task id out of a Windows-safe hashed signal file', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'log-source-freshness-signals-hashed-'));
      const sink = createSink();
      const hashedFile = path.join(tempDir, `task-id-${'0f1e2d3c'.repeat(4)}.json`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses isolated temp dir
      await writeFile(hashedFile, JSON.stringify({ taskId: 'task/7 a' }), 'utf8');

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        hashedFile,
        { legacyRootDirs: [], logSignalDirs: [tempDir] },
        sink
      );

      expect(handled).toBe(true);
      await vi.waitFor(() => {
        expect(sink.emitTaskLogChange).toHaveBeenCalledWith({
          teamName: 'demo',
          taskId: 'task/7 a',
          taskSignalKind: 'log',
        });
      });
      expect(sink.emitLogSourceChange).not.toHaveBeenCalled();
    });

    it('falls back to a team-level refresh when a hashed signal file cannot be read', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'log-source-freshness-signals-missing-'));
      const sink = createSink();

      const handled = routeTaskFreshnessSignalChange(
        'demo',
        path.join(tempDir, `task-id-${'0f1e2d3c'.repeat(4)}.json`),
        { legacyRootDirs: [], logSignalDirs: [tempDir] },
        sink
      );

      expect(handled).toBe(true);
      await vi.waitFor(() => {
        expect(sink.emitLogSourceChange).toHaveBeenCalledWith('demo');
      });
      expect(sink.emitTaskLogChange).not.toHaveBeenCalled();
    });
  });
});

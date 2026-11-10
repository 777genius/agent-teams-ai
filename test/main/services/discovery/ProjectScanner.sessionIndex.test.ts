import * as crypto from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
import { SessionMetadataIndex } from '../../../../src/main/services/discovery/SessionMetadataIndex';
import { subprojectRegistry } from '../../../../src/main/services/discovery/SubprojectRegistry';
import type { FileSystemProvider } from '../../../../src/main/services/infrastructure/FileSystemProvider';

function createSessionLine(content: string, timestamp = '2026-01-01T00:00:00.000Z'): string {
  return JSON.stringify({
    uuid: crypto.randomUUID(),
    type: 'user',
    message: { role: 'user', content },
    timestamp,
  });
}

function createNoiseLine(): string {
  return JSON.stringify({
    uuid: crypto.randomUUID(),
    type: 'system',
    content: 'noise',
    timestamp: '2026-01-01T00:00:00.000Z',
  });
}

function createSessionLineWithCwd(content: string, cwd: string): string {
  return JSON.stringify({
    uuid: crypto.randomUUID(),
    type: 'user',
    cwd,
    message: { role: 'user', content },
    timestamp: '2026-01-01T00:00:00.000Z',
  });
}

function createSshLikeLocalProvider(): FileSystemProvider {
  return {
    type: 'ssh',
    exists: (filePath: string) => Promise.resolve(fs.existsSync(filePath)),
    readFile: async (filePath: string, encoding: BufferEncoding = 'utf8') =>
      fs.promises.readFile(filePath, encoding),
    stat: async (filePath: string) => {
      const stats = await fs.promises.stat(filePath);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
      };
    },
    readdir: async (dirPath: string) => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry) => {
          const entryPath = path.join(dirPath, entry.name);
          const stats = await fs.promises.stat(entryPath);
          return {
            name: entry.name,
            isFile: () => entry.isFile(),
            isDirectory: () => entry.isDirectory(),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            birthtimeMs: stats.birthtimeMs,
          };
        })
      );
    },
    createReadStream: (filePath: string, opts?: { start?: number; encoding?: BufferEncoding }) =>
      fs.createReadStream(filePath, opts),
    dispose: () => undefined,
  };
}

function createReadStreamFailingLocalProvider(): FileSystemProvider {
  return {
    ...createSshLikeLocalProvider(),
    type: 'local',
    createReadStream: () => {
      throw new Error('session body should not be read when a fresh index entry exists');
    },
  };
}

function readIndexSessions(
  indexDir: string,
  projectDir: string
): Record<string, Record<string, unknown>> {
  const raw = fs.readFileSync(SessionMetadataIndex.getIndexPath(indexDir, projectDir), 'utf8');
  const parsed = JSON.parse(raw) as { sessions?: Record<string, Record<string, unknown>> };
  return parsed.sessions ?? {};
}

function sortStrings(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

describe('ProjectScanner session metadata index', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    subprojectRegistry.clear();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createFixture(): {
    projectsDir: string;
    indexDir: string;
    projectId: string;
    projectDir: string;
    sessionPath: string;
  } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-index-'));
    tempDirs.push(rootDir);

    const projectsDir = path.join(rootDir, 'projects');
    const indexDir = path.join(rootDir, 'session-index');
    const projectId = '-Users-test-indexed-project';
    const projectDir = path.join(projectsDir, projectId);
    const sessionPath = path.join(projectDir, 'session-1.jsonl');

    fs.mkdirSync(projectDir, { recursive: true });

    return {
      projectsDir,
      indexDir,
      projectId,
      projectDir,
      sessionPath,
    };
  }

  it('does not serve stale indexed metadata after a session file changes', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();

    fs.writeFileSync(sessionPath, `${createSessionLine('old indexed title')}\n`, 'utf8');

    const firstScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const firstSessions = await firstScanner.listSessions(projectId);
    expect(firstSessions).toHaveLength(1);
    expect(firstSessions[0].firstMessage).toBe('old indexed title');

    await firstScanner.flushSessionMetadataIndexForTesting();
    const indexPath = SessionMetadataIndex.getIndexPath(indexDir, projectDir);
    expect(fs.existsSync(indexPath)).toBe(true);

    fs.writeFileSync(
      sessionPath,
      `${createSessionLine('new indexed title with different size')}\n`,
      'utf8'
    );
    const future = new Date('2026-01-01T00:01:00.000Z');
    fs.utimesSync(sessionPath, future, future);

    const secondScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const secondSessions = await secondScanner.listSessions(projectId);
    expect(secondSessions).toHaveLength(1);
    expect(secondSessions[0].firstMessage).toBe('new indexed title with different size');
  });

  it('falls back to live parsing when the persisted index is corrupt', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('live title')}\n`, 'utf8');

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      '{not valid json',
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('live title');
  });

  it('ignores malformed indexed metadata and reparses the live session file', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('live metadata title')}\n`, 'utf8');
    const stats = fs.statSync(sessionPath);

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      JSON.stringify({
        schemaVersion: 1,
        projectStorageDir: projectDir,
        updatedAt: Date.now(),
        sessions: {
          [sessionPath]: {
            sessionId: 'session-1',
            filePath: sessionPath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            birthtimeMs: stats.birthtimeMs,
            hasContent: true,
            metadata: {
              firstUserMessage: { text: 42, timestamp: 'bad' },
              messageCount: 'bad',
              isOngoing: 'bad',
              gitBranch: null,
            },
            updatedAt: Date.now(),
          },
        },
      }),
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);
    await scanner.flushSessionMetadataIndexForTesting();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('live metadata title');
    expect(
      (
        readIndexSessions(indexDir, projectDir)[sessionPath].metadata as {
          firstUserMessage?: { text?: string };
        }
      ).firstUserMessage?.text
    ).toBe('live metadata title');
  });

  it('does not trust content presence from an entry with malformed metadata', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(
      sessionPath,
      `${createSessionLine('visible despite corrupt index')}\n`,
      'utf8'
    );
    const stats = fs.statSync(sessionPath);

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      JSON.stringify({
        schemaVersion: 1,
        projectStorageDir: projectDir,
        updatedAt: Date.now(),
        sessions: {
          [sessionPath]: {
            sessionId: 'session-1',
            filePath: sessionPath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            birthtimeMs: stats.birthtimeMs,
            hasContent: false,
            metadata: {
              firstUserMessage: { text: 42, timestamp: 'bad' },
              messageCount: 'bad',
              isOngoing: 'bad',
              gitBranch: null,
            },
            updatedAt: Date.now(),
          },
        },
      }),
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('visible despite corrupt index');
  });

  it('does not trust content presence when the indexed session id mismatches the file', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('visible despite id mismatch')}\n`, 'utf8');
    const stats = fs.statSync(sessionPath);

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      JSON.stringify({
        schemaVersion: 1,
        projectStorageDir: projectDir,
        updatedAt: Date.now(),
        sessions: {
          [sessionPath]: {
            sessionId: 'different-session',
            filePath: sessionPath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            birthtimeMs: stats.birthtimeMs,
            hasContent: false,
            updatedAt: Date.now(),
          },
        },
      }),
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('visible despite id mismatch');
  });

  it('does not trust content presence from an entry with invalid numeric signature fields', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(
      sessionPath,
      `${createSessionLine('visible despite invalid signature')}\n`,
      'utf8'
    );
    const stats = fs.statSync(sessionPath);

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      JSON.stringify({
        schemaVersion: 1,
        projectStorageDir: projectDir,
        updatedAt: Date.now(),
        sessions: {
          [sessionPath]: {
            sessionId: 'session-1',
            filePath: sessionPath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            birthtimeMs: -1,
            hasContent: false,
            updatedAt: Date.now(),
          },
        },
      }),
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('visible despite invalid signature');
  });

  it('does not hide a session when a stale no-content index entry exists', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createNoiseLine()}\n`, 'utf8');

    const firstScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const noiseSessions = await firstScanner.listSessions(projectId);
    expect(noiseSessions).toHaveLength(0);
    await firstScanner.flushSessionMetadataIndexForTesting();
    expect(readIndexSessions(indexDir, projectDir)[sessionPath].hasContent).toBe(false);

    fs.writeFileSync(sessionPath, `${createSessionLine('visible after stale false')}\n`, 'utf8');
    const future = new Date('2026-01-01T00:02:00.000Z');
    fs.utimesSync(sessionPath, future, future);

    const secondScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const liveSessions = await secondScanner.listSessions(projectId);

    expect(liveSessions).toHaveLength(1);
    expect(liveSessions[0].firstMessage).toBe('visible after stale false');
  });

  it('ignores indexed metadata containing non-finite numeric fields', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('live finite numeric title')}\n`, 'utf8');
    const stats = fs.statSync(sessionPath);

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      `{
        "schemaVersion": 1,
        "projectStorageDir": ${JSON.stringify(projectDir)},
        "updatedAt": ${Date.now()},
        "sessions": {
          ${JSON.stringify(sessionPath)}: {
            "sessionId": "session-1",
            "filePath": ${JSON.stringify(sessionPath)},
            "mtimeMs": ${stats.mtimeMs},
            "size": ${stats.size},
            "birthtimeMs": ${stats.birthtimeMs},
            "hasContent": true,
            "metadata": {
              "firstUserMessage": {
                "text": "indexed title with corrupt numeric field",
                "timestamp": "2026-01-01T00:00:00.000Z"
              },
              "messageCount": 1,
              "isOngoing": false,
              "gitBranch": null,
              "model": null,
              "contextConsumption": 1e999
            },
            "updatedAt": ${Date.now()}
          }
        }
      }`,
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('live finite numeric title');
  });

  it('ignores indexed metadata with corrupt phase breakdown fields', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('live phase breakdown title')}\n`, 'utf8');
    const stats = fs.statSync(sessionPath);

    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      SessionMetadataIndex.getIndexPath(indexDir, projectDir),
      `{
        "schemaVersion": 1,
        "projectStorageDir": ${JSON.stringify(projectDir)},
        "updatedAt": ${Date.now()},
        "sessions": {
          ${JSON.stringify(sessionPath)}: {
            "sessionId": "session-1",
            "filePath": ${JSON.stringify(sessionPath)},
            "mtimeMs": ${stats.mtimeMs},
            "size": ${stats.size},
            "birthtimeMs": ${stats.birthtimeMs},
            "hasContent": true,
            "metadata": {
              "firstUserMessage": {
                "text": "indexed title with corrupt phase breakdown",
                "timestamp": "2026-01-01T00:00:00.000Z"
              },
              "messageCount": 1,
              "isOngoing": false,
              "gitBranch": null,
              "model": null,
              "contextConsumption": 10,
              "compactionCount": 1,
              "phaseBreakdown": [
                {
                  "phaseNumber": 1,
                  "contribution": 10,
                  "peakTokens": 10,
                  "postCompaction": 1e999
                }
              ]
            },
            "updatedAt": ${Date.now()}
          }
        }
      }`,
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('live phase breakdown title');
  });

  it('does not retry forever when the index cannot be persisted', async () => {
    const { projectsDir, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('best effort cache')}\n`, 'utf8');
    const stats = fs.statSync(sessionPath);
    const blockedIndexRoot = path.join(path.dirname(projectsDir), 'blocked-index-root');
    fs.writeFileSync(blockedIndexRoot, 'not a directory', 'utf8');

    const index = new SessionMetadataIndex({
      rootDir: blockedIndexRoot,
      persistDelayMs: 0,
    });
    await index.setMetadata(
      {
        sessionId: 'session-1',
        filePath: sessionPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        birthtimeMs: stats.birthtimeMs,
      },
      {
        firstUserMessage: {
          text: 'best effort cache',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
        messageCount: 1,
        isOngoing: false,
        gitBranch: null,
        model: null,
      }
    );

    const flushResult = await withTimeout(
      index.flushForTesting().then(() => 'resolved'),
      500
    );

    expect(flushResult).toBe('resolved');
    expect(fs.existsSync(SessionMetadataIndex.getIndexPath(blockedIndexRoot, projectDir))).toBe(
      false
    );
  });

  it('persists content filtering and metadata across scanner instances for paginated listing', async () => {
    const { projectsDir, indexDir, projectId, projectDir } = createFixture();
    const visiblePath = path.join(projectDir, 'session-visible.jsonl');
    const noisePath = path.join(projectDir, 'session-noise.jsonl');
    fs.writeFileSync(visiblePath, `${createSessionLine('visible title')}\n`, 'utf8');
    fs.writeFileSync(noisePath, `${createNoiseLine()}\n`, 'utf8');

    const firstScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const firstPage = await firstScanner.listSessionsPaginated(projectId, null, 10, {
      includeTotalCount: true,
      prefilterAll: true,
      metadataLevel: 'deep',
    });
    expect(firstPage.sessions.map((session) => session.id)).toEqual(['session-visible']);
    expect(firstPage.totalCount).toBe(1);

    await firstScanner.flushSessionMetadataIndexForTesting();
    const indexedSessions = readIndexSessions(indexDir, projectDir);
    expect(sortStrings(Object.keys(indexedSessions))).toEqual(
      sortStrings([noisePath, visiblePath])
    );
    expect(indexedSessions[visiblePath].hasContent).toBe(true);
    expect(indexedSessions[noisePath].hasContent).toBe(false);
    expect(
      (
        indexedSessions[visiblePath].metadata as {
          firstUserMessage?: { text?: string };
        }
      ).firstUserMessage?.text
    ).toBe('visible title');

    const secondScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const secondPage = await secondScanner.listSessionsPaginated(projectId, null, 10, {
      includeTotalCount: true,
      prefilterAll: true,
      metadataLevel: 'deep',
    });
    expect(secondPage.sessions.map((session) => session.id)).toEqual(['session-visible']);
    expect(secondPage.sessions[0].firstMessage).toBe('visible title');
    expect(secondPage.totalCount).toBe(1);
  });

  it('serves fresh indexed listing data without reopening the session body', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('fresh cached title')}\n`, 'utf8');

    const firstScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const firstSessions = await firstScanner.listSessions(projectId);
    expect(firstSessions).toHaveLength(1);
    await firstScanner.flushSessionMetadataIndexForTesting();
    expect(readIndexSessions(indexDir, projectDir)[sessionPath].hasContent).toBe(true);

    const secondScanner = new ProjectScanner(
      projectsDir,
      undefined,
      createReadStreamFailingLocalProvider(),
      {
        sessionIndexDir: indexDir,
        sessionIndexPersistDelayMs: 0,
      }
    );
    const secondSessions = await secondScanner.listSessions(projectId);

    expect(secondSessions).toHaveLength(1);
    expect(secondSessions[0].firstMessage).toBe('fresh cached title');
  });

  it('does not persist a local session index for ssh filesystem providers', async () => {
    const { projectsDir, indexDir, projectId, projectDir, sessionPath } = createFixture();
    fs.writeFileSync(sessionPath, `${createSessionLine('ssh provider title')}\n`, 'utf8');

    const scanner = new ProjectScanner(projectsDir, undefined, createSshLikeLocalProvider(), {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await scanner.listSessions(projectId);
    await scanner.flushSessionMetadataIndexForTesting();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstMessage).toBe('ssh provider title');
    expect(fs.existsSync(SessionMetadataIndex.getIndexPath(indexDir, projectDir))).toBe(false);
  });

  it('prunes deleted session entries from the persisted index after relisting', async () => {
    const { projectsDir, indexDir, projectId, projectDir } = createFixture();
    const keepPath = path.join(projectDir, 'session-keep.jsonl');
    const deletePath = path.join(projectDir, 'session-delete.jsonl');
    fs.writeFileSync(keepPath, `${createSessionLine('keep title')}\n`, 'utf8');
    fs.writeFileSync(deletePath, `${createSessionLine('delete title')}\n`, 'utf8');

    const firstScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    await firstScanner.listSessions(projectId);
    await firstScanner.flushSessionMetadataIndexForTesting();
    expect(sortStrings(Object.keys(readIndexSessions(indexDir, projectDir)))).toEqual(
      sortStrings([deletePath, keepPath])
    );

    fs.rmSync(deletePath);

    const secondScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const sessions = await secondScanner.listSessions(projectId);
    await secondScanner.flushSessionMetadataIndexForTesting();

    expect(sessions.map((session) => session.id)).toEqual(['session-keep']);
    expect(Object.keys(readIndexSessions(indexDir, projectDir))).toEqual([keepPath]);
  });

  it('does not prune sibling composite-subproject entries when listing one subproject', async () => {
    const { projectsDir, indexDir, projectId, projectDir } = createFixture();
    const sessionAPath = path.join(projectDir, 'session-a.jsonl');
    const sessionBPath = path.join(projectDir, 'session-b.jsonl');
    fs.writeFileSync(
      sessionAPath,
      `${createSessionLineWithCwd('title a', '/Users/test/indexed-project-a')}\n`,
      'utf8'
    );
    fs.writeFileSync(
      sessionBPath,
      `${createSessionLineWithCwd('title b', '/Users/test/indexed-project-b')}\n`,
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    const projects = await scanner.scan();
    const compositeProjects = projects
      .filter((project) => project.id.startsWith(`${projectId}::`))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(compositeProjects).toHaveLength(2);

    await scanner.listSessions(compositeProjects[0].id);
    await scanner.listSessions(compositeProjects[1].id);
    await scanner.flushSessionMetadataIndexForTesting();
    expect(sortStrings(Object.keys(readIndexSessions(indexDir, projectDir)))).toEqual(
      sortStrings([sessionAPath, sessionBPath])
    );

    const freshScanner = new ProjectScanner(projectsDir, undefined, undefined, {
      sessionIndexDir: indexDir,
      sessionIndexPersistDelayMs: 0,
    });
    await freshScanner.scan();
    await freshScanner.listSessions(compositeProjects[0].id);
    await freshScanner.flushSessionMetadataIndexForTesting();

    expect(sortStrings(Object.keys(readIndexSessions(indexDir, projectDir)))).toEqual(
      sortStrings([sessionAPath, sessionBPath])
    );
  });
});

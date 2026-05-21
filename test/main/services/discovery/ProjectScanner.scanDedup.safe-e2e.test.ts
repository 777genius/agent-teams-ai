import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
import { subprojectRegistry } from '../../../../src/main/services/discovery/SubprojectRegistry';

import type {
  FileSystemProvider,
  FsDirent,
  FsStatResult,
  ReadStreamOptions,
} from '../../../../src/main/services/infrastructure/FileSystemProvider';

interface CountingProvider extends FileSystemProvider {
  readonly readdirCounts: Map<string, number>;
  getMaxConcurrentReaddirs(): number;
  releaseBlockedRead(): void;
  waitForBlockedRead(): Promise<void>;
}

function createSessionLine(cwd: string): string {
  return JSON.stringify({
    uuid: crypto.randomUUID(),
    type: 'user',
    cwd,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  });
}

function createProject(projectsDir: string, encodedName: string, cwd: string): string {
  const projectDir = path.join(projectsDir, encodedName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-1.jsonl'), `${createSessionLine(cwd)}\n`);
  return projectDir;
}

function toStatResult(stats: fs.Stats): FsStatResult {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
  };
}

function toDirent(entry: fs.Dirent): FsDirent {
  return {
    name: entry.name,
    isFile: () => entry.isFile(),
    isDirectory: () => entry.isDirectory(),
  };
}

function createCountingProvider(blockFirstReadPath?: string): CountingProvider {
  const readdirCounts = new Map<string, number>();
  let blockedReadStartedResolve: (() => void) | null = null;
  let releaseBlockedReadResolve: (() => void) | null = null;
  let activeReaddirs = 0;
  let maxConcurrentReaddirs = 0;
  const blockedReadStarted = blockFirstReadPath
    ? new Promise<void>((resolve) => {
        blockedReadStartedResolve = resolve;
      })
    : Promise.resolve();

  return {
    type: 'local',
    readdirCounts,
    async exists(filePath: string): Promise<boolean> {
      return fs.existsSync(filePath);
    },
    async readFile(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
      return fs.promises.readFile(filePath, encoding);
    },
    async stat(filePath: string): Promise<FsStatResult> {
      return toStatResult(await fs.promises.stat(filePath));
    },
    async readdir(dirPath: string): Promise<FsDirent[]> {
      activeReaddirs += 1;
      maxConcurrentReaddirs = Math.max(maxConcurrentReaddirs, activeReaddirs);
      try {
        const count = (readdirCounts.get(dirPath) ?? 0) + 1;
        readdirCounts.set(dirPath, count);
        if (dirPath === blockFirstReadPath && count === 1) {
          blockedReadStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseBlockedReadResolve = resolve;
          });
        }
        return (await fs.promises.readdir(dirPath, { withFileTypes: true })).map(toDirent);
      } finally {
        activeReaddirs -= 1;
      }
    },
    createReadStream(filePath: string, opts?: ReadStreamOptions): fs.ReadStream {
      return fs.createReadStream(filePath, {
        start: opts?.start,
        encoding: opts?.encoding,
      });
    },
    dispose(): void {
      releaseBlockedReadResolve?.();
    },
    getMaxConcurrentReaddirs(): number {
      return maxConcurrentReaddirs;
    },
    releaseBlockedRead(): void {
      releaseBlockedReadResolve?.();
    },
    waitForBlockedRead(): Promise<void> {
      return blockedReadStarted;
    },
  };
}

describe('ProjectScanner scan dedup safe e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    subprojectRegistry.clear();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('shares one in-flight scan between project and repository-group startup reads', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-dedup-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const encodedName = '-Users-test-dedup-project';
    const projectDir = createProject(projectsDir, encodedName, '/Users/test/dedup-project');
    const provider = createCountingProvider();
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const [projects, groups] = await Promise.all([
      scanner.scan(),
      scanner.scanWithWorktreeGrouping(),
    ]);

    expect(projects.map((project) => project.id)).toContain(encodedName);
    expect(groups.map((group) => group.id)).toContain(encodedName);
    expect(provider.readdirCounts.get(projectsDir)).toBe(1);
    expect(provider.readdirCounts.get(projectDir)).toBe(1);
  });

  it('does not cache an in-flight scan after clearScanCache invalidates it', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-dedup-clear-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    createProject(projectsDir, '-Users-test-clear-project', '/Users/test/clear-project');
    const provider = createCountingProvider(projectsDir);
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const firstScan = scanner.scan();
    await provider.waitForBlockedRead();
    scanner.clearScanCache();
    const secondScan = scanner.scan();
    const thirdScan = scanner.scan();
    provider.releaseBlockedRead();
    await expect(firstScan).resolves.toHaveLength(1);
    await expect(secondScan).resolves.toHaveLength(1);
    await expect(thirdScan).resolves.toHaveLength(1);

    expect(provider.readdirCounts.get(projectsDir)).toBe(2);
    expect(provider.getMaxConcurrentReaddirs()).toBe(1);
  });
});

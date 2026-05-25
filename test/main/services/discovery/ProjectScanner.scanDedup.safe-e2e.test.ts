import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
import { subprojectRegistry } from '../../../../src/main/services/discovery/SubprojectRegistry';
import { configManager } from '../../../../src/main/services/infrastructure/ConfigManager';

import type {
  FileSystemProvider,
  FsDirent,
  FsStatResult,
  ReadStreamOptions,
} from '../../../../src/main/services/infrastructure/FileSystemProvider';

interface CountingProvider extends FileSystemProvider {
  readonly readdirCounts: Map<string, number>;
  getMaxConcurrentReaddirs(): number;
  getMaxConcurrentStats(): number;
  getStatCount(): number;
  setProjectReaddirDelay(ms: number): void;
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

function createProject(
  projectsDir: string,
  encodedName: string,
  cwd: string,
  sessionCount = 1
): string {
  const projectDir = path.join(projectsDir, encodedName);
  fs.mkdirSync(projectDir, { recursive: true });
  for (let index = 1; index <= sessionCount; index += 1) {
    fs.writeFileSync(
      path.join(projectDir, `session-${index}.jsonl`),
      `${createSessionLine(cwd)}\n`
    );
  }
  return projectDir;
}

function createSplitProject(
  projectsDir: string,
  encodedName: string,
  cwds: readonly string[]
): string {
  const projectDir = path.join(projectsDir, encodedName);
  fs.mkdirSync(projectDir, { recursive: true });
  cwds.forEach((cwd, index) => {
    fs.writeFileSync(
      path.join(projectDir, `split-session-${index + 1}.jsonl`),
      `${createSessionLine(cwd)}\n`
    );
  });
  return projectDir;
}

function buildCompositeId(baseDir: string, cwd: string): string {
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return `${baseDir}::${hash}`;
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

interface CountingProviderOptions {
  blockFirstReadPath?: string;
  projectReaddirDelayMs?: number;
  statDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 20
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await delay(intervalMs);
  }
  return predicate();
}

function createCountingProvider(options: string | CountingProviderOptions = {}): CountingProvider {
  const blockFirstReadPath = typeof options === 'string' ? options : options.blockFirstReadPath;
  let projectReaddirDelayMs =
    typeof options === 'string' ? 0 : (options.projectReaddirDelayMs ?? 0);
  const statDelayMs = typeof options === 'string' ? 0 : (options.statDelayMs ?? 0);
  const readdirCounts = new Map<string, number>();
  let rootReaddirPath: string | null = null;
  let blockedReadStartedResolve: (() => void) | null = null;
  let releaseBlockedReadResolve: (() => void) | null = null;
  let activeReaddirs = 0;
  let maxConcurrentReaddirs = 0;
  let activeStats = 0;
  let maxConcurrentStats = 0;
  let statCount = 0;
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
      statCount += 1;
      activeStats += 1;
      maxConcurrentStats = Math.max(maxConcurrentStats, activeStats);
      try {
        if (statDelayMs > 0) {
          await delay(statDelayMs);
        }
        return toStatResult(await fs.promises.stat(filePath));
      } finally {
        activeStats -= 1;
      }
    },
    async readdir(dirPath: string): Promise<FsDirent[]> {
      activeReaddirs += 1;
      maxConcurrentReaddirs = Math.max(maxConcurrentReaddirs, activeReaddirs);
      try {
        rootReaddirPath ??= dirPath;
        const count = (readdirCounts.get(dirPath) ?? 0) + 1;
        readdirCounts.set(dirPath, count);
        if (projectReaddirDelayMs > 0 && dirPath !== rootReaddirPath) {
          await delay(projectReaddirDelayMs);
        }
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
    getMaxConcurrentStats(): number {
      return maxConcurrentStats;
    },
    getStatCount(): number {
      return statCount;
    },
    setProjectReaddirDelay(ms: number): void {
      projectReaddirDelayMs = Math.max(0, ms);
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
    vi.restoreAllMocks();
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

  it('shares one in-flight repository-group build including custom path enrichment', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-groups-dedup-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const encodedName = '-Users-test-groups-project';
    createProject(projectsDir, encodedName, '/Users/test/groups-project');
    const customPath = path.join(rootDir, 'manual-project');
    fs.mkdirSync(customPath, { recursive: true });
    const getCustomProjectPathsSpy = vi
      .spyOn(configManager, 'getCustomProjectPaths')
      .mockReturnValue([customPath]);
    const provider = createCountingProvider();
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const [firstGroups, secondGroups] = await Promise.all([
      scanner.scanWithWorktreeGrouping(),
      scanner.scanWithWorktreeGrouping(),
    ]);

    expect(firstGroups).toHaveLength(2);
    expect(secondGroups).toEqual(firstGroups);
    expect(getCustomProjectPathsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reuse stale repository groups when custom project paths change', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-groups-custom-fresh-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    createProject(projectsDir, '-Users-test-custom-fresh-project', '/Users/test/custom-fresh');
    const firstCustomPath = path.join(rootDir, 'first-manual-project');
    const secondCustomPath = path.join(rootDir, 'second-manual-project');
    fs.mkdirSync(firstCustomPath, { recursive: true });
    fs.mkdirSync(secondCustomPath, { recursive: true });
    vi.spyOn(configManager, 'getCustomProjectPaths')
      .mockReturnValueOnce([firstCustomPath])
      .mockReturnValueOnce([secondCustomPath]);
    const provider = createCountingProvider();
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const firstGroups = await scanner.scanWithWorktreeGrouping();
    const secondGroups = await scanner.scanWithWorktreeGrouping();

    expect(firstGroups.some((group) => group.worktrees[0]?.path === firstCustomPath)).toBe(true);
    expect(secondGroups.some((group) => group.worktrees[0]?.path === secondCustomPath)).toBe(true);
    expect(secondGroups.some((group) => group.worktrees[0]?.path === firstCustomPath)).toBe(false);
  });

  it('continues scanning later project directories while one project is slow', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-rolling-projects-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const projectDirs: string[] = [];
    for (let projectIndex = 0; projectIndex < 14; projectIndex += 1) {
      projectDirs.push(
        createProject(
          projectsDir,
          `-Users-test-rolling-${projectIndex}`,
          `/Users/test/rolling-${projectIndex}`
        )
      );
    }
    const provider = createCountingProvider(projectDirs[0]);
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const scan = scanner.scan();
    await provider.waitForBlockedRead();
    const laterProjectScanned = await waitForCondition(
      () => (provider.readdirCounts.get(projectDirs[13]) ?? 0) > 0
    );

    provider.releaseBlockedRead();
    const projects = await scan;

    expect(laterProjectScanned).toBe(true);
    expect(projects).toHaveLength(14);
  });

  it('uses a bounded cwd hint instead of partial splitting for larger project dirs', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-bounded-cwd-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const encodedName = '-Users-test-bounded-cwd';
    createSplitProject(
      projectsDir,
      encodedName,
      Array.from({ length: 13 }, (_value, index) => `/Users/test/bounded-cwd/app-${index}`)
    );
    const provider = createCountingProvider();
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const projects = await scanner.scan();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: encodedName,
      totalSessions: 13,
    });
    expect(projects[0]?.path).toContain('/Users/test/bounded-cwd/app-');
    expect(subprojectRegistry.isComposite(projects[0]?.id ?? '')).toBe(false);
  });

  it('bounds local scan stat concurrency without restatting files during cwd extraction', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-io-limit-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    for (let projectIndex = 0; projectIndex < 6; projectIndex += 1) {
      createProject(
        projectsDir,
        `-Users-test-io-limit-${projectIndex}`,
        `/Users/test/io-limit-${projectIndex}`,
        5
      );
    }
    const provider = createCountingProvider({ statDelayMs: 10 });
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanFileIoConcurrency: 2,
    });

    const projects = await scanner.scan();

    expect(projects).toHaveLength(6);
    expect(provider.getStatCount()).toBe(30);
    expect(provider.getMaxConcurrentStats()).toBeLessThanOrEqual(2);
  });

  it('aborts queued local file I/O after a project scan budget timeout', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-io-abort-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    createProject(projectsDir, '-Users-test-io-abort', '/Users/test/io-abort', 8);
    const provider = createCountingProvider({ statDelayMs: 250 });
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanBudgetMs: 1300,
      scanFileIoConcurrency: 1,
    });

    await expect(scanner.scan()).resolves.toEqual([]);
    await delay(2400);

    expect(provider.getStatCount()).toBeGreaterThan(0);
    expect(provider.getStatCount()).toBeLessThan(8);
  });

  it('returns an uncached partial scan before the scan budget can hit renderer timeout', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-budget-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const projectCount = 6;
    for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
      createProject(
        projectsDir,
        `-Users-test-budget-${projectIndex}`,
        `/Users/test/budget-${projectIndex}`
      );
    }
    const provider = createCountingProvider({ projectReaddirDelayMs: 250 });
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanBudgetMs: 75,
    });

    const firstStartedAt = Date.now();
    const firstProjects = await scanner.scan();
    const firstMs = Date.now() - firstStartedAt;

    expect(firstMs).toBeLessThan(1000);
    expect(firstProjects).toEqual([]);
    expect(provider.readdirCounts.get(projectsDir)).toBe(1);

    await delay(300);
    await scanner.scan();
    expect(provider.readdirCounts.get(projectsDir)).toBe(2);
  });

  it('does not cache a scan when project-level timeout omits directories', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-project-timeout-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    for (let projectIndex = 0; projectIndex < 2; projectIndex += 1) {
      createProject(
        projectsDir,
        `-Users-test-project-timeout-${projectIndex}`,
        `/Users/test/project-timeout-${projectIndex}`
      );
    }
    const provider = createCountingProvider({ projectReaddirDelayMs: 1100 });
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanBudgetMs: 1000,
    });

    const firstProjects = await scanner.scan();
    const firstRootReads = provider.readdirCounts.get(projectsDir);
    const secondProjects = await scanner.scan();

    expect(firstProjects).toEqual([]);
    expect(secondProjects).toEqual([]);
    expect(firstRootReads).toBe(1);
    expect(provider.readdirCounts.get(projectsDir)).toBe(2);
  });

  it('does not let a timed-out background project scan mutate the subproject registry', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-timeout-registry-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const encodedName = '-Users-test-timeout-registry';
    const firstCwd = '/Users/test/timeout-registry/app';
    const secondCwd = '/Users/test/timeout-registry/docs';
    createSplitProject(projectsDir, encodedName, [firstCwd, secondCwd]);
    const provider = createCountingProvider({ statDelayMs: 1200 });
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanBudgetMs: 1050,
      scanFileIoConcurrency: 2,
    });

    await expect(scanner.scan()).resolves.toEqual([]);
    await delay(1600);

    expect(subprojectRegistry.getCwd(buildCompositeId(encodedName, firstCwd))).toBeNull();
    expect(subprojectRegistry.getCwd(buildCompositeId(encodedName, secondCwd))).toBeNull();
  });

  it('returns the previous complete scan instead of replacing it with a budget partial', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-budget-cache-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const projectCount = 6;
    for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
      createProject(
        projectsDir,
        `-Users-test-budget-cache-${projectIndex}`,
        `/Users/test/budget-cache-${projectIndex}`
      );
    }
    const provider = createCountingProvider();
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanBudgetMs: 1500,
    });

    const firstProjects = await scanner.scan();
    expect(firstProjects).toHaveLength(projectCount);

    provider.setProjectReaddirDelay(1700);
    await delay(2100);
    const secondProjects = await scanner.scan();

    expect(secondProjects).toHaveLength(projectCount);
    expect(secondProjects.map((project) => project.id)).toEqual(
      firstProjects.map((project) => project.id)
    );
    expect(provider.readdirCounts.get(projectsDir)).toBe(2);
  });

  it('restores subproject registry when falling back to a previous complete scan', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-budget-registry-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    createSplitProject(projectsDir, '-Users-test-registry-project', [
      '/Users/test/registry-project/app',
      '/Users/test/registry-project/docs',
    ]);
    const provider = createCountingProvider();
    const scanner = new ProjectScanner(projectsDir, undefined, provider, {
      scanBudgetMs: 1500,
    });

    const firstProjects = await scanner.scan();
    expect(firstProjects).toHaveLength(2);
    expect(firstProjects.every((project) => subprojectRegistry.isComposite(project.id))).toBe(true);
    const firstFilters = firstProjects.map((project) =>
      subprojectRegistry.getSessionFilter(project.id)
    );
    expect(firstFilters.every((filter) => filter?.size === 1)).toBe(true);

    provider.setProjectReaddirDelay(1700);
    await delay(2100);
    const secondProjects = await scanner.scan();

    expect(secondProjects.map((project) => project.id)).toEqual(
      firstProjects.map((project) => project.id)
    );
    for (const project of secondProjects) {
      expect(subprojectRegistry.getSessionFilter(project.id)?.size).toBe(1);
      expect(subprojectRegistry.getCwd(project.id)).toContain('/Users/test/registry-project/');
    }
  });

  it('keeps an in-flight split-project scan complete after cache invalidation', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-split-inflight-'));
    tempDirs.push(rootDir);
    const projectsDir = path.join(rootDir, 'projects');
    const projectDir = createSplitProject(projectsDir, '-Users-test-split-inflight', [
      '/Users/test/split-inflight/app',
      '/Users/test/split-inflight/docs',
    ]);
    const provider = createCountingProvider(projectDir);
    const scanner = new ProjectScanner(projectsDir, undefined, provider);

    const firstScan = scanner.scan();
    await provider.waitForBlockedRead();
    scanner.clearScanCache();
    provider.releaseBlockedRead();
    const projects = await firstScan;

    expect(projects).toHaveLength(2);
    expect(projects.every((project) => subprojectRegistry.isComposite(project.id))).toBe(true);
    expect(
      projects.every((project) => subprojectRegistry.getSessionFilter(project.id)?.size === 1)
    ).toBe(true);
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

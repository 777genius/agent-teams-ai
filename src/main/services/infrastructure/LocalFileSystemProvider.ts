/**
 * LocalFileSystemProvider - FileSystemProvider backed by Node's fs module.
 *
 * Thin wrapper around Node.js filesystem APIs.
 * This is the default provider used when operating in local mode.
 */

import * as path from 'node:path';

import * as fs from 'fs';

import type {
  FileSystemProvider,
  FsDirent,
  FsStatResult,
  ReadStreamOptions,
} from './FileSystemProvider';

const STAT_CONCURRENCY = process.platform === 'win32' ? 32 : 128;
const STAT_TIMEOUT_MS = 2000;
// If a directory is huge, pre-statting every entry can take seconds+ and
// saturate the thread pool. In those cases, prefer returning bare dirents and
// let callers stat only the files they actually need.
const STAT_PREFETCH_LIMIT = 1500;

async function statWithTimeout(filePath: string, timeoutMs: number): Promise<fs.Stats> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('stat timeout')), timeoutMs);
  });
  try {
    return await Promise.race([fs.promises.stat(filePath), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class LocalFileSystemProvider implements FileSystemProvider {
  readonly type = 'local' as const;

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return fs.promises.readFile(filePath, encoding);
  }

  async stat(filePath: string): Promise<FsStatResult> {
    const stats = await statWithTimeout(filePath, STAT_TIMEOUT_MS);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
    };
  }

  async readdir(dirPath: string): Promise<FsDirent[]> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    if (entries.length > STAT_PREFETCH_LIMIT) {
      return entries.map((entry) => ({
        name: entry.name,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
      }));
    }
    // Stat entries with bounded concurrency.
    // Unbounded Promise.all(stat(...)) can saturate the UV thread pool (even with
    // increased UV_THREADPOOL_SIZE) when directories contain thousands of files,
    // causing unrelated operations (teams/tasks/CLI checks) to time out.
    return mapLimit(entries, STAT_CONCURRENCY, async (entry) => {
      let mtimeMs: number | undefined;
      let birthtimeMs: number | undefined;
      let size: number | undefined;
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = await statWithTimeout(fullPath, STAT_TIMEOUT_MS);
        mtimeMs = stat.mtimeMs;
        birthtimeMs = stat.birthtimeMs;
        size = stat.size;
      } catch {
        // ignore
      }
      return {
        name: entry.name,
        mtimeMs,
        birthtimeMs,
        size,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
      };
    });
  }

  createReadStream(filePath: string, opts?: ReadStreamOptions): fs.ReadStream {
    return fs.createReadStream(filePath, {
      start: opts?.start,
      encoding: opts?.encoding,
    });
  }

  dispose(): void {
    // No resources to clean up for local fs
  }
}

import { getTaskChangeSummariesBasePath } from '@main/utils/pathDecoder';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import {
  normalizePersistedTaskChangeSummaryEntry,
  toPersistedSummary,
} from './taskChangeSummaryCacheSchema';

import type { TaskChangeSummaryCacheRepository } from './TaskChangeSummaryCacheRepository';
import type { PersistedTaskChangeSummaryEntry } from './taskChangeSummaryCacheTypes';

const logger = createLogger('Service:JsonTaskChangeSummaryCacheRepository');

const READ_TIMEOUT_MS = 5_000;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_CACHE_FILES = 1_000;

function encodeFileSegment(value: string): string {
  return encodeURIComponent(value);
}

export class JsonTaskChangeSummaryCacheRepository implements TaskChangeSummaryCacheRepository {
  private readonly latestGenerationByKey = new Map<string, number>();
  private readonly writeChains = new Map<string, Promise<void>>();

  private get basePath(): string {
    return getTaskChangeSummariesBasePath();
  }

  private teamDir(teamName: string): string {
    return path.join(this.basePath, encodeFileSegment(teamName));
  }

  private filePath(teamName: string, taskId: string): string {
    return path.join(this.teamDir(teamName), `${encodeFileSegment(taskId)}.json`);
  }

  async load(teamName: string, taskId: string): Promise<PersistedTaskChangeSummaryEntry | null> {
    const filePath = this.filePath(teamName, taskId);
    let content: string;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      try {
        content = await fs.promises.readFile(filePath, {
          encoding: 'utf8',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.warn(`Failed to read persisted task-change summary ${filePath}: ${String(error)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      logger.warn(`Corrupted persisted task-change summary ${filePath}: ${String(error)}`);
      await this.delete(teamName, taskId);
      return null;
    }

    const normalized = normalizePersistedTaskChangeSummaryEntry(parsed);
    if (!normalized) {
      await this.delete(teamName, taskId);
      return null;
    }

    if (new Date(normalized.expiresAt).getTime() <= Date.now()) {
      await this.delete(teamName, taskId);
      return null;
    }

    return normalized;
  }

  async save(
    entry: PersistedTaskChangeSummaryEntry,
    options?: { generation?: number }
  ): Promise<{ written: boolean }> {
    const cacheKey = `${entry.teamName}:${entry.taskId}`;
    const generation = options?.generation;
    const currentGeneration = this.latestGenerationByKey.get(cacheKey);
    if (
      generation !== undefined &&
      currentGeneration !== undefined &&
      generation < currentGeneration
    ) {
      return { written: false };
    }

    if (generation !== undefined) {
      this.latestGenerationByKey.set(cacheKey, generation);
    }

    const write = async (): Promise<{ written: boolean }> => {
      const normalized = toPersistedSummary(entry);
      const payload = JSON.stringify(normalized, null, 2);
      if (Buffer.byteLength(payload, 'utf8') > MAX_ENTRY_BYTES) {
        logger.warn(`Skipping oversized persisted task-change summary for ${cacheKey}`);
        return { written: false };
      }

      await atomicWriteAsync(this.filePath(entry.teamName, entry.taskId), payload);
      await this.prune();
      return { written: true };
    };

    const previous = this.writeChains.get(cacheKey) ?? Promise.resolve();
    let result: { written: boolean } = { written: false };
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        result = await write();
      })
      .finally(() => {
        if (this.writeChains.get(cacheKey) === next) {
          this.writeChains.delete(cacheKey);
        }
      });
    this.writeChains.set(cacheKey, next);
    await next;
    return result;
  }

  async delete(teamName: string, taskId: string): Promise<void> {
    const cacheKey = `${teamName}:${taskId}`;
    this.latestGenerationByKey.delete(cacheKey);
    await fs.promises.unlink(this.filePath(teamName, taskId)).catch(() => undefined);
  }

  async prune(): Promise<number> {
    let teamDirs: string[] = [];
    try {
      teamDirs = await fs.promises.readdir(this.basePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      logger.warn(`Failed to read persisted summary cache dir: ${String(error)}`);
      return 0;
    }

    const files: { path: string; mtimeMs: number }[] = [];
    for (const dirName of teamDirs) {
      const teamPath = path.join(this.basePath, dirName);
      let taskFiles: string[] = [];
      try {
        taskFiles = await fs.promises.readdir(teamPath);
      } catch {
        continue;
      }
      for (const taskFile of taskFiles) {
        const fullPath = path.join(teamPath, taskFile);
        try {
          const stats = await fs.promises.stat(fullPath);
          files.push({ path: fullPath, mtimeMs: stats.mtimeMs });
        } catch {
          // best effort
        }
      }
    }

    if (files.length <= MAX_CACHE_FILES) {
      return 0;
    }

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete = files.slice(0, files.length - MAX_CACHE_FILES);
    await Promise.all(toDelete.map((file) => fs.promises.unlink(file.path).catch(() => undefined)));
    return toDelete.length;
  }
}

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getTaskChangePresenceBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import {
  normalizePersistedTaskChangePresenceIndex,
  toPersistedTaskChangePresenceIndex,
} from './taskChangePresenceCacheSchema';
import { TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION } from './taskChangePresenceCacheTypes';

import type { PersistedTaskChangePresenceIndex } from './taskChangePresenceCacheTypes';
import type { TaskChangePresenceRepository } from './TaskChangePresenceRepository';

const logger = createLogger('Service:JsonTaskChangePresenceRepository');

const READ_TIMEOUT_MS = 5_000;

function encodeFileSegment(value: string): string {
  return encodeURIComponent(value);
}

export class JsonTaskChangePresenceRepository implements TaskChangePresenceRepository {
  private readonly writeChains = new Map<string, Promise<void>>();

  private get basePath(): string {
    return getTaskChangePresenceBasePath();
  }

  private filePath(teamName: string): string {
    return path.join(this.basePath, `${encodeFileSegment(teamName)}.json`);
  }

  private async readIndex(teamName: string): Promise<PersistedTaskChangePresenceIndex | null> {
    const filePath = this.filePath(teamName);
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
      logger.warn(`Failed to read task-change presence index ${filePath}: ${String(error)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      logger.warn(`Corrupted task-change presence index ${filePath}: ${String(error)}`);
      await fs.promises.unlink(filePath).catch(() => undefined);
      return null;
    }

    const normalized = normalizePersistedTaskChangePresenceIndex(parsed);
    if (!normalized) {
      await fs.promises.unlink(filePath).catch(() => undefined);
      return null;
    }

    return normalized;
  }

  async load(teamName: string): Promise<PersistedTaskChangePresenceIndex | null> {
    return this.readIndex(teamName);
  }

  async upsertEntry(
    teamName: string,
    metadata: {
      projectFingerprint: string;
      logSourceGeneration: string;
      writtenAt: string;
    },
    entry: {
      taskId: string;
      taskSignature: string;
      presence: 'has_changes' | 'no_changes';
      writtenAt: string;
      logSourceGeneration: string;
    }
  ): Promise<void> {
    const write = async (): Promise<void> => {
      const current =
        (await this.readIndex(teamName)) ??
        ({
          version: TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
          teamName,
          projectFingerprint: metadata.projectFingerprint,
          logSourceGeneration: metadata.logSourceGeneration,
          writtenAt: metadata.writtenAt,
          entries: {},
        } satisfies PersistedTaskChangePresenceIndex);

      const next = toPersistedTaskChangePresenceIndex({
        ...current,
        projectFingerprint: metadata.projectFingerprint,
        logSourceGeneration: metadata.logSourceGeneration,
        writtenAt: metadata.writtenAt,
        entries: {
          ...current.entries,
          [entry.taskId]: {
            taskId: entry.taskId,
            taskSignature: entry.taskSignature,
            presence: entry.presence,
            writtenAt: entry.writtenAt,
            logSourceGeneration: entry.logSourceGeneration,
          },
        },
      });

      await atomicWriteAsync(this.filePath(teamName), JSON.stringify(next, null, 2));
    };

    const previous = this.writeChains.get(teamName) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(write)
      .finally(() => {
        if (this.writeChains.get(teamName) === next) {
          this.writeChains.delete(teamName);
        }
      });

    this.writeChains.set(teamName, next);
    await next;
  }
}

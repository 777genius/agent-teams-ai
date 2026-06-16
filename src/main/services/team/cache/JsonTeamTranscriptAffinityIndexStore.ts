import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  normalizeTeamTranscriptAffinityIndex,
  toTeamTranscriptAffinityIndex,
} from './teamTranscriptAffinityIndexSchema';
import {
  type PersistedTeamTranscriptAffinityEntry,
  type PersistedTeamTranscriptAffinityIndex,
  TEAM_TRANSCRIPT_AFFINITY_INDEX_MAX_ENTRIES_PER_PROJECT,
  TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
  type TeamTranscriptAffinityIndexStore,
} from './teamTranscriptAffinityIndexTypes';

const logger = createLogger('Service:JsonTeamTranscriptAffinityIndexStore');

const READ_TIMEOUT_MS = 5_000;

function encodeFileSegment(value: string): string {
  return encodeURIComponent(value);
}

function sortEntriesByFreshness(
  entries: PersistedTeamTranscriptAffinityEntry[]
): PersistedTeamTranscriptAffinityEntry[] {
  return [...entries].sort((left, right) => {
    const rightWrittenAt = Date.parse(right.writtenAt);
    const leftWrittenAt = Date.parse(left.writtenAt);
    return rightWrittenAt - leftWrittenAt || right.fileName.localeCompare(left.fileName);
  });
}

export class JsonTeamTranscriptAffinityIndexStore implements TeamTranscriptAffinityIndexStore {
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly options: { maxEntriesPerProject?: number } = {}) {}

  private get maxEntriesPerProject(): number {
    return Math.max(
      1,
      this.options.maxEntriesPerProject ?? TEAM_TRANSCRIPT_AFFINITY_INDEX_MAX_ENTRIES_PER_PROJECT
    );
  }

  private filePath(teamName: string, projectId: string): string {
    return path.join(
      getTeamsBasePath(),
      teamName,
      'cache',
      'transcript-affinity',
      `${encodeFileSegment(projectId)}.json`
    );
  }

  private writeChainKey(teamName: string, projectId: string): string {
    return `${teamName}\0${projectId}`;
  }

  private async readIndex(
    teamName: string,
    projectId: string
  ): Promise<PersistedTeamTranscriptAffinityIndex | null> {
    const filePath = this.filePath(teamName, projectId);
    let content: string;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      try {
        content = await fs.readFile(filePath, {
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
      logger.debug(`Failed to read transcript affinity index ${filePath}: ${String(error)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      logger.debug(`Corrupted transcript affinity index ${filePath}: ${String(error)}`);
      await fs.unlink(filePath).catch(() => undefined);
      return null;
    }

    const normalized = normalizeTeamTranscriptAffinityIndex(parsed);
    if (!normalized || normalized.teamName !== teamName || normalized.projectId !== projectId) {
      await fs.unlink(filePath).catch(() => undefined);
      return null;
    }

    return normalized;
  }

  async loadProject(
    teamName: string,
    projectId: string
  ): Promise<PersistedTeamTranscriptAffinityIndex | null> {
    return this.readIndex(teamName, projectId);
  }

  async upsertProjectEntries(input: {
    teamName: string;
    projectId: string;
    projectDir: string;
    rootFileNames: ReadonlySet<string>;
    entries: readonly PersistedTeamTranscriptAffinityEntry[];
  }): Promise<void> {
    const chainKey = this.writeChainKey(input.teamName, input.projectId);
    const write = async (): Promise<void> => {
      const current = await this.readIndex(input.teamName, input.projectId);
      const entries = new Map<string, PersistedTeamTranscriptAffinityEntry>();

      for (const [fileName, entry] of Object.entries(current?.entries ?? {})) {
        if (input.rootFileNames.has(fileName)) {
          entries.set(fileName, entry);
        }
      }

      for (const entry of input.entries) {
        if (input.rootFileNames.has(entry.fileName)) {
          entries.set(entry.fileName, entry);
        }
      }

      const cappedEntries = sortEntriesByFreshness([...entries.values()]).slice(
        0,
        this.maxEntriesPerProject
      );
      const next = toTeamTranscriptAffinityIndex({
        version: TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
        teamName: input.teamName,
        projectId: input.projectId,
        projectDir: input.projectDir,
        writtenAt: new Date().toISOString(),
        entries: Object.fromEntries(cappedEntries.map((entry) => [entry.fileName, entry])),
      });

      await atomicWriteAsync(
        this.filePath(input.teamName, input.projectId),
        `${JSON.stringify(next, null, 2)}\n`
      );
    };

    const previous = this.writeChains.get(chainKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(write)
      .finally(() => {
        if (this.writeChains.get(chainKey) === next) {
          this.writeChains.delete(chainKey);
        }
      });

    this.writeChains.set(chainKey, next);
    await next;
  }
}

import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import { TeamTranscriptProjectResolver } from '../../TeamTranscriptProjectResolver';

import type { TeamConfig } from '@shared/types';

const logger = createLogger('Service:TeamTranscriptSourceLocator');
const TRANSCRIPT_DISCOVERY_WARN_MS = 3_000;
const TRANSCRIPT_DISCOVERY_FILE_COUNT_WARN = 500;
const TRANSCRIPT_DISCOVERY_SESSION_CONCURRENCY = process.platform === 'win32' ? 4 : 8;
const TRANSCRIPT_SOURCE_CONTEXT_CACHE_TTL_MS = 3_000;

export interface TeamTranscriptSourceContext {
  projectDir: string;
  projectId: string;
  config: TeamConfig;
  sessionIds: string[];
  transcriptFiles: string[];
}

interface TeamTranscriptSourceContextCacheEntry {
  expiresAt: number;
  generation: number;
  value: TeamTranscriptSourceContext;
}

interface TeamTranscriptSourceContextInFlightEntry {
  generation: number;
  promise: Promise<TeamTranscriptSourceContext | null>;
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
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TeamTranscriptSourceLocator {
  private readonly contextCache = new Map<string, TeamTranscriptSourceContextCacheEntry>();
  private readonly contextInFlight = new Map<string, TeamTranscriptSourceContextInFlightEntry>();
  private readonly generationByTeam = new Map<string, number>();

  constructor(
    private readonly projectResolver: TeamTranscriptProjectResolver = new TeamTranscriptProjectResolver()
  ) {}

  getGeneration(teamName: string): number {
    return this.generationByTeam.get(teamName) ?? 0;
  }

  invalidateTeam(teamName: string): void {
    this.generationByTeam.set(teamName, this.getGeneration(teamName) + 1);
    this.contextCache.delete(teamName);
    this.contextInFlight.delete(teamName);
  }

  clear(): void {
    const teamNames = new Set([
      ...this.contextCache.keys(),
      ...this.contextInFlight.keys(),
      ...this.generationByTeam.keys(),
    ]);
    for (const teamName of teamNames) {
      this.generationByTeam.set(teamName, this.getGeneration(teamName) + 1);
    }
    this.contextCache.clear();
    this.contextInFlight.clear();
  }

  async getContext(
    teamName: string,
    options?: { forceRefresh?: boolean }
  ): Promise<TeamTranscriptSourceContext | null> {
    if (options?.forceRefresh) {
      this.invalidateTeam(teamName);
    }

    const generation = this.getGeneration(teamName);
    const cached = this.contextCache.get(teamName);
    if (cached?.generation === generation && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.contextInFlight.get(teamName);
    if (inFlight?.generation === generation) {
      return await inFlight.promise;
    }

    let entry: TeamTranscriptSourceContextInFlightEntry | null = null;
    const promise = this.buildContext(teamName, generation).finally(() => {
      if (this.contextInFlight.get(teamName) === entry) {
        this.contextInFlight.delete(teamName);
      }
    });
    entry = { generation, promise };
    this.contextInFlight.set(teamName, entry);
    return await promise;
  }

  async listTranscriptFiles(teamName: string): Promise<string[]> {
    const context = await this.getContext(teamName);
    return context?.transcriptFiles ?? [];
  }

  private async buildContext(
    teamName: string,
    generation: number
  ): Promise<TeamTranscriptSourceContext | null> {
    const context = await this.projectResolver.getContext(teamName);
    if (!context) {
      return null;
    }

    const { projectDir, projectId, config, sessionIds } = context;
    const startedAt = Date.now();
    const transcriptFiles = await this.listTranscriptFilesForSessions(projectDir, sessionIds);
    const elapsedMs = Date.now() - startedAt;
    if (
      elapsedMs >= TRANSCRIPT_DISCOVERY_WARN_MS ||
      transcriptFiles.length >= TRANSCRIPT_DISCOVERY_FILE_COUNT_WARN
    ) {
      logger.warn(
        `Large task-log transcript discovery: team=${teamName} sessions=${sessionIds.length} files=${transcriptFiles.length} elapsedMs=${elapsedMs}`
      );
    }
    const value = { projectDir, projectId, config, sessionIds, transcriptFiles };
    if (this.getGeneration(teamName) === generation) {
      this.contextCache.set(teamName, {
        expiresAt: Date.now() + TRANSCRIPT_SOURCE_CONTEXT_CACHE_TTL_MS,
        generation,
        value,
      });
    }
    return value;
  }

  private async listTranscriptFilesForSessions(
    projectDir: string,
    sessionIds: string[]
  ): Promise<string[]> {
    const transcriptFiles = new Set<string>();

    const filesBySession = await mapLimit(
      sessionIds,
      TRANSCRIPT_DISCOVERY_SESSION_CONCURRENCY,
      async (sessionId) => {
        const sessionFiles: string[] = [];
        const mainTranscript = path.join(projectDir, `${sessionId}.jsonl`);
        try {
          const stat = await fs.stat(mainTranscript);
          if (stat.isFile()) {
            sessionFiles.push(mainTranscript);
          }
        } catch {
          // ignore missing root transcript
        }

        const subagentsDir = path.join(projectDir, sessionId, 'subagents');
        try {
          const dirEntries = await fs.readdir(subagentsDir, { withFileTypes: true });
          for (const entry of dirEntries) {
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith('.jsonl')) continue;
            if (!entry.name.startsWith('agent-')) continue;
            if (entry.name.startsWith('agent-acompact')) continue;
            sessionFiles.push(path.join(subagentsDir, entry.name));
          }
        } catch {
          // ignore missing subagent dir
        }
        return sessionFiles;
      }
    );

    for (const sessionFiles of filesBySession) {
      for (const filePath of sessionFiles) {
        transcriptFiles.add(filePath);
      }
    }

    return [...transcriptFiles].sort((left, right) => left.localeCompare(right));
  }
}

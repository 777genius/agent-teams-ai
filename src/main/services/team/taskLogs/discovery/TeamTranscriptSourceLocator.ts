import { encodePath, extractBaseDir, getProjectsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import { TeamConfigReader } from '../../TeamConfigReader';

import type { TeamConfig } from '@shared/types';

const logger = createLogger('Service:TeamTranscriptSourceLocator');

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value.charCodeAt(end - 1);
    if (ch === 47 || ch === 92) {
      end -= 1;
      continue;
    }
    break;
  }
  return end === value.length ? value : value.slice(0, end);
}

export interface TeamTranscriptSourceContext {
  projectDir: string;
  projectId: string;
  config: TeamConfig;
  sessionIds: string[];
  transcriptFiles: string[];
}

export class TeamTranscriptSourceLocator {
  constructor(private readonly configReader: TeamConfigReader = new TeamConfigReader()) {}

  async getContext(teamName: string): Promise<TeamTranscriptSourceContext | null> {
    const config = await this.configReader.getConfig(teamName);
    if (!config?.projectPath) {
      return null;
    }

    const normalizedProjectPath = trimTrailingSlashes(config.projectPath);
    let projectId = encodePath(normalizedProjectPath);
    let projectDir = path.join(getProjectsBasePath(), extractBaseDir(projectId));

    try {
      const stat = await fs.stat(projectDir);
      if (!stat.isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      const leadSessionId =
        typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
          ? config.leadSessionId.trim()
          : null;
      if (leadSessionId) {
        try {
          const projectEntries = await fs.readdir(getProjectsBasePath(), { withFileTypes: true });
          for (const entry of projectEntries) {
            if (!entry.isDirectory()) continue;
            const candidateDir = path.join(getProjectsBasePath(), entry.name);
            try {
              await fs.access(path.join(candidateDir, `${leadSessionId}.jsonl`));
              projectDir = candidateDir;
              projectId = entry.name;
              break;
            } catch {
              // not this project
            }
          }
        } catch {
          // best-effort fallback
        }
      }
    }

    const sessionIds = await this.discoverSessionIds(projectDir, config);
    const transcriptFiles = await this.listTranscriptFilesForSessions(projectDir, sessionIds);
    return { projectDir, projectId, config, sessionIds, transcriptFiles };
  }

  async listTranscriptFiles(teamName: string): Promise<string[]> {
    const context = await this.getContext(teamName);
    return context?.transcriptFiles ?? [];
  }

  private async discoverSessionIds(projectDir: string, config: TeamConfig): Promise<string[]> {
    const knownSessionIds = new Set<string>();
    if (typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0) {
      knownSessionIds.add(config.leadSessionId.trim());
    }
    if (Array.isArray(config.sessionHistory)) {
      for (const sessionId of config.sessionHistory) {
        if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
          knownSessionIds.add(sessionId.trim());
        }
      }
    }

    let discoveredSessionDirs: string[] = [];
    try {
      const dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
      discoveredSessionDirs = dirEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      logger.debug(`Cannot read transcript project dir: ${projectDir}`);
    }

    if (knownSessionIds.size === 0) {
      return discoveredSessionDirs.sort();
    }

    const verifiedSessionIds: string[] = [];
    for (const sessionId of knownSessionIds) {
      try {
        const stat = await fs.stat(path.join(projectDir, sessionId));
        if (stat.isDirectory()) {
          verifiedSessionIds.push(sessionId);
        }
      } catch {
        // ignore stale config session
      }
    }

    return Array.from(
      new Set([...knownSessionIds, ...verifiedSessionIds, ...discoveredSessionDirs])
    ).sort();
  }

  private async listTranscriptFilesForSessions(
    projectDir: string,
    sessionIds: string[]
  ): Promise<string[]> {
    const transcriptFiles = new Set<string>();

    for (const sessionId of sessionIds) {
      const mainTranscript = path.join(projectDir, `${sessionId}.jsonl`);
      try {
        const stat = await fs.stat(mainTranscript);
        if (stat.isFile()) {
          transcriptFiles.add(mainTranscript);
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
          transcriptFiles.add(path.join(subagentsDir, entry.name));
        }
      } catch {
        // ignore missing subagent dir
      }
    }

    return [...transcriptFiles].sort();
  }
}

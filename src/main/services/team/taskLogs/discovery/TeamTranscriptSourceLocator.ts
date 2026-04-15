import * as fs from 'fs/promises';
import * as path from 'path';

import { TeamTranscriptProjectResolver } from '../../TeamTranscriptProjectResolver';

import type { TeamConfig } from '@shared/types';

export interface TeamTranscriptSourceContext {
  projectDir: string;
  projectId: string;
  config: TeamConfig;
  sessionIds: string[];
  transcriptFiles: string[];
}

export class TeamTranscriptSourceLocator {
  constructor(
    private readonly projectResolver: TeamTranscriptProjectResolver = new TeamTranscriptProjectResolver()
  ) {}

  async getContext(teamName: string): Promise<TeamTranscriptSourceContext | null> {
    const context = await this.projectResolver.getContext(teamName);
    if (!context) {
      return null;
    }

    const { projectDir, projectId, config, sessionIds } = context;
    const transcriptFiles = await this.listTranscriptFilesForSessions(projectDir, sessionIds);
    return { projectDir, projectId, config, sessionIds, transcriptFiles };
  }

  async listTranscriptFiles(teamName: string): Promise<string[]> {
    const context = await this.getContext(teamName);
    return context?.transcriptFiles ?? [];
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

    return [...transcriptFiles].sort((left, right) => left.localeCompare(right));
  }
}

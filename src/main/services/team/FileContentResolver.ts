import { FileContentResolver as PortableResolver } from '@agent-teams/task-change-ledger/review-content';
import { readJsonlLines } from '@main/utils/jsonlLineReader';
import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import type { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import type { FileChangeWithContent, SnippetDiff } from '@shared/types';
export class FileContentResolver {
  private readonly resolver: PortableResolver;
  constructor(logsFinder: TeamMemberLogsFinder, gitFallback?: GitDiffFallback) {
    this.resolver = new PortableResolver({
      mode: 'legacy',
      history: {
        findMemberLogPaths: logsFinder.findMemberLogPaths.bind(logsFinder),
        getHomeDir,
        readJsonlLines,
      },
      ...(gitFallback ? { git: gitFallback } : {}),
      logger: createLogger('Service:FileContentResolver'),
    });
  }
  invalidateFile(filePath: string): void {
    return this.resolver.invalidateFile(filePath);
  }
  resolveFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[]
  ): Promise<{
    original: string | null;
    modified: string | null;
    source: FileChangeWithContent['contentSource'];
  }> {
    return this.resolver.resolveFileContent(teamName, memberName, filePath, snippets);
  }
  getFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[] = []
  ): Promise<FileChangeWithContent> {
    return this.resolver.getFileContent(teamName, memberName, filePath, snippets);
  }
  resolveAllFileContents(
    teamName: string,
    memberName: string,
    files: {
      filePath: string;
      relativePath: string;
      snippets: SnippetDiff[];
      linesAdded: number;
      linesRemoved: number;
      isNewFile: boolean;
    }[]
  ): Promise<Map<string, FileChangeWithContent>> {
    return this.resolver.resolveAllFileContents(teamName, memberName, files);
  }
}

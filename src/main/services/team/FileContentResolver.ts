import { FileContentResolver as PortableResolver } from '@agent-teams/task-change-ledger/review-content';
import { createLogger } from '@shared/utils/logger';

import type { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import type { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import type { FileChangeWithContent, SnippetDiff } from '@shared/types';
export class FileContentResolver {
  private readonly resolver: PortableResolver;
  constructor(_logsFinder: TeamMemberLogsFinder, _gitFallback?: GitDiffFallback) {
    this.resolver = new PortableResolver({
      // Current disk bytes are preview-only. Historical backups and Git commits
      // cannot prove a task-bound postimage or authorize rejection.
      mode: 'preview-only',
      logger: createLogger('Service:FileContentResolver'),
    });
  }
  invalidateFile(filePath: string): void {
    return void this.resolver.invalidateFile(filePath);
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
